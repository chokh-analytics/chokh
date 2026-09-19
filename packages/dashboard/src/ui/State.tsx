import type { CSSProperties, JSX } from 'react';

import { ChokhError } from '../lib/client.js';
import { format, messages } from '../messages/en.js';
import { Button } from './Button.js';
import styles from './State.module.css';

// A rectangle exactly the size of the thing that is coming. Nothing in this
// dashboard shifts when its numbers arrive.
export function Skeleton({
  width,
  height,
  style,
}: {
  width?: string | number;
  height: string | number;
  style?: CSSProperties;
}): JSX.Element {
  return <div className={styles.skeleton} style={{ width: width ?? '100%', height, ...style }} />;
}

export function EmptyState({
  message,
  action,
  centred = false,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
  centred?: boolean;
}): JSX.Element {
  return (
    <div className={[styles.state, centred ? styles.centred : ''].filter(Boolean).join(' ')}>
      <p>{message}</p>
      {action !== undefined && (
        <Button variant="quiet" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

// One card failing is one card failing. The rest of the page keeps its numbers
// and the retry asks again for this query alone, because a whole page that goes
// red because a device breakdown timed out is a page that threw away five
// answers to report one failure.
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): JSX.Element {
  const known = error instanceof ChokhError ? error : null;
  return (
    <div className={styles.state} role="alert">
      <p>{known?.message ?? messages.states.error}</p>
      {known !== null && (
        <p className={styles.errorCode}>{format(messages.states.errorCode, { code: known.code })}</p>
      )}
      {onRetry !== undefined && (
        <Button variant="quiet" onClick={onRetry}>
          {messages.states.retry}
        </Button>
      )}
    </div>
  );
}

// The thread that says a refetch is in flight without dimming anything.
export function Working(): JSX.Element {
  return <div className={styles.working} aria-hidden="true" />;
}
