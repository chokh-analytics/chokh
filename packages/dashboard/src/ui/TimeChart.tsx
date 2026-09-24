import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { bucketIndexAt, type Interval } from '@chokh/store/time';

import { formatClock, formatCount, formatDate, formatDateTime } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import { Skeleton } from './State.js';
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

// The chart is drawn in CSS pixels, not scaled like an image.
//
// A viewBox with preserveAspectRatio="none" and height:auto makes the drawing
// stretch to the container: on a 1180px screen the 190 unit box became 311px
// tall and every label grew by 1.6, and on a 360px phone it became 95px tall
// and the axis text was about five pixels. The viewBox width tracks the
// measured container instead, so one unit is one CSS pixel at every width and
// a 10px tick is 10px everywhere.
export const CHART_HEIGHT = 220;
// What the box is before anything has been measured, which is also what it is
// in a test environment with no ResizeObserver.
const FALLBACK_WIDTH = 720;
const PAD = { top: 12, right: 40, bottom: 22, left: 6 };

interface Plot {
  width: number;
  height: number;
}

function plotOf(width: number): Plot {
  return {
    width: Math.max(80, width - PAD.left - PAD.right),
    height: CHART_HEIGHT - PAD.top - PAD.bottom,
  };
}

// How wide the box actually is. A ResizeObserver rather than a window listener,
// because the chart changes width when the navigation wraps and when a card
// beside it appears, neither of which is a window resize.
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver !== 'function') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) {
        setWidth(Math.round(measured));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [box, width];
}

export interface ChartPoint {
  start: number;
  value: number;
}

// A mark: a fact stated about the site at an instant, drawn as one thin guide
// at the bucket the instant falls in, so a step in the line has its reason
// beside it. The kind is a word for the hover and the hidden list; the label
// is what was said.
export interface ChartMark {
  at: number;
  kind: string;
  label: string;
}

export interface TimeChartProps {
  title: string;
  points: ChartPoint[];
  previous?: ChartPoint[] | null;
  interval: Interval;
  timezone: string;
  metricLabel: string;
  previousLabel?: string;
  // How this metric is written.
  //
  // Without it every series is a count, so the bounce rate chart's axis reads
  // 0, 0, 1 for what the tile above it calls 30%, and the duration chart reads
  // 192K where the tile says 3m 12s. The axis, the hover card, the peak line
  // and the hidden table all go through this, because they are four places
  // showing one number and four is exactly enough for three of them to drift.
  formatValue?: (value: number) => string;
  formatExactValue?: (value: number) => string;
  // Drawn as itself with a block where the plot goes, rather than as a bare
  // rectangle somewhere else. The head, the gap and the legend are the same
  // elements in both states, so the panel is the same height before and after
  // the numbers land and nothing on the page moves.
  loading?: boolean;
  // Whether a comparison is coming. While loading there is no previous series
  // to look at, so without this the legend row is either always reserved, which
  // makes the panel shrink when a comparison turns out not to be wanted, or
  // never reserved, which makes it grow when one is.
  comparing?: boolean;
  // Drawn open rather than closed: the last bucket of a live range is a
  // fraction of a bucket, so the final point is marked as "now" rather than
  // being allowed to look like a fall.
  live?: boolean;
  // The marks inside the range, and where the range ends, which the points
  // alone cannot say: a mark after the last bucket's start is still inside
  // the range up to its end, and outside it past that.
  marks?: ChartMark[];
  rangeEnd?: number;
  // One control at the right of the head, beside the peak: the Overview puts
  // the annotations panel there, because the marks it lists are on this chart.
  headExtra?: ReactNode;
}

function scaleY(value: number, max: number, plot: Plot): number {
  if (max <= 0) {
    return PAD.top + plot.height;
  }
  return PAD.top + plot.height - (value / max) * plot.height;
}

function scaleX(index: number, count: number, plot: Plot): number {
  if (count <= 1) {
    return PAD.left + plot.width / 2;
  }
  return PAD.left + (index / (count - 1)) * plot.width;
}

function pathOf(points: ChartPoint[], max: number, plot: Plot): string {
  return points
    .map((point, index) => {
      const x = scaleX(index, points.length, plot).toFixed(2);
      const y = scaleY(point.value, max, plot).toFixed(2);
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}

function areaOf(points: ChartPoint[], max: number, plot: Plot): string {
  if (points.length === 0) {
    return '';
  }
  const base = (PAD.top + plot.height).toFixed(2);
  const first = scaleX(0, points.length, plot).toFixed(2);
  const last = scaleX(points.length - 1, points.length, plot).toFixed(2);
  return `${pathOf(points, max, plot)} L${last} ${base} L${first} ${base} Z`;
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

// How many labels the axis can hold, always including the first and the last.
//
// Five at a readable size needs about ninety pixels each, so a phone gets
// three: at 390 wide, five dates run into each other and the fix that made
// them legible would have been undone by the fix that made them fit.
export function tickIndexes(
  count: number,
  width: number,
  // How round the label at an index is, higher being rounder, 0 meaning not
  // round at all. Only the clock has an answer: a day is as round as the day
  // beside it.
  roundnessOf?: (index: number) => number,
): number[] {
  if (count <= 1) {
    return count === 1 ? [0] : [];
  }
  const room = width < 480 ? 3 : 5;
  const wanted = Math.min(room, count);
  const step = (count - 1) / (wanted - 1);
  const even = Array.from({ length: wanted }, (_, index) => Math.round(index * step));
  if (roundnessOf === undefined) {
    return even;
  }

  // Even spacing on an hourly day picks 0, 6, 12, 17, 23, and 17:00 beside
  // 12:00 and 23:00 reads as an error rather than as a tick. Each interior
  // tick moves to the roundest hour within half a step of where it was, which
  // buys 18:00 without letting a label drift into its neighbour.
  //
  // Every even position is reserved before anything moves, and a tick may only
  // move onto a free index. Two neighbours drawn to the same round hour put two
  // 03:00 labels on top of each other, on a Today opened between 08:00 and
  // 10:59: React warned about the duplicate key and five passing tests carried
  // the warning. Reserving first means a tick that cannot improve keeps its own
  // position, so a label is never dropped either: a missing one is a gap
  // somebody reads as missing data.
  const reach = Math.max(1, Math.floor(step / 2));
  const taken = new Set<number>(even);

  return even.map((index, position) => {
    if (position === 0 || position === wanted - 1) {
      return index;
    }
    let best = index;
    let bestScore = roundnessOf(index);
    for (let offset = 1; offset <= reach; offset += 1) {
      for (const candidate of [index - offset, index + offset]) {
        if (candidate <= 0 || candidate >= count - 1 || taken.has(candidate)) {
          continue;
        }
        const score = roundnessOf(candidate);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
    }
    if (best !== index) {
      taken.delete(index);
      taken.add(best);
    }
    return best;
  });
}

// How round a clock time is: midnight and midday first, then the quarters of
// the day, then every third and every second hour. A minute axis is scored the
// same way on its minutes, because :00 and :30 read as landmarks and :17 does
// not.
export function clockRoundness(ts: number, interval: Interval, timezone: string): number {
  const [hours, minutes] = formatClock(ts, timezone).split(':').map(Number);
  if (hours === undefined || minutes === undefined) {
    return 0;
  }
  if (interval === 'minute') {
    if (minutes === 0) return 4;
    if (minutes === 30) return 3;
    if (minutes % 15 === 0) return 2;
    if (minutes % 5 === 0) return 1;
    return 0;
  }
  if (minutes !== 0) {
    return 0;
  }
  if (hours === 0 || hours === 12) return 4;
  if (hours % 6 === 0) return 3;
  if (hours % 3 === 0) return 2;
  if (hours % 2 === 0) return 1;
  return 0;
}

export function TimeChart({
  title,
  points,
  previous,
  interval,
  timezone,
  metricLabel,
  previousLabel = messages.range.previousLabel,
  formatValue = formatCount,
  formatExactValue,
  loading = false,
  comparing = false,
  live = false,
  marks = [],
  rangeEnd,
  headExtra,
}: TimeChartProps): JSX.Element {
  const exact = formatExactValue ?? formatValue;
  const [hover, setHover] = useState<number | null>(null);
  const [box, width] = useMeasuredWidth();
  const plot = plotOf(width);

  const max = useMemo(() => {
    const here = points.reduce((best, point) => Math.max(best, point.value), 0);
    const there = (previous ?? []).reduce((best, point) => Math.max(best, point.value), 0);
    return niceMax(Math.max(here, there));
  }, [points, previous]);

  const peak = useMemo(
    () => points.reduce<ChartPoint | null>((best, point) => (best === null || point.value > best.value ? point : best), null),
    [points],
  );

  const hasData = !loading && points.some((point) => point.value > 0);
  const ticks = tickIndexes(
    points.length,
    width,
    interval === 'minute' || interval === 'hour'
      ? (index) => clockRoundness(points[index]?.start ?? 0, interval, timezone)
      : undefined,
  );
  const hasComparison = !loading && previous !== null && previous !== undefined && previous.length > 1;
  const hovered = hover === null ? null : points[hover];
  const hoveredPrevious = hover === null ? null : previous?.[hover];

  // Each mark's bucket, by the same rule the store folds a row into one. A
  // mark outside the range gets -1 and is not drawn; one inside it is drawn
  // at its bucket's x, so a deploy at 14:20 sits on the 14:00 point.
  const placedMarks = useMemo(() => {
    const starts = points.map((point) => point.start);
    const end = rangeEnd ?? (starts.length > 0 ? (starts[starts.length - 1] ?? 0) + 1 : 0);
    return marks
      .map((mark) => ({ ...mark, index: bucketIndexAt(starts, mark.at, end) }))
      .filter((mark) => mark.index >= 0);
  }, [marks, points, rangeEnd]);
  const markedBuckets = useMemo(
    () => [...new Set(placedMarks.map((mark) => mark.index))],
    [placedMarks],
  );
  const hoveredMarks = hover === null ? [] : placedMarks.filter((mark) => mark.index === hover);

  return (
    <div className={styles.chart}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        {!loading && peak !== null && peak.value > 0 && (
          <span className={styles.peak}>
            {format(messages.overview.chartPeak, {
              value: formatValue(peak.value),
              when: labelFor(peak.start, interval, timezone),
            })}
          </span>
        )}
        {headExtra !== undefined && <span className={styles.headExtra}>{headExtra}</span>}
      </div>

      <div className={styles.box} ref={box}>
        {loading ? (
          <Skeleton height={CHART_HEIGHT} />
        ) : (
        <svg
          className={styles.plot}
          width={width}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          role="img"
          aria-label={format(messages.a11y.chartLabel, {
            metric: metricLabel,
            interval,
            range: format(messages.a11y.rangeFromTo, {
              from: labelFor(points[0]?.start ?? 0, interval, timezone),
              to: labelFor(points[points.length - 1]?.start ?? 0, interval, timezone),
            }),
          })}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - bounds.left;
            const index = Math.round(
              ((x - PAD.left) / plot.width) * Math.max(1, points.length - 1),
            );
            setHover(Math.min(points.length - 1, Math.max(0, index)));
          }}
        >
          {/* Three horizontal gridlines, no vertical ones and no spines. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = PAD.top + plot.height * (1 - fraction);
            return (
              <g key={fraction}>
                <line
                  className={styles.grid}
                  x1={PAD.left}
                  x2={PAD.left + plot.width}
                  y1={y}
                  y2={y}
                />
                <text className={styles.tick} x={PAD.left + plot.width + 6} y={y + 3.5}>
                  {/*
                    Nothing but the baseline when there is nothing to scale. An
                    empty series rounds up to a maximum of one, so all three
                    labels read 1, 1, 0: two of them invented by the rounding
                    and none of them measured.
                  */}
                  {hasData || fraction === 0 ? formatValue(max * fraction) : ''}
                </text>
              </g>
            );
          })}

          {hasData && (
            <>
              {previous !== null && previous !== undefined && previous.length > 1 && (
                <path className={styles.previous} d={pathOf(previous, max, plot)} />
              )}
              <path className={styles.area} d={areaOf(points, max, plot)} />
              <path className={styles.line} d={pathOf(points, max, plot)} />
              {points.length > 0 && (
                <circle
                  className={styles.point}
                  cx={scaleX(points.length - 1, points.length, plot)}
                  cy={scaleY(points[points.length - 1]?.value ?? 0, max, plot)}
                  r={3.5}
                />
              )}
            </>
          )}

          {/*
            The marks: one thin guide per bucket that has any, and a small
            glyph at the axis so a guide is a thing and not a gridline. Behind
            the hover guide and in front of the area, so the line stays the
            line. The title is the native tooltip for a mouse that stops on
            one; the hidden list below is the same words for everybody else.
          */}
          {hasData &&
            markedBuckets.map((index) => {
              const x = scaleX(index, points.length, plot);
              const base = PAD.top + plot.height;
              const words = placedMarks
                .filter((mark) => mark.index === index)
                .map((mark) => format(messages.overview.chartMark, { kind: mark.kind, text: mark.label }))
                .join('; ');
              return (
                <g key={`mark-${index}`} className={styles.markGroup}>
                  <title>{words}</title>
                  <line className={styles.mark} x1={x} x2={x} y1={PAD.top} y2={base} />
                  <path
                    className={styles.markGlyph}
                    d={`M${(x - 3.5).toFixed(2)} ${(base + 1).toFixed(2)} L${x.toFixed(2)} ${(base - 4).toFixed(2)} L${(x + 3.5).toFixed(2)} ${(base + 1).toFixed(2)} Z`}
                  />
                </g>
              );
            })}

          {hovered !== undefined && hovered !== null && hasData && (
            <>
              <line
                className={styles.guide}
                x1={scaleX(hover ?? 0, points.length, plot)}
                x2={scaleX(hover ?? 0, points.length, plot)}
                y1={PAD.top}
                y2={PAD.top + plot.height}
              />
              <circle
                className={styles.point}
                cx={scaleX(hover ?? 0, points.length, plot)}
                cy={scaleY(hovered.value, max, plot)}
                r={3.5}
              />
            </>
          )}

          {ticks.map((index) => (
            <text
              key={index}
              className={styles.tick}
              x={scaleX(index, points.length, plot)}
              y={CHART_HEIGHT - 7}
              textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            >
              {index === points.length - 1 && live
                ? messages.overview.chartNow
                : labelFor(points[index]?.start ?? 0, interval, timezone)}
            </text>
          ))}
        </svg>
        )}

        {!loading && !hasData && <p className={styles.empty}>{messages.states.emptyChart}</p>}

        {hovered !== undefined && hovered !== null && hasData && (
          <div
            className={styles.hover}
            style={{
              left: `clamp(0px, ${(scaleX(hover ?? 0, points.length, plot) - 66).toFixed(0)}px, calc(100% - 132px))`,
              top: 0,
            }}
          >
            <span className={styles.hoverWhen}>
              {labelFor(hovered.start, interval, timezone)}
            </span>
            <span className={styles.hoverValue}>{exact(hovered.value)}</span>
            {hoveredPrevious !== undefined && hoveredPrevious !== null && (
              <span className={styles.hoverPrevious}>
                {format(messages.overview.chartPrevious, {
                  label: previousLabel,
                  value: exact(hoveredPrevious.value),
                })}
              </span>
            )}
            {hoveredMarks.map((mark, index) => (
              <span key={`${mark.at}-${index}`} className={styles.hoverMark}>
                {format(messages.overview.chartMark, { kind: mark.kind, text: mark.label })}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* A legend only when there are two series. With one, the title above has
          already said what the line is. */}
      {(hasComparison || (loading && comparing)) && (
        <div className={styles.legend} aria-hidden={loading ? true : undefined}>
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
        aria-label is a described picture; a chart with its own table is data,
        and it is the rule every chart in this product follows.
      */}
      <table className="sr-only">
        <caption>{messages.a11y.chartTable}</caption>
        <thead>
          <tr>
            <th scope="col">{messages.a11y.bucket}</th>
            <th scope="col">{metricLabel}</th>
            {hasComparison && <th scope="col">{previousLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={point.start}>
              <th scope="row">{labelFor(point.start, interval, timezone)}</th>
              <td>{exact(point.value)}</td>
              {hasComparison && <td>{exact(previous?.[index]?.value ?? 0)}</td>}
            </tr>
          ))}
        </tbody>
      </table>

      {/* The marks, for anybody who cannot see a guide: when, what kind, what it said. */}
      {placedMarks.length > 0 && (
        <div className="sr-only">
          <p>{messages.a11y.chartMarks}</p>
          <ul>
            {placedMarks.map((mark, index) => (
              <li key={`${mark.at}-${index}`}>
                {format(messages.annotations.listItem, {
                  when: formatDateTime(mark.at, timezone),
                  kind: mark.kind,
                  text: mark.label,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
