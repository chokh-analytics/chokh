// The stat badge (AN-RPT01): one number as an SVG a README or a page can
// carry as an image. Two boxes, the label on the left and the number on the
// right, sized from the text so nothing is clipped; a title and a label for
// whoever reads it without seeing it.

const GROUPED = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const COMPACT_FROM = 10_000;

export function compactCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const rounded = Math.round(value);
  return Math.abs(rounded) < COMPACT_FROM ? GROUPED.format(rounded) : COMPACT.format(rounded);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Verdana at 11px is about 6.5px a character; a badge that is a few pixels
// wide of the mark is fine and one that clips a digit is not.
const CHAR_WIDTH = 6.5;
const PAD = 8;
const HEIGHT = 20;

export function badgeSvg(label: string, value: string): string {
  const labelWidth = Math.round(label.length * CHAR_WIDTH + PAD * 2);
  const valueWidth = Math.round(value.length * CHAR_WIDTH + PAD * 2);
  const width = labelWidth + valueWidth;
  const title = `${escapeXml(label)}: ${escapeXml(value)}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<rect width="${labelWidth}" height="${HEIGHT}" rx="3" fill="#2f3542"/>` +
    `<rect x="${labelWidth - 3}" width="3" height="${HEIGHT}" fill="#0f766e"/>` +
    `<rect x="${labelWidth}" width="${valueWidth}" height="${HEIGHT}" rx="3" fill="#0f766e"/>` +
    `<rect x="${labelWidth}" width="3" height="${HEIGHT}" fill="#0f766e"/>` +
    `<g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">` +
    `<text x="${labelWidth / 2}" y="14">${escapeXml(label)}</text>` +
    `<text x="${labelWidth + valueWidth / 2}" y="14" font-weight="bold">${escapeXml(value)}</text>` +
    `</g></svg>`
  );
}
