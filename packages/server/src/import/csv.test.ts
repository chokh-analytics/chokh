import { describe, expect, it } from 'vitest';

import { csvRecords, parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks, LF or CRLF', () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'two\nlines'],
      ['1', '', '3'],
    ]);
  });

  it('ignores a byte order mark and blank lines', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('refuses a file that ends inside a quoted field', () => {
    expect(() => parseCsv('a\n"open')).toThrow('ends inside a quoted field');
  });
});

describe('csvRecords', () => {
  it('keys each row by the header', () => {
    expect(csvRecords('"date","visitors"\n"2025-01-01",10\n').records).toEqual([{ date: '2025-01-01', visitors: '10' }]);
  });

  it('refuses a row with a different number of fields, naming its line', () => {
    expect(() => csvRecords('a,b\n1,2\n3\n')).toThrow('line 3 has 1 fields where the header has 2');
  });
});
