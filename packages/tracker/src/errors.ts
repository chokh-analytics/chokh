// e.js: the optional JavaScript error script (AN-VIT01).
//
// Loaded beside a.js by a site that wants its errors, and only worth loading on
// a site whose owner turned error capture on: the collector drops every error
// row of a site that has not, whatever this sends. It reports through a.js, the
// way v.js does, so errors share the consent gate, the visitor id and the batch,
// and a.js spends a few bytes of its budget on the hand-off instead of all of
// this.
//
// A page whose script throws in a loop must not flood anybody: each distinct
// message is sent once per page load and no more than ten in all, and every
// field is cut to what the collector keeps before it leaves (the collector
// scrubs and cuts again, because it trusts no page). Nothing here reads the
// page, a form or storage; the error says what it says, and the collector
// takes the addresses, tokens and query strings out of it.
import type {} from './types';

export const MAX_ERRORS_PER_PAGE = 10;
const MESSAGE_MAX = 200;
const FRAME_MAX = 300;
const STACK_MAX = 1000;

interface ErrorDetail {
  frame?: string;
  stack?: string;
}

function describe(value: unknown, fallback: string): { message: string; stack?: string } {
  if (value instanceof Error) {
    const described: { message: string; stack?: string } = {
      message: value.name + ': ' + value.message,
    };
    if (typeof value.stack === 'string') described.stack = value.stack;
    return described;
  }
  return { message: fallback };
}

export function watchErrors(win: Window): void {
  const sent: string[] = [];

  function report(message: string, frame: string | undefined, stack: string | undefined): void {
    const key = message + '\n' + (frame ?? '');
    if (sent.length >= MAX_ERRORS_PER_PAGE || sent.indexOf(key) !== -1) {
      return;
    }
    sent.push(key);
    const pa = win.pa;
    if (pa === undefined) {
      return;
    }
    const detail: ErrorDetail = {};
    if (frame !== undefined) detail.frame = frame.slice(0, FRAME_MAX);
    if (stack !== undefined) detail.stack = stack.slice(0, STACK_MAX);
    pa('error', (message || 'Error').slice(0, MESSAGE_MAX), detail);
  }

  win.addEventListener('error', (event) => {
    // A resource that failed to load fires a plain Event on its element, and
    // never reaches a listener on the window without capture. Only a script
    // error arrives here as an ErrorEvent.
    if (!(event instanceof ErrorEvent)) {
      return;
    }
    const described = describe(event.error, event.message);
    const frame = event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : undefined;
    report(described.message, frame, described.stack);
  });

  win.addEventListener('unhandledrejection', (event) => {
    const reason = (event as Event & { reason?: unknown }).reason;
    const described = describe(reason, 'Unhandled rejection: ' + String(reason));
    report(described.message, undefined, described.stack);
  });
}
