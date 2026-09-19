import type { JSX, ReactNode } from 'react';

import { format, messages } from '../messages/en.js';
import type { Delta } from '../lib/format.js';
import { InfoDot } from './InfoDot.js';
import { Skeleton } from './State.js';
import styles from './KpiTile.module.css';

export interface KpiTileProps {
  label: string;
  // Already formatted. Null is a number the store could not compute, which is
  // not the same as zero and must not be drawn as one.
  value: string | null;
  delta?: Delta;
  help?: string;
  title?: string;
  loading?: boolean;
  // Present only on a tile that picks the chart metric.
  selected?: boolean;
  onSelect?: () => void;
  live?: ReactNode;
}

function DeltaLine({ delta }: { delta: Delta }): JSX.Element {
  if (delta.kind === 'none') {
    // Not "no change". A previous window with nothing in it has no percentage
    // at all, and saying it stayed the same is a claim nobody measured.
    return <span className={styles.delta}>{messages.states.noBaseline}</span>;
  }
  if (delta.kind === 'flat') {
    return <span className={styles.delta}>{messages.states.noChange}</span>;
  }
  const tone = delta.tone === 'good' ? styles.good : delta.tone === 'bad' ? styles.bad : '';
  return (
    <span className={[styles.delta, tone].filter(Boolean).join(' ')}>
      {delta.kind === 'up' ? '▲' : '▼'} {delta.label}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  delta,
  help,
  title,
  loading = false,
  selected = false,
  onSelect,
  live,
}: KpiTileProps): JSX.Element {
  const body = (
    <>
      <span className={styles.label}>{label}</span>
      {loading ? (
        <Skeleton height={32} width="70%" style={{ marginBlock: 2 }} />
      ) : (
        <span className={styles.value} title={title}>
          {value ?? messages.states.notAvailable}
        </span>
      )}
      {loading ? (
        <Skeleton height={13} width="45%" style={{ marginBlock: 2 }} />
      ) : (
        (live ?? (delta !== undefined ? <DeltaLine delta={delta} /> : <span />))
      )}
    </>
  );

  // The help dot is a sibling of the press target and never a child of it.
  //
  // A button inside a button is invalid HTML, and it is not a technicality: the
  // browser gives the inner one no events of its own, so pressing the dot to
  // read what a metric means would have changed which metric the chart draws.
  // It sits in the corner instead, above the target rather than inside it.
  const dot =
    help === undefined ? null : (
      <span className={styles.help}>
        <InfoDot text={help} label={format(messages.a11y.metricHelp, { metric: label })} />
      </span>
    );

  if (onSelect === undefined) {
    return (
      <div className={styles.tile}>
        <span className={styles.face}>{body}</span>
        {dot}
      </div>
    );
  }

  return (
    <div className={[styles.tile, selected ? styles.current : ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        className={[styles.face, styles.selectable].join(' ')}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {body}
      </button>
      {dot}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.row}>{children}</div>;
}

// The green dot, and the only thing on any page that moves by itself. Idle
// rather than absent when nobody is here, because a missing dot reads as a
// broken counter and a grey one reads as a quiet minute.
export function LiveDot({ on }: { on: boolean }): JSX.Element {
  return <span className={[styles.dot, on ? '' : styles.dotIdle].filter(Boolean).join(' ')} />;
}

export function LiveValue({ count, note }: { count: number; note: string }): JSX.Element {
  return (
    <>
      <span className={styles.live}>
        <LiveDot on={count > 0} />
        {count}
      </span>
      <span className={styles.delta}>{note}</span>
      {/*
        The one number on this page that changes while nobody touches anything.
        Polite, so it waits for a gap rather than interrupting, and off screen,
        because the figure above it is already visible: without it the count
        moves in silence for anybody who cannot see it.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {format(messages.a11y.liveCount, { count })} {note}
      </span>
    </>
  );
}
