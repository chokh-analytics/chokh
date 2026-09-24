import {
  annotationIdFor,
  type AccountStore,
  type Annotation,
  type AnnotationKind,
} from '../store/AnalyticsStore.js';
import type { CreateAnnotationInput } from '../schemas/annotations.schema.js';

// Annotations: a fact stated about the site at an instant, drawn as a mark on
// the chart. Nothing is counted when one is written; the store holds the
// statement and the chart draws it beside the point it explains.

export type NewAnnotation = CreateAnnotationInput & {
  siteId: string;
  createdBy: string;
  now: number;
};

export async function createAnnotation(
  store: AccountStore,
  input: NewAnnotation,
): Promise<Annotation> {
  const kind = input.kind as AnnotationKind;
  const annotation: Annotation = {
    siteId: input.siteId,
    // Derived from the fact, so a pipeline that retries its POST is refused
    // by the store's unique index as ANNOTATION_EXISTS rather than marking
    // the chart twice.
    id: annotationIdFor(input.siteId, input.at, kind, input.text),
    at: input.at,
    kind,
    text: input.text,
    createdBy: input.createdBy,
    createdAt: input.now,
  };
  if (input.url !== undefined) {
    annotation.url = input.url;
  }
  await store.createAnnotation(annotation);
  return annotation;
}
