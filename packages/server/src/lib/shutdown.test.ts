import { describe, expect, it } from 'vitest';

import { shutdown } from './shutdown.js';

describe('shutdown', () => {
  it('stops each thing after the one before it has stopped', async () => {
    const order: string[] = [];
    const step = (name: string, ms: number) =>
      [
        name,
        async (): Promise<void> => {
          order.push(`${name} stopping`);
          await new Promise((resolve) => setTimeout(resolve, ms));
          order.push(`${name} stopped`);
        },
      ] as const;
    await shutdown([step('the listener', 20), step('the store', 5), step('presence', 0)], () => undefined);
    expect(order).toEqual([
      'the listener stopping',
      'the listener stopped',
      'the store stopping',
      'the store stopped',
      'presence stopping',
      'presence stopped',
    ]);
  });

  it('says so when a step fails, and still stops the rest', async () => {
    const stopped: string[] = [];
    const said: [object, string][] = [];
    const gone = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    await shutdown(
      [
        ['the listener', async () => void stopped.push('the listener')],
        ['the store', () => Promise.reject(gone)],
        ['presence', async () => void stopped.push('presence')],
        [
          'the bus',
          () => {
            throw new Error('thrown, not rejected');
          },
        ],
        ['the replay set', async () => void stopped.push('the replay set')],
      ],
      (details, message) => said.push([details, message]),
    );
    expect(stopped).toEqual(['the listener', 'presence', 'the replay set']);
    expect(said).toHaveLength(2);
    expect(said[0]?.[0]).toEqual({ err: gone, step: 'the store' });
    expect(said[1]?.[0]).toMatchObject({ step: 'the bus' });
  });
});
