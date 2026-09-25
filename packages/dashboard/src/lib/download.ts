// A report as a file, from the browser's side (AN-RPT01).
//
// CSV is the server's: the route writes the file with the query on screen and
// a browser downloading a link is better at downloading than any code here.
// JSON is what the page already holds: the envelope's data, pretty printed,
// saved under the same name the server would have used, so the two files of
// one card sit beside each other in a folder and say what they are.

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// A name from what is in it, and nothing a file system objects to: an event
// is whatever a page passed and a funnel id is base64url, so the detail is
// reduced to the characters every file system takes.
export function exportName(
  siteId: string,
  kind: string,
  detail: string | undefined,
  range: { from: number; to: number },
): string {
  const safe = detail === undefined ? '' : `-${detail.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
  return `${siteId}-${kind}${safe}-${day(range.from)}-${day(range.to)}`;
}

export function jsonText(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Saves what the page holds as a file, through a link the page clicks for the
// person: the one way a browser offers to name a download. The object URL is
// released on the next turn, after the click has read it.
export function saveJson(name: string, data: unknown): void {
  const blob = new Blob([jsonText(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.json`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
