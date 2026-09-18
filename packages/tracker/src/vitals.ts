// v.js: the optional Core Web Vitals script.
//
// AN-TRK01 asks for the web-vitals build inlined into a.js when it fits the
// budget. Measured on 2026-09-18 it does not: a.js with web-vitals inlined is
// 5995 B gzipped against a 3072 B budget. So vitals ship as this second,
// optional file, which reports through a.js and therefore shares its consent
// gate, visitor id and batching.
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import type { Metric } from 'web-vitals';

import type {} from './types';

function report(metric: Metric): void {
  const pa = window.pa;
  if (pa !== undefined) {
    pa('vital', metric.name, { value: metric.value, rating: metric.rating });
  }
}

onCLS(report);
onFCP(report);
onINP(report);
onLCP(report);
onTTFB(report);
