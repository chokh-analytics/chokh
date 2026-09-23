import { useCallback, useRef, useState, type FormEvent, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import {
  FUNNEL_WINDOWS,
  MAX_FUNNEL_STEPS,
  MAX_FUNNELS_PER_SITE,
  MIN_FUNNEL_STEPS,
  defaultFunnelWindow,
  type Funnel,
  type FunnelWindow,
  type Goal,
} from '@chokh/store/contract';

import { isOwner, useApp } from '../app/context.js';
import { api, type FunnelStepInput } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { funnelsKey, useFunnels, useGoals } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { ReportPage } from '../reports/ReportPage.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field, SelectField } from '../ui/Field.js';
import { ErrorState, Skeleton } from '../ui/State.js';
import styles from './Funnels.module.css';

// A site's funnels: the list, the one being read, a way to add one and a way
// to take one away.
//
// A funnel is a question asked of the raw events, like a goal: nothing is
// counted when one is written, so one added today answers for every day the
// events still cover, and deleting one loses nothing. There is no edit, for
// the goal's reason: the id is the question, so a changed question is a new
// funnel, and a delete and an add cost nothing.
//
// Adding and deleting need the admin scope, which only an owner holds. The
// builder is drawn for everybody and disabled with the reason for anybody
// else, the way the goal form is.

const WINDOW_LABELS: Record<FunnelWindow, string> = {
  visit: messages.funnels.windowVisit,
  '1h': messages.funnels.window1h,
  '1d': messages.funnels.window1d,
  '7d': messages.funnels.window7d,
  '30d': messages.funnels.window30d,
};

// Which funnel is drawn, in the link like everything else somebody is looking
// at, so a funnel is a view somebody can send. It is this page's own
// parameter and not part of the view query: no other report reads it, and a
// change of range or filters carries it along (useViewQuery). A link with no
// funnel in it draws the oldest, and a link naming one the site no longer has
// draws the oldest too, and says so, the way a deleted goal is dropped.
const FUNNEL_PARAM = 'funnel';

function useFunnelParam(): {
  requested: string | null;
  linkTo: (funnelId: string | null) => string;
  choose: (funnelId: string | null) => void;
} {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const asked = new URLSearchParams(search).get(FUNNEL_PARAM);

  const linkTo = useCallback(
    (funnelId: string | null) => {
      const params = new URLSearchParams(search);
      if (funnelId === null) {
        params.delete(FUNNEL_PARAM);
      } else {
        params.set(FUNNEL_PARAM, funnelId);
      }
      const text = params.toString();
      return `${location}${text === '' ? '' : `?${text}`}`;
    },
    [search, location],
  );

  const choose = useCallback(
    (funnelId: string | null) => {
      const target = linkTo(funnelId);
      if (target !== `${location}${search === '' ? '' : `?${search}`}`) {
        navigate(target);
      }
    },
    [linkTo, location, search, navigate],
  );

  return { requested: asked === null || asked === '' ? null : asked, linkTo, choose };
}

function useRefreshFunnels(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: funnelsKey(site.id) });
  };
}

function Chevron(): JSX.Element {
  return (
    <svg
      className={styles.chevron}
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6z" />
    </svg>
  );
}

function FunnelItem({
  funnel,
  chosen,
  owner,
  onChoose,
  onDeleted,
}: {
  funnel: Funnel;
  chosen: boolean;
  owner: boolean;
  onChoose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshFunnels();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteFunnel(client, site.id, funnel.id);
      onDeleted();
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      setBusy(false);
    }
  }

  return (
    <li className={[styles.item, chosen ? styles.chosen : ''].filter(Boolean).join(' ')}>
      <div className={styles.itemHead}>
        {/* The funnel's own name is the control: pressing it draws it. */}
        <button type="button" className={styles.pick} aria-pressed={chosen} onClick={onChoose}>
          {funnel.name}
        </button>
        <span className={styles.window}>{WINDOW_LABELS[funnel.window]}</span>
        {owner && !confirming && (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            {messages.funnels.delete}
          </Button>
        )}
      </div>
      <ol
        className={styles.stepLine}
        aria-label={format(messages.funnels.steps, { name: funnel.name })}
      >
        {funnel.steps.map((step, index) => (
          <li key={`${index}-${step.kind}-${step.match}`} className={styles.stepChip}>
            {index > 0 && <Chevron />}
            <span className={styles.stepName}>{step.name}</span>
          </li>
        ))}
      </ol>
      {confirming && (
        <div className={styles.confirm}>
          <p>{format(messages.funnels.deleteConfirm, { name: funnel.name })}</p>
          {problem !== null && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}
          <div className={styles.actions}>
            <Button onClick={() => void remove()} disabled={busy}>
              {messages.funnels.deleteYes}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              {messages.funnels.deleteNo}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function FunnelList({
  owner,
  list,
  drawn,
  gone,
  onChoose,
  onDeleted,
}: {
  owner: boolean;
  list: ReturnType<typeof useFunnels>;
  drawn: Funnel | null;
  gone: boolean;
  onChoose: (funnelId: string) => void;
  onDeleted: (funnelId: string) => void;
}): JSX.Element {
  const funnels = list.data?.data.funnels ?? [];

  const body = (): JSX.Element => {
    if (list.isPending) {
      return (
        <div className={styles.loading}>
          {[0, 1].map((index) => (
            <Skeleton key={index} height={52} />
          ))}
        </div>
      );
    }
    if (list.isError) {
      return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
    }
    if (funnels.length === 0) {
      return (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{messages.funnels.empty}</p>
          <p>{messages.funnels.emptyLede}</p>
        </div>
      );
    }
    return (
      <ul className={styles.list}>
        {funnels.map((funnel) => (
          <FunnelItem
            key={funnel.id}
            funnel={funnel}
            chosen={drawn?.id === funnel.id}
            owner={owner}
            onChoose={() => onChoose(funnel.id)}
            onDeleted={() => onDeleted(funnel.id)}
          />
        ))}
      </ul>
    );
  };

  return (
    <Card title={messages.funnels.title}>
      <p className={styles.lede}>{messages.funnels.lede}</p>
      {gone && (
        <p className={styles.gone} role="status">
          {messages.funnels.gone}
        </p>
      )}
      {body()}
    </Card>
  );
}

// One step of the builder: a page typed in, or a goal chosen. Keyed by a
// counter rather than by position, so moving a step moves what was typed in
// it rather than leaving the text where the step was.
interface DraftStep {
  key: number;
  kind: 'page' | 'goal';
  page: string;
  goalId: string;
}

interface Problems {
  name?: string;
  steps: (string | undefined)[];
}

// What somebody entered, checked before it is sent. The server checks it again
// and is the one that counts; this is so a missing slash is a sentence under
// the step rather than a round trip.
function problemsOf(name: string, steps: DraftStep[], goals: readonly Goal[]): Problems {
  return {
    ...(name.trim() === '' ? { name: messages.goals.required } : {}),
    steps: steps.map((step) => {
      if (step.kind === 'goal') {
        if (step.goalId === '') {
          return messages.goals.required;
        }
        return goals.some((goal) => goal.id === step.goalId) ? undefined : messages.funnels.goalGone;
      }
      if (step.page.trim() === '') {
        return messages.goals.required;
      }
      return step.page.trim().startsWith('/') ? undefined : messages.goals.invalidPath;
    }),
  };
}

function hasProblems(problems: Problems): boolean {
  return problems.name !== undefined || problems.steps.some((problem) => problem !== undefined);
}

// One field of a refusal's details, which the envelope types as unknown.
function detail(details: unknown, key: string): unknown {
  return typeof details === 'object' && details !== null ? Reflect.get(details, key) : undefined;
}

function AddFunnel({
  owner,
  onCreated,
  linkTo,
}: {
  owner: boolean;
  onCreated: (funnelId: string) => void;
  linkTo: (funnelId: string) => string;
}): JSX.Element {
  const { client, site } = useApp();
  const refresh = useRefreshFunnels();
  const goals = useGoals(client, site.id);
  const goalList = goals.data?.data.goals ?? [];
  const keys = useRef(0);
  const blank = useCallback(
    (): DraftStep => ({ key: (keys.current += 1), kind: 'page', page: '', goalId: '' }),
    [],
  );
  const firstWindow = defaultFunnelWindow(site.settings.visitorIdMode);

  const [name, setName] = useState('');
  const [timeWindow, setTimeWindow] = useState<FunnelWindow>(firstWindow);
  const [steps, setSteps] = useState<DraftStep[]>(() => [blank(), blank()]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the server refused, and where: a sentence for the form, a sentence
  // for one step, or the funnel that already asks this question.
  const [problem, setProblem] = useState<string | null>(null);
  const [stepProblem, setStepProblem] = useState<{ index: number; message: string } | null>(null);
  const [existing, setExisting] = useState<string | null>(null);

  const problems = tried ? problemsOf(name, steps, goalList) : { steps: [] };

  function change(index: number, next: Partial<DraftStep>): void {
    setSteps((current) => current.map((step, at) => (at === index ? { ...step, ...next } : step)));
    setStepProblem(null);
  }

  function move(index: number, by: -1 | 1): void {
    setSteps((current) => {
      const to = index + by;
      if (to < 0 || to >= current.length) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) {
        next.splice(to, 0, moved);
      }
      return next;
    });
    setStepProblem(null);
  }

  function remove(index: number): void {
    setSteps((current) =>
      current.length <= MIN_FUNNEL_STEPS ? current : current.filter((_step, at) => at !== index),
    );
    setStepProblem(null);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (hasProblems(problemsOf(name, steps, goalList))) {
      return;
    }
    setBusy(true);
    setProblem(null);
    setStepProblem(null);
    setExisting(null);
    try {
      const answer = await api.createFunnel(client, site.id, {
        name: name.trim(),
        window: timeWindow,
        steps: steps.map(
          (step): FunnelStepInput =>
            step.kind === 'goal' ? { goalId: step.goalId } : { page: step.page.trim() },
        ),
      });
      setName('');
      setTimeWindow(firstWindow);
      setSteps([blank(), blank()]);
      setTried(false);
      await refresh();
      // The funnel somebody has just built is the one they want to read.
      onCreated(answer.data.funnel.id);
    } catch (error) {
      const code = error instanceof ChokhError ? error.code : null;
      const funnelId = error instanceof ChokhError ? detail(error.details, 'funnelId') : undefined;
      const step = error instanceof ChokhError ? detail(error.details, 'step') : undefined;
      if (code === 'FUNNEL_EXISTS') {
        setProblem(messages.funnels.exists);
        setExisting(typeof funnelId === 'string' ? funnelId : null);
      } else if (code === 'GOAL_NOT_FOUND' && typeof step === 'number') {
        setStepProblem({ index: step, message: messages.funnels.goalGone });
      } else if (code === 'FUNNEL_LIMIT') {
        setProblem(format(messages.funnels.limit, { max: MAX_FUNNELS_PER_SITE }));
      } else {
        setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      }
    } finally {
      setBusy(false);
    }
  }

  const full = steps.length >= MAX_FUNNEL_STEPS;

  return (
    <Card title={messages.funnels.addTitle}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {!owner && <p className={styles.lede}>{messages.funnels.ownerOnly}</p>}
        <fieldset className={styles.fieldset} disabled={!owner || busy}>
          <legend className="sr-only">{messages.funnels.addTitle}</legend>
          <Field
            label={messages.funnels.name}
            placeholder={messages.funnels.namePlaceholder}
            maxLength={100}
            value={name}
            onChange={(input) => setName(input.target.value)}
            {...(problems.name === undefined ? {} : { problem: problems.name })}
          />
          <SelectField
            label={messages.funnels.window}
            help={messages.funnels.windowHelp}
            value={timeWindow}
            options={FUNNEL_WINDOWS.map((value) => ({ value, label: WINDOW_LABELS[value] }))}
            onChange={(input) =>
              setTimeWindow(
                FUNNEL_WINDOWS.find((value) => value === input.target.value) ?? firstWindow,
              )
            }
          />
          <ol className={styles.steps}>
            {steps.map((step, index) => {
              const said =
                stepProblem?.index === index ? stepProblem.message : problems.steps[index];
              return (
                <li key={step.key}>
                  <fieldset className={styles.step}>
                    <legend className={styles.stepLegend}>
                      {format(messages.funnels.step, { number: index + 1 })}
                    </legend>
                    <div className={styles.stepFields}>
                      <SelectField
                        label={messages.funnels.stepKind}
                        value={step.kind}
                        options={[
                          { value: 'page', label: messages.funnels.stepKindPage },
                          { value: 'goal', label: messages.funnels.stepKindGoal },
                        ]}
                        onChange={(input) =>
                          change(index, { kind: input.target.value === 'goal' ? 'goal' : 'page' })
                        }
                      />
                      {step.kind === 'page' ? (
                        <Field
                          label={messages.goals.matchPage}
                          placeholder={messages.goals.matchPagePlaceholder}
                          help={messages.goals.matchPageHelp}
                          maxLength={1024}
                          className={styles.mono}
                          value={step.page}
                          onChange={(input) => change(index, { page: input.target.value })}
                          {...(said === undefined ? {} : { problem: said })}
                        />
                      ) : goals.isSuccess && goalList.length === 0 ? (
                        // The page option still works, and this one says where
                        // a goal comes from rather than offering an empty list.
                        <p className={styles.noGoals}>
                          <span>{messages.funnels.noGoals}</span>{' '}
                          <Link href={`/${site.id}/goals`}>{messages.funnels.noGoalsLink}</Link>
                        </p>
                      ) : (
                        <SelectField
                          label={messages.funnels.stepGoal}
                          value={step.goalId}
                          options={[
                            { value: '', label: messages.funnels.stepGoalNone },
                            ...goalList.map((goal) => ({ value: goal.id, label: goal.name })),
                          ]}
                          onChange={(input) => change(index, { goalId: input.target.value })}
                          {...(said === undefined ? {} : { problem: said })}
                        />
                      )}
                    </div>
                    <div className={styles.stepActions}>
                      <Button variant="quiet" onClick={() => move(index, -1)} disabled={index === 0}>
                        {messages.funnels.moveUp}
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() => move(index, 1)}
                        disabled={index === steps.length - 1}
                      >
                        {messages.funnels.moveDown}
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() => remove(index)}
                        disabled={steps.length <= MIN_FUNNEL_STEPS}
                      >
                        {messages.funnels.removeStep}
                      </Button>
                    </div>
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <div className={styles.addStep}>
            <Button onClick={() => setSteps((current) => [...current, blank()])} disabled={full}>
              {messages.funnels.addStep}
            </Button>
            {full && (
              <span className={styles.note}>
                {format(messages.funnels.maxSteps, { max: MAX_FUNNEL_STEPS })}
              </span>
            )}
          </div>
          {problem !== null && (
            <p className={styles.problem} role="alert">
              <span>{problem}</span>
              {existing !== null && (
                <>
                  {' '}
                  <Link href={linkTo(existing)}>{messages.funnels.existsShow}</Link>
                </>
              )}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={!owner || busy}>
              {busy ? messages.funnels.saving : messages.funnels.save}
            </Button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}

export function Funnels(): JSX.Element {
  const { client, me, site } = useApp();
  const owner = isOwner(me.teams, site.teamId);
  const list = useFunnels(client, site.id);
  const { requested, linkTo, choose } = useFunnelParam();

  const funnels = list.data?.data.funnels;
  const named =
    requested === null ? undefined : funnels?.find((funnel) => funnel.id === requested);
  // Nothing is drawn until the list has answered, so a link naming a funnel is
  // never drawn as the oldest one first and then swapped.
  const drawn = funnels === undefined ? null : (named ?? funnels[0] ?? null);
  const gone = requested !== null && funnels !== undefined && named === undefined;

  return (
    <ReportPage title={messages.funnels.title}>
      <FunnelList
        owner={owner}
        list={list}
        drawn={drawn}
        gone={gone}
        onChoose={(funnelId) => choose(funnelId)}
        onDeleted={(funnelId) => {
          // The funnel the link named has gone, so the link stops naming it
          // rather than saying it no longer exists about a delete just made.
          if (requested === funnelId) {
            choose(null);
          }
        }}
      />
      <AddFunnel owner={owner} onCreated={(funnelId) => choose(funnelId)} linkTo={linkTo} />
    </ReportPage>
  );
}
