// A small RFC 4180 reader, so the importers need no dependency: fields
// separated by commas, a field in double quotes may hold commas, line breaks
// and doubled quotes, lines end in LF or CRLF, a byte order mark is ignored.
// Every row becomes an object keyed by the header row.

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (char === '\r' && input[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
    i += 1;
  }
  if (quoted) {
    throw new Error('the file ends inside a quoted field');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A blank line is not a record.
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

export function csvRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const [header, ...body] = parseCsv(text);
  if (header === undefined) {
    return { header: [], records: [] };
  }
  const names = header.map((name) => name.trim());
  const records = body.map((cells, index) => {
    if (cells.length !== names.length) {
      throw new Error(`line ${index + 2} has ${cells.length} fields where the header has ${names.length}`);
    }
    const record: Record<string, string> = {};
    names.forEach((name, column) => {
      record[name] = cells[column] as string;
    });
    return record;
  });
  return { header: names, records };
}
