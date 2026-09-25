import { useMemo, type JSX } from 'react';
import {
  JOURNEY_STEPS,
  type JourneyNode,
  type JourneyResult,
} from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { useTabParam } from '../app/useTabParam.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { toggleFilter } from '../lib/filters.js';
import { api } from '../lib/api.js';
import { exportName } from '../lib/download.js';
import { formatCount, formatExact } from '../lib/format.js';
import { toStatsParams } from '../lib/query.js';
import { useJourneys } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Card, type CardTab } from '../ui/Card.js';
import { SelectField } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import styles from './Journeys.module.css';

// The paths visits took: the page they came in on, then the next three.
//
// A chunk of its own, imported by Pages only when this tab is open, because
// it is the one card on the report that draws a picture and most visits to
// Pages never ask for it.
//
// Four columns of real elements, so every page and every number is text a
// screen reader and a search box can find, with the bands between them one
// SVG that is only a picture. A node is as tall as its share of the visits
// (with room for its words), and says how many visits ended on it; the last
// column also says how many went on, so every column adds up to the column
// before it. Pressing a page narrows the report to the visits that saw it.
// That is the one filter every card on this report can answer: a filter on
// the entry page is one a raw event cannot carry, so the other cards would
// refuse it and the link would drop it.
//
// Wider than a phone on purpose. The flow keeps a width a path can be read at
// and scrolls inside its card, the way the visitor table does, rather than
// squeezing four columns of paths into 390 pixels or moving the page sideways.

const BRANCH_CHOICES = ['5', '3', '10'] as const;

const COLUMN_LABELS = [
  messages.journeys.column1,
  messages.journeys.column2,
  messages.journeys.column3,
  messages.journeys.column4,
];

// The drawing's geometry. Across, a viewBox a thousand wide that the SVG is
// stretched over, so a column is a share of the card rather than a width in
// pixels; down, pixels, because a node holds a line of text.
const VIEW_WIDTH = 1000;
const COLUMN_WIDTH = 190;
const COLUMN_STEP = (VIEW_WIDTH - COLUMN_WIDTH) / (JOURNEY_STEPS - 1);
// How tall every visit of the first column is together, before a node is
// given room for its words.
const FLOW_PX = 240;
const MIN_NODE_PX = 30;
const NOTE_PX = 18;
const GAP_PX = 10;

interface Placed {
  node: JourneyNode;
  column: number;
  top: number;
  height: number;
}

interface Band {
  key: string;
  path: string;
}

function nodeId(column: number, key: string | null): string {
  return JSON.stringify([column, key]);
}

function layout(result: JourneyResult): { placed: Placed[]; bands: Band[]; height: number } {
  const scale = result.visits === 0 ? 0 : FLOW_PX / result.visits;
  const placed: Placed[] = [];
  const byId = new Map<string, Placed>();
  let height = 0;
  result.columns.forEach((nodes, column) => {
    let top = 0;
    for (const node of nodes) {
      const box = Math.max(MIN_NODE_PX, Math.round(node.visits * scale));
      const notes = column === JOURNEY_STEPS - 1 ? 2 : 1;
      const at: Placed = { node, column, top, height: box };
      placed.push(at);
      byId.set(nodeId(column, node.key), at);
      top += box + notes * NOTE_PX + GAP_PX;
    }
    height = Math.max(height, top);
  });

  // Bands leave a node in the order their targets are drawn and arrive in the
  // order their sources are, stacked from the top of each node, so no two
  // cross inside a node.
  const drawnAt = new Map(placed.map((at, index) => [nodeId(at.column, at.node.key), index]));
  const position = (column: number, key: string | null): number =>
    drawnAt.get(nodeId(column, key)) ?? placed.length;
  const links = [...result.links].sort(
    (left, right) =>
      left.column - right.column ||
      position(left.column, left.from) - position(right.column, right.from) ||
      position(left.column + 1, left.to) - position(right.column + 1, right.to),
  );
  const leaving = new Map<string, number>();
  const arriving = new Map<string, number>();
  const bands: Band[] = [];
  for (const link of links) {
    const source = byId.get(nodeId(link.column, link.from));
    const target = byId.get(nodeId(link.column + 1, link.to));
    if (source === undefined || target === undefined) {
      continue;
    }
    const thick = Math.max(1, link.visits * scale);
    const out = leaving.get(nodeId(link.column, link.from)) ?? 0;
    const into = arriving.get(nodeId(link.column + 1, link.to)) ?? 0;
    leaving.set(nodeId(link.column, link.from), out + thick);
    arriving.set(nodeId(link.column + 1, link.to), into + thick);
    const x1 = link.column * COLUMN_STEP + COLUMN_WIDTH;
    const x2 = (link.column + 1) * COLUMN_STEP;
    const mid = (x1 + x2) / 2;
    const y1 = source.top + out;
    const y2 = target.top + into;
    const top = `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
    const bottom = `L${x2} ${y2 + thick}C${mid} ${y2 + thick} ${mid} ${y1 + thick} ${x1} ${y1 + thick}Z`;
    bands.push({ key: JSON.stringify([link.column, link.from, link.to]), path: `${top}${bottom}` });
  }
  return { placed, bands, height };
}

function NodeBox({
  at,
  chosen,
  onPick,
}: {
  at: Placed;
  chosen: boolean;
  onPick: (page: string) => void;
}): JSX.Element {
  const { node, column } = at;
  const page = node.key;
  const label = page ?? messages.journeys.other;
  const body = (
    <>
      <span className={styles.nodeLabel}>{label}</span>
      <span className={styles.nodeCount} title={formatExact(node.visits)}>
        {formatCount(node.visits)}
      </span>
    </>
  );
  return (
    <div
      className={styles.slot}
      style={{
        left: `${(column * COLUMN_STEP * 100) / VIEW_WIDTH}%`,
        width: `${(COLUMN_WIDTH * 100) / VIEW_WIDTH}%`,
        top: `${at.top}px`,
      }}
    >
      {page === null ? (
        // The rest of the column, not a page: nothing to filter by.
        <div
          className={[styles.node, styles.other].join(' ')}
          style={{ height: `${at.height}px` }}
        >
          {body}
        </div>
      ) : (
        <button
          type="button"
          className={styles.node}
          style={{ height: `${at.height}px` }}
          aria-pressed={chosen}
          title={format(messages.journeys.pick, { page })}
          onClick={() => onPick(page)}
        >
          {body}
        </button>
      )}
      <p className={styles.note}>
        {format(messages.journeys.left, { count: formatCount(node.exits) })}
      </p>
      {column === JOURNEY_STEPS - 1 && (
        <p className={styles.note}>
          {format(messages.journeys.onward, { count: formatCount(node.onward) })}
        </p>
      )}
    </div>
  );
}

// The same numbers as a table, for anybody the picture does not reach: each
// step, each page on it, how many visits were there, how many ended there and
// where the rest went next. Hidden inside a block, because a table ignores the
// one pixel width a hidden element is given and grows to its content, which on
// a phone pushed the page 330 px sideways.
function FlowTable({ result }: { result: JourneyResult }): JSX.Element {
  return (
    <div className="sr-only">
      <table>
        <caption>{messages.journeys.tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{messages.journeys.tableStep}</th>
            <th scope="col">{messages.journeys.tablePage}</th>
            <th scope="col">{messages.journeys.tableVisits}</th>
            <th scope="col">{messages.journeys.tableLeft}</th>
            <th scope="col">{messages.journeys.tableNext}</th>
          </tr>
        </thead>
        <tbody>
          {result.columns.flatMap((nodes, column) =>
            nodes.map((node) => {
              const next = result.links.filter(
                (link) => link.column === column && link.from === node.key,
              );
              return (
                <tr key={nodeId(column, node.key)}>
                  <td>{COLUMN_LABELS[column]}</td>
                  <td>{node.key ?? messages.journeys.other}</td>
                  <td>{formatExact(node.visits)}</td>
                  <td>{formatExact(node.exits)}</td>
                  <td>
                    <ul>
                      {next.map((link) => (
                        <li key={link.to ?? ''}>
                          {format(messages.journeys.tableNextItem, {
                            page: link.to ?? messages.journeys.other,
                            count: formatExact(link.visits),
                          })}
                        </li>
                      ))}
                      {node.onward > 0 && (
                        <li>{format(messages.journeys.onward, { count: formatExact(node.onward) })}</li>
                      )}
                    </ul>
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Journeys({
  title,
  tabs,
  onTab,
}: {
  title: string;
  tabs: CardTab[];
  onTab: (id: string) => void;
}): JSX.Element {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  const { tab: branches, set: setBranches } = useTabParam('branches', BRANCH_CHOICES);
  const result = useJourneys({ client, siteId: site.id, query, now }, Number(branches));
  const data = result.data?.data;
  const drawn = useMemo(() => (data === undefined ? null : layout(data)), [data]);
  const chosen = new Set(
    query.filters
      .filter((filter) => filter.dim === 'page' && filter.op === 'is')
      .map((filter) => filter.value),
  );
  const retentionDays =
    typeof result.data?.meta?.retentionDays === 'number'
      ? result.data.meta.retentionDays
      : site.settings.retentionDays;

  function pick(page: string): void {
    set({ ...query, filters: toggleFilter(query.filters, { dim: 'page', op: 'is', value: page }) });
  }

  const body = (): JSX.Element => {
    if (result.isPending) {
      return <Skeleton height={320} />;
    }
    if (result.isError) {
      return <ErrorState error={result.error} onRetry={() => result.refetch()} />;
    }
    if (data === undefined || drawn === null || data.visits === 0) {
      return query.filters.length > 0 ? (
        <EmptyState
          message={messages.states.emptyFiltered}
          action={{ label: messages.filters.clear, onClick: () => set({ ...query, filters: [] }) }}
        />
      ) : (
        <EmptyState message={messages.journeys.empty} />
      );
    }
    return (
      <>
        <div className={styles.scroll} tabIndex={0} role="group" aria-label={messages.journeys.flow}>
          <div className={styles.heads} aria-hidden="true">
            {COLUMN_LABELS.map((label, column) => (
              <span
                key={label}
                className={styles.head}
                style={{
                  left: `${(column * COLUMN_STEP * 100) / VIEW_WIDTH}%`,
                  width: `${(COLUMN_WIDTH * 100) / VIEW_WIDTH}%`,
                }}
              >
                {label}
              </span>
            ))}
          </div>
          <div className={styles.flow} style={{ height: `${drawn.height}px` }}>
            <svg
              className={styles.bands}
              viewBox={`0 0 ${VIEW_WIDTH} ${Math.max(1, drawn.height)}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {drawn.bands.map((band) => (
                <path key={band.key} d={band.path} />
              ))}
            </svg>
            {drawn.placed.map((at) => (
              <NodeBox
                key={nodeId(at.column, at.node.key)}
                at={at}
                chosen={at.node.key !== null && chosen.has(at.node.key)}
                onPick={pick}
              />
            ))}
          </div>
        </div>
        <FlowTable result={data} />
      </>
    );
  };

  return (
    <Card
      title={title}
      tabs={tabs}
      tab="journeys"
      onTab={onTab}
      download={{
        csvHref: api.exportUrl(client, site.id, toStatsParams(query), {
          report: 'journeys',
          branches: Number(branches),
        }),
        json: () => result.data?.data,
        name: exportName(site.id, 'journeys', undefined, query.range),
        title: messages.reports.tabJourneys,
      }}
      help={
        <InfoDot
          label={format(messages.a11y.metricHelp, { metric: messages.reports.tabJourneys })}
          text={messages.journeys.help}
        />
      }
    >
      <div className={styles.controls}>
        <p className={styles.summary}>
          {data === undefined
            ? null
            : format(messages.journeys.total, { count: formatCount(data.visits) })}
        </p>
        <SelectField
          className={styles.branches}
          label={messages.journeys.branches}
          value={branches}
          options={['3', '5', '10'].map((value) => ({ value, label: value }))}
          onChange={(input) =>
            setBranches(BRANCH_CHOICES.find((value) => value === input.target.value) ?? '5')
          }
        />
      </div>
      {body()}
      <p className={styles.footnote}>{format(messages.metricHelp.rawOnly, { days: retentionDays })}</p>
    </Card>
  );
}
