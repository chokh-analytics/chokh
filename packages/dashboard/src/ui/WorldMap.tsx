import { useState, type JSX } from 'react';

import { project } from '../map/naturalEarth.js';
import { SHAPES, WORLD } from '../map/world.generated.js';
import { countryName, formatCount } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import styles from './WorldMap.module.css';

// One dot per city, sized by how many people are in it.
//
// This is the report neither Plausible nor Fathom has, and the one the founder
// asked for first. It is only on Realtime, because only the presence set
// carries coordinates: a city breakdown over a range answers names, and a name
// is not a place.
//
// The coordinates are rounded to two decimals when the presence entry is
// written, which is about a kilometre. That rounding is why they are not behind
// read:identity: what is kept is where a city is, and it was never anything
// finer.

export interface MapCity {
  key: string;
  country?: string;
  lat?: number;
  lon?: number;
  visitors: number;
}

interface Placed {
  city: MapCity;
  x: number;
  y: number;
  radius: number;
}

// Cities closer together than this on screen are drawn as one dot. Two towns
// twenty kilometres apart are two dots on top of each other at this scale, and
// the one underneath cannot be hovered.
const MERGE_PX = 7;

export function placeCities(cities: MapCity[], width: number): Placed[] {
  const k = width / WORLD.width;
  const placed: Placed[] = [];
  for (const city of [...cities].sort((left, right) => right.visitors - left.visitors)) {
    if (city.lat === undefined || city.lon === undefined) {
      continue;
    }
    const [x, y] = project(city.lon, city.lat, WORLD);
    const near = placed.find(
      (other) => Math.abs(other.x - x) * k < MERGE_PX && Math.abs(other.y - y) * k < MERGE_PX,
    );
    if (near !== undefined) {
      near.city = { ...near.city, visitors: near.city.visitors + city.visitors };
      near.radius = radiusFor(near.city.visitors);
      continue;
    }
    placed.push({ city, x, y, radius: radiusFor(city.visitors) });
  }
  return placed;
}

// Area, not radius, so ten people are not ten times the ink of one. Clamped at
// both ends: one visitor still has to be visible and a thousand must not cover
// a continent.
function radiusFor(visitors: number): number {
  return Math.min(22, 4 + Math.sqrt(Math.max(1, visitors)) * 3.2);
}

export interface WorldMapProps {
  cities: MapCity[];
  // What a dot does. A city is a dimension the store can filter by, so this
  // narrows the page the way a row does.
  onSelect?: (city: MapCity) => void;
}

export function WorldMap({ cities, onSelect }: WorldMapProps): JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  // The drawing scales with its box and the dots scale with it, so this is one
  // of the two places in this product where a stretched viewBox is right: there
  // is no text in it.
  const placed = placeCities(cities, WORLD.width);
  const total = cities.reduce((sum, city) => sum + city.visitors, 0);

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.map}
        viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
        role="img"
        aria-label={format(messages.realtime.mapLabel, {
          count: total,
          cities: placed.length,
        })}
      >
        <g className={styles.land}>
          {SHAPES.map((shape) => (
            <path key={shape.id} d={shape.d} />
          ))}
        </g>
        {placed.map((dot) => (
          <circle
            key={dot.city.key + (dot.city.country ?? '')}
            className={[styles.dot, hover === dot.city.key ? styles.dotHover : '']
              .filter(Boolean)
              .join(' ')}
            cx={dot.x}
            cy={dot.y}
            r={dot.radius}
            onMouseEnter={() => setHover(dot.city.key)}
            onMouseLeave={() => setHover(null)}
            onClick={onSelect === undefined ? undefined : () => onSelect(dot.city)}
          />
        ))}
      </svg>

      {/*
        The same places as a list, for anybody who cannot see the dots. A map
        with an aria-label is a described picture; a map with its cities in it
        is data, which is the rule every chart here follows too.
      */}
      <ul className="sr-only">
        {placed.map((dot) => (
          <li key={dot.city.key}>
            {dot.city.key}
            {dot.city.country === undefined ? '' : `, ${countryName(dot.city.country) ?? dot.city.country}`}
            {`: ${formatCount(dot.city.visitors)}`}
          </li>
        ))}
      </ul>

      {hover !== null && (
        <p className={styles.caption} aria-hidden="true">
          {placed.find((dot) => dot.city.key === hover)?.city.key}
          {' '}
          {formatCount(placed.find((dot) => dot.city.key === hover)?.city.visitors ?? 0)}
        </p>
      )}
      {hover === null && <p className={styles.caption}>{messages.realtime.mapNote}</p>}
    </div>
  );
}
