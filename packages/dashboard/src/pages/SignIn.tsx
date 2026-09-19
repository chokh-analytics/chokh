import { useState, type FormEvent, type JSX } from 'react';
import { useSearch } from 'wouter';

import { api } from '../lib/api.js';
import { ChokhError, type Client } from '../lib/client.js';
import { messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Wordmark } from '../ui/Wordmark.js';
import styles from './SignIn.module.css';

// Signing in, and creating the account that owns the install.
//
// One component for both, because they are the same card with two verbs, and
// because the second one exists for exactly one moment in the life of an
// install: the first time anybody opens it. POST /api/auth/register is open
// while there is nobody and refuses everybody afterwards, so the page does not
// ask the server which mode it is in. It offers the link, and the server's own
// refusal is what the person reads if they take it by mistake. One message
// beats one more public route that says how far along somebody else's install
// is.

// Why an SSO hop landed here instead of on the dashboard. The server redirects
// with its own code in the query string rather than putting a JSON body in the
// address bar.
function ssoNotice(code: string | null): string | null {
  if (code === null) {
    return null;
  }
  return code === 'TOKEN_EXPIRED' ? messages.auth.ssoExpired : messages.auth.ssoRefused;
}

export interface SignInProps {
  client: Client;
  // Called once the session cookie is set, so the shell can ask who this is.
  onSignedIn: () => void;
  mode?: 'signIn' | 'register';
  onModeChange?: (mode: 'signIn' | 'register') => void;
}

export function SignIn({
  client,
  onSignedIn,
  mode = 'signIn',
  onModeChange,
}: SignInProps): JSX.Element {
  const search = useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const registering = mode === 'register';
  const sso = ssoNotice(new URLSearchParams(search).get('sso'));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      if (registering) {
        await api.register(client, {
          email,
          password,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
        });
      } else {
        await api.signIn(client, email, password);
      }
      onSignedIn();
    } catch (error) {
      // The server's own message, whatever the refusal was. Login is
      // deliberately constant time and says the same thing whether or not the
      // address exists, the rate limiter says it is a rate limiter, and
      // registration after the first account says the install already has an
      // owner. All three are written to be read, and improving on them here
      // would mean a second copy of a sentence to keep in step.
      setNotice(error instanceof ChokhError ? error.message : messages.states.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.head}>
        <Wordmark size={28} />
        <p className={styles.lede}>
          {registering ? messages.auth.createLede : messages.auth.signInLede}
        </p>
      </div>

      <form className={styles.card} onSubmit={(event) => void submit(event)}>
        <h1 className={styles.title}>
          {registering ? messages.auth.createTitle : messages.auth.signInTitle}
        </h1>

        {(notice ?? sso) !== null && (
          <p className={styles.notice} role="status" aria-live="polite">
            {notice ?? sso}
          </p>
        )}

        {registering && (
          <Field
            label={messages.auth.name}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}

        <Field
          label={messages.auth.email}
          type="email"
          required
          autoComplete="username"
          // The one field anybody wants their cursor in when this page opens.
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <Field
          label={messages.auth.password}
          type="password"
          required
          autoComplete={registering ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <div className={styles.actions}>
          <Button type="submit" variant="primary" block disabled={busy}>
            {busy
              ? messages.auth.signingIn
              : registering
                ? messages.auth.create
                : messages.auth.signIn}
          </Button>

          {onModeChange !== undefined && (
            <p className={styles.aside}>
              {registering ? (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => onModeChange('signIn')}
                >
                  {messages.auth.backToSignIn}
                </button>
              ) : (
                <>
                  {messages.auth.firstAccountPrompt}{' '}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => onModeChange('register')}
                  >
                    {messages.auth.firstAccountLink}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </form>
    </main>
  );
}
