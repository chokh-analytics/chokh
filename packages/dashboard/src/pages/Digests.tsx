import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';
import type { AlertDelivery } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { api, type DigestCadence, type DigestRow } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { formatDateTime } from '../lib/format.js';
import { digestsKey, useDigests } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { SelectField, TextareaField } from '../ui/Field.js';
import { ProFeature } from '../ui/Pro.js';
import { ErrorState, Skeleton } from '../ui/State.js';
import styles from './Alerts.module.css';

// Digests (AN-RPT01, the paid half), on the Alerts page: the list with what
// each one does and what happened last, send now and delete, and the form
// for one more. Gated the way alerts are: on an install with no key the
// section is here, named and described, with nothing to fill in.

const MAX_ADDRESSES = 5;
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HOURS = Array.from({ length: 24 }, (_each, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, '0')}:00`,
}));

function hourWords(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function cadenceWords(cadence: DigestCadence): string {
  return cadence === 'daily' ? messages.digests.cadenceDaily : messages.digests.cadenceWeekly;
}

function scheduleWords(digest: DigestRow): string {
  return digest.cadence === 'daily'
    ? format(messages.digests.daily, { hour: hourWords(digest.hour) })
    : format(messages.digests.weekly, {
        weekday: messages.digests.weekdays[digest.weekday ?? 1] ?? '',
        hour: hourWords(digest.hour),
      });
}

function deliveryWords(delivery: AlertDelivery): string {
  return delivery.ok
    ? format(messages.alerts.deliveredTo, { target: delivery.target })
    : format(messages.alerts.failedTo, { target: delivery.target, error: delivery.error ?? '' });
}

function useRefreshDigests(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  return () => queryClient.invalidateQueries({ queryKey: digestsKey(site.id) });
}

function DigestItem({ digest, owner }: { digest: DigestRow; owner: boolean }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshDigests();
  const timezone = site.settings.timezone;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<AlertDelivery[] | null>(null);

  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteDigest(client, site.id, digest.id);
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      setBusy(false);
    }
  }

  async function sendNow(): Promise<void> {
    setBusy(true);
    setProblem(null);
    setSent(null);
    try {
      const answer = await api.sendDigestNow(client, site.id, digest.id);
      setSent(answer.data.deliveries);
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{cadenceWords(digest.cadence)}</span>
      </div>
      <p className={styles.watches}>{scheduleWords(digest)}</p>
      <p className={styles.channels}>{format(messages.digests.to, { addresses: digest.to.join(', ') })}</p>
      <p className={styles.last}>
        {digest.last === undefined
          ? messages.digests.neverSent
          : format(messages.digests.lastSent, {
              when: formatDateTime(digest.last.at, timezone),
              period: digest.last.period.slice(2),
              delivered: digest.last.deliveries.filter((each) => each.ok).length,
              of: digest.last.deliveries.length,
            })}
      </p>
      {sent !== null && (
        <ul className={styles.outcomes} aria-label={messages.digests.sendOutcomes}>
          {sent.map((delivery, index) => (
            <li key={index} className={delivery.ok ? styles.ok : styles.failed}>
              {deliveryWords(delivery)}
            </li>
          ))}
        </ul>
      )}
      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      {owner &&
        (confirming ? (
          <div className={styles.actions}>
            <span className={styles.note}>
              {format(messages.digests.deleteConfirm, { cadence: cadenceWords(digest.cadence).toLowerCase() })}
            </span>
            <Button onClick={() => void remove()} disabled={busy}>
              {messages.digests.deleteYes}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              {messages.digests.deleteNo}
            </Button>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button variant="quiet" onClick={() => void sendNow()} disabled={busy}>
              {busy ? messages.digests.sending : messages.digests.sendNow}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(true)} disabled={busy}>
              {messages.digests.delete}
            </Button>
          </div>
        ))}
    </li>
  );
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function AddDigest({ mail, needs }: { mail: boolean; needs: string[] }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshDigests();
  const [cadence, setCadence] = useState<DigestCadence>('daily');
  const [addresses, setAddresses] = useState('');
  const [hour, setHour] = useState('8');
  const [weekday, setWeekday] = useState('1');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const to = lines(addresses);
  const addressProblem =
    !tried
      ? undefined
      : to.length === 0
        ? messages.digests.needAddress
        : to.length > MAX_ADDRESSES
          ? messages.digests.tooMany
          : to.some((each) => !ADDRESS.test(each))
            ? messages.digests.badAddress
            : undefined;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (to.length === 0 || to.length > MAX_ADDRESSES || to.some((each) => !ADDRESS.test(each))) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.createDigest(client, site.id, {
        cadence,
        to,
        hour: Number(hour),
        ...(cadence === 'weekly' ? { weekday: Number(weekday) } : {}),
      });
      setAddresses('');
      setTried(false);
      await refresh();
    } catch (error) {
      setProblem(
        error instanceof ChokhError && error.code === 'DIGEST_EXISTS'
          ? format(messages.digests.exists, { cadence: cadenceWords(cadence).toLowerCase() })
          : error instanceof ChokhError
            ? error.message
            : messages.states.error,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <fieldset className={styles.fieldset} disabled={busy || !mail}>
        <legend className="sr-only">{messages.digests.addTitle}</legend>
        {!mail && (
          <p className={styles.note}>
            {format(messages.digests.mailUnavailable, { variable: needs.join(' and ') })}
          </p>
        )}
        <div className={styles.row}>
          <SelectField
            label={messages.digests.cadence}
            value={cadence}
            options={[
              { value: 'daily', label: messages.digests.cadenceDaily },
              { value: 'weekly', label: messages.digests.cadenceWeekly },
            ]}
            onChange={(change) => setCadence(change.target.value === 'weekly' ? 'weekly' : 'daily')}
          />
          <SelectField
            label={format(messages.digests.hour, { zone: site.settings.timezone })}
            value={hour}
            options={HOURS}
            onChange={(change) => setHour(change.target.value)}
          />
          {cadence === 'weekly' && (
            <SelectField
              label={messages.digests.weekday}
              value={weekday}
              options={messages.digests.weekdays.map((name, index) => ({ value: String(index), label: name }))}
              onChange={(change) => setWeekday(change.target.value)}
            />
          )}
        </div>
        <TextareaField
          label={messages.digests.addresses}
          help={messages.digests.addressesHelp}
          rows={3}
          value={addresses}
          onChange={(change) => setAddresses(change.target.value)}
          {...(addressProblem === undefined ? {} : { problem: addressProblem })}
        />
        {problem !== null && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={busy || !mail}>
            {busy ? messages.digests.saving : messages.digests.save}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function Digests({ owner }: { owner: boolean }): JSX.Element {
  const { client, site } = useApp();
  const digests = useDigests(client, site.id);

  if (digests.isPending) {
    return (
      <Card title={messages.digests.title}>
        <div className={styles.loading}>
          {[0, 1].map((index) => (
            <Skeleton key={index} height={48} />
          ))}
        </div>
      </Card>
    );
  }
  if (digests.isError) {
    const error = digests.error;
    const gated =
      error instanceof ChokhError && (error.code === 'LICENSE_REQUIRED' || error.status === 404);
    if (gated) {
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      return (
        <Card title={messages.digests.title}>
          <ProFeature title={messages.digests.title} {...(reason === undefined ? {} : { reason })} />
          <p className={styles.lede}>{messages.digests.describe}</p>
        </Card>
      );
    }
    return (
      <Card title={messages.digests.title}>
        <ErrorState error={error} onRetry={() => digests.refetch()} />
      </Card>
    );
  }

  const rows = digests.data.data.digests;
  const meta = digests.data.meta ?? {};
  const mail = meta['mail'] !== false;
  const needs = Array.isArray(meta['needs']) ? (meta['needs'] as string[]) : [];
  return (
    <>
      <Card title={messages.digests.title}>
        <p className={styles.lede}>{messages.digests.lede}</p>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{messages.digests.empty}</p>
            <p>{messages.digests.emptyLede}</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {rows.map((digest) => (
              <DigestItem key={digest.id} digest={digest} owner={owner} />
            ))}
          </ul>
        )}
      </Card>
      <Card title={messages.digests.addTitle}>
        {owner ? (
          <AddDigest mail={mail} needs={needs} />
        ) : (
          <p className={styles.lede}>{messages.digests.ownerOnly}</p>
        )}
      </Card>
    </>
  );
}
