import { useMemo, useState, type FormEvent, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MAX_GOALS_PER_SITE, type Conversion, type Goal, type GoalKind } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { api } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { formatCount, formatExact, formatRate, formatValue } from '../lib/format.js';
import { goalsKey, useEvents, useGoalStats } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { ReportPage } from '../reports/ReportPage.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { ErrorState, Skeleton } from '../ui/State.js';
import styles from './Goals.module.css';

// A site's goals: what each one counted in this range, a way to add one, and a
// way to take one away.
//
// A goal is a question asked of the raw events, not a counter: nothing is
// counted when one is written, which is why one added today answers for every
// day the events still cover, and why deleting one loses nothing. The page says
// that at the one moment it matters, which is the moment somebody is about to
// press Delete.
//
// Adding and deleting need the admin scope, which only an owner of the site's
// team holds, because a goal changes what every report of the site says. The
// form is drawn for everybody and disabled with the reason for anybody else,
// rather than missing: a page that shows a viewer no way to add a goal is a
// page that looks broken to a viewer.

// The names a page is really sending, offered as the event name is typed. A
// goal on a name nothing sends is a goal that reads zero for ever.
const SUGGESTIONS = 50;

function isOwner(teams: { id: string; role: string }[], teamId: string): boolean {
  return teams.some((team) => team.id === teamId && team.role === 'owner');
}

function useRefreshGoals(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: goalsKey(site.id) }),
      queryClient.invalidateQueries({ queryKey: ['goal-stats', site.id] }),
    ]);
  };
}

function Absent(): JSX.Element {
  return <span className={styles.absent}>{messages.states.notAvailable}</span>;
}

function GoalRow({
  goal,
  conversion,
  top,
  chosen,
  owner,
}: {
  goal: Goal;
  conversion: Conversion;
  top: number;
  chosen: boolean;
  owner: boolean;
}): JSX.Element {
  const { client, site } = useApp();
  const { query, set } = useViewQuery();
  const refresh = useRefreshGoals();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteGoal(client, site.id, goal.id);
      // The goal on screen was this one, so the column goes with it rather
      // than waiting for the list to drop an id it no longer has.
      if (chosen) {
        set({ ...query, goal: null });
      }
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      setBusy(false);
    }
  }

  return (
    <>
      <tr className={chosen ? styles.chosen : undefined}>
        <td className={styles.cell}>
          {/* Choosing a goal here puts it on every report and stays on this page. */}
          <button
            type="button"
            className={styles.pick}
            aria-pressed={chosen}
            onClick={() => set({ ...query, goal: chosen ? null : goal.id })}
          >
            <span
              className={styles.bar}
              style={{ width: `${top === 0 ? 0 : (conversion.visitors / top) * 100}%` }}
              aria-hidden="true"
            />
            <span className={styles.name}>{goal.name}</span>
          </button>
        </td>
        <td className={[styles.cell, styles.match].join(' ')}>
          <code>{goal.match}</code>
        </td>
        <td
          className={[styles.cell, styles.right, styles.mono].join(' ')}
          title={
            conversion.visitors === 0 ? messages.goals.noConversions : formatExact(conversion.visitors)
          }
        >
          {formatCount(conversion.visitors)}
        </td>
        <td className={[styles.cell, styles.right, styles.mono].join(' ')}>
          {formatRate(conversion.rate) ?? <Absent />}
        </td>
        <td className={[styles.cell, styles.right, styles.mono].join(' ')}>
          {formatCount(conversion.completions)}
        </td>
        <td className={[styles.cell, styles.right, styles.mono].join(' ')}>
          {conversion.value === null ? <Absent /> : formatValue(conversion.value)}
        </td>
        <td className={[styles.cell, styles.right].join(' ')}>
          {owner && !confirming && (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              {messages.goals.delete}
            </Button>
          )}
        </td>
      </tr>
      {confirming && (
        <tr>
          <td className={styles.confirm} colSpan={7}>
            <p>{format(messages.goals.deleteConfirm, { name: goal.name })}</p>
            {problem !== null && (
              <p className={styles.problem} role="alert">
                {problem}
              </p>
            )}
            <div className={styles.actions}>
              <Button onClick={() => void remove()} disabled={busy}>
                {messages.goals.deleteYes}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                {messages.goals.deleteNo}
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function GoalList({ owner }: { owner: boolean }): JSX.Element {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  const result = useGoalStats({ client, siteId: site.id, query, now });
  const rows = useMemo(
    () =>
      (result.data?.data.rows ?? []).filter(
        (row): row is { goal: Goal; conversion: Conversion } => row.goal !== undefined,
      ),
    [result.data],
  );
  const top = rows.reduce((best, row) => Math.max(best, row.conversion.visitors), 0);
  const retentionDays =
    typeof result.data?.meta?.retentionDays === 'number'
      ? result.data.meta.retentionDays
      : site.settings.retentionDays;

  const body = (): JSX.Element => {
    if (result.isPending) {
      return (
        <div className={styles.loading}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={32} />
          ))}
        </div>
      );
    }
    if (result.isError) {
      return <ErrorState error={result.error} onRetry={() => result.refetch()} />;
    }
    if (rows.length === 0) {
      return (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{messages.goals.empty}</p>
          <p>{messages.goals.emptyLede}</p>
        </div>
      );
    }
    return (
      <>
        {/*
          The list scrolls inside its card rather than the page scrolling
          under it: seven columns are wider than a phone, and a page that
          moves sideways drags the navigation and the range bar with it. No
          column is hidden, every one is a scroll away, and the box takes
          focus so a keyboard can scroll it. The visitor table does the same.
        */}
        <div
          className={styles.scroll}
          tabIndex={0}
          role="group"
          aria-label={messages.goals.title}
        >
          <table className={styles.table}>
            <caption className="sr-only">{messages.goals.title}</caption>
            <thead className={styles.head}>
              <tr>
                <th scope="col">{messages.goals.picker}</th>
                <th scope="col" className={styles.match}>
                  {messages.goals.matches}
                </th>
                <th scope="col" className={styles.right}>
                  {messages.metrics.converted}
                </th>
                <th scope="col" className={styles.right}>
                  <span className={styles.withHelp}>
                    {messages.metrics.conversionRate}
                    <InfoDot
                      label={format(messages.a11y.metricHelp, { metric: messages.metrics.conversionRate })}
                      text={messages.metricHelp.conversionRate}
                    />
                  </span>
                </th>
                <th scope="col" className={styles.right}>
                  <span className={styles.withHelp}>
                    {messages.metrics.completions}
                    <InfoDot
                      label={format(messages.a11y.metricHelp, { metric: messages.metrics.completions })}
                      text={messages.metricHelp.completions}
                    />
                  </span>
                </th>
                <th scope="col" className={styles.right}>
                  <span className={styles.withHelp}>
                    {messages.metrics.value}
                    <InfoDot
                      label={format(messages.a11y.metricHelp, { metric: messages.metrics.value })}
                      text={messages.metricHelp.value}
                    />
                  </span>
                </th>
                <th scope="col">
                  <span className="sr-only">{messages.goals.delete}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <GoalRow
                  key={row.goal.id}
                  goal={row.goal}
                  conversion={row.conversion}
                  top={top}
                  chosen={query.goal === row.goal.id}
                  owner={owner}
                />
              ))}
            </tbody>
          </table>
        </div>
        {top === 0 && <p className={styles.note}>{messages.goals.noConversions}</p>}
      </>
    );
  };

  return (
    <Card title={messages.goals.title}>
      <p className={styles.lede}>{messages.goals.lede}</p>
      {body()}
      <p className={styles.note}>{format(messages.metricHelp.rawOnly, { days: retentionDays })}</p>
    </Card>
  );
}

// What a person typed, checked before it is sent. The server checks it again
// and is the one that counts; this is here so a missing slash is a sentence
// under the field rather than a round trip.
function problemsOf(input: { name: string; kind: GoalKind; match: string }): {
  name?: string;
  match?: string;
} {
  const problems: { name?: string; match?: string } = {};
  if (input.name.trim() === '') {
    problems.name = messages.goals.required;
  }
  if (input.match.trim() === '') {
    problems.match = messages.goals.required;
  } else if (input.kind === 'page' && !input.match.trim().startsWith('/')) {
    problems.match = messages.goals.invalidPath;
  }
  return problems;
}

function AddGoal({ owner }: { owner: boolean }): JSX.Element {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  const refresh = useRefreshGoals();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<GoalKind>('event');
  const [match, setMatch] = useState('');
  const [value, setValue] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Only while somebody is naming an event, and only for an owner who can.
  const events = useEvents({ client, siteId: site.id, query, now }, SUGGESTIONS);
  const suggestions = kind === 'event' && owner ? (events.data?.data.rows ?? []) : [];
  const listId = `goal-events-${site.id}`;

  const problems = tried ? problemsOf({ name, kind, match }) : {};

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (Object.keys(problemsOf({ name, kind, match })).length > 0) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.createGoal(client, site.id, {
        name: name.trim(),
        kind,
        match: match.trim(),
        ...(value.trim() === '' ? {} : { value: Number(value) }),
      });
      setName('');
      setMatch('');
      setValue('');
      setTried(false);
      await refresh();
    } catch (error) {
      setProblem(
        error instanceof ChokhError && error.code === 'GOAL_EXISTS'
          ? messages.goals.exists
          : error instanceof ChokhError && error.code === 'GOAL_LIMIT'
            ? format(messages.goals.limit, { max: MAX_GOALS_PER_SITE })
            : error instanceof ChokhError
              ? error.message
              : messages.states.error,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={messages.goals.addTitle}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {!owner && <p className={styles.lede}>{messages.goals.ownerOnly}</p>}
        <fieldset className={styles.fieldset} disabled={!owner || busy}>
          <legend className="sr-only">{messages.goals.addTitle}</legend>
          <Field
            label={messages.goals.name}
            placeholder={messages.goals.namePlaceholder}
            maxLength={100}
            value={name}
            onChange={(change) => setName(change.target.value)}
            {...(problems.name === undefined ? {} : { problem: problems.name })}
          />
          <SelectField
            label={messages.goals.kind}
            value={kind}
            options={[
              { value: 'event', label: messages.goals.kindEvent },
              { value: 'page', label: messages.goals.kindPage },
            ]}
            onChange={(change) => setKind(change.target.value === 'page' ? 'page' : 'event')}
          />
          <Field
            label={kind === 'page' ? messages.goals.matchPage : messages.goals.matchEvent}
            placeholder={
              kind === 'page' ? messages.goals.matchPagePlaceholder : messages.goals.matchEventPlaceholder
            }
            help={kind === 'page' ? messages.goals.matchPageHelp : messages.goals.matchEventHelp}
            maxLength={kind === 'page' ? 1024 : 200}
            className={styles.mono}
            value={match}
            onChange={(change) => setMatch(change.target.value)}
            {...(suggestions.length > 0 ? { list: listId } : {})}
            {...(problems.match === undefined ? {} : { problem: problems.match })}
          />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((row) => (
                <option key={row.key} value={row.key} />
              ))}
            </datalist>
          )}
          <Field
            label={messages.goals.value}
            help={messages.goals.valueHelp}
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={value}
            onChange={(change) => setValue(change.target.value)}
          />
          {problem !== null && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={!owner || busy}>
              {busy ? messages.goals.saving : messages.goals.save}
            </Button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}

export function Goals(): JSX.Element {
  const { me, site } = useApp();
  const owner = isOwner(me.teams, site.teamId);
  return (
    <ReportPage title={messages.goals.title}>
      <GoalList owner={owner} />
      <AddGoal owner={owner} />
    </ReportPage>
  );
}

