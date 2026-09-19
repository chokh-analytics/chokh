import { useEffect, useState, type FormEvent, type JSX } from 'react';

import { api, type CreatedSite, type MyTeam } from '../lib/api.js';
import { ChokhError, type Client } from '../lib/client.js';
import { messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Field, SelectField } from '../ui/Field.js';
import { Wordmark } from '../ui/Wordmark.js';
import styles from './FirstRun.module.css';

// Add a site, copy a line, watch it arrive.
//
// The founder's decision of 2026-09-19, and the reason is the ten seconds a
// developer gives an unfamiliar product: an install that signs somebody in and
// shows them an empty screen has lost them before they have read anything. This
// is one form over a route that already exists, plus the snippet, plus an
// indicator that polls the realtime read until the first pageview lands.

const PROTOCOL = /^https?:\/\//i;

// The zone every day boundary of this site will ever be drawn in. It cannot be
// changed once there is a year of rollups filed under it, so it is asked here
// rather than defaulted quietly, and it is prefilled with the browser's own,
// which is right far more often than UTC is.
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

// Every zone this browser knows, which is the same list the server validates
// against: a free text field here accepts "Dhaka" or "GMT+6" and the site is
// then refused, or worse, created with a zone that means something else.
// supportedValuesOf is in every browser this product supports; the fallback is
// for one that is not and for jsdom.
function timezoneOptions(current: string): { value: string; label: string }[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const all = zones.includes(current) ? zones : [current, ...zones];
  return all.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

// Which team a new site belongs to.
//
// Only an owner of the named team may create a site in it, and the server's
// default is the team called default. Somebody the SSO exchange provisioned
// owns a team of their own and not that one, so posting nothing refused them
// with "Only an owner of default may create a site in it" on the one screen a
// fresh install gives them. Their own team is what gets posted.
export function teamToCreateIn(teams: MyTeam[]): MyTeam | null {
  return teams.find((team) => team.role === 'owner') ?? null;
}

function snippetFor(siteId: string): string {
  const origin = typeof location === 'undefined' ? 'https://your-chokh-host' : location.origin;
  return `<script defer src="${origin}/a.js" data-site="${siteId}"></script>`;
}

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1_800);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? messages.sites.snippetCopied : label}
    </Button>
  );
}

// Polls the realtime read until somebody is on the site. Five seconds, stopped
// the moment it succeeds, and stopped by the browser when the tab is hidden.
function useFirstPageview(client: Client, siteId: string, onArrived: () => void): boolean {
  const [arrived, setArrived] = useState(false);

  useEffect(() => {
    if (arrived) {
      return;
    }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (document.hidden) {
        return;
      }
      try {
        const answer = await api.realtime(client, siteId);
        if (!cancelled && (answer.data.online > 0 || answer.data.recent.length > 0)) {
          setArrived(true);
          onArrived();
        }
      } catch {
        // A poll that fails is a poll; the next one is in five seconds.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, siteId, arrived, onArrived]);

  return arrived;
}

function Waiting({
  client,
  site,
  onArrived,
}: {
  client: Client;
  site: CreatedSite;
  onArrived: () => void;
}): JSX.Element {
  const arrived = useFirstPageview(client, site.site.id, onArrived);
  return (
    <p
      className={[styles.waiting, arrived ? styles.received : ''].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
    >
      <span className={[styles.dot, arrived ? styles.dotLive : ''].filter(Boolean).join(' ')} />
      {arrived ? messages.states.firstReceived : messages.states.waitingWatching}
    </p>
  );
}

export interface FirstRunProps {
  client: Client;
  // The teams this person belongs to, from GET /api/me.
  teams: MyTeam[];
  // Called once there is a site to look at, so the shell can ask again who this
  // person is and which sites they can now read.
  onReady: () => void;
}

export function FirstRun({ client, teams, onReady }: FirstRunProps): JSX.Element {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSite | null>(null);
  const team = teamToCreateIn(teams);
  const zones = timezoneOptions(timezone);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.createSite(client, {
        name: name.trim(),
        // A site is identified by its domain and a key minted for it works
        // nowhere else, so a pasted https:// is trimmed rather than refused:
        // it is the form anybody copies out of an address bar.
        domains: [domain.trim().replace(PROTOCOL, '').replace(/\/.*$/, '')],
        ...(team === null ? {} : { teamId: team.id }),
        settings: { timezone },
      });
      setCreated(answer.data);
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
    } finally {
      setBusy(false);
    }
  }

  if (created !== null) {
    return (
      <main className={styles.page}>
        <Wordmark size={28} />
        <div className={styles.card}>
          <h1 className={styles.title}>{messages.sites.snippetTitle}</h1>
          <p className={styles.lede}>{messages.sites.snippetLede}</p>

          <div className={styles.snippet}>
            <pre className={styles.code}>
              <code>{snippetFor(created.site.id)}</code>
            </pre>
            <CopyButton text={snippetFor(created.site.id)} label={messages.sites.copySnippet} />
          </div>

          {/*
            The identify secret leaves the server exactly twice: here, and when
            it is rotated. It is never in a GET, so this is the only chance
            anybody has to keep it, and the card says so rather than letting
            somebody close the page and find out later.
          */}
          <div className={styles.secret}>
            <p className={styles.secretTitle}>{messages.sites.secretTitle}</p>
            <p className={styles.secretLede}>{messages.sites.secretLede}</p>
            <p className={styles.secretValue}>{created.identifySecret}</p>
          </div>

          <Waiting client={client} site={created} onArrived={onReady} />

          <Button variant="primary" onClick={onReady}>
            {messages.overview.title}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <Wordmark size={28} />
      <form className={styles.card} onSubmit={(event) => void submit(event)}>
        <h1 className={styles.title}>{messages.sites.addTitle}</h1>
        <p className={styles.lede}>{messages.sites.addLede}</p>

        <div className={styles.form}>
          <Field
            label={messages.sites.name}
            placeholder={messages.sites.namePlaceholder}
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label={messages.sites.domain}
            placeholder={messages.sites.domainPlaceholder}
            help={messages.sites.domainHelp}
            required
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
          <SelectField
            label={messages.sites.timezone}
            help={messages.sites.timezoneHelp}
            required
            options={zones}
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </div>

        {problem !== null && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}

        <Button type="submit" variant="primary" block disabled={busy}>
          {busy ? messages.sites.creating : messages.sites.create}
        </Button>
      </form>
    </main>
  );
}
