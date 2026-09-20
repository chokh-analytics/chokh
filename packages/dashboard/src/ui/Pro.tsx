import type { JSX } from 'react';

import type { LicenseStatus } from '../lib/api.js';
import { formatDateLong } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import styles from './Pro.module.css';

// A gated feature is described, never simulated and never hidden.
//
// That is AGENTS.md rule 10 and it is the whole of this file. A feature this
// install has not licensed is drawn where it would be, named, with one sentence
// saying what it does and that a licence key turns it on. It is not removed
// from the navigation, it is not a locked rectangle over a screenshot of
// numbers that are not yours, and it is not a modal.
//
// Three reasons, and the first is the honest one. Somebody deciding whether to
// self-host this needs to see the whole shape of the product, including the
// parts they would pay for, before they install it rather than after. Hiding
// them makes the free product look smaller than it is and the paid one look
// like a secret. Second, an install that has a licence and a misconfigured key
// looks identical to one that never bought anything if the feature simply is
// not there, and the person who has to fix that is reading this dashboard.
// Third, a blurred screenshot of invented numbers is a lie on a page whose
// entire promise is that it does not draw numbers nobody measured.

export function ProBadge(): JSX.Element {
  return <span className={styles.badge}>{messages.license.badge}</span>;
}

// Why the server refused, in a sentence a person can act on: buying something,
// renewing something and emailing somebody are different next steps.
const REASONS: Record<string, string> = {
  missing: messages.license.reasonMissing,
  expired: messages.license.reasonExpired,
  not_licensed: messages.license.reasonNotLicensed,
  bad_signature: messages.license.reasonBadSignature,
  malformed: messages.license.reasonMalformed,
  no_issuer: messages.license.reasonNoIssuer,
  unknown_version: messages.license.reasonUnknownVersion,
};

export function reasonText(reason: string | undefined): string | null {
  return reason === undefined ? null : (REASONS[reason] ?? null);
}

export interface ProFeatureProps {
  // What the feature is called, in the words the person reading uses. Named
  // first in the sentence, because what it does matters more than what it
  // costs.
  title: string;
  // Why this install cannot run it, from the server's refusal. Absent when the
  // page knew before it asked.
  reason?: string;
}

// The feature, present and inert, with its name and its reason. Drawn inside
// whatever card the feature would have lived in, so the page keeps its shape.
export function ProFeature({ title, reason }: ProFeatureProps): JSX.Element {
  const why = reasonText(reason);
  return (
    <div className={styles.gated}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        <ProBadge />
      </div>
      <p className={styles.why}>{format(messages.license.gatedHelp, { feature: title })}</p>
      {why !== null && <p className={styles.reason}>{why}</p>}
    </div>
  );
}

// The licence itself, in the account menu.
//
// Three states and not two. No key at all is not a failure and does not read as
// one: the core is the whole product for most people and the line says so. A
// key that has run out keeps the licensee and the date, because "Chokh Pro
// expired on 20 September" and "you have never had a licence" are different
// sentences, and a renewal is a different conversation from a purchase.
export function LicenseLine({
  license,
  timeZone,
}: {
  license: LicenseStatus | null;
  timeZone: string;
}): JSX.Element {
  if (license === null || (license.licensee === null && !license.licensed)) {
    return (
      <div className={styles.status}>
        <span>{messages.license.none}</span>
      </div>
    );
  }

  const date =
    license.expiresAt === null ? null : formatDateLong(license.expiresAt, timeZone);

  if (!license.licensed) {
    return (
      <div className={styles.status}>
        <span className={styles.statusExpired}>
          {date === null ? messages.license.pro : format(messages.license.expired, { date })}
        </span>
        {license.licensee !== null && <span>{license.licensee}</span>}
      </div>
    );
  }

  return (
    <div className={styles.status}>
      <span className={styles.statusTier}>
        {format(messages.license.licensedTo, { licensee: license.licensee ?? messages.license.pro })}
      </span>
      {date !== null && <span>{format(messages.license.until, { date })}</span>}
    </div>
  );
}
