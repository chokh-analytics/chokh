import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';
import {
  ALERT_WINDOWS,
  MAX_ALERTS_PER_SITE,
  MAX_ALERT_CHANNELS,
  type AlertChannel,
  type AlertChannelKind,
  type AlertCondition,
  type AlertDelivery,
  type AlertKind,
  type AlertWindow,
} from '@chokh/store/contract';

import { isOwner, useApp } from '../app/context.js';
import { api, type AlertRow } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { formatDateTime } from '../lib/format.js';
import { alertsKey, useAlerts, useGoals } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField } from '../ui/Field.js';
import { ProFeature } from '../ui/Pro.js';
import { ErrorState, Skeleton } from '../ui/State.js';
import styles from './Alerts.module.css';

// Alerts: a question asked of the numbers every five minutes, and a message
// when the answer changes. The first paid feature, and the first page drawn
// under AGENTS.md rule 10: on an install with no licence it is here, named,
// described in words, and inert, never blurred and never missing.
//
// The page asks the list once. A 403 LICENSE_REQUIRED, or a 404 on a build
// with no packages/ee at all, draws the feature described with the server's
// reason; a 200 draws the list, the test and delete controls for an owner,
// and the form. Adding, deleting and testing need the admin scope, which only
// an owner holds, because an alert sends messages out of the product.

function useRefreshAlerts(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  return () => queryClient.invalidateQueries({ queryKey: alertsKey(site.id) });
}

function channelWords(channel: AlertChannel): string {
  switch (channel.kind) {
    case 'email':
      return format(messages.alerts.channelEmail, { to: channel.to });
    case 'telegram':
      return format(messages.alerts.channelTelegram, { chatId: channel.chatId });
    case 'webhook': {
      let host = channel.url;
      try {
        host = new URL(channel.url).host;
      } catch {
        // Kept as typed.
      }
      return format(messages.alerts.channelWebhook, { host });
    }
  }
}

function deliveryWords(delivery: AlertDelivery): string {
  return delivery.ok
    ? format(messages.alerts.deliveredTo, { target: delivery.target })
    : format(messages.alerts.failedTo, { target: delivery.target, error: delivery.error ?? '' });
}

function AlertItem({ alert, owner }: { alert: AlertRow; owner: boolean }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshAlerts();
  const timezone = site.settings.timezone;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<AlertDelivery[] | null>(null);
  const last = alert.recent[alert.recent.length - 1];

  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteAlert(client, site.id, alert.id);
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    setProblem(null);
    setTested(null);
    try {
      const answer = await api.testAlert(client, site.id, alert.id);
      setTested(answer.data.deliveries);
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{alert.name}</span>
        <span className={alert.state.firing ? styles.firing : styles.quiet}>
          {alert.state.firing
            ? format(messages.alerts.firingSince, {
                when: formatDateTime(alert.state.since ?? 0, timezone),
              })
            : messages.alerts.quiet}
        </span>
      </div>
      <p className={styles.watches}>{alert.watches}</p>
      <p className={styles.channels}>{alert.channels.map(channelWords).join(', ')}</p>
      {last !== undefined && (
        <p className={styles.last}>
          {format(last.event === 'fired' ? messages.alerts.lastFired : messages.alerts.lastRecovered, {
            when: formatDateTime(last.at, timezone),
            delivered: last.deliveries.filter((each) => each.ok).length,
            of: last.deliveries.length,
          })}
        </p>
      )}
      {tested !== null && (
        <ul className={styles.outcomes} aria-label={messages.alerts.testOutcomes}>
          {tested.map((delivery, index) => (
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
            <span className={styles.note}>{format(messages.alerts.deleteConfirm, { name: alert.name })}</span>
            <Button onClick={() => void remove()} disabled={busy}>
              {messages.alerts.deleteYes}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              {messages.alerts.deleteNo}
            </Button>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button variant="quiet" onClick={() => void test()} disabled={busy}>
              {busy ? messages.alerts.testing : messages.alerts.test}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(true)} disabled={busy}>
              {messages.alerts.delete}
            </Button>
          </div>
        ))}
    </li>
  );
}

interface ChannelDraft {
  kind: AlertChannelKind;
  target: string;
  secret: string;
}

const WINDOW_OPTIONS = ALERT_WINDOWS.map((window) => ({
  value: String(window),
  label: messages.alerts.windows[window],
}));

function channelOf(draft: ChannelDraft): AlertChannel {
  switch (draft.kind) {
    case 'email':
      return { kind: 'email', to: draft.target.trim() };
    case 'telegram':
      return { kind: 'telegram', chatId: draft.target.trim() };
    case 'webhook':
      return {
        kind: 'webhook',
        url: draft.target.trim(),
        ...(draft.secret.trim() === '' ? {} : { secret: draft.secret.trim() }),
      };
  }
}

function AddAlert({ available }: { available: AlertChannelKind[] }): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshAlerts();
  const goals = useGoals(client, site.id);
  const goalList = goals.data?.data.goals ?? [];
  const firstKind = available[0] ?? 'webhook';

  const [name, setName] = useState('');
  const [kind, setKind] = useState<AlertKind>('traffic');
  const [metric, setMetric] = useState<'visitors' | 'pageviews'>('visitors');
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [percent, setPercent] = useState('50');
  const [minimum, setMinimum] = useState('20');
  const [goalId, setGoalId] = useState('');
  const [goalDirection, setGoalDirection] = useState<'above' | 'below'>('below');
  const [count, setCount] = useState('1');
  const [window, setWindow] = useState<AlertWindow>(60);
  const [statuses, setStatuses] = useState<'4xx' | '5xx' | 'any'>('5xx');
  const [minutes, setMinutes] = useState('30');
  const [channels, setChannels] = useState<ChannelDraft[]>([{ kind: firstKind, target: '', secret: '' }]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const chosenGoal = goalId === '' ? (goalList[0]?.id ?? '') : goalId;
  const missingName = tried && name.trim() === '';
  const missingGoal = tried && kind === 'goal' && chosenGoal === '';
  const missingTarget = tried && channels.some((channel) => channel.target.trim() === '');

  function condition(): AlertCondition {
    switch (kind) {
      case 'traffic':
        return { kind, metric, direction, percent: Number(percent), minimum: Number(minimum) };
      case 'goal':
        return { kind, goalId: chosenGoal, direction: goalDirection, count: Number(count), window };
      case 'errors':
        return { kind, statuses, count: Number(count), window };
      case 'silence':
        return { kind, minutes: Number(minutes) };
    }
  }

  function setChannel(index: number, patch: Partial<ChannelDraft>): void {
    setChannels((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (name.trim() === '' || (kind === 'goal' && chosenGoal === '') || channels.some((c) => c.target.trim() === '')) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.createAlert(client, site.id, {
        name: name.trim(),
        condition: condition(),
        channels: channels.map(channelOf),
      });
      setName('');
      setTried(false);
      await refresh();
    } catch (error) {
      setProblem(
        error instanceof ChokhError && error.code === 'ALERT_EXISTS'
          ? messages.alerts.exists
          : error instanceof ChokhError && error.code === 'ALERT_LIMIT'
            ? format(messages.alerts.limit, { max: MAX_ALERTS_PER_SITE })
            : error instanceof ChokhError
              ? error.message
              : messages.states.error,
      );
    } finally {
      setBusy(false);
    }
  }

  const kindOptions = (['traffic', 'goal', 'errors', 'silence'] as const).map((each) => ({
    value: each,
    label: messages.alerts.kinds[each],
  }));
  const channelOptions = available.map((each) => ({ value: each, label: messages.alerts.channelKinds[each] }));
  const missingKinds = (['email', 'telegram'] as const).filter((each) => !available.includes(each));

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className="sr-only">{messages.alerts.addTitle}</legend>
        <Field
          label={messages.alerts.name}
          placeholder={messages.alerts.namePlaceholder}
          maxLength={100}
          value={name}
          onChange={(change) => setName(change.target.value)}
          {...(missingName ? { problem: messages.alerts.required } : {})}
        />
        <SelectField
          label={messages.alerts.kind}
          value={kind}
          options={kindOptions}
          help={messages.alerts.kindHelp[kind]}
          onChange={(change) => setKind(change.target.value as AlertKind)}
        />

        {kind === 'traffic' && (
          <div className={styles.row}>
            <SelectField
              label={messages.alerts.metric}
              value={metric}
              options={[
                { value: 'visitors', label: messages.metrics.visitors },
                { value: 'pageviews', label: messages.metrics.pageviews },
              ]}
              onChange={(change) => setMetric(change.target.value === 'pageviews' ? 'pageviews' : 'visitors')}
            />
            <SelectField
              label={messages.alerts.direction}
              value={direction}
              options={[
                { value: 'down', label: messages.alerts.directionDown },
                { value: 'up', label: messages.alerts.directionUp },
              ]}
              onChange={(change) => setDirection(change.target.value === 'up' ? 'up' : 'down')}
            />
            <Field
              label={messages.alerts.percent}
              type="number"
              min={20}
              max={1000}
              inputMode="numeric"
              value={percent}
              onChange={(change) => setPercent(change.target.value)}
            />
            <Field
              label={messages.alerts.minimum}
              help={messages.alerts.minimumHelp}
              type="number"
              min={1}
              inputMode="numeric"
              value={minimum}
              onChange={(change) => setMinimum(change.target.value)}
            />
          </div>
        )}

        {kind === 'goal' && (
          <div className={styles.row}>
            <SelectField
              label={messages.alerts.goal}
              value={chosenGoal}
              options={goalList.map((goal) => ({ value: goal.id, label: goal.name }))}
              onChange={(change) => setGoalId(change.target.value)}
              {...(missingGoal ? { problem: messages.alerts.noGoals } : {})}
              {...(goalList.length === 0 ? { help: messages.alerts.noGoals } : {})}
            />
            <SelectField
              label={messages.alerts.direction}
              value={goalDirection}
              options={[
                { value: 'below', label: messages.alerts.goalBelow },
                { value: 'above', label: messages.alerts.goalAbove },
              ]}
              onChange={(change) => setGoalDirection(change.target.value === 'above' ? 'above' : 'below')}
            />
            <Field
              label={messages.alerts.count}
              type="number"
              min={1}
              inputMode="numeric"
              value={count}
              onChange={(change) => setCount(change.target.value)}
            />
            <SelectField
              label={messages.alerts.window}
              value={String(window)}
              options={WINDOW_OPTIONS}
              onChange={(change) => setWindow(Number(change.target.value) as AlertWindow)}
            />
          </div>
        )}

        {kind === 'errors' && (
          <div className={styles.row}>
            <SelectField
              label={messages.alerts.statuses}
              value={statuses}
              options={[
                { value: '5xx', label: messages.alerts.statuses5xx },
                { value: '4xx', label: messages.alerts.statuses4xx },
                { value: 'any', label: messages.alerts.statusesAny },
              ]}
              onChange={(change) =>
                setStatuses(change.target.value === '4xx' ? '4xx' : change.target.value === 'any' ? 'any' : '5xx')
              }
            />
            <Field
              label={messages.alerts.count}
              type="number"
              min={1}
              inputMode="numeric"
              value={count}
              onChange={(change) => setCount(change.target.value)}
            />
            <SelectField
              label={messages.alerts.window}
              value={String(window)}
              options={WINDOW_OPTIONS}
              onChange={(change) => setWindow(Number(change.target.value) as AlertWindow)}
            />
          </div>
        )}

        {kind === 'silence' && (
          <div className={styles.row}>
            <Field
              label={messages.alerts.minutes}
              help={messages.alerts.minutesHelp}
              type="number"
              min={5}
              max={1440}
              inputMode="numeric"
              value={minutes}
              onChange={(change) => setMinutes(change.target.value)}
            />
          </div>
        )}

        <div className={styles.channelsHead}>
          <span className={styles.label}>{messages.alerts.channels}</span>
          <span className={styles.help}>
            {missingKinds.length === 0
              ? messages.alerts.channelsHelpAll
              : format(messages.alerts.channelsHelpMissing, {
                  kinds: missingKinds.map((each) => messages.alerts.channelKinds[each]).join(', '),
                })}
          </span>
        </div>
        {channels.map((channel, index) => (
          <div key={index} className={styles.channel}>
            <SelectField
              label={format(messages.alerts.channelKind, { n: index + 1 })}
              value={channel.kind}
              options={channelOptions}
              onChange={(change) => setChannel(index, { kind: change.target.value as AlertChannelKind, target: '' })}
            />
            <Field
              label={messages.alerts.channelTarget[channel.kind]}
              placeholder={messages.alerts.channelPlaceholder[channel.kind]}
              type={channel.kind === 'email' ? 'email' : channel.kind === 'webhook' ? 'url' : 'text'}
              value={channel.target}
              onChange={(change) => setChannel(index, { target: change.target.value })}
              {...(missingTarget && channel.target.trim() === '' ? { problem: messages.alerts.required } : {})}
            />
            {channel.kind === 'webhook' && (
              <Field
                label={messages.alerts.secret}
                help={messages.alerts.secretHelp}
                value={channel.secret}
                onChange={(change) => setChannel(index, { secret: change.target.value })}
              />
            )}
            {channels.length > 1 && (
              <div>
                <Button
                  variant="quiet"
                  onClick={() => setChannels((rows) => rows.filter((_, at) => at !== index))}
                >
                  {messages.alerts.removeChannel}
                </Button>
              </div>
            )}
          </div>
        ))}
        {channels.length < MAX_ALERT_CHANNELS && (
          <div>
            <Button
              variant="quiet"
              onClick={() => setChannels((rows) => [...rows, { kind: firstKind, target: '', secret: '' }])}
            >
              {messages.alerts.addChannel}
            </Button>
          </div>
        )}

        {problem !== null && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? messages.alerts.saving : messages.alerts.save}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

// What the feature is, in words, for an install that has not licensed it and
// for the top of the page on one that has.
function Description(): JSX.Element {
  return (
    <div className={styles.describe}>
      <p className={styles.lede}>{messages.alerts.lede}</p>
      <ul className={styles.kindList}>
        {(['traffic', 'goal', 'errors', 'silence'] as const).map((each) => (
          <li key={each}>
            <span className={styles.kindName}>{messages.alerts.kinds[each]}</span>{' '}
            {messages.alerts.kindHelp[each]}
          </li>
        ))}
      </ul>
      <p className={styles.lede}>{messages.alerts.channelsLede}</p>
    </div>
  );
}

export function Alerts(): JSX.Element {
  const { client, site, me } = useApp();
  const owner = isOwner(me.teams, site.teamId);
  const alerts = useAlerts(client, site.id);

  let body: JSX.Element;
  if (alerts.isPending) {
    body = (
      <Card title={messages.alerts.title}>
        <div className={styles.loading}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={48} />
          ))}
        </div>
      </Card>
    );
  } else if (alerts.isError) {
    const error = alerts.error;
    const gated =
      error instanceof ChokhError && (error.code === 'LICENSE_REQUIRED' || error.status === 404);
    if (gated) {
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      body = (
        <Card title={messages.alerts.title}>
          <ProFeature title={messages.alerts.title} {...(reason === undefined ? {} : { reason })} />
          <Description />
        </Card>
      );
    } else {
      body = (
        <Card title={messages.alerts.title}>
          <ErrorState error={error} onRetry={() => alerts.refetch()} />
        </Card>
      );
    }
  } else {
    const rows = alerts.data.data.alerts;
    const available = (alerts.data.meta?.['channels'] as AlertChannelKind[] | undefined) ?? ['webhook'];
    body = (
      <>
        <Card title={messages.alerts.title}>
          <p className={styles.lede}>{messages.alerts.lede}</p>
          {rows.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{messages.alerts.empty}</p>
              <p>{messages.alerts.emptyLede}</p>
            </div>
          ) : (
            <ul className={styles.list}>
              {rows.map((alert) => (
                <AlertItem key={alert.id} alert={alert} owner={owner} />
              ))}
            </ul>
          )}
        </Card>
        <Card title={messages.alerts.addTitle}>
          {owner ? (
            <AddAlert available={available} />
          ) : (
            <p className={styles.lede}>{messages.alerts.ownerOnly}</p>
          )}
        </Card>
      </>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className="sr-only">{messages.alerts.title}</h1>
      {body}
    </div>
  );
}
