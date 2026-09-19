import type { JSX } from 'react';

import { formatCount } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import styles from './Sparkline.module.css';

// The last half hour, a bar a minute.
//
// Bars rather than a line, because a minute is a count and not a reading: a
// line between two minutes implies a value in between, and there is no such
// minute. No axes, no gridlines and no labels, because a sparkline that needs
// an axis is not a sparkline: the number beside it says the rate and the shape
// says the trend.

export interface SparklineProps {
  // One value per bucket, oldest first.
  values: number[];
  label: string;
  // What the last bucket is worth, said in words beside the shape.
  now: number;
  loading?: boolean;
}

const WIDTH = 300;
const HEIGHT = 44;
const GAP = 1;

export function Sparkline({ values, label, now, loading = false }: SparklineProps): JSX.Element {
  const max = Math.max(1, ...values);
  const width = values.length === 0 ? WIDTH : (WIDTH + GAP) / values.length - GAP;

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.plot}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={format(messages.realtime.sparklineLabel, {
          label,
          total: values.reduce((sum, value) => sum + value, 0),
        })}
      >
        {!loading &&
          values.map((value, index) => {
            // A bucket with nothing in it still gets a hairline, so a quiet
            // minute reads as a measured zero rather than as a gap in the data.
            const height = value === 0 ? 1 : Math.max(1, (value / max) * HEIGHT);
            return (
              <rect
                key={index}
                className={value === 0 ? styles.barEmpty : styles.bar}
                x={index * (width + GAP)}
                y={HEIGHT - height}
                width={width}
                height={height}
              />
            );
          })}
      </svg>
      <p className={styles.rate}>
        {loading ? '' : format(messages.realtime.perMinute, { count: formatCount(now) })}
      </p>
    </div>
  );
}
