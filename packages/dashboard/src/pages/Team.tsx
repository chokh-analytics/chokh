import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type JSX } from 'react';

import { SiteTabs, useSiteAccess } from '../app/SiteTabs.js';
import { useApp } from '../app/context.js';
import {
  api,
  type CreatedInvitation,
  type Invitation,
  type InvitationScope,
  type KeySummary,
  type ListedMember,
  type MembershipEffects,
  type Role,
} from '../lib/api.js';
import { ChokhError, type Answer } from '../lib/client.js';
import { formatDateTime } from '../lib/format.js';
import {
  invitationsKey,
  siteMembersKey,
  teamMembersKey,
  useInvitations,
  useSiteMembers,
  useTeamMembers,
} from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import page from '../reports/ReportPage.module.css';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField } from '../ui/Field.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import { Panel } from './TeamPanel.js';
import { Teams } from './Teams.js';
import styles from './Team.module.css';

// Who can reach this site (AN-TEAM01): the team that owns it, the people let
// in to this site alone, and the invitations still waiting.
//
// Three rules this page is built around.
//
// A change says everything it did. Lowering or removing somebody ends their
// sessions, may leave keys they made still working, and never touches a role
// they hold on a single site, because that row is its own thing. The server
// answers with all three and the page puts each in front of the owner: the
// keys as a question it will not answer for them, and the roles that are
// still standing with an offer to take those off as well. "Removed" is never
// somebody still reading one site without the person who removed them
// knowing.
//
// An invitation's link exists once. Only a hash of its token is kept, so the
// link is shown in the answer to the request that made it, with a copy button
// and a sentence saying it will not be shown again, and is held in this
// component's memory until it is dismissed. It is in no list afterwards.
//
// Nobody is sent to fetch a refusal. Somebody without admin on the site reads
// one sentence saying who sees this page, and nothing is asked of the server.

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'viewer', label: messages.team.roleViewer },
  { value: 'editor', label: messages.team.roleEditor },
  { value: 'owner', label: messages.team.roleOwner },
];

function roleWord(role: Role): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

function problemOf(error: unknown): string {
  return error instanceof ChokhError ? error.message : messages.states.error;
}

function nameOf(member: Pick<ListedMember, 'userId' | 'email' | 'name'>): string {
  return member.name ?? member.email ?? member.userId;
}

// One request a change is made of. It takes the answer to the keys question
// when there is one, and leaves it out the first time so the server asks.
interface Step {
  run: (revokeKeys?: boolean) => Promise<Answer<unknown>>;
}

interface Change {
  who: string;
  userId: string;
  steps: Step[];
  // What to say when all of it went through.
  done: string;
}

interface KeysQuestion extends Change {
  keys: KeySummary[];
}

interface KeptRoles {
  who: string;
  userId: string;
  rows: MembershipEffects['siteRolesKept'];
}

interface Runner {
  busy: boolean;
  problem: string | null;
  notice: string | null;
  question: KeysQuestion | null;
  kept: KeptRoles | null;
  change(change: Change): void;
  answer(revokeKeys: boolean): void;
  cancel(): void;
  takeOff(): void;
  leave(): void;
}

// Runs a change one request at a time, and stops where the server asks what
// to do about keys. The answer carries on from that request and not from the
// start, so a step that already went through is never sent twice.
function useChanges(refresh: () => Promise<void>): Runner {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [question, setQuestion] = useState<KeysQuestion | null>(null);
  const [kept, setKept] = useState<KeptRoles | null>(null);

  async function drive(change: Change, decision?: boolean): Promise<void> {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    setQuestion(null);
    let revokeKeys = decision;
    let said = change.done;
    let standing: KeptRoles | null = null;
    try {
      for (let index = 0; index < change.steps.length; index += 1) {
        const step = change.steps[index] as Step;
        try {
          const answer = await step.run(revokeKeys);
          revokeKeys = undefined;
          const effects = answer.meta as Partial<MembershipEffects> | undefined;
          if (effects?.sessionsEnded === true && change.done === messages.team.saved) {
            said = messages.team.sessionsEnded;
          }
          const rows = effects?.siteRolesKept ?? [];
          if (rows.length > 0) {
            standing = { who: change.who, userId: change.userId, rows };
          }
        } catch (error) {
          if (error instanceof ChokhError && error.code === 'KEYS_DECISION_REQUIRED') {
            const keys = (error.details as { keys?: KeySummary[] } | undefined)?.keys ?? [];
            setQuestion({ ...change, steps: change.steps.slice(index), keys });
            return;
          }
          throw error;
        }
      }
      setKept(standing);
      setNotice(said);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      // Whatever happened, the lists say what is true now.
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }

  return {
    busy,
    problem,
    notice,
    question,
    kept,
    change: (change) => {
      setKept(null);
      void drive(change);
    },
    answer: (revokeKeys) => {
      if (question !== null) void drive(question, revokeKeys);
    },
    cancel: () => setQuestion(null),
    takeOff: () => {
      if (kept === null) return;
      const { who, userId, rows } = kept;
      setKept(null);
      void drive({
        who,
        userId,
        done: messages.team.keptRemoved,
        steps: rows.map((row) => ({
          run: (revokeKeys?: boolean) => api.removeSiteMember(client, row.siteId, userId, revokeKeys),
        })),
      });
    },
    leave: () => setKept(null),
  };
}

function siteName(sites: readonly { id: string; name: string }[], siteId: string): string {
  return sites.find((site) => site.id === siteId)?.name ?? siteId;
}

// What a change came back with: the keys question, the roles still standing,
// what went wrong, or one line saying it is done.
function Outcome({ runner }: { runner: Runner }): JSX.Element | null {
  const { me } = useApp();
  if (runner.question !== null) {
    const question = runner.question;
    return (
      <Panel title={format(messages.team.keysTitle, { who: question.who })}>
        <p className={styles.note}>{messages.team.keysLede}</p>
        <ul className={styles.plain}>
          {question.keys.map((key) => (
            <li key={key.id}>
              {format(messages.team.keyLine, {
                name: key.name,
                site: siteName(me.sites, key.siteId),
                scopes: key.scopes.join(', '),
              })}
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <Button onClick={() => runner.answer(true)} disabled={runner.busy}>
            {messages.team.keysRevoke}
          </Button>
          <Button onClick={() => runner.answer(false)} disabled={runner.busy}>
            {messages.team.keysKeep}
          </Button>
          <Button variant="quiet" onClick={runner.cancel} disabled={runner.busy}>
            {messages.team.keysCancel}
          </Button>
        </div>
      </Panel>
    );
  }
  if (runner.kept !== null) {
    const kept = runner.kept;
    return (
      <Panel title={format(messages.team.keptTitle, { who: kept.who })}>
        <p className={styles.note}>{messages.team.keptLede}</p>
        <ul className={styles.plain}>
          {kept.rows.map((row) => (
            <li key={row.siteId}>
              {format(messages.team.keptLine, {
                role: roleWord(row.role),
                site: siteName(me.sites, row.siteId),
              })}
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <Button onClick={runner.takeOff} disabled={runner.busy}>
            {runner.busy ? messages.team.keptRemoving : messages.team.keptRemove}
          </Button>
          <Button variant="quiet" onClick={runner.leave} disabled={runner.busy}>
            {messages.team.keptLeave}
          </Button>
        </div>
      </Panel>
    );
  }
  if (runner.problem !== null) {
    return (
      <p className={styles.problem} role="alert">
        {runner.problem}
      </p>
    );
  }
  if (runner.notice !== null) {
    return (
      <p className={styles.done} role="status">
        {runner.notice}
      </p>
    );
  }
  return null;
}

function MemberItem({
  member,
  self,
  busy,
  onSave,
  onRemove,
}: {
  member: ListedMember;
  self: boolean;
  busy: boolean;
  onSave: (to: { role: Role; identity: boolean }) => void;
  onRemove: () => void;
}): JSX.Element {
  const [role, setRole] = useState<Role>(member.role);
  const [identity, setIdentity] = useState(member.identity);
  const [confirming, setConfirming] = useState(false);
  // The list was read again: what is on screen follows what is true.
  useEffect(() => {
    setRole(member.role);
    setIdentity(member.identity);
  }, [member.role, member.identity]);

  const who = nameOf(member);
  // An owner always may, so the box says so and is not a choice.
  const sees = role === 'owner' ? true : identity;
  const dirty = role !== member.role || sees !== (member.role === 'owner' ? true : member.identity);

  return (
    <li className={styles.member}>
      <div className={styles.who}>
        <span className={styles.name}>
          {who}
          {self && <span className={styles.tag}>{messages.team.you}</span>}
        </span>
        {member.email !== undefined && member.email !== who && (
          <span className={styles.email}>{member.email}</span>
        )}
      </div>
      {member.managed ? (
        <div className={styles.controls}>
          <span className={styles.fixed}>{roleWord(member.role)}</span>
          <p className={styles.managed}>{messages.team.managed}</p>
        </div>
      ) : (
        <div className={styles.controls}>
          <select
            className={styles.select}
            aria-label={format(messages.team.roleFor, { who })}
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className={styles.check}>
            <input
              type="checkbox"
              aria-label={format(messages.team.identityFor, { who })}
              checked={sees}
              disabled={busy || role === 'owner'}
              onChange={(event) => setIdentity(event.target.checked)}
            />
            <span aria-hidden="true">{messages.team.identity}</span>
          </label>
        </div>
      )}
      <div className={styles.rowActions}>
        {confirming ? (
          <>
            <span className={styles.note}>{format(messages.team.removeConfirm, { who })}</span>
            <Button
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
              disabled={busy}
            >
              {messages.team.remove}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              {messages.team.removeNo}
            </Button>
          </>
        ) : (
          <>
            {!member.managed && (
              <Button onClick={() => onSave({ role, identity: sees })} disabled={busy || !dirty}>
                {busy && dirty ? messages.team.saving : messages.team.save}
              </Button>
            )}
            <Button
              variant="quiet"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-label={format(messages.team.removeFor, { who })}
            >
              {messages.team.remove}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function Loading(): JSX.Element {
  return (
    <div className={styles.loading}>
      <Skeleton height={44} />
      <Skeleton height={44} />
      <Skeleton height={44} />
    </div>
  );
}

function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: teamMembersKey(site.teamId) }),
      queryClient.invalidateQueries({ queryKey: siteMembersKey(site.id) }),
      queryClient.invalidateQueries({ queryKey: invitationsKey({ kind: 'team', id: site.teamId }) }),
      queryClient.invalidateQueries({ queryKey: invitationsKey({ kind: 'site', id: site.id }) }),
      // A change to this person's own place changes what GET /api/me says.
      queryClient.invalidateQueries({ queryKey: ['me'] }),
    ]);
  };
}

function TeamMembers({ teamName }: { teamName: string }): JSX.Element {
  const { client, site, me } = useApp();
  const list = useTeamMembers(client, site.teamId, true);
  const runner = useChanges(useRefresh());
  const members = list.data?.data.members ?? [];
  return (
    <Card title={format(messages.team.teamTitle, { team: list.data?.data.team.name ?? teamName })}>
      <p className={styles.lede}>{messages.team.teamLede}</p>
      <Outcome runner={runner} />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <ul className={styles.list} aria-label={messages.team.membersCaption}>
          {members.map((member) => (
            <MemberItem
              key={member.userId}
              member={member}
              self={member.userId === me.user?.id}
              busy={runner.busy}
              onSave={(to) =>
                runner.change({
                  who: nameOf(member),
                  userId: member.userId,
                  done: messages.team.saved,
                  steps: [
                    {
                      run: (revokeKeys) =>
                        api.setTeamMember(client, site.teamId, member.userId, {
                          ...to,
                          ...(revokeKeys === undefined ? {} : { revokeKeys }),
                        }),
                    },
                  ],
                })
              }
              onRemove={() =>
                runner.change({
                  who: nameOf(member),
                  userId: member.userId,
                  done: messages.team.removed,
                  steps: [
                    {
                      run: (revokeKeys) =>
                        api.removeTeamMember(client, site.teamId, member.userId, revokeKeys),
                    },
                  ],
                })
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function SiteMembers(): JSX.Element {
  const { client, site, me } = useApp();
  const list = useSiteMembers(client, site.id, true);
  const runner = useChanges(useRefresh());
  const members = list.data?.data.members ?? [];
  return (
    <Card title={messages.team.siteTitle}>
      <p className={styles.lede}>{format(messages.team.siteLede, { site: site.name })}</p>
      <Outcome runner={runner} />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : members.length === 0 ? (
        <EmptyState message={messages.team.siteNone} />
      ) : (
        <ul className={styles.list} aria-label={messages.team.membersCaption}>
          {members.map((member) => (
            <MemberItem
              key={member.userId}
              member={member}
              self={member.userId === me.user?.id}
              busy={runner.busy}
              onSave={(to) =>
                runner.change({
                  who: nameOf(member),
                  userId: member.userId,
                  done: messages.team.saved,
                  steps: [
                    {
                      run: (revokeKeys) =>
                        api.setSiteMember(client, site.id, member.userId, {
                          ...to,
                          ...(revokeKeys === undefined ? {} : { revokeKeys }),
                        }),
                    },
                  ],
                })
              }
              onRemove={() =>
                runner.change({
                  who: nameOf(member),
                  userId: member.userId,
                  done: messages.team.removed,
                  steps: [
                    {
                      run: (revokeKeys) =>
                        api.removeSiteMember(client, site.id, member.userId, revokeKeys),
                    },
                  ],
                })
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

// The link, the one time it exists. Held in memory by the form that made it
// until it is dismissed, and written nowhere.
function OnceLink({ made, onDone }: { made: CreatedInvitation; onDone: () => void }): JSX.Element {
  const { site } = useApp();
  const [copied, setCopied] = useState(false);
  // The server answers a path: which host this dashboard is reached at is the
  // dashboard's to know, never something read from a request.
  const link = `${window.location.origin}${made.once.link}`;
  return (
    <Panel title={format(messages.team.linkTitle, { email: made.invitation.email })}>
      <p className={styles.once}>{messages.team.linkOnce}</p>
      <input
        className={styles.link}
        readOnly
        aria-label={messages.team.linkLabel}
        value={link}
        onFocus={(event) => event.target.select()}
        // Never offered back by the browser on another visit.
        autoComplete="off"
        spellCheck={false}
      />
      <p className={styles.note}>
        {format(messages.team.linkExpires, {
          when: formatDateTime(made.invitation.expiresAt, site.settings.timezone),
        })}
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
          }}
        >
          {messages.team.linkCopy}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          {messages.team.linkDone}
        </Button>
        {copied && (
          <span className={styles.done} role="status">
            {messages.team.linkCopied}
          </span>
        )}
      </div>
    </Panel>
  );
}

function Invite({ teamName }: { teamName: string | null }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefresh();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [identity, setIdentity] = useState(false);
  // To the whole team when this person may, because that is the common case;
  // somebody who runs one site can only invite to it.
  const [to, setTo] = useState<'team' | 'site'>(teamName === null ? 'site' : 'team');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [emailProblem, setEmailProblem] = useState(false);
  const [made, setMade] = useState<CreatedInvitation | null>(null);

  const scopes = [
    ...(teamName === null
      ? []
      : [{ value: 'team', label: format(messages.team.inviteToTeam, { team: teamName }) }]),
    { value: 'site', label: format(messages.team.inviteToSite, { site: site.name }) },
  ];

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const address = email.trim();
    if (!address.includes('@')) {
      setEmailProblem(true);
      return;
    }
    setEmailProblem(false);
    setBusy(true);
    setProblem(null);
    const scope: InvitationScope =
      to === 'team' ? { kind: 'team', id: site.teamId } : { kind: 'site', id: site.id };
    try {
      const answer = await api.createInvitation(client, scope, {
        email: address,
        role,
        identity: role === 'owner' ? true : identity,
      });
      setMade(answer.data);
      setEmail('');
      await refresh();
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={messages.team.inviteTitle}>
      <p className={styles.lede}>{messages.team.inviteLede}</p>
      {made !== null && <OnceLink made={made} onDone={() => setMade(null)} />}
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.fieldset} disabled={busy}>
          <legend className="sr-only">{messages.team.inviteTitle}</legend>
          <Field
            label={messages.team.inviteEmail}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...(emailProblem ? { problem: messages.team.inviteEmailProblem } : {})}
          />
          <div className={styles.pair}>
            <SelectField
              label={messages.team.role}
              options={ROLE_OPTIONS}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            />
            <SelectField
              label={messages.team.inviteTo}
              options={scopes}
              value={to}
              onChange={(event) => setTo(event.target.value as 'team' | 'site')}
            />
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={role === 'owner' ? true : identity}
              disabled={role === 'owner'}
              onChange={(event) => setIdentity(event.target.checked)}
            />
            <span>{messages.team.identity}</span>
          </label>
          <p className={styles.note}>{messages.team.identityHelp}</p>
          {problem !== null && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? messages.team.inviteSending : messages.team.inviteSend}
            </Button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}

function WaitingItem({ invitation }: { invitation: Invitation }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const when = formatDateTime(invitation.expiresAt, site.settings.timezone);

  async function revoke(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.revokeInvitation(client, invitation.scope, invitation.id);
      await refresh();
    } catch (error) {
      setProblem(problemOf(error));
      setBusy(false);
    }
  }

  // Three things a waiting row can be, and the second is the one a list that
  // only said "waiting" would lie about: its link answers 410.
  const state =
    invitation.state === 'expired'
      ? format(messages.team.waitingExpired, { when })
      : invitation.usable
        ? format(messages.team.waitingUntil, { when })
        : messages.team.waitingUnusable;

  return (
    <li className={styles.member}>
      <div className={styles.who}>
        <span className={styles.name}>{invitation.email}</span>
        <span className={styles.email}>
          {format(
            invitation.scope.kind === 'team'
              ? messages.team.waitingAsTeam
              : messages.team.waitingAsSite,
            { role: roleWord(invitation.role) },
          )}
        </span>
      </div>
      <p className={invitation.usable ? styles.state : styles.stateOff}>{state}</p>
      <div className={styles.rowActions}>
        {confirming ? (
          <>
            <span className={styles.note}>
              {format(messages.team.revokeConfirm, { email: invitation.email })}
            </span>
            <Button onClick={() => void revoke()} disabled={busy}>
              {messages.team.revoke}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              {messages.team.revokeNo}
            </Button>
          </>
        ) : (
          <Button
            variant="quiet"
            onClick={() => setConfirming(true)}
            aria-label={format(messages.team.revokeFor, { email: invitation.email })}
          >
            {messages.team.revoke}
          </Button>
        )}
      </div>
      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </li>
  );
}

function Waiting({ teamOwner }: { teamOwner: boolean }): JSX.Element {
  const { client, site } = useApp();
  const toTeam = useInvitations(client, { kind: 'team', id: site.teamId }, teamOwner);
  const toSite = useInvitations(client, { kind: 'site', id: site.id }, true);
  const pending = toSite.isPending || (teamOwner && toTeam.isPending);
  const failed = toSite.isError ? toSite : teamOwner && toTeam.isError ? toTeam : null;
  const rows = [
    ...(toTeam.data?.data.invitations ?? []),
    ...(toSite.data?.data.invitations ?? []),
  ].sort((left, right) => right.createdAt - left.createdAt);

  return (
    <Card title={messages.team.waitingTitle}>
      {pending ? (
        <Loading />
      ) : failed !== null ? (
        <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={messages.team.waitingNone} />
      ) : (
        <ul className={[styles.list, styles.first].join(' ')} aria-label={messages.team.waitingTitle}>
          {rows.map((invitation) => (
            <WaitingItem key={invitation.id} invitation={invitation} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Team(): JSX.Element {
  const { me, site } = useApp();
  const access = useSiteAccess();
  const teamName = me.teams.find((team) => team.id === site.teamId)?.name ?? site.teamId;

  return (
    <div className={page.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{format(messages.team.title, { name: site.name })}</h1>
        <p className={styles.intro}>{access.admin ? messages.team.lede : messages.team.adminOnly}</p>
      </div>
      <SiteTabs />
      {access.admin && (
        <div className={page.stack}>
          <Invite teamName={access.teamOwner ? teamName : null} />
          <Waiting teamOwner={access.teamOwner} />
          {access.teamOwner ? (
            <TeamMembers teamName={teamName} />
          ) : (
            <Card title={format(messages.team.teamTitle, { team: teamName })}>
              <EmptyState message={messages.team.teamOwnerOnly} />
            </Card>
          )}
          <SiteMembers />
          <Teams />
        </div>
      )}
    </div>
  );
}
