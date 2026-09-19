import { useState, type JSX } from 'react';

import { SHAPES, WORLD } from '../map/world.generated.js';
import { countryName, formatCount } from '../lib/format.js';
import { format, messages } from '../messages/en.js';
import styles from './Choropleth.module.css';

// The world, painted by how many visitors came from each country.
//
// Five steps and not a continuous ramp. A continuous colour scale looks more
// precise and is less readable: nobody can tell 1,400 from 1,700 by shade, and
// pretending they can is the same class of mistake as a bar chart with no axis.
// Five bands, a legend that says what the bands are, and the actual numbers in
// the table beside it.
//
// The steps are on a log scale because analytics data is: one country almost
// always has an order of magnitude more than the rest, and a linear ramp paints
// the whole map in the lightest band with one country in the darkest.

export interface CountryValue {
  key: string;
  visitors: number;
}

export const STEPS = 5;

// Which band a value falls in, 0 to STEPS - 1. Zero is not a band: a country
// nobody came from is not the palest shade of somebody, it is unpainted.
export function bandOf(value: number, max: number): number | null {
  if (value <= 0 || max <= 0) {
    return null;
  }
  const scale = Math.log10(max) || 1;
  const band = Math.ceil((Math.log10(value) / scale) * STEPS);
  return Math.min(STEPS, Math.max(1, band)) - 1;
}

export interface ChoroplethProps {
  countries: CountryValue[];
  onSelect?: (key: string) => void;
}

export function Choropleth({ countries, onSelect }: ChoroplethProps): JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  const byKey = new Map(countries.map((row) => [row.key, row.visitors]));
  const max = countries.reduce((best, row) => Math.max(best, row.visitors), 0);
  const total = countries.reduce((sum, row) => sum + row.visitors, 0);
  const hovered = hover === null ? null : (byKey.get(hover) ?? 0);

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.map}
        viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
        role="img"
        aria-label={format(messages.reports.mapLabel, {
          count: total,
          countries: countries.length,
        })}
      >
        {SHAPES.map((shape) => {
          const value = byKey.get(shape.id) ?? 0;
          const band = bandOf(value, max);
          return (
            <path
              key={shape.id}
              d={shape.d}
              className={[
                styles.country,
                band === null ? styles.empty : (styles[`band${band}`] ?? ''),
                hover === shape.id ? styles.hover : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => setHover(shape.id)}
              onMouseLeave={() => setHover(null)}
              onClick={band === null || onSelect === undefined ? undefined : () => onSelect(shape.id)}
            />
          );
        })}
      </svg>

      <div className={styles.foot}>
        {/*
          The legend says what the bands mean, because a map whose colours mean
          nothing in particular is decoration.
        */}
        <p className={styles.legend} aria-hidden="true">
          <span className={styles.legendLow}>{formatCount(1)}</span>
          <span className={styles.ramp}>
            {Array.from({ length: STEPS }, (_step, index) => (
              <span key={index} className={styles[`band${index}`]} />
            ))}
          </span>
          <span className={styles.legendHigh}>{formatCount(max)}</span>
        </p>
        <p className={styles.caption} aria-hidden="true">
          {hover === null
            ? messages.reports.mapNote
            : `${countryName(hover) ?? hover}: ${formatCount(hovered ?? 0)}`}
        </p>
      </div>

      {/*
        The same data as a list, for anybody who cannot see the map. Every chart
        in this product carries its numbers: an aria-label on a picture is a
        description, and a description of a map is not a map.
      */}
      <ul className="sr-only">
        {countries.map((row) => (
          <li key={row.key}>{`${countryName(row.key) ?? row.key}: ${formatCount(row.visitors)}`}</li>
        ))}
      </ul>
    </div>
  );
}
