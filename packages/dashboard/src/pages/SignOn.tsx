import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import { useApp } from '../app/context.js';
import { api } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { navigation } from '../lib/leave.js';
import { ME_STALE_MS, useOidc } from '../lib/queries.js';
import { messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ProFeature } from '../ui/Pro.js';
import styles from './Team.module.css';

// Single sign-on (AN-TEAM01): signing in through an OpenID Connect provider.
// Part of Chokh Pro, and drawn here under AGENTS.md rule 10, because this is
// where somebody signed in reads what the install can do: on an install that
// has it switched off the card is here, named and described, with nothing in
// it to press. The sign-in page itself says nothing about it unless it is
// on; a sign-in page is read by strangers.
//
// With it on, this is where an account connects itself. That is the only way
// an account that already exists comes to be signed in by the provider:
// nobody is found by the address a provider sends, so nobody is connected by
// anybody but themselves, from inside their own session.

function problemOf(error: unknown): string {
  return error instanceof ChokhError ? error.message : messages.states.error;
}

function Connection(): JSX.Element {
  const { client } = useApp();
  const queryClient = useQueryClient();
  const identity = useQuery({
    queryKey: ['oidc-identity'],
    queryFn: () => api.oidcIdentity(client),
    staleTime: ME_STALE_MS,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (identity.isPending) {
    return <p className={styles.lede}>{messages.states.loading}</p>;
  }
  const state = identity.data?.data;
  if (state === undefined) {
    return (
      <p className={styles.problem} role="alert">
        {problemOf(identity.error)}
      </p>
    );
  }

  return (
    <>
      <p className={styles.lede}>
        {!state.connected
          ? messages.team.ssoNotConnected
          : state.canDisconnect
            ? messages.team.ssoConnected
            : messages.team.ssoConnectedOnly}
      </p>
      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      {notice !== null && (
        <p className={styles.done} role="status">
          {notice}
        </p>
      )}
      <div className={[styles.actions, styles.inset].join(' ')}>
        {state.connected ? (
          <Button
            // An account with no password has no other way in, and the
            // sentence above says so.
            disabled={busy || !state.canDisconnect}
            onClick={() =>
              void run(async () => {
                await api.oidcDisconnect(client);
                await queryClient.invalidateQueries({ queryKey: ['oidc-identity'] });
                setNotice(messages.team.ssoDisconnected);
              })
            }
          >
            {messages.team.ssoDisconnect}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // The server answers where to send the browser, and has
                // already left the cookie that will recognise it coming back.
                const begun = await api.oidcLink(client);
                navigation.leave(begun.data.url);
              })
            }
          >
            {busy ? messages.team.ssoWorking : messages.team.ssoConnect}
          </Button>
        )}
      </div>
    </>
  );
}

export function SignOn(): JSX.Element {
  const { client } = useApp();
  const oidc = useOidc(client);
  return (
    <Card title={messages.team.ssoTitle}>
      <p className={styles.lede}>{messages.team.ssoLede}</p>
      {oidc.data?.data.enabled === true ? <Connection /> : <ProFeature title={messages.team.ssoTitle} />}
    </Card>
  );
}
