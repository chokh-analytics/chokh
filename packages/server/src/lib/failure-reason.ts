const UNKNOWN = 'no reason was given';

/**
 * Why something failed, in one line a person can read. `error.message` alone is
 * not that: where a host name answers on both IPv4 and IPv6, Node tries each
 * address and reports a refused connection as an `AggregateError` whose own
 * message is empty and whose reasons are inside it. So the reasons inside are
 * read first, each said once, and an error with nothing to say is named by its
 * code before it is called unknown.
 */
export function failureReason(error: unknown): string {
  if (error instanceof AggregateError) {
    const inside = [...new Set(error.errors.map((inner: unknown) => failureReason(inner)))].filter(
      (reason) => reason !== UNKNOWN,
    );
    if (inside.length > 0) return inside.join(', ');
  }
  if (error instanceof Error) {
    if (error.message !== '') return error.message;
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === 'string' && code !== '' ? code : UNKNOWN;
  }
  const said = typeof error === 'string' ? error : '';
  return said === '' ? UNKNOWN : said;
}
