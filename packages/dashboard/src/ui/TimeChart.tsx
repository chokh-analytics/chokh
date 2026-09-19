import { useMemo, useState, type JSX } from 'react';
import type { Interval } from '@chokh/store/time';

import { formatClock, formatCount, formatDate, formatExact } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import styles from './TimeChart.module.css';

// One series, drawn by hand.
//
// No charting library. The look this product asks for is thin marks, one
// accent, no dots, no legend unless there are two series, and a comparison that
// stays behind the line: every one of those is the opposite of a library's
// defaults, and the fight to turn them all off costs more than the 220 lines
// below and 95 KB besides.
//
// The viewBox is a fixed grid and the SVG scales itself, so nothing here
// measures the DOM, nothing re-renders on a resize, and the chart is the same
// shape in a screenshot as it is on a phone.

const WIDTH = 720;
const HEIGHT = 190;
const PAD = { top: 12, right: 34, bottom: 20, left: 6 };
const PLOT = {
  width: WIDTH - PAD.left - PAD.right,
  height: HEIGHT - PAD.top - PAD.bottom,
};

export interface ChartPoint {
  start: number;
  value: number;
}

export interface TimeChartProps {
  title: string;
  points: ChartPoint[];
  previous?: ChartPoint[] | null;
  interval: Interval;
  timezone: string;
  metricLabel: string;
  previousLabel?: string;
  // Drawn open rather than closed: the last bucket of a live range is a
  // fraction of a bucket, so the final point is marked as "now" rather than
  // being allowed to look like a fall.
  live?: boolean;
}

function scaleY(value: number, max: number): number {
  if (max <= 0) {
    return PAD.top + PLOT.height;
  }
  return PAD.top + PLOT.height - (value / max) * PLOT.height;
}

function scaleX(index: number, count: number): number {
  if (count <= 1) {
    return PAD.left + PLOT.width / 2;
  }
  return PAD.left + (index / (count - 1)) * PLOT.width;
}

function pathOf(points: ChartPoint[], max: number): string {
  return points
    .map((point, index) => {
      const x = scaleX(index, points.length).toFixed(2);
      const y = scaleY(point.value, max).toFixed(2);
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}

function areaOf(points: ChartPoint[], max: number): string {
  if (points.length === 0) {
    return '';
  }
  const base = (PAD.top + PLOT.height).toFixed(2);
  const first = scaleX(0, points.length).toFixed(2);
  const last = scaleX(points.length - 1, points.length).toFixed(2);
  return `${pathOf(points, max)} L${last} ${base} L${first} ${base} Z`;
}

// A round number at or above the highest point, so the top gridline is a
// number somebody can read rather than 96.
//
// The steps are close together on purpose. A ladder of 1, 2, 5, 10 rounds a
// peak of 53 up to 100 and leaves the line drawn across the bottom half of a
// chart that is mostly empty; these put it at 60 and the shape fills the plot.
const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of STEPS) {
    const candidate = step * magnitude;
    if (candidate >= value) {
      return candidate;
    }
  }
  return 10 * magnitude;
}

// A minute and an hour want a clock; a day, a week and a month want a date.
function labelFor(ts: number, interval: Interval, timezone: string): string {
  return interval === 'minute' || interval === 'hour'
    ? formatClock(ts, timezone)
    : formatDate(ts, timezone);
}

// Five labels at most, always including the first and the last, so the axis is
// legible at every range instead of becoming a smear at ninety days.
function tickIndexes(count: number): number[] {
  if (count <= 1) {
    return count === 1 ? [0] : [];
  }
  const wanted = Math.min(5, count);
  const step = (count - 1) / (wanted - 1);
  return Array.from({ length: wanted }, (_, index) => Math.round(index * step));
}

export function TimeChart({
  title,
  points,
  previous,
  interval,
  timezone,
  metricLabel,
  previousLabel = messages.range.previousLabel,
  live = false,
}: TimeChartProps): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => {
    const here = points.reduce((best, point) => Math.max(best, point.value), 0);
    const there = (previous ?? []).reduce((best, point) => Math.max(best, point.value), 0);
    return niceMax(Math.max(here, there));
  }, [points, previous]);

  const peak = useMemo(
    () => points.reduce<ChartPoint | null>((best, point) => (best === null || point.value > best.value ? point : best), null),
    [points],
  );

  const hasData = points.some((point) => point.value > 0);
  const ticks = tickIndexes(points.length);
  const hovered = hover === null ? null : points[hover];
  const hoveredPrevious = hover === null ? null : previous?.[hover];

  return (
    <div className={styles.chart}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        {peak !== null && peak.value > 0 && (
          <span className={styles.peak}>
            {format(messages.overview.chartPeak, {
              value: formatCount(peak.value),
              when: labelFor(peak.start, interval, timezone),
            })}
          </span>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          className={styles.plot}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={format(messages.a11y.chartLabel, {
            metric: metricLabel,
            interval,
            range: `${labelFor(points[0]?.start ?? 0, interval, timezone)} to ${labelFor(
              points[points.length - 1]?.start ?? 0,
              interval,
              timezone,
            )}`,
          })}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - box.left) / box.width;
            const x = ratio * WIDTH;
            const index = Math.round(
              ((x - PAD.left) / PLOT.width) * Math.max(1, points.length - 1),
            );
            setHover(Math.min(points.length - 1, Math.max(0, index)));
          }}
        >
          {/* Three horizontal gridlines, no vertical ones and no spines. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = PAD.top + PLOT.height * (1 - fraction);
            return (
              <g key={fraction}>
                <line
                  className={styles.grid}
                  x1={PAD.left}
                  x2={PAD.left + PLOT.width}
                  y1={y}
                  y2={y}
                />
                <text className={styles.tick} x={PAD.left + PLOT.width + 6} y={y + 3.5}>
                  {formatCount(max * fraction)}
                </text>
              </g>
            );
          })}

          {hasData && (
            <>
              {previous !== null && previous !== undefined && previous.length > 1 && (
                <path className={styles.previous} d={pathOf(previous, max)} />
              )}
              <path className={styles.area} d={areaOf(points, max)} />
              <path className={styles.line} d={pathOf(points, max)} />
              {points.length > 0 && (
                <circle
                  className={styles.point}
                  cx={scaleX(points.length - 1, points.length)}
                  cy={scaleY(points[points.length - 1]?.value ?? 0, max)}
                  r={3.5}
                />
              )}
            </>
          )}

          {hovered !== undefined && hovered !== null && hasData && (
            <>
              <line
                className={styles.guide}
                x1={scaleX(hover ?? 0, points.length)}
                x2={scaleX(hover ?? 0, points.length)}
                y1={PAD.top}
                y2={PAD.top + PLOT.height}
              />
              <circle
                className={styles.point}
                cx={scaleX(hover ?? 0, points.length)}
                cy={scaleY(hovered.value, max)}
                r={3.5}
              />
            </>
          )}

          {ticks.map((index) => (
            <text
              key={index}
              className={styles.tick}
              x={scaleX(index, points.length)}
              y={HEIGHT - 6}
              textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            >
              {index === points.length - 1 && live
                ? messages.overview.chartNow
                : labelFor(points[index]?.start ?? 0, interval, timezone)}
            </text>
          ))}
        </svg>

        {!hasData && <p className={styles.empty}>{messages.states.emptyChart}</p>}

        {hovered !== undefined && hovered !== null && hasData && (
          <div
            className={styles.hover}
            style={{
              left: `clamp(0px, ${((scaleX(hover ?? 0, points.length) / WIDTH) * 100).toFixed(2)}% - 66px, calc(100% - 132px))`,
              top: 0,
            }}
          >
            <span className={styles.hoverWhen}>
              {labelFor(hovered.start, interval, timezone)}
            </span>
            <span className={styles.hoverValue}>
              {formatExact(hovered.value)} {metricLabel.toLowerCase()}
            </span>
            {hoveredPrevious !== undefined && hoveredPrevious !== null && (
              <span className={styles.hoverPrevious}>
                {previousLabel}: {formatExact(hoveredPrevious.value)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* A legend only when there are two series. With one, the title above has
          already said what the line is. */}
      {previous !== null && previous !== undefined && previous.length > 1 && (
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.swatch} />
            {metricLabel}
          </span>
          <span className={styles.legendItem}>
            <span className={[styles.swatch, styles.swatchPrevious].join(' ')} />
            {previousLabel}
          </span>
        </div>
      )}

      {/*
        The numbers, for anybody who cannot see the line. A chart with an
        aria-label is a described picture; a chart with its own table is data.
        Neither Plausible nor Fathom does this.
      */}
      <table className="sr-only">
        <caption>{messages.a11y.chartTable}</caption>
        <thead>
          <tr>
            <th scope="col">{messages.a11y.bucket}</th>
            <th scope="col">{metricLabel}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.start}>
              <th scope="row">{labelFor(point.start, interval, timezone)}</th>
              <td>{formatExact(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
