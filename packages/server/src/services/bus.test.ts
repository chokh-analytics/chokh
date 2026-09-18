import { describe, expect, it } from 'vitest';

import { createMemoryBus } from './bus.js';

describe('the in-process bus', () => {
  it('wakes every listener of the site a batch landed on', async () => {
    const bus = createMemoryBus();
    let one = 0;
    let two = 0;
    await bus.subscribe('s_one', () => (one += 1));
    await bus.subscribe('s_one', () => (two += 1));

    await bus.publish('s_one');

    expect(one).toBe(1);
    expect(two).toBe(1);
  });

  it('wakes nobody watching another site', async () => {
    const bus = createMemoryBus();
    let woken = 0;
    await bus.subscribe('s_one', () => (woken += 1));
    await bus.publish('s_two');
    expect(woken).toBe(0);
  });

  it('publishing to a site nobody watches is not an error', async () => {
    const bus = createMemoryBus();
    await expect(bus.publish('s_nobody')).resolves.toBeUndefined();
  });

  // The one thing standing between a long lived server and a listener leak: every
  // stream that closes unsubscribes.
  it('stops waking a listener that unsubscribed', async () => {
    const bus = createMemoryBus();
    let woken = 0;
    const off = await bus.subscribe('s_one', () => (woken += 1));
    await bus.publish('s_one');
    await off();
    await bus.publish('s_one');
    expect(woken).toBe(1);
  });

  it('unsubscribing twice is harmless', async () => {
    const bus = createMemoryBus();
    const off = await bus.subscribe('s_one', () => undefined);
    await off();
    await expect(off()).resolves.toBeUndefined();
  });
});
