// Types for fixture-answers.mjs, for the demo's TypeScript.
export interface FixtureAnswer {
  status: number;
  body: unknown;
}

export const REALTIME_FRAME: unknown;

export function answer(
  path: string,
  params: URLSearchParams,
  options?: { licensed?: boolean; invite?: boolean },
): FixtureAnswer;
