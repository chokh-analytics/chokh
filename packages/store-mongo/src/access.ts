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
  type AuditRecord,
  type InvitationRecord,
  type Role,
  type Site,
  type SiteMember,
  type StoredIdentity,
  type StoredInvitation,
  type StoredTeam,
  type StoredUser,
  type TeamMember,
  type TeamMemberChange,
} from '@chokh/store';
import { MongoServerError, ObjectId, type Collection, type Db, type Filter } from 'mongodb';

import { AUDIT_LOG, IDENTITIES, INVITATIONS, SITE_MEMBERS, schema } from './schema.js';

// Access on MongoDB (AN-TEAM01; packages/store/src/access.ts has the rules).
//
// MongoDB has no transaction here to lean on (a standalone mongod has none),
// so each rule that has to be true under two writers at once is one write that
// compares and sets: a team's list is written only if nobody else wrote it
// since it was read, an invitation is claimed by the update that finds it
// still open, and what makes an address single on a scope and an identity
// single on an account is a unique index.
//
// Which is why three collections refuse a write until the migration has made
// their unique indexes. Everything Chokh had before this ticket still works on
// a database nobody migrated, as it always has; but an invitation that could
// be issued twice, or an identity that two accounts could hold, is a security
// rule resting on somebody remembering to run a command, so those writes say
// MIGRATION_REQUIRED and name the command instead.

// A team as it sits in MongoDB: the contract's shape and a revision that every
// write of the list adds one to, so a writer can tell that the list it read is
// still the list.
export type TeamDoc = StoredTeam & { rev?: number };

interface InvitationDoc {
  id: string;
  tokenHash: string;
  email: string;
  scopeKind: AccessScope['kind'];
  scopeId: string;
  role: Role;
  identity: boolean;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedBy?: string;
  revokedAt?: number;
  revokedBy?: string;
  // Present, and true, while the invitation is neither accepted nor revoked.
  // A partial index cannot say "this field is absent", so being open is a
  // field of its own that the two unique-while-open indexes filter on, taken
  // off by the write that accepts or revokes.
  open?: true;
}

function recordOf(doc: InvitationDoc): InvitationRecord {
  const record: InvitationRecord = {
    id: doc.id,
    email: doc.email,
    scope: { kind: doc.scopeKind, id: doc.scopeId },
    role: doc.role,
    identity: doc.identity,
    invitedBy: doc.invitedBy,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
  };
  if (doc.acceptedAt !== undefined) record.acceptedAt = doc.acceptedAt;
  if (doc.acceptedBy !== undefined) record.acceptedBy = doc.acceptedBy;
  if (doc.revokedAt !== undefined) record.revokedAt = doc.revokedAt;
  if (doc.revokedBy !== undefined) record.revokedBy = doc.revokedBy;
  return record;
}

type AuditDoc = AuditRecord & { _id: ObjectId };

function entryOf(doc: AuditDoc): AuditEntry {
  const { _id, ...row } = doc;
  return { ...row, id: _id.toHexString() };
}

const OBJECT_ID = /^[0-9a-f]{24}$/;

// How many times a change to a team's list is tried again when somebody else
// wrote the list in between. Each loser of a round reads again and tries
// again, so this is how many writers one team can take at the same instant.
const TEAM_WRITE_ATTEMPTS = 24;

function isDuplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

const NO_ID = { projection: { _id: 0 } } as const;

// One page of the log, as the read the adapter sends: one row more than the
// page, so it knows whether there is another. Exported so a test can ask
// MongoDB how it plans exactly this.
export function auditPageFind(query: AuditPageQuery): {
  filter: Filter<AuditRecord>;
  sort: { ts: -1; _id: -1 };
  limit: number;
} {
  checkAuditPage(query);
  const after = query.after;
  if (after !== undefined && !OBJECT_ID.test(after.id)) {
    throw new StoreQueryError('INVALID_CURSOR', 'That cursor was not written by this store');
  }
  // Every value below is compared as a value: the scope's id, the actor and
  // the target are wrapped in $eq, so an object where a string was expected is
  // compared with the field and never read as an operator.
  const all: Filter<AuditRecord>[] = [
    query.scope.kind === 'site'
      ? { siteId: { $eq: query.scope.id } }
      : { teamId: { $eq: query.scope.id } },
  ];
  if (query.from !== undefined) all.push({ ts: { $gte: query.from } });
  if (query.to !== undefined) all.push({ ts: { $lt: query.to } });
  if (query.actorId !== undefined) all.push({ 'actor.id': { $eq: query.actorId } });
  if (query.actions !== undefined) all.push({ action: { $in: query.actions } });
  if (query.target !== undefined) all.push({ target: { $eq: query.target } });
  if (after !== undefined) {
    // "Before the cursor" is an earlier instant, or the same instant and an
    // earlier id. Said as a ceiling on the instant and then the choice, not as
    // the choice alone: MongoDB takes its index bounds from the ceiling and
    // starts the walk at the cursor, where from the choice alone it starts at
    // the newest row of the log and reads past every page already shown.
    all.push({ ts: { $lte: after.ts } });
    all.push({ $or: [{ ts: { $lt: after.ts } }, { _id: { $lt: new ObjectId(after.id) } }] });
  }
  return { filter: { $and: all }, sort: { ts: -1, _id: -1 }, limit: query.limit + 1 };
}

export interface AccessDeps {
  db: Db;
  users: Collection<StoredUser>;
  teams: Collection<TeamDoc>;
  sites: Collection<Site>;
  siteOrThrow(siteId: string): Promise<Site>;
}

export function createAccess(deps: AccessDeps): AccessStore {
  const { db, users, teams, sites, siteOrThrow } = deps;
  const siteMembers = db.collection<SiteMember>(SITE_MEMBERS);
  const invitations = db.collection<InvitationDoc>(INVITATIONS);
  const identities = db.collection<StoredIdentity>(IDENTITIES);
  const auditLog = db.collection<AuditRecord>(AUDIT_LOG);

  // The collections whose unique indexes have been seen. Asked once and
  // remembered; a refusal is not remembered, so the first write after the
  // migration ran goes through without a restart.
  const migrated = new Set<string>();

  async function requireIndexes(collection: string): Promise<void> {
    if (migrated.has(collection)) {
      return;
    }
    const declared = (schema.find((each) => each.name === collection)?.indexes ?? [])
      .filter((index) => index.unique === true)
      .map((index) => String(index.name));
    let existing: string[] = [];
    try {
      const found = await db.collection(collection).listIndexes().toArray();
      existing = found.map((index) => String(index.name));
    } catch {
      // A collection nobody has created has no indexes, which is the answer.
      existing = [];
    }
    if (declared.length > 0 && declared.every((name) => existing.includes(name))) {
      migrated.add(collection);
      return;
    }
    throw new StoreQueryError(
      'MIGRATION_REQUIRED',
      `The ${collection} collection has not been migrated, so what keeps its rows single does not exist yet. Run: node packages/store-mongo/dist/migrate.js --apply`,
    );
  }

  function openOn(scope: AccessScope): Filter<InvitationDoc> {
    return { scopeKind: scope.kind, scopeId: scope.id, open: true };
  }

  return {
    usersByIds(userIds: string[]): Promise<StoredUser[]> {
      if (userIds.length === 0) {
        return Promise.resolve([]);
      }
      return users
        .find({ id: { $in: userIds } }, NO_ID)
        .sort({ id: 1 })
        .toArray();
    },

    async bumpSessionEpoch(userId: string): Promise<number> {
      const updated = await users.findOneAndUpdate(
        { id: userId },
        { $inc: { sessionEpoch: 1 } },
        { returnDocument: 'after', projection: { _id: 0, sessionEpoch: 1 } },
      );
      if (updated === null) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${userId}`);
      }
      return updated.sessionEpoch ?? 0;
    },

    async changeTeamMember(
      teamId: string,
      userId: string,
      to: TeamMemberChange | null,
    ): Promise<StoredTeam> {
      for (let attempt = 0; attempt < TEAM_WRITE_ATTEMPTS; attempt += 1) {
        const team = await teams.findOne({ id: teamId }, NO_ID);
        if (team === null) {
          throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
        }
        // Which of the owners can sign in with a password. Only the owners
        // matter to the rule, so only they are read.
        const owners = team.members
          .filter((member) => member.role === 'owner')
          .map((member) => member.userId);
        const holders =
          owners.length === 0
            ? []
            : await users
                .find(
                  { id: { $in: owners }, passwordHash: { $exists: true } },
                  { projection: { _id: 0, id: 1 } },
                )
                .toArray();
        const members: TeamMember[] = changedMembers(
          team.members,
          userId,
          to,
          new Set(holders.map((holder) => holder.id)),
        );
        // Written only if the list is still the one the rule was checked
        // against. Somebody else's write in between moved the revision, and
        // this round is read and judged again.
        const written = await teams.updateOne(
          { id: teamId, rev: team.rev === undefined ? { $exists: false } : team.rev },
          { $set: { members }, $inc: { rev: 1 } },
        );
        if (written.matchedCount === 1) {
          return { id: team.id, name: team.name, members };
        }
      }
      throw new StoreQueryError(
        'TEAM_BUSY',
        'That team was being changed by too many others at once, try again',
      );
    },

    async renameTeam(teamId: string, name: string): Promise<StoredTeam> {
      const updated = await teams.findOneAndUpdate(
        { id: teamId },
        { $set: { name } },
        { returnDocument: 'after', projection: { _id: 0, rev: 0 } },
      );
      if (updated === null) {
        throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
      }
      return { id: updated.id, name: updated.name, members: updated.members };
    },

    async deleteTeam(teamId: string): Promise<void> {
      if (teamId === DEFAULT_TEAM_ID) {
        throw new StoreQueryError('DEFAULT_TEAM', 'The default team is never deleted');
      }
      if ((await teams.countDocuments({ id: teamId }, { limit: 1 })) === 0) {
        throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
      }
      if ((await sites.countDocuments({ teamId }, { limit: 1 })) > 0) {
        throw new StoreQueryError('TEAM_HAS_SITES', 'That team still holds a site');
      }
      // Its invitations first: stopped between the two, what is left is a team
      // with nothing waiting on it, never an invitation to a team that is gone.
      await invitations.deleteMany({ scopeKind: 'team', scopeId: teamId });
      await teams.deleteOne({ id: teamId });
    },

    siteMembers(siteId: string): Promise<SiteMember[]> {
      return siteMembers.find({ siteId }, NO_ID).sort({ userId: 1 }).toArray();
    },

    siteGrantsForUser(userId: string): Promise<SiteMember[]> {
      return siteMembers.find({ userId }, NO_ID).sort({ siteId: 1 }).toArray();
    },

    async setSiteMember(member: SiteMember): Promise<void> {
      await requireIndexes(SITE_MEMBERS);
      await siteOrThrow(member.siteId);
      const write = (): Promise<unknown> =>
        siteMembers.updateOne(
          { siteId: member.siteId, userId: member.userId },
          { $set: { role: member.role, identity: member.identity } },
          { upsert: true },
        );
      try {
        await write();
      } catch (error) {
        // Two upserts of one new row at once: the index lets one insert and
        // refuses the other, which then finds the row and updates it.
        if (!isDuplicate(error)) {
          throw error;
        }
        await write();
      }
    },

    async removeSiteMember(siteId: string, userId: string): Promise<boolean> {
      const result = await siteMembers.deleteOne({ siteId, userId });
      return result.deletedCount > 0;
    },

    async createInvitation(invitation: StoredInvitation): Promise<void> {
      checkInvitation(invitation);
      await requireIndexes(INVITATIONS);
      const email = invitation.email.toLowerCase();
      const scope = invitation.scope;
      if (scope.kind === 'team') {
        if ((await teams.countDocuments({ id: scope.id }, { limit: 1 })) === 0) {
          throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${scope.id}`);
        }
      } else {
        await siteOrThrow(scope.id);
      }
      const waiting: Filter<InvitationDoc> = {
        ...openOn(scope),
        expiresAt: { $gt: invitation.createdAt },
      };
      if ((await invitations.countDocuments({ ...waiting, email }, { limit: 1 })) > 0) {
        throw new StoreQueryError(
          'INVITATION_EXISTS',
          'An invitation to that address is already waiting there',
        );
      }
      if ((await invitations.countDocuments(waiting)) >= MAX_PENDING_INVITATIONS) {
        throw new StoreQueryError(
          'INVITATION_LIMIT',
          `At most ${MAX_PENDING_INVITATIONS} invitations can be waiting on one team or site`,
        );
      }
      // One to this address that lapsed unused is closed by the new one, which
      // is also what frees the address in the index for the insert below.
      await invitations.updateMany(
        { ...openOn(scope), email, expiresAt: { $lte: invitation.createdAt } },
        {
          $set: { revokedAt: invitation.createdAt, revokedBy: invitation.invitedBy },
          $unset: { open: '' },
        },
      );
      try {
        await invitations.insertOne({
          id: invitation.id,
          tokenHash: invitation.tokenHash,
          email,
          scopeKind: scope.kind,
          scopeId: scope.id,
          role: invitation.role,
          identity: invitation.identity,
          invitedBy: invitation.invitedBy,
          createdAt: invitation.createdAt,
          expiresAt: invitation.expiresAt,
          open: true,
        });
      } catch (error) {
        // The same token or id again, or a second invitation to the address
        // that got in between the look above and this insert.
        if (isDuplicate(error)) {
          throw new StoreQueryError(
            'INVITATION_EXISTS',
            'An invitation to that address is already waiting there',
          );
        }
        throw error;
      }
    },

    async invitationByHash(tokenHash: string): Promise<InvitationRecord | null> {
      const doc = await invitations.findOne({ tokenHash }, NO_ID);
      return doc === null ? null : recordOf(doc);
    },

    async invitation(id: string): Promise<InvitationRecord | null> {
      const doc = await invitations.findOne({ id }, NO_ID);
      return doc === null ? null : recordOf(doc);
    },

    async openInvitations(scope: AccessScope): Promise<InvitationRecord[]> {
      const docs = await invitations.find(openOn(scope), NO_ID).sort({ createdAt: 1, id: 1 }).toArray();
      return docs.map(recordOf);
    },

    async invitationsSentBy(userId: string): Promise<InvitationRecord[]> {
      const docs = await invitations
        .find({ invitedBy: userId, open: true }, NO_ID)
        .sort({ createdAt: 1, id: 1 })
        .toArray();
      return docs.map(recordOf);
    },

    async revokeInvitation(id: string, at: number, by: string): Promise<boolean> {
      const result = await invitations.updateOne(
        { id, open: true },
        { $set: { revokedAt: at, revokedBy: by }, $unset: { open: '' } },
      );
      return result.modifiedCount === 1;
    },

    async claimInvitation(
      tokenHash: string,
      at: number,
      userId: string,
    ): Promise<InvitationRecord | null> {
      // One write that finds it open and unexpired and closes it. Whoever's
      // write this is has the invitation; every other finds nothing.
      const doc = await invitations.findOneAndUpdate(
        { tokenHash, open: true, expiresAt: { $gt: at } },
        { $set: { acceptedAt: at, acceptedBy: userId }, $unset: { open: '' } },
        { returnDocument: 'after', projection: { _id: 0 } },
      );
      return doc === null ? null : recordOf(doc);
    },

    async linkIdentity(identity: StoredIdentity): Promise<void> {
      await requireIndexes(IDENTITIES);
      if ((await users.countDocuments({ id: identity.userId }, { limit: 1 })) === 0) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${identity.userId}`);
      }
      const taken = (): Promise<number> =>
        identities.countDocuments(
          { issuer: identity.issuer, subject: identity.subject },
          { limit: 1 },
        );
      if ((await taken()) > 0) {
        throw new StoreQueryError('IDENTITY_TAKEN', 'That identity is already linked to an account');
      }
      try {
        await identities.insertOne({
          issuer: identity.issuer,
          subject: identity.subject,
          userId: identity.userId,
          linkedAt: identity.linkedAt,
        });
      } catch (error) {
        if (!isDuplicate(error)) {
          throw error;
        }
        // One of the two unique indexes refused it. Which one decides what the
        // caller is told: the pair belongs to somebody, or this account
        // already has an identity from that issuer.
        if ((await taken()) > 0) {
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
      const link = await identities.findOne({ issuer, subject }, NO_ID);
      return link === null ? null : users.findOne({ id: link.userId }, NO_ID);
    },

    identitiesForUser(userId: string): Promise<StoredIdentity[]> {
      return identities.find({ userId }, NO_ID).sort({ issuer: 1 }).toArray();
    },

    async unlinkIdentity(userId: string, issuer: string): Promise<boolean> {
      const result = await identities.deleteOne({ userId, issuer });
      return result.deletedCount > 0;
    },

    async auditPage(query: AuditPageQuery): Promise<AuditPage> {
      const read = auditPageFind(query);
      const docs = (await auditLog
        .find(read.filter)
        .sort(read.sort)
        .limit(read.limit)
        .toArray()) as AuditDoc[];
      const rows = docs.slice(0, query.limit).map(entryOf);
      const last = rows[rows.length - 1];
      return {
        rows,
        next: docs.length > query.limit && last !== undefined ? { ts: last.ts, id: last.id } : null,
      };
    },
  };
}
