import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LicenseStatus } from '../lib/api.js';
import { ChokhError, licenseRefusal } from '../lib/client.js';
import { LicenseLine, ProBadge, ProFeature, reasonText } from './Pro.js';

// A gated feature is described, never simulated and never hidden (AGENTS.md
// rule 10).
//
// The case that matters most is the last one in the first block: it fails if
// somebody ever "tidies up" by removing a gated control instead of labelling
// it. That is the whole rule, and a rule with no test is a paragraph.

const TZ = 'Asia/Dhaka';

function status(over: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    licensed: true,
    plan: 'pro',
    licensee: 'A Test Company Ltd.',
    expiresAt: Date.UTC(2027, 8, 20),
    features: ['*'],
    ...over,
  };
}

describe('a feature this install has not licensed', () => {
  it('names the feature, labels it, and says what turns it on', () => {
    render(<ProFeature title="Alerts" reason="missing" />);

    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(
      screen.getByText('Alerts is part of Chokh Pro. It is here, and a licence key turns it on.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This install has no licence key.')).toBeInTheDocument();
  });

  // Buying something, renewing something and emailing somebody are different
  // next steps, so the refusal is not one sentence for all of them.
  it.each([
    ['missing', 'This install has no licence key.'],
    ['expired', 'The licence key on this install has expired.'],
    ['not_licensed', 'The licence key on this install does not include this feature.'],
    ['bad_signature', 'The licence key on this install was not issued for Chokh.'],
    ['no_issuer', 'This build carries no licence issuer, so no key can be used with it.'],
  ])('explains %s in words somebody can act on', (reason, sentence) => {
    render(<ProFeature title="Alerts" reason={reason} />);
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('says nothing about a reason it does not recognise, rather than guessing', () => {
    render(<ProFeature title="Alerts" reason="something-new" />);

    expect(screen.getByText('Part of Chokh Pro')).toBeInTheDocument();
    expect(reasonText('something-new')).toBeNull();
  });

  // The rule, made mechanical. Removing a gated control instead of labelling it
  // is the one change this file exists to fail.
  it('is on the page, not removed from it', () => {
    const { container } = render(<ProFeature title="Session replay" />);

    expect(container.textContent).toContain('Session replay');
    expect(within(container).getByText('Part of Chokh Pro')).toBeVisible();
    // And no blurred screenshot of numbers nobody measured, which is the other
    // way to get this wrong: nothing here draws a value.
    expect(container.querySelectorAll('img, canvas, svg')).toHaveLength(0);
  });

  it('draws the badge on its own where a row or a tab needs one', () => {
    render(<ProBadge />);
    expect(screen.getByText('Part of Chokh Pro')).toBeInTheDocument();
  });
});

describe('the licence line in the account menu', () => {
  it('names the licensee and the date on a licensed install', () => {
    render(<LicenseLine license={status()} timeZone={TZ} />);

    expect(screen.getByText('Chokh Pro, licensed to A Test Company Ltd.')).toBeInTheDocument();
    expect(screen.getByText('Until 20 September 2027')).toBeInTheDocument();
  });

  // A renewal is a different conversation from a purchase, so an install whose
  // key ran out is told the date rather than "you have never had a licence".
  it('says when a key expired, and whose it was', () => {
    render(
      <LicenseLine license={status({ licensed: false, features: [] })} timeZone={TZ} />,
    );

    expect(screen.getByText('Chokh Pro expired on 20 September 2027')).toBeInTheDocument();
    expect(screen.getByText('A Test Company Ltd.')).toBeInTheDocument();
  });

  // Not an apology and not an advertisement. The core is the whole product for
  // most people and this line reads that way.
  it('tells an install with no key that what it has is free for ever', () => {
    render(
      <LicenseLine
        license={{ licensed: false, plan: null, licensee: null, expiresAt: null, features: [] }}
        timeZone={TZ}
      />,
    );

    expect(
      screen.getByText('No licence key. Everything you can see is free to self-host, for ever.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/expired/)).toBeNull();
  });

  // The read can fail, and a failed read of the licence is not something
  // anybody has to see: the worst case is a label shown where it was not
  // needed.
  it('says the same thing when the licence could not be read at all', () => {
    render(<LicenseLine license={null} timeZone={TZ} />);
    expect(screen.getByText(/free to self-host/)).toBeInTheDocument();
  });
});

describe('a LICENSE_REQUIRED answer reaching the client', () => {
  it('is read as a feature and a reason rather than as an error', () => {
    const error = new ChokhError(403, 'LICENSE_REQUIRED', 'This install has no licence key', {
      feature: 'alerts',
      reason: 'missing',
    });

    expect(licenseRefusal(error)).toEqual({ feature: 'alerts', reason: 'missing' });
  });

  it.each([
    ['an ordinary failure', new ChokhError(500, 'INTERNAL_ERROR', 'boom')],
    [
      'a refusal with no details',
      new ChokhError(403, 'LICENSE_REQUIRED', 'This install has no licence key'),
    ],
    ['something that is not an error at all', 'nope'],
  ])('is not read out of %s', (_name, error) => {
    expect(licenseRefusal(error)).toBeNull();
  });
});
