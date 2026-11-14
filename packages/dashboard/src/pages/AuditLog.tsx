import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { useLocation, useSearch } from 'wouter';
import { dayBounds } from '@chokh/store/time';

import { SiteTabs, useSiteAccess } from '../app/SiteTabs.js';
import { useApp } from '../app/context.js';
import {
  identityAllowed,
  type AuditKind,
  type AuditLogPage,
  type AuditParams,
  type AuditRow,
  type InvitationScope,
} from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { formatCount, formatDateTime } from '../lib/format.js';
import { auditKey, useAuditLog } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import page from '../reports/ReportPage.module.css';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField } from '../ui/Field.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import styles from './AuditLog.module.css';

// The audit log, read (AN-TEAM01): who read which person, who was let in,
// and when.
//
// One thing shapes this page more than any other: opening the log is itself
// written to the log. So the list is asked for when somebody asks and at no
// other time. It does not reload when the window gets the focus back, when
// the network returns or on a timer (lib/queries.ts), and the filters are a
// form with a button rather than boxes that search as they are typed in,
// because every search is a row saying this person opened the log. The page
// says so in a sentence, so the row is never a surprise to whoever reads the
// log next.
//
// What is asked lives in the address bar like every other choice in this
// dashboard, so a filtered log can be sent to somebody.

type Log = 'site' | 'team';
const KINDS: readonly AuditKind[] = ['identity', 'access', 'log'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Asked {
  log: Log;
  kind: AuditKind | '';
  by: string;
  about: string;
  from: string;
  to: string;
}

function readAsked(search: string): Asked {
  const params = new URLSearchParams(search);
  const kind = params.get('kind') ?? '';
  const day = (name: string): string => {
    const value = params.get(name) ?? '';
    return DAY.test(value) ? value : '';
  };
  return {
    log: params.get('log') === 'team' ? 'team' : 'site',
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as AuditKind) : '',
    by: (params.get('by') ?? '').trim(),
    about: (params.get('about') ?? '').trim(),
    from: day('from'),
    to: day('to'),
  };
}

function writeAsked(asked: Asked): string {
  const params = new URLSearchParams();
  if (asked.log === 'team') params.set('log', 'team');
  if (asked.kind !== '') params.set('kind', asked.kind);
  if (asked.by !== '') params.set('by', asked.by);
  if (asked.about !== '') params.set('about', asked.about);
  if (asked.from !== '') params.set('from', asked.from);
  if (asked.to !== '') params.set('to', asked.to);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

// Whole days of the site's calendar, the last one included.
function paramsOf(asked: Asked, timezone: string): AuditParams {
  return {
    kind: asked.kind === '' ? undefined : asked.kind,
    actor: asked.by === '' ? undefined : asked.by,
    target: asked.about === '' ? undefined : asked.about,
    from: asked.from === '' ? undefined : dayBounds(asked.from, timezone).start,
    to: asked.to === '' ? undefined : dayBounds(asked.to, timezone).end,
  };
}

const ACTIONS: Readonly<Record<string, string>> = {
  'read:identity': messages.audit.actionReadIdentity,
  'read:audit': messages.audit.actionReadAudit,
  'member:set': messages.audit.actionMemberSet,
  'member:remove': messages.audit.actionMemberRemove,
  'member:refused': messages.audit.actionMemberRefused,
  'invite:create': messages.audit.actionInviteCreate,
  'invite:revoke': messages.audit.actionInviteRevoke,
  'invite:accept': messages.audit.actionInviteAccept,
  'team:create': messages.audit.actionTeamCreate,
  'team:delete': messages.audit.actionTeamDelete,
  'site:move': messages.audit.actionSiteMove,
  'identity:link': messages.audit.actionIdentityLink,
  'identity:unlink': messages.audit.actionIdentityUnlink,
};

// Who acted, in the words somebody reading the log would use: the name, then
// the address, and only then an id.
function actorOf(row: AuditRow, accounts: AuditLogPage['accounts']): { name: string; id: string } {
  if (row.actor.kind === 'key') {
    return { name: format(messages.audit.actorKey, { id: row.actor.id }), id: row.actor.id };
  }
  const account = accounts[row.actor.id];
  const name =
    account?.name ??
    account?.email ??
    row.actor.email ??
    format(messages.audit.actorAccount, { id: row.actor.id });
  return { name, id: row.actor.id };
}

function Filters({
  asked,
  identity,
  onAsk,
}: {
  asked: Asked;
  identity: boolean;
  onAsk: (next: Asked) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(asked);
  const [problem, setProblem] = useState(false);
  // The address bar moved on its own (back, a link, a button in a row): the
  // form follows it.
  useEffect(() => {
    setDraft(asked);
  }, [asked.log, asked.kind, asked.by, asked.about, asked.from, asked.to]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (draft.from !== '' && draft.to !== '' && draft.from > draft.to) {
      setProblem(true);
      return;
    }
    setProblem(false);
    onAsk({ ...draft, by: draft.by.trim(), about: draft.about.trim() });
  }

  const cleared: Asked = { log: asked.log, kind: '', by: '', about: '', from: '', to: '' };
  const filtered = writeAsked({ ...asked, log: 'site' }) !== '';

  return (
    <form className={styles.filters} onSubmit={submit} aria-label={messages.audit.filters}>
      <SelectField
        label={messages.audit.kind}
        value={draft.kind}
        onChange={(event) => setDraft({ ...draft, kind: event.target.value as Asked['kind'] })}
        options={[
          { value: '', label: messages.audit.kindAll },
          { value: 'identity', label: messages.audit.kindIdentity },
          { value: 'access', label: messages.audit.kindAccess },
          { value: 'log', label: messages.audit.kindLog },
        ]}
      />
      <Field
        label={messages.audit.target}
        help={identity ? messages.audit.targetHelp : messages.audit.targetNeedsScope}
        value={identity ? draft.about : ''}
        disabled={!identity}
        onChange={(event) => setDraft({ ...draft, about: event.target.value })}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={messages.audit.actor}
        help={messages.audit.actorHelp}
        value={draft.by}
        onChange={(event) => setDraft({ ...draft, by: event.target.value })}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={messages.audit.from}
        type="date"
        value={draft.from}
        onChange={(event) => setDraft({ ...draft, from: event.target.value })}
      />
      <Field
        label={messages.audit.to}
        type="date"
        value={draft.to}
        onChange={(event) => setDraft({ ...draft, to: event.target.value })}
        {...(problem ? { problem: messages.audit.datesProblem } : {})}
      />
      <div className={styles.filterActions}>
        <Button type="submit" variant="primary">
          {messages.audit.apply}
        </Button>
        {filtered && (
          <Button variant="quiet" onClick={() => onAsk(cleared)}>
            {messages.audit.clear}
          </Button>
        )}
      </div>
    </form>
  );
}

function Rows({
  scope,
  asked,
  filters,
  onAsk,
}: {
  scope: InvitationScope;
  asked: Asked;
  filters: AuditParams;
  onAsk: (next: Asked) => void;
}): JSX.Element {
  const { client, site } = useApp();
  const queryClient = useQueryClient();
  const list = useAuditLog(client, scope, filters, true);
  const timezone = site.settings.timezone;

  const pages = list.data?.pages ?? [];
  const rows = pages.flatMap((each) => each.data.rows);
  const accounts = Object.assign({}, ...pages.map((each) => each.data.accounts)) as AuditLogPage['accounts'];
  // Known from the first answer, and assumed until then.
  const identity = pages[0] === undefined ? true : identityAllowed(pages[0].meta);
  const filtered = writeAsked({ ...asked, log: 'site' }) !== '';

  // Opening it again is a new listing and a new row in the log, and it is the
  // only way this list is ever asked for twice: by somebody pressing this.
  const reopen = (): void => {
    void queryClient.resetQueries({ queryKey: auditKey(scope, filters) });
  };

  // The listing was opened more than an hour ago: the next page is refused,
  // and what is on screen stays, with the way on.
  const stale =
    list.isFetchNextPageError &&
    list.error instanceof ChokhError &&
    (list.error.code === 'CURSOR_EXPIRED' || list.error.code === 'INVALID_CURSOR');

  if (list.isPending) {
    return (
      <div className={styles.loading} role="status" aria-label={messages.states.loading}>
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={36} />
      </div>
    );
  }
  if (list.isError && rows.length === 0) {
    return <ErrorState error={list.error} onRetry={reopen} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        message={filtered ? messages.audit.emptyFiltered : messages.audit.empty}
        {...(filtered
          ? {
              action: {
                label: messages.audit.clear,
                onClick: () => onAsk({ log: asked.log, kind: '', by: '', about: '', from: '', to: '' }),
              },
            }
          : {})}
      />
    );
  }

  return (
    <>
      {!identity && <p className={styles.hiddenNote}>{messages.audit.hiddenNote}</p>}
      {/* The table scrolls inside its card and never takes the page with it,
          and the box can take the focus so a keyboard can scroll it too. */}
      <div className={styles.scroll} tabIndex={0} role="group" aria-label={messages.audit.caption}>
        <table className={styles.table}>
          <caption className="sr-only">{messages.audit.caption}</caption>
          <thead className={styles.head}>
            <tr>
              <th scope="col">{messages.audit.when}</th>
              <th scope="col">{messages.audit.who}</th>
              <th scope="col">{messages.audit.what}</th>
              <th scope="col">{messages.audit.about}</th>
              <th scope="col">{messages.audit.details}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const actor = actorOf(row, accounts);
              const about =
                row.target === undefined
                  ? null
                  : (accounts[row.target]?.name ?? accounts[row.target]?.email ?? row.target);
              return (
                <tr key={row.id} className={styles.row}>
                  <td className={[styles.cell, styles.when].join(' ')} title={new Date(row.ts).toISOString()}>
                    {formatDateTime(row.ts, timezone)}
                  </td>
                  <td className={styles.cell}>
                    <button
                      type="button"
                      className={styles.pick}
                      title={format(messages.audit.onlyBy, { who: actor.name })}
                      aria-label={format(messages.audit.onlyBy, { who: actor.name })}
                      onClick={() => onAsk({ ...asked, by: actor.id })}
                    >
                      {actor.name}
                    </button>
                  </td>
                  <td className={styles.cell}>{ACTIONS[row.action] ?? row.action}</td>
                  <td className={styles.cell}>
                    {about === null ? (
                      <span className={styles.muted}>
                        {identity ? messages.audit.nobody : messages.audit.hidden}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.pick}
                        title={format(messages.audit.onlyAbout, { target: about })}
                        aria-label={format(messages.audit.onlyAbout, { target: about })}
                        onClick={() => onAsk({ ...asked, about: row.target ?? '' })}
                      >
                        {about}
                      </button>
                    )}
                  </td>
                  <td className={styles.cell}>
                    <div className={styles.detail}>
                      {row.fields.length > 0 && <span>{row.fields.join(', ')}</span>}
                      <span className={styles.route}>{row.route}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.foot}>
        {stale ? (
          <p className={styles.stale} role="alert">
            {messages.audit.expired}
          </p>
        ) : (
          <p className={styles.count} aria-live="polite">
            {format(list.hasNextPage ? messages.audit.showing : messages.audit.showingAll, {
              count: formatCount(rows.length),
            })}
          </p>
        )}
        <div className={styles.footActions}>
          {list.hasNextPage && !stale && (
            <Button
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              aria-busy={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? messages.audit.loadingMore : messages.audit.more}
            </Button>
          )}
          <Button variant={stale ? 'primary' : 'quiet'} onClick={reopen}>
            {messages.audit.reopen}
          </Button>
        </div>
      </div>
    </>
  );
}

export function AuditLog(): JSX.Element {
  const { site, me } = useApp();
  const access = useSiteAccess();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const asked = readAsked(search);
  const teamName = me.teams.find((team) => team.id === site.teamId)?.name ?? site.teamId;

  const ask = (next: Asked): void => {
    navigate(`${location}${writeAsked(next)}`);
  };

  const scope: InvitationScope =
    asked.log === 'team' ? { kind: 'team', id: site.teamId } : { kind: 'site', id: site.id };
  const filters = paramsOf(asked, site.settings.timezone);
  // The team's log is its owners'; the site's is for whoever has admin here.
  const allowed = asked.log === 'team' ? access.teamOwner : access.admin;

  return (
    <div className={page.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{format(messages.audit.title, { name: site.name })}</h1>
        <p className={styles.intro}>{access.admin ? messages.audit.lede : messages.audit.adminOnly}</p>
      </div>
      <SiteTabs />
      {access.admin && (
        <Card
          title={asked.log === 'team' ? teamName : site.name}
          tabs={[
            { id: 'site', label: messages.audit.logSite },
            { id: 'team', label: messages.audit.logTeam },
          ]}
          tab={asked.log}
          onTab={(id) => ask({ ...asked, log: id === 'team' ? 'team' : 'site' })}
        >
          <p className={styles.recorded}>{messages.audit.recorded}</p>
          {allowed ? (
            <>
              <Filters asked={asked} identity={access.identity} onAsk={ask} />
              <Rows scope={scope} asked={asked} filters={filters} onAsk={ask} />
            </>
          ) : (
            <EmptyState message={messages.audit.teamOwnerOnly} />
          )}
        </Card>
      )}
    </div>
  );
}
