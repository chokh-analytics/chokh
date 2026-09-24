import {
  canonicalFilters,
  segmentIdFor,
  type AccountStore,
  type Segment,
} from '../store/AnalyticsStore.js';
import type { CreateSegmentInput } from '../schemas/segments.schema.js';

// Segments: a named, saved filter list, and nothing more. Applying one is
// sending its filters to a report, which every report already answers, so
// nothing here is counted and the store holds only the question.

export type NewSegment = CreateSegmentInput & {
  siteId: string;
  createdBy: string;
  now: number;
};

export async function createSegment(store: AccountStore, input: NewSegment): Promise<Segment> {
  const filters = canonicalFilters(input.filters);
  const segment: Segment = {
    siteId: input.siteId,
    // Derived from the filters, so the same filters saved twice under another
    // name are refused by the store's unique index as SEGMENT_EXISTS.
    id: segmentIdFor(input.siteId, filters),
    name: input.name,
    filters,
    createdBy: input.createdBy,
    createdAt: input.now,
  };
  await store.createSegment(segment);
  return segment;
}
