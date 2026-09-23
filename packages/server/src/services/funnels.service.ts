import { attempt, type Refusal } from '../lib/store-error.js';
import type { CreateFunnelInput } from '../schemas/funnels.schema.js';
import {
  defaultFunnelWindow,
  funnelIdFor,
  type AccountStore,
  type Funnel,
  type FunnelRead,
  type FunnelStep,
  type FunnelWindow,
  type Site,
} from '../store/AnalyticsStore.js';

// Funnels: steps a visitor takes in order, within a window.
//
// Like a goal, a funnel is written as a question and nothing is counted when it
// is. A step made from a goal copies the goal's question here, once, so deleting
// the goal later changes no funnel; goalId stays on the step to say where it
// came from and is never read again.

export type NewFunnel = CreateFunnelInput & {
  site: Site;
  createdBy: string;
  now: number;
};

// A refusal that points at what refused it: the step that named a goal that is
// not here, or the funnel that already asks this question, whose id is the one
// this funnel would have had, because the id is derived from the question.
export type FunnelOutcome =
  | { ok: true; data: Funnel }
  | (Refusal & { ok: false; step?: number; funnelId?: string });

export async function createFunnel(store: AccountStore, input: NewFunnel): Promise<FunnelOutcome> {
  const steps: FunnelStep[] = [];
  for (const [index, step] of input.steps.entries()) {
    if ('page' in step) {
      steps.push({ kind: 'page', match: step.page, name: step.name ?? step.page });
      continue;
    }
    // Resolved against the site the route already read, so a goal of another
    // site is a goal that is not here.
    const goal = await store.goal(input.site.id, step.goalId);
    if (goal === null) {
      return {
        ok: false,
        status: 404,
        code: 'GOAL_NOT_FOUND',
        message: `Step ${index + 1} names no goal of ${input.site.id}`,
        step: index,
      };
    }
    steps.push({
      kind: goal.kind,
      match: goal.match,
      name: step.name ?? goal.name,
      goalId: goal.id,
    });
  }
  const window: FunnelWindow =
    input.window ?? defaultFunnelWindow(input.site.settings.visitorIdMode);
  const funnel: Funnel = {
    siteId: input.site.id,
    id: funnelIdFor(input.site.id, window, steps),
    name: input.name,
    steps,
    window,
    createdBy: input.createdBy,
    createdAt: input.now,
  };
  const created = await attempt(async () => {
    await store.createFunnel(funnel);
    return funnel;
  });
  if (!created.ok && created.code === 'FUNNEL_EXISTS') {
    return { ...created, funnelId: funnel.id };
  }
  return created;
}

// What a report needs of a funnel: the questions in order, and the window.
export function funnelRead(funnel: Funnel): FunnelRead {
  return {
    steps: funnel.steps.map((step) => ({ kind: step.kind, match: step.match })),
    window: funnel.window,
  };
}
