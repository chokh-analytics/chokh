import { describe, expect, it } from 'vitest';

import { csvCell, csvDocument, csvRow } from './csv.js';

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('/pricing')).toBe('/pricing');
    expect(csvCell(42)).toBe('42');
  });

  it('answers empty for nothing, so a null rate is a blank and not the word null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a value with a comma, a quote or a newline, and doubles the quotes', () => {
    expect(csvCell('Dhaka, Bangladesh')).toBe('"Dhaka, Bangladesh"');
    expect(csvCell('a "quoted" path')).toBe('"a ""quoted"" path"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  // A page path and a referrer are text somebody else chose. A spreadsheet reads a
  // leading = as a formula, so an export would otherwise be a way to run something
  // in the reader's Excel.
  it('defuses a value a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 comes first')).toBe('\'+44 comes first');
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // Quoting still happens on top of the guard when the value needs both.
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
  });
});

describe('csvRow and csvDocument', () => {
  it('joins cells with commas and rows with CRLF, and ends with a newline', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,');
    expect(csvDocument(['key', 'visitors'], [['/', 3], ['/pricing', 1]])).toBe(
      'key,visitors\r\n/,3\r\n/pricing,1\r\n',
    );
  });

  it('writes a header and nothing else for an empty report', () => {
    expect(csvDocument(['key', 'visitors'], [])).toBe('key,visitors\r\n');
  });
});
