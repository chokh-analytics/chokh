import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { Link } from 'wouter';

import { api, type InvitationPreview, type InvitationScope, type PublicUser } from '../lib/api.js';
import { ChokhError, type Client } from '../lib/client.js';
import { formatDateLong } from '../lib/format.js';
import { forgetInviteToken, inviteToken, onInviteToken } from '../lib/invite-token.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Skeleton } from '../ui/State.js';
import { Wordmark } from '../ui/Wordmark.js';
import styles from './Invite.module.css';

// The page an invitation link opens (AN-TEAM01).
//
// The link is /invite#<token>. By the time this component runs the token is
// no longer in the address bar: it was taken off before anything else ran
// (index.html, lib/invite-token.ts) and is held in memory. This page reads it
// from there, posts it in a body to ask what the invitation is for, and posts
// it once more to use it. It is never put in a URL, a query, a storage area
// or a cache key, so a reload forgets it, and the page says so.
//
// Who may use an invitation is the server's rule and the page only follows
// it. An address with no account yet makes one, with a password the person
// chooses here. An address that already has an account is accepted by that
// account, signed in, and nobody else, so the sign-in form for it is on this
// page: sending somebody to /login would lose the link they arrived with.

const MIN_PASSWORD = 12;

// Whoever is signed in at this browser, or null. A 401 is the ordinary answer
// for somebody arriving by a link, not a failure.
async function whoIsHere(client: Client): Promise<PublicUser | null> {
  try {
    return (await api.me(client)).data.user;
  } catch {
    return null;
  }
}

function problemOf(error: unknown): string {
  return error instanceof ChokhError ? error.message : messages.states.error;
}

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export interface InviteProps {
  client: Client;
  // Called once the invitation has been used and the person is signed in,
  // with where it let them in.
  onAccepted: (scope: InvitationScope) => void;
}

type Loaded =
  | { state: 'reading' }
  | { state: 'refused'; message: string }
  | { state: 'ready'; preview: InvitationPreview; user: PublicUser | null }
  | { state: 'done' };

export function Invite({ client, onAccepted }: InviteProps): JSX.Element {
  // The module keeps it; this component only borrows it.
  const [token, setToken] = useState(() => inviteToken());
  const [loaded, setLoaded] = useState<Loaded>({ state: 'reading' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const asked = useRef<string | null>(null);

  // The link opened again in this same tab: a new token, and the page starts
  // over with it.
  useEffect(
    () =>
      onInviteToken(() => {
        setToken(inviteToken());
        setLoaded({ state: 'reading' });
        setNotice(null);
        setPassword('');
      }),
    [],
  );

  useEffect(() => {
    // Once for each token, also where an effect is run twice to look for
    // mistakes: a lookup counts against the address's attempts.
    if (token === null || asked.current === token) {
      return;
    }
    asked.current = token;
    void (async () => {
      try {
        const [preview, user] = await Promise.all([
          api.lookupInvitation(client, token),
          whoIsHere(client),
        ]);
        // An answer about a link that has since been replaced is not shown.
        if (asked.current !== token) return;
        setLoaded({ state: 'ready', preview: preview.data.invitation, user });
      } catch (error) {
        if (asked.current !== token) return;
        setLoaded({ state: 'refused', message: problemOf(error) });
      }
    })();
  }, [client, token]);

  async function accept(body: { password?: string; name?: string }): Promise<void> {
    if (token === null) {
      return;
    }
    const answer = await api.acceptInvitation(client, { token, ...body });
    // Used, so there is nothing left to hold.
    forgetInviteToken();
    setLoaded({ state: 'done' });
    onAccepted(answer.data.scope);
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  function frame(children: JSX.Element | (JSX.Element | false | null)[]): JSX.Element {
    return (
      <main className={styles.page}>
        <div className={styles.head}>
          <Wordmark size={28} />
        </div>
        <div className={styles.card}>
          <h1 className={styles.title}>{messages.invite.title}</h1>
          {children}
        </div>
      </main>
    );
  }

  if (token === null) {
    return frame([
      <p key="why" className={styles.text}>
        {messages.invite.noToken}
      </p>,
      <Link key="in" to="/login" className={styles.link}>
        {messages.invite.goToSignIn}
      </Link>,
    ]);
  }

  if (loaded.state === 'reading') {
    return frame(
      <div role="status" aria-label={messages.invite.reading} className={styles.reading}>
        <Skeleton height={18} />
        <Skeleton height={18} width="70%" />
        <Skeleton height={36} />
      </div>,
    );
  }

  if (loaded.state === 'refused') {
    return frame([
      <p key="why" className={styles.notice} role="alert">
        {loaded.message}
      </p>,
      <p key="help" className={styles.text}>
        {messages.invite.refusedHelp}
      </p>,
      <Link key="in" to="/login" className={styles.link}>
        {messages.invite.goToSignIn}
      </Link>,
    ]);
  }

  if (loaded.state === 'done') {
    return frame(
      <p className={styles.text} role="status">
        {messages.invite.done}
      </p>,
    );
  }

  const { preview, user } = loaded;
  const what = format(
    preview.scope.kind === 'team' ? messages.invite.whatTeam : messages.invite.whatSite,
    {
      invitedBy: preview.invitedBy,
      email: preview.email,
      name: preview.scope.name,
      role:
        preview.role === 'owner'
          ? messages.team.roleOwner
          : preview.role === 'editor'
            ? messages.team.roleEditor
            : messages.team.roleViewer,
    },
  );
  const about = [
    <p key="what" className={styles.what}>
      {what}
    </p>,
    preview.identity && (
      <p key="identity" className={styles.text}>
        {messages.invite.identityToo}
      </p>
    ),
    <p key="expires" className={styles.text}>
      {format(messages.invite.expires, {
        // The reader's own calendar: they have no site yet whose zone to use.
        when: formatDateLong(
          preview.expiresAt,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
      })}
    </p>,
    notice !== null && (
      <p key="notice" className={styles.notice} role="alert">
        {notice}
      </p>
    ),
  ];

  // Signed in as somebody this invitation is not for. The server would refuse
  // either way (an account is not made from inside another's session, and an
  // invitation is accepted only by its own address), so the page says which
  // account is here and offers the way out.
  if (user !== null && !sameAddress(user.email, preview.email)) {
    return frame([
      ...about,
      <p key="other" className={styles.text}>
        {format(messages.invite.otherAccount, { email: preview.email, other: user.email })}
      </p>,
      <Button
        key="out"
        block
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await api.signOut(client);
            setLoaded({ state: 'ready', preview, user: null });
          })
        }
      >
        {messages.invite.signOut}
      </Button>,
    ]);
  }

  // The account the invitation is for, signed in already.
  if (user !== null) {
    return frame([
      ...about,
      <p key="as" className={styles.text}>
        {format(messages.invite.signedInAs, { email: user.email })}
      </p>,
      <Button key="go" variant="primary" block disabled={busy} onClick={() => void run(() => accept({}))}>
        {busy ? messages.invite.accepting : messages.invite.accept}
      </Button>,
    ]);
  }

  // An address that has an account: that account signs in here and accepts.
  if (preview.accountExists) {
    const submit = (event: FormEvent): void => {
      event.preventDefault();
      void run(async () => {
        await api.signIn(client, preview.email, password);
        await accept({});
      });
    };
    return frame([
      ...about,
      <form key="form" className={styles.form} onSubmit={submit}>
        <p className={styles.text}>{format(messages.invite.existing, { email: preview.email })}</p>
        <Field
          label={messages.auth.email}
          type="email"
          autoComplete="username"
          readOnly
          value={preview.email}
        />
        <Field
          label={messages.invite.currentPassword}
          type="password"
          required
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" variant="primary" block disabled={busy}>
          {busy ? messages.invite.accepting : messages.invite.signInAndAccept}
        </Button>
      </form>,
    ]);
  }

  // Nobody has this address yet: the person chooses a password and the
  // account is theirs. The owner who invited them never knew it.
  const create = (event: FormEvent): void => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setShort(true);
      return;
    }
    setShort(false);
    void run(() =>
      accept({ password, ...(name.trim() === '' ? {} : { name: name.trim() }) }),
    );
  };
  return frame([
    ...about,
    <form key="form" className={styles.form} onSubmit={create} noValidate>
      <p className={styles.text}>{messages.invite.newAccount}</p>
      <Field
        label={messages.auth.email}
        type="email"
        autoComplete="username"
        readOnly
        value={preview.email}
      />
      <Field
        label={messages.invite.name}
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Field
        label={messages.invite.password}
        type="password"
        required
        autoComplete="new-password"
        autoFocus
        help={messages.invite.passwordHelp}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        {...(short ? { problem: messages.invite.passwordShort } : {})}
      />
      <Button type="submit" variant="primary" block disabled={busy}>
        {busy ? messages.invite.accepting : messages.invite.createAndAccept}
      </Button>
    </form>,
  ]);
}
