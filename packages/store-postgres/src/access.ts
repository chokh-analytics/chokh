import {
  DEFAULT_TEAM_ID,
  MAX_PENDING_INVITATIONS,
  StoreQueryError,
  changedMembers,
  checkAuditPage,
  checkInvitation,
  type AccessScope,
  type AccessStore,
  type AuditEntry,
  type AuditPage,
  type AuditPageQuery,
  type InvitationRecord,
  type Role,
  type SiteMember,
  type StoredIdentity,
  type StoredInvitation,
  type StoredTeam,
  type StoredUser,
  type TeamMemberChange,
} from '@chokh/store';
import type { Pool } from 'pg';

import {
  auditOf,
  teamOf,
  userOf,
  type AuditRow,
  type TeamRow,
  type UserRow,
} from './accounts.js';
import { UNIQUE_VIOLATION, isCode, json, text, textArray, transaction } from './db.js';
import {
  AUDIT_LOG,
  IDENTITIES,
  INVITATIONS,
  SITES,
  SITE_MEMBERS,
  TEAMS,
  USERS,
} from './schema.js';
import type { Sites } from './sites.js';

// Access on PostgreSQL (AN-TEAM01; packages/store/src/access.ts has the rules).
//
// Each rule that has to hold under two writers at once is held by the
// database: a team's row is locked while the last-owner rule is checked and
// the list written, an invitation is claimed by the one UPDATE that finds it
// still open, and what makes an address single on a scope and an identity
// single on an account is a unique index the migration made (the adapter does
// not open on a database that lacks one).

interface SiteMemberRow {
  site_id: string;
  user_id: string;
  role: Role;
  identity: boolean;
}

function siteMemberOf(row: SiteMemberRow): SiteMember {
  return { siteId: row.site_id, userId: row.user_id, role: row.role, identity: row.identity };
}

interface InvitationRow {
  id: string;
  email: string;
  scope_kind: AccessScope['kind'];
  scope_id: string;
  role: Role;
  identity: boolean;
  invited_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

// Every column but the hash, which no read hands back.
const INVITATION_COLUMNS =
  'id, email, scope_kind, scope_id, role, identity, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at, revoked_by';

const OPEN = 'accepted_at IS NULL AND revoked_at IS NULL';

function invitationOf(row: InvitationRow): InvitationRecord {
  const record: InvitationRecord = {
    id: row.id,
    email: row.email,
    scope: { kind: row.scope_kind, id: row.scope_id },
    role: row.role,
    identity: row.identity,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  if (row.accepted_at !== null) record.acceptedAt = row.accepted_at;
  if (row.accepted_by !== null) record.acceptedBy = row.accepted_by;
  if (row.revoked_at !== null) record.revokedAt = row.revoked_at;
  if (row.revoked_by !== null) record.revokedBy = row.revoked_by;
  return record;
}

interface IdentityRow {
  issuer: string;
  subject: string;
  user_id: string;
  linked_at: number;
}

function identityOf(row: IdentityRow): StoredIdentity {
  return {
    issuer: row.issuer,
    subject: row.subject,
    userId: row.user_id,
    linkedAt: row.linked_at,
  };
}

// A row's id in a cursor is its sequence number: digits and nothing else, and
// few enough of them to be a number this process can hold exactly.
const SEQUENCE = /^[0-9]{1,15}$/;

// One page of the log, as the statement the adapter runs and what it is run
// with. Exported so a test can ask Postgres how it plans exactly this.
export function auditPageSql(query: AuditPageQuery): { sql: string; params: unknown[] } {
  checkAuditPage(query);
  const after = query.after;
  if (after !== undefined && !SEQUENCE.test(after.id)) {
    throw new StoreQueryError('INVALID_CURSOR', 'That cursor was not written by this store');
  }
  const params: unknown[] = [query.scope.id];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  // The column is chosen from two constants by a kind the check above has
  // already held to 'site' or 'team'; every value is bound.
  const where = [`${query.scope.kind === 'site' ? 'site_id' : 'team_id'} = $1`];
  if (query.from !== undefined) where.push(`ts >= ${bind(query.from)}`);
  if (query.to !== undefined) where.push(`ts < ${bind(query.to)}`);
  if (after !== undefined) {
    where.push(`(ts, seq) < (${bind(after.ts)}, ${bind(Number(after.id))})`);
  }
  if (query.actorId !== undefined) where.push(`actor ->> 'id' = ${bind(text(query.actorId))}`);
  if (query.actions !== undefined) {
    where.push(`action = ANY(${bind(textArray(query.actions))}::text[])`);
  }
  if (query.target !== undefined) where.push(`target = ${bind(text(query.target))}`);
  const sql = `SELECT seq, site_id, team_id, ts, actor, action, route, target, fields
       FROM ${AUDIT_LOG}
      WHERE ${where.join(' AND ')}
      ORDER BY ts DESC, seq DESC
      LIMIT ${bind(query.limit + 1)}`;
  return { sql, params };
}

export function createAccess(pool: Pool, sites: Sites): AccessStore {
  return {
    async usersByIds(userIds: string[]): Promise<StoredUser[]> {
      if (userIds.length === 0) {
        return [];
      }
      const result = await pool.query<UserRow>(
        `SELECT * FROM ${USERS} WHERE id = ANY($1::text[]) ORDER BY id`,
        [textArray(userIds)],
      );
      return result.rows.map(userOf);
    },

    async bumpSessionEpoch(userId: string): Promise<number> {
      const result = await pool.query<{ session_epoch: number }>(
        `UPDATE ${USERS} SET session_epoch = coalesce(session_epoch, 0) + 1
          WHERE id = $1 RETURNING session_epoch`,
        [userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${userId}`);
      }
      return row.session_epoch;
    },

    changeTeamMember(
      teamId: string,
      userId: string,
      to: TeamMemberChange | null,
    ): Promise<StoredTeam> {
      return transaction(pool, async (client) => {
        // The team's row is held from here to the commit, so the list the rule
        // is checked against is the list that is written. setTeamMember's one
        // UPDATE takes the same lock, and waits its turn.
        const found = await client.query<TeamRow>(
          `SELECT * FROM ${TEAMS} WHERE id = $1 FOR UPDATE`,
          [teamId],
        );
        const row = found.rows[0];
        if (row === undefined) {
          throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
        }
        const team = teamOf(row);
        // Which of the owners can sign in with a password. Only the owners
        // matter to the rule, so only they are read.
        const owners = team.members
          .filter((member) => member.role === 'owner')
          .map((member) => member.userId);
        const holders =
          owners.length === 0
            ? []
            : (
                await client.query<{ id: string }>(
                  `SELECT id FROM ${USERS} WHERE id = ANY($1::text[]) AND password_hash IS NOT NULL`,
                  [textArray(owners)],
                )
              ).rows;
        const members = changedMembers(
          team.members,
          userId,
          to,
          new Set(holders.map((holder) => holder.id)),
        );
        await client.query(`UPDATE ${TEAMS} SET members = $2::jsonb WHERE id = $1`, [
          teamId,
          json(members),
        ]);
        return { id: team.id, name: team.name, members };
      });
    },

    async renameTeam(teamId: string, name: string): Promise<StoredTeam> {
      const result = await pool.query<TeamRow>(
        `UPDATE ${TEAMS} SET name = $2 WHERE id = $1 RETURNING *`,
        [teamId, text(name)],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
      }
      return teamOf(row);
    },

    async deleteTeam(teamId: string): Promise<void> {
      if (teamId === DEFAULT_TEAM_ID) {
        throw new StoreQueryError('DEFAULT_TEAM', 'The default team is never deleted');
      }
      await transaction(pool, async (client) => {
        const found = await client.query(`SELECT id FROM ${TEAMS} WHERE id = $1 FOR UPDATE`, [
          teamId,
        ]);
        if (found.rowCount === 0) {
          throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
        }
        const held = await client.query(`SELECT 1 FROM ${SITES} WHERE team_id = $1 LIMIT 1`, [
          teamId,
        ]);
        if ((held.rowCount ?? 0) > 0) {
          throw new StoreQueryError('TEAM_HAS_SITES', 'That team still holds a site');
        }
        await client.query(
          `DELETE FROM ${INVITATIONS} WHERE scope_kind = 'team' AND scope_id = $1`,
          [teamId],
        );
        await client.query(`DELETE FROM ${TEAMS} WHERE id = $1`, [teamId]);
      });
    },

    async siteMembers(siteId: string): Promise<SiteMember[]> {
      const result = await pool.query<SiteMemberRow>(
        `SELECT * FROM ${SITE_MEMBERS} WHERE site_id = $1 ORDER BY user_id`,
        [siteId],
      );
      return result.rows.map(siteMemberOf);
    },

    async siteGrantsForUser(userId: string): Promise<SiteMember[]> {
      const result = await pool.query<SiteMemberRow>(
        `SELECT * FROM ${SITE_MEMBERS} WHERE user_id = $1 ORDER BY site_id`,
        [userId],
      );
      return result.rows.map(siteMemberOf);
    },

    async setSiteMember(member: SiteMember): Promise<void> {
      await sites.siteOrThrow(member.siteId);
      // One row per person and site by the key, so the same person set twice
      // at once is one row with one of the two roles, never two rows.
      await pool.query(
        `INSERT INTO ${SITE_MEMBERS} (site_id, user_id, role, identity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (site_id, user_id) DO UPDATE
            SET role = EXCLUDED.role, identity = EXCLUDED.identity`,
        [text(member.siteId), text(member.userId), member.role, member.identity],
      );
    },

    async removeSiteMember(siteId: string, userId: string): Promise<boolean> {
      const result = await pool.query(
        `DELETE FROM ${SITE_MEMBERS} WHERE site_id = $1 AND user_id = $2`,
        [siteId, userId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async createInvitation(invitation: StoredInvitation): Promise<void> {
      checkInvitation(invitation);
      const email = invitation.email.toLowerCase();
      const scope = invitation.scope;
      if (scope.kind === 'team') {
        const found = await pool.query(`SELECT 1 FROM ${TEAMS} WHERE id = $1`, [scope.id]);
        if (found.rowCount === 0) {
          throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${scope.id}`);
        }
      } else {
        await sites.siteOrThrow(scope.id);
      }
      try {
        await transaction(pool, async (client) => {
          const waiting = await client.query<{ email: string }>(
            `SELECT email FROM ${INVITATIONS}
              WHERE scope_kind = $1 AND scope_id = $2 AND ${OPEN} AND expires_at > $3`,
            [scope.kind, scope.id, invitation.createdAt],
          );
          if (waiting.rows.some((row) => row.email === email)) {
            throw new StoreQueryError(
              'INVITATION_EXISTS',
              'An invitation to that address is already waiting there',
            );
          }
          if (waiting.rows.length >= MAX_PENDING_INVITATIONS) {
            throw new StoreQueryError(
              'INVITATION_LIMIT',
              `At most ${MAX_PENDING_INVITATIONS} invitations can be waiting on one team or site`,
            );
          }
          // One to this address that lapsed unused is closed by the new one,
          // which is also what frees the address in the index for the insert.
          await client.query(
            `UPDATE ${INVITATIONS} SET revoked_at = $4, revoked_by = $5
              WHERE scope_kind = $1 AND scope_id = $2 AND email = $3 AND ${OPEN}
                AND expires_at <= $4`,
            [scope.kind, scope.id, email, invitation.createdAt, text(invitation.invitedBy)],
          );
          await client.query(
            `INSERT INTO ${INVITATIONS}
               (id, token_hash, email, scope_kind, scope_id, role, identity, invited_by,
                created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              text(invitation.id),
              text(invitation.tokenHash),
              text(email),
              scope.kind,
              text(scope.id),
              invitation.role,
              invitation.identity,
              text(invitation.invitedBy),
              invitation.createdAt,
              invitation.expiresAt,
            ],
          );
        });
      } catch (error) {
        // The same token or id again, or a second invitation to the address
        // that got in between the look and the insert: the index refused it.
        if (isCode(error, UNIQUE_VIOLATION)) {
          throw new StoreQueryError(
            'INVITATION_EXISTS',
            'An invitation to that address is already waiting there',
          );
        }
        throw error;
      }
    },

    async invitationByHash(tokenHash: string): Promise<InvitationRecord | null> {
      const result = await pool.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM ${INVITATIONS} WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row === undefined ? null : invitationOf(row);
    },

    async invitation(id: string): Promise<InvitationRecord | null> {
      const result = await pool.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM ${INVITATIONS} WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? null : invitationOf(row);
    },

    async openInvitations(scope: AccessScope): Promise<InvitationRecord[]> {
      const result = await pool.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM ${INVITATIONS}
          WHERE scope_kind = $1 AND scope_id = $2 AND ${OPEN}
          ORDER BY created_at, id`,
        [scope.kind, scope.id],
      );
      return result.rows.map(invitationOf);
    },

    async invitationsSentBy(userId: string): Promise<InvitationRecord[]> {
      const result = await pool.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM ${INVITATIONS}
          WHERE invited_by = $1 AND ${OPEN}
          ORDER BY created_at, id`,
        [userId],
      );
      return result.rows.map(invitationOf);
    },

    async revokeInvitation(id: string, at: number, by: string): Promise<boolean> {
      const result = await pool.query(
        `UPDATE ${INVITATIONS} SET revoked_at = $2, revoked_by = $3 WHERE id = $1 AND ${OPEN}`,
        [id, at, text(by)],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async claimInvitation(
      tokenHash: string,
      at: number,
      userId: string,
    ): Promise<InvitationRecord | null> {
      // One statement that finds it open and unexpired and closes it. Whoever's
      // statement this is has the invitation; every other finds no row.
      const result = await pool.query<InvitationRow>(
        `UPDATE ${INVITATIONS} SET accepted_at = $2, accepted_by = $3
          WHERE token_hash = $1 AND ${OPEN} AND expires_at > $2
          RETURNING ${INVITATION_COLUMNS}`,
        [tokenHash, at, text(userId)],
      );
      const row = result.rows[0];
      return row === undefined ? null : invitationOf(row);
    },

    async linkIdentity(identity: StoredIdentity): Promise<void> {
      const known = await pool.query(`SELECT 1 FROM ${USERS} WHERE id = $1`, [identity.userId]);
      if (known.rowCount === 0) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${identity.userId}`);
      }
      const taken = async (): Promise<boolean> => {
        const held = await pool.query(
          `SELECT 1 FROM ${IDENTITIES} WHERE issuer = $1 AND subject = $2`,
          [identity.issuer, identity.subject],
        );
        return (held.rowCount ?? 0) > 0;
      };
      if (await taken()) {
        throw new StoreQueryError('IDENTITY_TAKEN', 'That identity is already linked to an account');
      }
      try {
        await pool.query(
          `INSERT INTO ${IDENTITIES} (issuer, subject, user_id, linked_at) VALUES ($1, $2, $3, $4)`,
          [text(identity.issuer), text(identity.subject), text(identity.userId), identity.linkedAt],
        );
      } catch (error) {
        if (!isCode(error, UNIQUE_VIOLATION)) {
          throw error;
        }
        // One of the two keys refused it. Which one decides what the caller is
        // told: the pair belongs to somebody, or this account already has an
        // identity from that issuer.
        if (await taken()) {
          throw new StoreQueryError(
            'IDENTITY_TAKEN',
            'That identity is already linked to an account',
          );
        }
        throw new StoreQueryError(
          'IDENTITY_EXISTS',
          'That account already has an identity from that issuer',
        );
      }
    },

    async userByIdentity(issuer: string, subject: string): Promise<StoredUser | null> {
      const result = await pool.query<UserRow>(
        `SELECT account.* FROM ${IDENTITIES} link JOIN ${USERS} account ON account.id = link.user_id
          WHERE link.issuer = $1 AND link.subject = $2`,
        [issuer, subject],
      );
      const row = result.rows[0];
      return row === undefined ? null : userOf(row);
    },

    async identitiesForUser(userId: string): Promise<StoredIdentity[]> {
      const result = await pool.query<IdentityRow>(
        `SELECT * FROM ${IDENTITIES} WHERE user_id = $1 ORDER BY issuer`,
        [userId],
      );
      return result.rows.map(identityOf);
    },

    async unlinkIdentity(userId: string, issuer: string): Promise<boolean> {
      const result = await pool.query(
        `DELETE FROM ${IDENTITIES} WHERE user_id = $1 AND issuer = $2`,
        [userId, issuer],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async auditPage(query: AuditPageQuery): Promise<AuditPage> {
      const { sql, params } = auditPageSql(query);
      const result = await pool.query<AuditRow & { seq: number }>(sql, params);
      const rows: AuditEntry[] = result.rows
        .slice(0, query.limit)
        .map((row) => ({ ...auditOf(row), id: String(row.seq) }));
      const last = rows[rows.length - 1];
      return {
        rows,
        next:
          result.rows.length > query.limit && last !== undefined
            ? { ts: last.ts, id: last.id }
            : null,
      };
    },
  };
}
