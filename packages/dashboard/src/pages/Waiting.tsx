import { useEffect, useState, type JSX } from 'react';

import { api } from '../lib/api.js';
import type { Client } from '../lib/client.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import styles from './Waiting.module.css';

// A site that has never been visited, on its own Overview.
//
// The second of the three empty states the plan names, and the one the Overview
// was missing: a site with nothing in it showed a row of zeros, three tiles
// reading "not avai…" and a chart axis of 1, 1, 0. Every one of those is a
// measurement, and the site has not been measured. What somebody at this point
// needs is the line of script and a reason to believe it is working, which is
// what the first run screen gives them and what they lose the moment a site
// exists.

export function snippetFor(siteId: string, origin: string): string {
  return `<script defer src="${origin}/a.js" data-site="${siteId}"></script>`;
}

function CopySnippet({ text }: { text: string }): JSX.Element {
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
      {copied ? messages.sites.snippetCopied : messages.sites.copySnippet}
    </Button>
  );
}

// Polls until somebody is on the site, then tells the page to ask again. Five
// seconds, stopped the moment it succeeds and while the tab is hidden.
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

export interface WaitingProps {
  client: Client;
  siteId: string;
  domain: string;
  origin: string;
  onArrived: () => void;
}

export function Waiting({
  client,
  siteId,
  domain,
  origin,
  onArrived,
}: WaitingProps): JSX.Element {
  const arrived = useFirstPageview(client, siteId, onArrived);
  const snippet = snippetFor(siteId, origin);

  return (
    <section className={styles.panel}>
      <h2 className={styles.title}>{messages.states.waitingTitle}</h2>
      <p className={styles.lede}>{format(messages.states.waitingLede, { domain })}</p>

      <div className={styles.snippet}>
        <pre className={styles.code}>
          <code>{snippet}</code>
        </pre>
        <CopySnippet text={snippet} />
      </div>

      <p
        className={[styles.waiting, arrived ? styles.received : ''].filter(Boolean).join(' ')}
        role="status"
        aria-live="polite"
      >
        <span className={[styles.dot, arrived ? styles.dotLive : ''].filter(Boolean).join(' ')} />
        {arrived ? messages.states.firstReceived : messages.states.waitingWatching}
      </p>
    </section>
  );
}
