import { goalIdFor, type AccountStore, type Goal, type GoalRead } from '../store/AnalyticsStore.js';
import type { CreateGoalInput } from '../schemas/goals.schema.js';

// Goals: a page being viewed or a custom event being sent, counted as a success.
//
// A goal is written as a question and nothing is counted when it is: every
// report that takes one asks the raw events at read time. Which is why this
// service is so small, and why deleting a goal and adding it again brings its
// numbers back.

export type NewGoal = CreateGoalInput & {
  siteId: string;
  createdBy: string;
  now: number;
};

export async function createGoal(store: AccountStore, input: NewGoal): Promise<Goal> {
  const goal: Goal = {
    siteId: input.siteId,
    // Derived from the question, so asking it twice is refused by the store's
    // unique index as GOAL_EXISTS rather than stored under a second name.
    id: goalIdFor(input.siteId, input.kind, input.match),
    name: input.name,
    kind: input.kind,
    match: input.match,
    createdBy: input.createdBy,
    createdAt: input.now,
  };
  if (input.value !== undefined) {
    goal.value = input.value;
  }
  await store.createGoal(goal);
  return goal;
}

// What a report needs of a goal: the question and what a completion is worth.
export function goalRead(goal: Goal): GoalRead {
  return goal.value === undefined
    ? { kind: goal.kind, match: goal.match }
    : { kind: goal.kind, match: goal.match, value: goal.value };
}
