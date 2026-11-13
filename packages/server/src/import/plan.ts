import { dayKey, importDecision, type ImportRefusedDay, type ImportRow } from '../store/AnalyticsStore.js';

// What a run would do, day by day, before anything is written: new, changed,
// unchanged, or refused and why. The store applies the same rule again when it
// writes, so this is the advice and the write is the authority; the two only
// differ if somebody else writes between them.

export type DayStatus = 'new' | 'changed' | 'unchanged' | 'refused';

export interface DayPlan {
  date: string;
  status: DayStatus;
  rows: number;
  refusal?: ImportRefusedDay;
}

export interface ImportPlan {
  days: DayPlan[];
  // The rows of the new and changed days: what --apply writes.
  toWrite: ImportRow[];
}

function fingerprint(rows: readonly ImportRow[]): string {
  return rows
    .map((row) => [row.dim, row.key, row.visitors, row.pageviews, row.visits, row.bounces, row.durationSum].join('\u0000'))
    .sort()
    .join('\n');
}

function byDay(rows: readonly ImportRow[]): Map<string, ImportRow[]> {
  const days = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const list = days.get(row.date) ?? [];
    list.push(row);
    days.set(row.date, list);
  }
  return days;
}

export interface PlanInput {
  importId: string;
  incoming: readonly ImportRow[];
  // This import's rows as the store holds them now.
  existing: readonly ImportRow[];
  // The days other imports hold, and by whom.
  heldByOthers: ReadonlyMap<string, string>;
  ownFrom: string | null;
  now: number;
  timezone: string;
}

export function planImport(input: PlanInput): ImportPlan {
  const today = dayKey(input.now, input.timezone);
  const incoming = byDay(input.incoming);
  const existing = byDay(input.existing);
  const days: DayPlan[] = [];
  const toWrite: ImportRow[] = [];
  for (const date of [...incoming.keys()].sort()) {
    const rows = incoming.get(date) ?? [];
    const refusal = importDecision(input.importId, date, input.ownFrom, today, input.heldByOthers.get(date));
    if (refusal !== undefined) {
      days.push({ date, status: 'refused', rows: rows.length, refusal });
      continue;
    }
    const held = existing.get(date);
    const status: DayStatus =
      held === undefined ? 'new' : fingerprint(held) === fingerprint(rows) ? 'unchanged' : 'changed';
    days.push({ date, status, rows: rows.length });
    if (status !== 'unchanged') toWrite.push(...rows);
  }
  return { days, toWrite };
}
