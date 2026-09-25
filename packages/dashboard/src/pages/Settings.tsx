import { useState, type FormEvent, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isRouteRule } from '@chokh/store/contract';

import { isOwner, useApp } from '../app/context.js';
import { api, type PublicSite } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { format, messages } from '../messages/en.js';
import page from '../reports/ReportPage.module.css';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField, TextareaField } from '../ui/Field.js';
import styles from './Settings.module.css';

// A site's settings: what it is called, how it keeps its numbers, what it
// keeps out, and which of its pages fold into one row.
//
// Three forms in three cards, each saving only its own fields, so a person
// editing the exclusion lists cannot lose a name somebody else changed a
// minute ago. Every control is drawn for everybody and disabled with the
// reason for anybody who is not an owner, rather than missing: a viewer
// reading what the site excludes is reading a fact about the numbers.
//
// The timezone is shown and not a control. Every rollup key and every day
// boundary is drawn in it, and a year of history cannot be re-keyed, which
// the sentence beside it says.

type Settings = PublicSite['settings'];

// Textarea lines as a list: trimmed, the blank ones dropped.
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// The PATCH, and the shell told to ask again who this person is, because the
// site on screen comes from that answer and has to say what was just saved.
function useSaveSite(): (patch: {
  name?: string;
  domains?: string[];
  settings?: Partial<Settings>;
}) => Promise<PublicSite> {
  const queryClient = useQueryClient();
  const { client, site } = useApp();
  return async (patch) => {
    const answer = await api.patchSite(client, site.id, patch);
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    return answer.data.site;
  };
}

// What every card's form shares: the busy flag, the problem line, the saved
// line and the submit button, around the fields the card owns.
function Form({
  title,
  owner,
  onSubmit,
  problem,
  saved,
  busy,
  note,
  children,
}: {
  title: string;
  owner: boolean;
  onSubmit: (event: FormEvent) => void;
  problem: string | null;
  saved: boolean;
  busy: boolean;
  note?: string;
  children: JSX.Element | JSX.Element[];
}): JSX.Element {
  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <fieldset className={styles.fieldset} disabled={!owner || busy}>
        <legend className="sr-only">{title}</legend>
        {children}
        {note !== undefined && <p className={styles.note}>{note}</p>}
        {problem !== null && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={!owner || busy}>
            {busy ? messages.settings.saving : messages.settings.save}
          </Button>
          {saved && (
            <span className={styles.saved} role="status">
              {messages.settings.saved}
            </span>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function problemOf(error: unknown): string {
  return error instanceof ChokhError ? error.message : messages.states.error;
}

function General({ owner }: { owner: boolean }): JSX.Element {
  const { site } = useApp();
  const save = useSaveSite();
  const [name, setName] = useState(site.name);
  const [domains, setDomains] = useState(site.domains.join('\n'));
  const [retention, setRetention] = useState(String(site.settings.retentionDays));
  const [ipMode, setIpMode] = useState<Settings['ipMode']>(site.settings.ipMode);
  const [visitorIdMode, setVisitorIdMode] = useState<Settings['visitorIdMode']>(
    site.settings.visitorIdMode,
  );
  const [botFilter, setBotFilter] = useState(site.settings.botFilter);
  const [unsigned, setUnsigned] = useState(site.settings.allowUnsignedIdentify);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const days = Number(retention);
  const problems = {
    name: tried && name.trim() === '' ? messages.settings.required : undefined,
    domains: tried && lines(domains).length === 0 ? messages.settings.oneDomain : undefined,
    retention:
      tried && !(Number.isInteger(days) && days >= 1 && days <= 3650)
        ? messages.settings.retentionRange
        : undefined,
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    setSaved(false);
    if (
      name.trim() === '' ||
      lines(domains).length === 0 ||
      !(Number.isInteger(days) && days >= 1 && days <= 3650)
    ) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await save({
        name: name.trim(),
        domains: lines(domains),
        settings: {
          retentionDays: days,
          ipMode,
          visitorIdMode,
          botFilter,
          allowUnsignedIdentify: unsigned,
        },
      });
      setTried(false);
      setSaved(true);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={messages.settings.general}>
      <Form
        title={messages.settings.general}
        owner={owner}
        onSubmit={(event) => void submit(event)}
        problem={problem}
        saved={saved}
        busy={busy}
      >
        <Field
          label={messages.settings.name}
          maxLength={120}
          value={name}
          onChange={(change) => setName(change.target.value)}
          {...(problems.name === undefined ? {} : { problem: problems.name })}
        />
        <TextareaField
          label={messages.settings.domains}
          help={messages.settings.domainsHelp}
          rows={3}
          value={domains}
          onChange={(change) => setDomains(change.target.value)}
          {...(problems.domains === undefined ? {} : { problem: problems.domains })}
        />
        <div className={styles.fact}>
          <span className={styles.factLabel}>{messages.settings.timezone}</span>
          <span className={styles.factValue}>{site.settings.timezone}</span>
          <span className={styles.factHelp}>{messages.settings.timezoneHelp}</span>
        </div>
        <Field
          label={messages.settings.retention}
          help={messages.settings.retentionHelp}
          type="number"
          min={1}
          max={3650}
          step={1}
          inputMode="numeric"
          value={retention}
          onChange={(change) => setRetention(change.target.value)}
          {...(problems.retention === undefined ? {} : { problem: problems.retention })}
        />
        <SelectField
          label={messages.settings.ipMode}
          value={ipMode}
          options={[
            { value: 'full', label: messages.settings.ipFull },
            { value: 'anonymized', label: messages.settings.ipAnonymized },
            { value: 'none', label: messages.settings.ipNone },
          ]}
          onChange={(change) =>
            setIpMode(
              change.target.value === 'full'
                ? 'full'
                : change.target.value === 'none'
                  ? 'none'
                  : 'anonymized',
            )
          }
        />
        <SelectField
          label={messages.settings.visitorIdMode}
          value={visitorIdMode}
          options={[
            { value: 'cookieless', label: messages.settings.visitorCookieless },
            { value: 'persistent', label: messages.settings.visitorPersistent },
          ]}
          onChange={(change) =>
            setVisitorIdMode(change.target.value === 'persistent' ? 'persistent' : 'cookieless')
          }
        />
        <SelectField
          label={messages.settings.botFilter}
          value={botFilter ? 'on' : 'off'}
          options={[
            { value: 'on', label: messages.settings.botOn },
            { value: 'off', label: messages.settings.botOff },
          ]}
          onChange={(change) => setBotFilter(change.target.value === 'on')}
        />
        <SelectField
          label={messages.settings.unsignedIdentify}
          help={messages.settings.unsignedHelp}
          value={unsigned ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: messages.settings.unsignedYes },
            { value: 'no', label: messages.settings.unsignedNo },
          ]}
          onChange={(change) => setUnsigned(change.target.value === 'yes')}
        />
      </Form>
    </Card>
  );
}

function Exclusions({ owner }: { owner: boolean }): JSX.Element {
  const { site } = useApp();
  const save = useSaveSite();
  const [ips, setIps] = useState(site.settings.excludeIps.join('\n'));
  const [paths, setPaths] = useState(site.settings.excludePaths.join('\n'));
  const [params, setParams] = useState(site.settings.excludeQueryParams.join('\n'));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const badPath = lines(paths).some((line) => !line.startsWith('/'));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    setSaved(false);
    if (badPath) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await save({
        settings: {
          excludeIps: lines(ips),
          excludePaths: lines(paths),
          excludeQueryParams: lines(params),
        },
      });
      setTried(false);
      setSaved(true);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={messages.settings.exclusions}>
      <p className={styles.lede}>{messages.settings.exclusionsLede}</p>
      <Form
        title={messages.settings.exclusions}
        owner={owner}
        onSubmit={(event) => void submit(event)}
        problem={problem}
        saved={saved}
        busy={busy}
      >
        <TextareaField
          label={messages.settings.excludeIps}
          help={messages.settings.excludeIpsHelp}
          rows={3}
          value={ips}
          onChange={(change) => setIps(change.target.value)}
        />
        <TextareaField
          label={messages.settings.excludePaths}
          help={messages.settings.excludePathsHelp}
          rows={3}
          value={paths}
          onChange={(change) => setPaths(change.target.value)}
          {...(tried && badPath ? { problem: messages.settings.invalidPath } : {})}
        />
        <TextareaField
          label={messages.settings.excludeQueryParams}
          help={messages.settings.excludeQueryParamsHelp}
          rows={3}
          value={params}
          onChange={(change) => setParams(change.target.value)}
        />
      </Form>
    </Card>
  );
}

function RouteGroups({ owner }: { owner: boolean }): JSX.Element {
  const { site } = useApp();
  const save = useSaveSite();
  const [rules, setRules] = useState(site.settings.routeGroups.join('\n'));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Said while the jobs still owe the regroup, from the site row itself, so a
  // page opened an hour later says the same thing until the pass has run.
  const [regrouping, setRegrouping] = useState(site.routesChangedAt !== undefined);

  const badRule = lines(rules).some((line) => !isRouteRule(line));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    setSaved(false);
    if (badRule) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const updated = await save({ settings: { routeGroups: lines(rules) } });
      setTried(false);
      setSaved(true);
      setRegrouping(updated.routesChangedAt !== undefined);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={messages.settings.routes}>
      <p className={styles.lede}>{messages.settings.routesLede}</p>
      <Form
        title={messages.settings.routes}
        owner={owner}
        onSubmit={(event) => void submit(event)}
        problem={problem}
        saved={saved}
        busy={busy}
        {...(regrouping ? { note: messages.settings.regrouping } : {})}
      >
        <TextareaField
          label={messages.settings.routeGroups}
          help={messages.settings.routeGroupsHelp}
          placeholder={messages.settings.routeGroupsPlaceholder}
          rows={4}
          value={rules}
          onChange={(change) => setRules(change.target.value)}
          {...(tried && badRule ? { problem: messages.settings.invalidRule } : {})}
        />
      </Form>
    </Card>
  );
}

// A line to paste somewhere, with a copy control beside it.
function Snippet({ label, text }: { label: string; text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.snippet}>
      <span className={styles.snippetLabel}>{label}</span>
      <pre className={styles.code}>
        <code>{text}</code>
      </pre>
      <div className={styles.actions}>
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? messages.settings.shareSnippetCopied : messages.settings.shareSnippetCopy}
        </Button>
      </div>
    </div>
  );
}

// The public share (AN-RPT01): make the link, copy it, put a password on it,
// replace it, turn it off. No form to save: each control is one call and the
// site row in GET /api/me is refreshed after it, so the card always draws what
// the server holds.
function Sharing({ owner }: { owner: boolean }): JSX.Element {
  const { client, site } = useApp();
  const queryClient = useQueryClient();
  const share = site.share;
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const link = share === undefined ? null : `${origin}/share/${share.token}`;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setProblem(null);
    setCopied(false);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function setThePassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (password.length < 8) {
      return;
    }
    await run(() => api.putShare(client, site.id, { password }));
    setPassword('');
    setTried(false);
  }

  async function copy(): Promise<void> {
    if (link === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card title={messages.settings.sharing}>
      <p className={styles.lede}>{messages.settings.sharingLede}</p>
      {share === undefined ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={!owner || busy}
            onClick={() => void run(() => api.putShare(client, site.id, {}))}
          >
            {busy ? messages.settings.shareWorking : messages.settings.shareMake}
          </Button>
        </div>
      ) : (
        <div className={styles.form}>
          <Field label={messages.settings.shareLink} value={link ?? ''} readOnly />
          <div className={styles.actions}>
            <Button onClick={() => void copy()}>{messages.settings.shareCopy}</Button>
            {copied && (
              <span className={styles.saved} role="status">
                {messages.settings.shareCopied}
              </span>
            )}
          </div>
          <p className={styles.note}>
            {share.protected ? messages.settings.shareProtected : messages.settings.shareOpen}
          </p>
          <form onSubmit={setThePassword} noValidate>
            <fieldset className={styles.fieldset} disabled={!owner || busy}>
              <legend className="sr-only">{messages.settings.sharePassword}</legend>
              <Field
                label={messages.settings.sharePassword}
                help={messages.settings.sharePasswordHelp}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                {...(tried && password.length < 8
                  ? { problem: messages.settings.sharePasswordHelp }
                  : {})}
              />
              <div className={styles.actions}>
                <Button type="submit" variant="primary" disabled={!owner || busy}>
                  {share.protected
                    ? messages.settings.shareChangePassword
                    : messages.settings.shareSetPassword}
                </Button>
                {share.protected && (
                  <Button
                    disabled={!owner || busy}
                    onClick={() => void run(() => api.putShare(client, site.id, { password: null }))}
                  >
                    {messages.settings.shareRemovePassword}
                  </Button>
                )}
              </div>
            </fieldset>
          </form>
          <p className={styles.note}>{messages.settings.shareEmbedLede}</p>
          <Snippet
            label={messages.settings.shareBadge}
            text={`![${messages.metrics.visitors}](${origin}/api/share/${share.token}/widget.svg?metric=visitors&range=30d)`}
          />
          <Snippet
            label={messages.settings.shareIframe}
            text={`<iframe src="${origin}/share/${share.token}/embed?range=30d" width="640" height="160" title="${site.name}" loading="lazy" style="border:0"></iframe>`}
          />
          <div className={styles.actions}>
            <Button
              disabled={!owner || busy}
              title={messages.settings.shareNewLinkHelp}
              onClick={() => void run(() => api.putShare(client, site.id, { regenerate: true }))}
            >
              {messages.settings.shareNewLink}
            </Button>
            <Button
              disabled={!owner || busy}
              title={messages.settings.shareOffHelp}
              onClick={() => void run(() => api.deleteShare(client, site.id))}
            >
              {messages.settings.shareOff}
            </Button>
          </div>
        </div>
      )}
      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </Card>
  );
}

export function Settings(): JSX.Element {
  const { me, site } = useApp();
  const owner = isOwner(me.teams, site.teamId);
  return (
    <div className={page.page}>
      <div>
        <h1 className={styles.title}>{format(messages.settings.title, { name: site.name })}</h1>
        <p className={styles.lede}>
          {owner ? messages.settings.lede : messages.settings.ownerOnly}
        </p>
      </div>
      <div className={page.stack}>
        <General owner={owner} />
        <Exclusions owner={owner} />
        <RouteGroups owner={owner} />
        <Sharing owner={owner} />
      </div>
    </div>
  );
}
