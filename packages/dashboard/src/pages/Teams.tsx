import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import { useApp } from '../app/context.js';
import { api, type KeySummary } from '../lib/api.js';
import { ChokhError, licenseRefusal } from '../lib/client.js';
import { useLicense } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField } from '../ui/Field.js';
import { ProFeature } from '../ui/Pro.js';
import { Panel } from './TeamPanel.js';
import styles from './Team.module.css';

// More than one team (AN-TEAM01): make a team, delete an empty one, move this
// site to another. Part of Chokh Pro, and drawn under AGENTS.md rule 10: on an
// install with no key the card is here, named, described in a sentence, and
// has nothing in it to fill in. Never hidden, never a locked picture.
//
// What is paid is these three acts. The teams somebody is in are listed
// either way, because they exist either way: a team an application's sign-in
// made, or one made while a key was in force, goes on working without one.

const FEATURE = 'teams';
const DEFAULT_TEAM = 'default';

function problemOf(error: unknown): string {
  return error instanceof ChokhError ? error.message : messages.states.error;
}

function roleWord(role: string): string {
  return role === 'owner'
    ? messages.team.roleOwner
    : role === 'editor'
      ? messages.team.roleEditor
      : messages.team.roleViewer;
}

interface Run {
  busy: boolean;
  problem: string | null;
  // The server refused for the licence after the page thought there was one:
  // a key that ran out while the page was open.
  lapsed: string | null;
  notice: string | null;
  go(work: () => Promise<string>): Promise<void>;
}

function useRun(): Run {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lapsed, setLapsed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return {
    busy,
    problem,
    lapsed,
    notice,
    async go(work) {
      setBusy(true);
      setProblem(null);
      setNotice(null);
      try {
        const said = await work();
        // The teams, and which team this site is in, come from the answer the
        // shell boots from.
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        setNotice(said);
      } catch (error) {
        const refusal = licenseRefusal(error);
        if (refusal !== null) {
          setLapsed(refusal.reason ?? 'missing');
          await queryClient.invalidateQueries({ queryKey: ['license'] });
        } else {
          setProblem(problemOf(error));
        }
      } finally {
        setBusy(false);
      }
    },
  };
}

// The teams this person is in. With `actions`, an owner may delete one that
// is empty; without (no key), the list is the same list and nothing on it is
// a control.
function TeamList({ run, actions }: { run: Run; actions: boolean }): JSX.Element {
  const { client, me } = useApp();
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <ul className={styles.list} aria-label={messages.team.teamsYours}>
      {me.teams.map((team) => {
        const sites = me.sites.filter((site) => site.teamId === team.id).length;
        // Why this one cannot be deleted, when it cannot, said beside it
        // rather than found out by pressing.
        const why =
          team.role !== 'owner'
            ? messages.team.teamDeleteNotOwner
            : team.id === DEFAULT_TEAM
              ? messages.team.teamDeleteDefault
              : sites > 0
                ? messages.team.teamDeleteHasSites
                : null;
        return (
          <li key={team.id} className={styles.member}>
            <div className={styles.who}>
              <span className={styles.name}>{team.name}</span>
              <span className={styles.email}>
                {format(
                  sites === 0
                    ? messages.team.teamLineNone
                    : sites === 1
                      ? messages.team.teamLineOne
                      : messages.team.teamLineSites,
                  { role: roleWord(team.role), count: sites },
                )}
              </span>
            </div>
            <p className={styles.state}>{actions ? (why ?? '') : ''}</p>
            <div className={styles.rowActions}>
              {!actions ? null : confirming === team.id ? (
                <>
                  <span className={styles.note}>
                    {format(messages.team.teamDeleteConfirm, { team: team.name })}
                  </span>
                  <Button
                    disabled={run.busy}
                    onClick={() => {
                      setConfirming(null);
                      void run.go(async () => {
                        await api.deleteTeam(client, team.id);
                        return format(messages.team.teamDeleted, { team: team.name });
                      });
                    }}
                  >
                    {messages.team.teamDelete}
                  </Button>
                  <Button variant="quiet" disabled={run.busy} onClick={() => setConfirming(null)}>
                    {messages.team.teamDeleteNo}
                  </Button>
                </>
              ) : (
                <Button
                  variant="quiet"
                  disabled={run.busy || why !== null}
                  aria-label={format(messages.team.teamDeleteFor, { team: team.name })}
                  onClick={() => setConfirming(team.id)}
                >
                  {messages.team.teamDelete}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MakeTeam({ run }: { run: Run }): JSX.Element {
  const { client } = useApp();
  const [name, setName] = useState('');
  const [missing, setMissing] = useState(false);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    void run.go(async () => {
      const made = await api.createTeam(client, wanted);
      setName('');
      return format(messages.team.teamMade, { team: made.data.team.name });
    });
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <fieldset className={styles.fieldset} disabled={run.busy}>
        <legend className={styles.legend}>{messages.team.teamNew}</legend>
        <Field
          label={messages.team.teamName}
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...(missing ? { problem: messages.team.teamNameProblem } : {})}
        />
        <div className={styles.actions}>
          <Button type="submit" disabled={run.busy}>
            {run.busy ? messages.team.teamMaking : messages.team.teamMake}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function MoveSite({ run }: { run: Run }): JSX.Element {
  const { client, me, site } = useApp();
  const ownsThis = me.teams.some((team) => team.id === site.teamId && team.role === 'owner');
  const others = me.teams.filter((team) => team.role === 'owner' && team.id !== site.teamId);
  const [to, setTo] = useState('');
  const [keys, setKeys] = useState<KeySummary[] | null>(null);
  const chosen = others.find((team) => team.id === to) ?? others[0];

  function move(revokeKeys?: boolean): void {
    if (chosen === undefined) {
      return;
    }
    void run.go(async () => {
      try {
        await api.moveSite(client, site.id, chosen.id, revokeKeys);
      } catch (error) {
        if (error instanceof ChokhError && error.code === 'KEYS_DECISION_REQUIRED') {
          // Asked, and not answered for them.
          setKeys((error.details as { keys?: KeySummary[] } | undefined)?.keys ?? []);
          return '';
        }
        throw error;
      }
      setKeys(null);
      return format(messages.team.moved, { team: chosen.name });
    });
  }

  if (!ownsThis) {
    return <p className={styles.lede}>{messages.team.moveOwnerOnly}</p>;
  }
  if (chosen === undefined) {
    return <p className={styles.lede}>{messages.team.moveNone}</p>;
  }
  return (
    <>
      {keys !== null && (
        <Panel title={messages.team.moveKeysTitle}>
          <p className={styles.note}>{messages.team.moveKeysLede}</p>
          <ul className={styles.plain}>
            {keys.map((key) => (
              <li key={key.id}>
                {format(messages.team.keyLine, {
                  name: key.name,
                  site: site.name,
                  scopes: key.scopes.join(', '),
                })}
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Button disabled={run.busy} onClick={() => move(true)}>
              {messages.team.keysRevoke}
            </Button>
            <Button disabled={run.busy} onClick={() => move(false)}>
              {messages.team.keysKeep}
            </Button>
            <Button variant="quiet" disabled={run.busy} onClick={() => setKeys(null)}>
              {messages.team.keysCancel}
            </Button>
          </div>
        </Panel>
      )}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          move();
        }}
      >
        <fieldset className={styles.fieldset} disabled={run.busy}>
          <legend className={styles.legend}>{messages.team.moveTitle}</legend>
          <p className={styles.note}>{format(messages.team.moveLede, { site: site.name })}</p>
          <SelectField
            label={messages.team.moveTo}
            options={others.map((team) => ({ value: team.id, label: team.name }))}
            value={chosen.id}
            onChange={(event) => setTo(event.target.value)}
          />
          <div className={styles.actions}>
            <Button type="submit" disabled={run.busy}>
              {run.busy ? messages.team.moving : messages.team.moveGo}
            </Button>
          </div>
        </fieldset>
      </form>
    </>
  );
}

export function Teams(): JSX.Element {
  const { client } = useApp();
  const license = useLicense(client);
  const run = useRun();
  const status = license.data?.data;
  const allowed =
    run.lapsed === null &&
    status?.licensed === true &&
    (status.features.includes('*') || status.features.includes(FEATURE));

  return (
    <Card title={messages.team.teamsTitle}>
      <p className={styles.lede}>{messages.team.teamsLede}</p>
      <TeamList run={run} actions={allowed} />
      {allowed ? (
        <>
          {run.problem !== null && (
            <p className={styles.problem} role="alert">
              {run.problem}
            </p>
          )}
          {run.notice !== null && run.notice !== '' && (
            <p className={styles.done} role="status">
              {run.notice}
            </p>
          )}
          <MakeTeam run={run} />
          <MoveSite run={run} />
        </>
      ) : (
        <ProFeature
          title={messages.team.teamsTitle}
          {...(run.lapsed === null ? {} : { reason: run.lapsed })}
        />
      )}
    </Card>
  );
}
