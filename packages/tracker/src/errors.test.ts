import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ERRORS_PER_PAGE, watchErrors } from './errors';

// e.js hands each error to a.js as pa('error', message, { frame, stack }), once
// per distinct message and frame, ten a page load at most, every field cut.

function throwAt(win: Window, error: unknown, message: string, filename = 'https://s.test/app.js'): void {
  win.dispatchEvent(new ErrorEvent('error', { error, message, filename, lineno: 12, colno: 4 }));
}

describe('e.js', () => {
  let pa: ReturnType<typeof vi.fn>;
  let win: Window;

  beforeEach(() => {
    // A target of its own per case, so each starts a fresh page load.
    win = new EventTarget() as Window;
    pa = vi.fn();
    win.pa = pa as unknown as Window['pa'];
    watchErrors(win);
  });

  it('sends the name and message, the frame and the stack of a thrown error', () => {
    const error = new TypeError('a is undefined');
    error.stack = 'TypeError: a is undefined\n    at f (https://s.test/app.js:12:4)';
    throwAt(win, error, 'Uncaught TypeError: a is undefined');
    expect(pa).toHaveBeenCalledWith('error', 'TypeError: a is undefined', {
      frame: 'https://s.test/app.js:12:4',
      stack: 'TypeError: a is undefined\n    at f (https://s.test/app.js:12:4)',
    });
  });

  it('falls back to the event message, and sends an opaque cross-origin error with no frame', () => {
    throwAt(win, null, 'Script error.', '');
    expect(pa).toHaveBeenCalledWith('error', 'Script error.', {});
  });

  it('reports an unhandled rejection', () => {
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = 'quota';
    win.dispatchEvent(event);
    expect(pa).toHaveBeenCalledWith('error', 'Unhandled rejection: quota', {});
  });

  it('sends one message once per page load and no more than ten in all', () => {
    for (let at = 0; at < 3; at += 1) throwAt(win, new Error('same'), 'same');
    expect(pa).toHaveBeenCalledTimes(1);
    for (let at = 0; at < 20; at += 1) throwAt(win, new Error(`loop ${at}`), 'loop');
    expect(pa).toHaveBeenCalledTimes(MAX_ERRORS_PER_PAGE);
  });

  it('cuts every field to what the collector keeps', () => {
    const error = new Error('x'.repeat(500));
    error.stack = 'y'.repeat(5000);
    throwAt(win, error, '', `https://s.test/${'z'.repeat(400)}.js`);
    const [, message, detail] = pa.mock.calls[0] as [string, string, { frame: string; stack: string }];
    expect(message).toHaveLength(200);
    expect(detail.frame).toHaveLength(300);
    expect(detail.stack).toHaveLength(1000);
  });

  it('ignores a resource that failed to load', () => {
    win.dispatchEvent(new Event('error'));
    expect(pa).not.toHaveBeenCalled();
  });
});
