import {
  MAX_ALERTS_PER_SITE,
  MAX_ALERT_RECENT,
  MAX_ANNOTATIONS_PER_SITE,
  MAX_FUNNELS_PER_SITE,
  MAX_GOALS_PER_SITE,
  MAX_SEGMENTS_PER_SITE,
  StoreQueryError,
  checkAuditRow,
  type AccessStore,
  type AccountStore,
  type Alert,
  type AlertChannel,
  type AlertCondition,
  type AlertFiring,
  type AlertState,
  type Annotation,
  type AnnotationKind,
  type ApiKeyRecord,
  type AuditRecord,
  type Digest,
  type DigestCadence,
  type DigestSend,
  type Filter,
  type Funnel,
  type FunnelStep,
  type FunnelWindow,
  type Goal,
  type GoalKind,
  type Scope,
  type Segment,
  type StoredApiKey,
  type StoredTeam,
  type StoredUser,
  type TeamMember,
  type UserPatch,
} from '@chokh/store';
import type { Pool } from 'pg';

import { UNIQUE_VIOLATION, isCode, json, text, textArray } from './db.js';
import {
  ALERTS,
  ANNOTATIONS,
  API_KEYS,
  AUDIT_LOG,
  DIGESTS,
  FUNNELS,
  GOALS,
  SEGMENTS,
  TEAMS,
  USERS,
} from './schema.js';
import type { Sites } from './sites.js';

// The control plane: accounts, teams, keys, the audit log and the site scoped
// configuration. Everything here is small and read by its key, so there is no
// plan to prove; what matters is that each refusal is the one the other
// adapters give, and that the claims are one statement.

// The site scoped half of AccountStore: everything but the sites themselves,
// which sites.ts owns because the reporting side reads them too.
//
// Nor the access half (site members, invitations, identities, the guarded
// team changes and the paged log), which access.ts owns with its reasons.
export type Accounts = Omit<
  AccountStore,
  'createSite' | 'updateSite' | 'siteByShareToken' | keyof AccessStore
>;

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  created_at: number;
  last_login_at: number | null;
  session_epoch: number | null;
}

export function userOf(row: UserRow): StoredUser {
  const user: StoredUser = { id: row.id, email: row.email, createdAt: row.created_at };
  if (row.name !== null) user.name = row.name;
  if (row.password_hash !== null) user.passwordHash = row.password_hash;
  if (row.last_login_at !== null) user.lastLoginAt = row.last_login_at;
  if (row.session_epoch !== null) user.sessionEpoch = row.session_epoch;
  return user;
}

export interface TeamRow {
  id: string;
  name: string;
  members: TeamMember[];
}

export function teamOf(row: TeamRow): StoredTeam {
  return { id: row.id, name: row.name, members: row.members };
}

interface ApiKeyRow {
  key_hash?: string;
  id: string;
  site_id: string;
  name: string;
  scopes: Scope[];
  created_at: number;
  created_by: string;
}

function apiKeyRecordOf(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

interface GoalRow {
  site_id: string;
  id: string;
  name: string;
  kind: GoalKind;
  match: string;
  value: number | null;
  created_by: string;
  created_at: number;
}

function goalOf(row: GoalRow): Goal {
  const goal: Goal = {
    siteId: row.site_id,
    id: row.id,
    name: row.name,
    kind: row.kind,
    match: row.match,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (row.value !== null) goal.value = row.value;
  return goal;
}

interface FunnelRow {
  site_id: string;
  id: string;
  name: string;
  steps: FunnelStep[];
  funnel_window: FunnelWindow;
  created_by: string;
  created_at: number;
}

function funnelOf(row: FunnelRow): Funnel {
  return {
    siteId: row.site_id,
    id: row.id,
    name: row.name,
    steps: row.steps,
    window: row.funnel_window,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface SegmentRow {
  site_id: string;
  id: string;
  name: string;
  filters: Filter[];
  created_by: string;
  created_at: number;
}

function segmentOf(row: SegmentRow): Segment {
  return {
    siteId: row.site_id,
    id: row.id,
    name: row.name,
    filters: row.filters,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface AnnotationRow {
  site_id: string;
  id: string;
  at: number;
  kind: AnnotationKind;
  note: string;
  url: string | null;
  created_by: string;
  created_at: number;
}

function annotationOf(row: AnnotationRow): Annotation {
  const annotation: Annotation = {
    siteId: row.site_id,
    id: row.id,
    at: row.at,
    kind: row.kind,
    text: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (row.url !== null) annotation.url = row.url;
  return annotation;
}

interface AlertRow {
  site_id: string;
  id: string;
  name: string;
  condition: AlertCondition;
  channels: AlertChannel[];
  created_by: string;
  created_at: number;
  firing: boolean;
  since: number | null;
  checked_bucket: number | null;
  recent: AlertFiring[];
}

function alertOf(row: AlertRow): Alert {
  const state: AlertState = { firing: row.firing };
  if (row.since !== null) state.since = row.since;
  if (row.checked_bucket !== null) state.checkedBucket = row.checked_bucket;
  return {
    siteId: row.site_id,
    id: row.id,
    name: row.name,
    condition: row.condition,
    channels: row.channels,
    createdBy: row.created_by,
    createdAt: row.created_at,
    state,
    recent: row.recent,
  };
}

interface DigestRow {
  site_id: string;
  id: string;
  cadence: DigestCadence;
  recipients: string[];
  hour: number;
  weekday: number | null;
  created_by: string;
  created_at: number;
  last_period: string | null;
  last: DigestSend | null;
}

function digestOf(row: DigestRow): Digest {
  const digest: Digest = {
    siteId: row.site_id,
    id: row.id,
    cadence: row.cadence,
    to: row.recipients,
    hour: row.hour,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (row.weekday !== null) digest.weekday = row.weekday;
  if (row.last_period !== null) digest.lastPeriod = row.last_period;
  if (row.last !== null) digest.last = row.last;
  return digest;
}

export interface AuditRow {
  site_id: string | null;
  team_id: string | null;
  ts: number;
  actor: AuditRecord['actor'];
  action: string;
  route: string;
  target: string | null;
  fields: string[];
}

export function auditOf(row: AuditRow): AuditRecord {
  const record: AuditRecord = {
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    route: row.route,
    fields: row.fields,
  };
  if (row.site_id !== null) record.siteId = row.site_id;
  if (row.team_id !== null) record.teamId = row.team_id;
  if (row.target !== null) record.target = row.target;
  return record;
}

// By name, then by age, so two rows of one name keep an order: the sort the
// other adapters give a list a person reads.
function byName<Row extends { name: string; createdAt: number }>(rows: Row[]): Row[] {
  return rows.sort(
    (left, right) => left.name.localeCompare(right.name) || left.createdAt - right.createdAt,
  );
}

export function createAccounts(pool: Pool, sites: Sites): Accounts {
  async function count(table: string, siteId: string): Promise<number> {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*) AS n FROM ${table} WHERE site_id = $1`,
      [siteId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function remove(table: string, siteId: string, id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM ${table} WHERE site_id = $1 AND id = $2`, [
      siteId,
      id,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  // Insert a row whose id is derived from what it asks. The primary key is
  // what refuses the same question twice, so there is no read before the write
  // for two requests to race past.
  async function insertOnce(
    sql: string,
    params: unknown[],
    exists: { code: string; message: string },
  ): Promise<void> {
    try {
      await pool.query(sql, params);
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new StoreQueryError(exists.code, exists.message);
      }
      throw error;
    }
  }

  return {
    async createUser(user: StoredUser): Promise<void> {
      // Lowercased here, because one address is one address however it was
      // typed and the unique index would otherwise hold both.
      const email = user.email.toLowerCase();
      const created = await pool.query(
        `INSERT INTO ${USERS} (id, email, name, password_hash, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO NOTHING`,
        [
          text(user.id),
          text(email),
          text(user.name),
          text(user.passwordHash),
          user.createdAt,
          user.lastLoginAt ?? null,
        ],
      );
      if (created.rowCount === 0) {
        throw new StoreQueryError('EMAIL_EXISTS', 'An account already uses that address');
      }
    },

    async updateUser(userId: string, patch: UserPatch): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [userId];
      const set = (name: string, value: unknown): void => {
        params.push(value);
        sets.push(`${name} = $${params.length}`);
      };
      if (patch.name !== undefined) set('name', text(patch.name));
      if (patch.passwordHash !== undefined) set('password_hash', text(patch.passwordHash));
      if (patch.lastLoginAt !== undefined) set('last_login_at', patch.lastLoginAt);
      if (sets.length === 0) {
        return;
      }
      const result = await pool.query(
        `UPDATE ${USERS} SET ${sets.join(', ')} WHERE id = $1`,
        params,
      );
      if (result.rowCount === 0) {
        throw new StoreQueryError('UNKNOWN_USER', `No account answers to ${userId}`);
      }
    },

    async userById(userId: string): Promise<StoredUser | null> {
      const result = await pool.query<UserRow>(`SELECT * FROM ${USERS} WHERE id = $1`, [userId]);
      const row = result.rows[0];
      return row === undefined ? null : userOf(row);
    },

    async userByEmail(email: string): Promise<StoredUser | null> {
      const result = await pool.query<UserRow>(`SELECT * FROM ${USERS} WHERE email = $1`, [
        email.toLowerCase(),
      ]);
      const row = result.rows[0];
      return row === undefined ? null : userOf(row);
    },

    async userCount(): Promise<number> {
      const result = await pool.query<{ n: number }>(`SELECT count(*) AS n FROM ${USERS}`);
      return result.rows[0]?.n ?? 0;
    },

    async createTeam(team: StoredTeam): Promise<void> {
      const created = await pool.query(
        `INSERT INTO ${TEAMS} (id, name, members) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [text(team.id), text(team.name), json(team.members)],
      );
      if (created.rowCount === 0) {
        throw new StoreQueryError('TEAM_EXISTS', `A team already answers to ${team.id}`);
      }
    },

    async team(teamId: string): Promise<StoredTeam | null> {
      const result = await pool.query<TeamRow>(`SELECT * FROM ${TEAMS} WHERE id = $1`, [teamId]);
      const row = result.rows[0];
      return row === undefined ? null : teamOf(row);
    },

    async teamsForUser(userId: string): Promise<StoredTeam[]> {
      // Containment, which the GIN index on members answers: the teams whose
      // list holds a member with this userId.
      const result = await pool.query<TeamRow>(
        `SELECT * FROM ${TEAMS} WHERE members @> $1::jsonb ORDER BY id`,
        [json([{ userId }])],
      );
      return result.rows.map(teamOf);
    },

    async setTeamMember(teamId: string, member: TeamMember): Promise<StoredTeam> {
      // One statement: the member taken out of the list if they were in it and
      // put at its end, so two changes to one team cannot lose each other the
      // way a read and a write would.
      const result = await pool.query<TeamRow>(
        `UPDATE ${TEAMS}
            SET members = (
                  SELECT coalesce(jsonb_agg(each.member ORDER BY each.position), '[]'::jsonb)
                    FROM jsonb_array_elements(members) WITH ORDINALITY AS each(member, position)
                   WHERE each.member ->> 'userId' <> $2
                ) || $3::jsonb
          WHERE id = $1
          RETURNING *`,
        [teamId, member.userId, json([{ ...member }])],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new StoreQueryError('UNKNOWN_TEAM', `No team answers to ${teamId}`);
      }
      return teamOf(row);
    },

    async createApiKey(key: StoredApiKey): Promise<void> {
      const created = await pool.query(
        `INSERT INTO ${API_KEYS} (key_hash, id, site_id, name, scopes, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
         ON CONFLICT (key_hash) DO NOTHING`,
        [
          text(key.keyHash),
          text(key.id),
          text(key.siteId),
          text(key.name),
          textArray(key.scopes),
          key.createdAt,
          text(key.createdBy),
        ],
      );
      if (created.rowCount === 0) {
        throw new StoreQueryError('KEY_EXISTS', 'That key already exists');
      }
    },

    async apiKeyByHash(keyHash: string): Promise<StoredApiKey | null> {
      const result = await pool.query<ApiKeyRow & { key_hash: string }>(
        `SELECT * FROM ${API_KEYS} WHERE key_hash = $1`,
        [keyHash],
      );
      const row = result.rows[0];
      return row === undefined ? null : { ...apiKeyRecordOf(row), keyHash: row.key_hash };
    },

    async apiKeys(siteId: string): Promise<ApiKeyRecord[]> {
      // A hash is still a secret, so a list of keys is not a list of them: the
      // column is never selected.
      const result = await pool.query<ApiKeyRow>(
        `SELECT id, site_id, name, scopes, created_at, created_by
           FROM ${API_KEYS} WHERE site_id = $1 ORDER BY created_at, id`,
        [siteId],
      );
      return result.rows.map(apiKeyRecordOf);
    },

    async deleteApiKey(siteId: string, keyId: string): Promise<boolean> {
      return remove(API_KEYS, siteId, keyId);
    },

    async goals(siteId: string): Promise<Goal[]> {
      const result = await pool.query<GoalRow>(`SELECT * FROM ${GOALS} WHERE site_id = $1`, [
        siteId,
      ]);
      return result.rows.map(goalOf).sort((left, right) => left.createdAt - right.createdAt);
    },

    async goal(siteId: string, goalId: string): Promise<Goal | null> {
      const result = await pool.query<GoalRow>(
        `SELECT * FROM ${GOALS} WHERE site_id = $1 AND id = $2`,
        [siteId, goalId],
      );
      const row = result.rows[0];
      return row === undefined ? null : goalOf(row);
    },

    async createGoal(goal: Goal): Promise<void> {
      await sites.siteOrThrow(goal.siteId);
      if ((await count(GOALS, goal.siteId)) >= MAX_GOALS_PER_SITE) {
        throw new StoreQueryError('GOAL_LIMIT', `A site can have at most ${MAX_GOALS_PER_SITE} goals`);
      }
      await insertOnce(
        `INSERT INTO ${GOALS} (site_id, id, name, kind, match, value, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          text(goal.siteId),
          text(goal.id),
          text(goal.name),
          goal.kind,
          text(goal.match),
          goal.value ?? null,
          text(goal.createdBy),
          goal.createdAt,
        ],
        { code: 'GOAL_EXISTS', message: 'A goal already asks that question' },
      );
    },

    async deleteGoal(siteId: string, goalId: string): Promise<boolean> {
      return remove(GOALS, siteId, goalId);
    },

    async funnels(siteId: string): Promise<Funnel[]> {
      const result = await pool.query<FunnelRow>(`SELECT * FROM ${FUNNELS} WHERE site_id = $1`, [
        siteId,
      ]);
      return result.rows.map(funnelOf).sort((left, right) => left.createdAt - right.createdAt);
    },

    async funnel(siteId: string, funnelId: string): Promise<Funnel | null> {
      const result = await pool.query<FunnelRow>(
        `SELECT * FROM ${FUNNELS} WHERE site_id = $1 AND id = $2`,
        [siteId, funnelId],
      );
      const row = result.rows[0];
      return row === undefined ? null : funnelOf(row);
    },

    async createFunnel(funnel: Funnel): Promise<void> {
      await sites.siteOrThrow(funnel.siteId);
      const exists = { code: 'FUNNEL_EXISTS', message: 'A funnel already asks that question' };
      if ((await count(FUNNELS, funnel.siteId)) >= MAX_FUNNELS_PER_SITE) {
        // A full site asked for a funnel it already has is told it has it, the
        // answer every adapter gives: which refusal a caller reads must not
        // depend on the adapter. Only a full site pays for this read.
        const asked = await pool.query(
          `SELECT 1 FROM ${FUNNELS} WHERE site_id = $1 AND id = $2`,
          [funnel.siteId, funnel.id],
        );
        if ((asked.rowCount ?? 0) > 0) {
          throw new StoreQueryError(exists.code, exists.message);
        }
        throw new StoreQueryError(
          'FUNNEL_LIMIT',
          `A site can have at most ${MAX_FUNNELS_PER_SITE} funnels`,
        );
      }
      await insertOnce(
        `INSERT INTO ${FUNNELS} (site_id, id, name, steps, funnel_window, created_by, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          text(funnel.siteId),
          text(funnel.id),
          text(funnel.name),
          json(funnel.steps),
          funnel.window,
          text(funnel.createdBy),
          funnel.createdAt,
        ],
        exists,
      );
    },

    async deleteFunnel(siteId: string, funnelId: string): Promise<boolean> {
      return remove(FUNNELS, siteId, funnelId);
    },

    async segments(siteId: string): Promise<Segment[]> {
      const result = await pool.query<SegmentRow>(
        `SELECT * FROM ${SEGMENTS} WHERE site_id = $1`,
        [siteId],
      );
      return byName(result.rows.map(segmentOf));
    },

    async segment(siteId: string, segmentId: string): Promise<Segment | null> {
      const result = await pool.query<SegmentRow>(
        `SELECT * FROM ${SEGMENTS} WHERE site_id = $1 AND id = $2`,
        [siteId, segmentId],
      );
      const row = result.rows[0];
      return row === undefined ? null : segmentOf(row);
    },

    async createSegment(segment: Segment): Promise<void> {
      await sites.siteOrThrow(segment.siteId);
      if ((await count(SEGMENTS, segment.siteId)) >= MAX_SEGMENTS_PER_SITE) {
        throw new StoreQueryError(
          'SEGMENT_LIMIT',
          `A site can have at most ${MAX_SEGMENTS_PER_SITE} segments`,
        );
      }
      await insertOnce(
        `INSERT INTO ${SEGMENTS} (site_id, id, name, filters, created_by, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          text(segment.siteId),
          text(segment.id),
          text(segment.name),
          json(segment.filters),
          text(segment.createdBy),
          segment.createdAt,
        ],
        { code: 'SEGMENT_EXISTS', message: 'A segment already saves those filters' },
      );
    },

    async deleteSegment(siteId: string, segmentId: string): Promise<boolean> {
      return remove(SEGMENTS, siteId, segmentId);
    },

    async annotations(siteId: string, from: number, to: number): Promise<Annotation[]> {
      // The primary key answers the site by its prefix and the instant is
      // filtered from there: a site holds at most a thousand, which is fewer
      // rows than an index of its own would be worth.
      const result = await pool.query<AnnotationRow>(
        `SELECT * FROM ${ANNOTATIONS} WHERE site_id = $1 AND at >= $2 AND at < $3`,
        [siteId, from, to],
      );
      return result.rows
        .map(annotationOf)
        .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
    },

    async annotation(siteId: string, annotationId: string): Promise<Annotation | null> {
      const result = await pool.query<AnnotationRow>(
        `SELECT * FROM ${ANNOTATIONS} WHERE site_id = $1 AND id = $2`,
        [siteId, annotationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : annotationOf(row);
    },

    async createAnnotation(annotation: Annotation): Promise<void> {
      await sites.siteOrThrow(annotation.siteId);
      if ((await count(ANNOTATIONS, annotation.siteId)) >= MAX_ANNOTATIONS_PER_SITE) {
        throw new StoreQueryError(
          'ANNOTATION_LIMIT',
          `A site can have at most ${MAX_ANNOTATIONS_PER_SITE} annotations`,
        );
      }
      await insertOnce(
        `INSERT INTO ${ANNOTATIONS} (site_id, id, at, kind, note, url, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          text(annotation.siteId),
          text(annotation.id),
          annotation.at,
          annotation.kind,
          text(annotation.text),
          text(annotation.url),
          text(annotation.createdBy),
          annotation.createdAt,
        ],
        { code: 'ANNOTATION_EXISTS', message: 'That annotation is already there' },
      );
    },

    async deleteAnnotation(siteId: string, annotationId: string): Promise<boolean> {
      return remove(ANNOTATIONS, siteId, annotationId);
    },

    async alerts(siteId: string): Promise<Alert[]> {
      const result = await pool.query<AlertRow>(`SELECT * FROM ${ALERTS} WHERE site_id = $1`, [
        siteId,
      ]);
      return byName(result.rows.map(alertOf));
    },

    async alert(siteId: string, alertId: string): Promise<Alert | null> {
      const result = await pool.query<AlertRow>(
        `SELECT * FROM ${ALERTS} WHERE site_id = $1 AND id = $2`,
        [siteId, alertId],
      );
      const row = result.rows[0];
      return row === undefined ? null : alertOf(row);
    },

    async createAlert(alert: Alert): Promise<void> {
      await sites.siteOrThrow(alert.siteId);
      if ((await count(ALERTS, alert.siteId)) >= MAX_ALERTS_PER_SITE) {
        throw new StoreQueryError('ALERT_LIMIT', `A site can have at most ${MAX_ALERTS_PER_SITE} alerts`);
      }
      await insertOnce(
        `INSERT INTO ${ALERTS}
           (site_id, id, name, condition, channels, created_by, created_at,
            firing, since, checked_bucket, recent)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          text(alert.siteId),
          text(alert.id),
          text(alert.name),
          json(alert.condition),
          json(alert.channels),
          text(alert.createdBy),
          alert.createdAt,
          alert.state.firing,
          alert.state.since ?? null,
          alert.state.checkedBucket ?? null,
          json(alert.recent),
        ],
        { code: 'ALERT_EXISTS', message: 'An alert already asks that' },
      );
    },

    async deleteAlert(siteId: string, alertId: string): Promise<boolean> {
      return remove(ALERTS, siteId, alertId);
    },

    async claimAlertCheck(siteId: string, alertId: string, bucket: number): Promise<boolean> {
      // Compared and set in one statement, which is what makes the claim hold
      // between two processes: the second waits on the row, reads what the
      // first wrote and no longer matches.
      const result = await pool.query(
        `UPDATE ${ALERTS} SET checked_bucket = $3
          WHERE site_id = $1 AND id = $2 AND (checked_bucket IS NULL OR checked_bucket < $3)`,
        [siteId, alertId, bucket],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async recordAlertState(
      siteId: string,
      alertId: string,
      state: Pick<AlertState, 'firing' | 'since'>,
      firing?: AlertFiring,
    ): Promise<boolean> {
      // The transition, when there is one, goes on the end of the list and the
      // list keeps its newest MAX_ALERT_RECENT, in one statement. The claimed
      // bucket is not named, so it is left as it is.
      const result = await pool.query(
        `UPDATE ${ALERTS}
            SET firing = $3,
                since = $4,
                recent = CASE WHEN $5::jsonb IS NULL THEN recent ELSE (
                  SELECT coalesce(jsonb_agg(kept.entry ORDER BY kept.position), '[]'::jsonb)
                    FROM (
                      SELECT each.entry, each.position
                        FROM jsonb_array_elements(recent || $5::jsonb)
                             WITH ORDINALITY AS each(entry, position)
                       ORDER BY each.position DESC
                       LIMIT ${MAX_ALERT_RECENT}
                    ) kept
                ) END
          WHERE site_id = $1 AND id = $2`,
        [siteId, alertId, state.firing, state.since ?? null, firing === undefined ? null : json([firing])],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async digests(siteId: string): Promise<Digest[]> {
      const result = await pool.query<DigestRow>(`SELECT * FROM ${DIGESTS} WHERE site_id = $1`, [
        siteId,
      ]);
      return result.rows
        .map(digestOf)
        .sort((left, right) => left.cadence.localeCompare(right.cadence));
    },

    async digest(siteId: string, digestId: string): Promise<Digest | null> {
      const result = await pool.query<DigestRow>(
        `SELECT * FROM ${DIGESTS} WHERE site_id = $1 AND id = $2`,
        [siteId, digestId],
      );
      const row = result.rows[0];
      return row === undefined ? null : digestOf(row);
    },

    async createDigest(digest: Digest): Promise<void> {
      await sites.siteOrThrow(digest.siteId);
      await insertOnce(
        `INSERT INTO ${DIGESTS}
           (site_id, id, cadence, recipients, hour, weekday, created_by, created_at, last_period, last)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          text(digest.siteId),
          text(digest.id),
          digest.cadence,
          textArray(digest.to),
          digest.hour,
          digest.weekday ?? null,
          text(digest.createdBy),
          digest.createdAt,
          text(digest.lastPeriod),
          json(digest.last),
        ],
        { code: 'DIGEST_EXISTS', message: 'A digest of that cadence already exists' },
      );
    },

    async deleteDigest(siteId: string, digestId: string): Promise<boolean> {
      return remove(DIGESTS, siteId, digestId);
    },

    async claimDigestSend(siteId: string, digestId: string, period: string): Promise<boolean> {
      // The same claim as an alert's bucket. A period is a string that sorts
      // by bytes in the order it happened, which is how the column compares.
      const result = await pool.query(
        `UPDATE ${DIGESTS} SET last_period = $3
          WHERE site_id = $1 AND id = $2 AND (last_period IS NULL OR last_period < $3)`,
        [siteId, digestId, period],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async recordDigestSend(siteId: string, digestId: string, send: DigestSend): Promise<boolean> {
      const result = await pool.query(
        `UPDATE ${DIGESTS} SET last = $3::jsonb WHERE site_id = $1 AND id = $2`,
        [siteId, digestId, json(send)],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async audit(row: AuditRecord): Promise<void> {
      checkAuditRow(row);
      await pool.query(
        `INSERT INTO ${AUDIT_LOG} (site_id, team_id, ts, actor, action, route, target, fields)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::text[])`,
        [
          text(row.siteId),
          text(row.teamId),
          row.ts,
          json(row.actor),
          text(row.action),
          text(row.route),
          text(row.target),
          textArray(row.fields),
        ],
      );
    },

    async auditTrail(siteId: string, from: number, to: number): Promise<AuditRecord[]> {
      const result = await pool.query<AuditRow>(
        `SELECT site_id, team_id, ts, actor, action, route, target, fields
           FROM ${AUDIT_LOG}
          WHERE site_id = $1 AND ts >= $2 AND ts < $3
          ORDER BY ts, seq`,
        [siteId, from, to],
      );
      return result.rows.map(auditOf);
    },
  };
}
