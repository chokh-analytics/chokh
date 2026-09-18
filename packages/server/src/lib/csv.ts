// CSV, written once, because a report exported wrong is worse than one not
// exported at all.
//
// Two rules a naive join gets wrong. A value holding a comma, a quote or a
// newline is quoted and its quotes doubled, which is RFC 4180. And a value
// beginning with =, +, - or @ is prefixed with a single quote: a spreadsheet
// reads those as a formula, and a page path or a referrer is attacker chosen
// text, so a breakdown export is otherwise a way to run something in the
// reader's Excel. Prefixing is what every spreadsheet reads as a literal.

type Cell = string | number | null | undefined;

const NEEDS_QUOTES = /[",\r\n]/;
const LOOKS_LIKE_A_FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'number' ? String(value) : value;
  const guarded = LOOKS_LIKE_A_FORMULA.test(text) ? `'${text}` : text;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(',');
}

// CRLF between rows, which is what RFC 4180 says and what Excel on Windows
// wants. A trailing newline, so appending a file to another one works.
export function csvDocument(header: readonly string[], rows: readonly Cell[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}
