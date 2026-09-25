import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { count, headline, periodWords, rate, topLines, type DigestReport, type Line } from './compose.js';

// The digest as one page (AN-RPT01): the numbers with their change, the
// period's shape as bars, and the three top-five lists. Drawn with pdf-lib
// and a standard font, so no browser and no font file is needed on the host,
// and the page is the same on every install.

const WIDTH = 595;
const HEIGHT = 842;
const MARGIN = 48;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.06, 0.46, 0.43);
const LINE = rgb(0.9, 0.91, 0.93);

interface Pen {
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
}

function text(pen: Pen, value: string, x: number, size: number, options: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: number } = {}): void {
  const font = options.bold === true ? pen.bold : pen.regular;
  const at = options.right === undefined ? x : options.right - font.widthOfTextAtSize(value, size);
  pen.page.drawText(value, { x: at, y: pen.y, size, font, color: options.color ?? INK });
}

function rule(pen: Pen): void {
  pen.page.drawLine({
    start: { x: MARGIN, y: pen.y },
    end: { x: WIDTH - MARGIN, y: pen.y },
    thickness: 0.5,
    color: LINE,
  });
}

function heading(pen: Pen, value: string): void {
  pen.y -= 22;
  text(pen, value, MARGIN, 11, { bold: true, color: MUTED });
  pen.y -= 6;
  rule(pen);
  pen.y -= 14;
}

function lines(pen: Pen, rows: Line[], x: number, width: number, withChange: boolean): void {
  if (rows.length === 0) {
    text(pen, 'nothing', x, 10, { color: MUTED });
    pen.y -= 14;
    return;
  }
  for (const row of rows) {
    text(pen, row.label.length > 44 ? `${row.label.slice(0, 43)}…` : row.label, x, 10);
    text(pen, row.value, x, 10, { bold: true, right: x + width - (withChange ? 64 : 0) });
    if (withChange) {
      text(pen, row.change, x, 9, { color: MUTED, right: x + width });
    }
    pen.y -= 14;
  }
}

// The period's shape: one bar per point, visitors, the tallest at full height.
function bars(pen: Pen, report: DigestReport): void {
  const points = report.series;
  const top = Math.max(1, ...points.map((point) => point.metrics.visitors));
  const width = WIDTH - MARGIN * 2;
  const height = 72;
  const base = pen.y - height;
  const gap = 2;
  const barWidth = Math.max(1, (width - gap * Math.max(0, points.length - 1)) / Math.max(1, points.length));
  points.forEach((point, index) => {
    const value = point.metrics.visitors;
    const barHeight = (value / top) * height;
    pen.page.drawRectangle({
      x: MARGIN + index * (barWidth + gap),
      y: base,
      width: barWidth,
      height: Math.max(0.5, barHeight),
      color: ACCENT,
    });
  });
  pen.y = base - 4;
  const legend =
    report.cadence === 'daily'
      ? `Visitors by hour, peak ${count(top)}`
      : `Visitors by day, peak ${count(top)}`;
  pen.y -= 10;
  text(pen, legend, MARGIN, 9, { color: MUTED });
}

export async function renderDigestPdf(report: DigestReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${report.site.name}, ${periodWords(report)}`);
  doc.setProducer('Chokh');
  doc.setCreator('Chokh');
  const page = doc.addPage([WIDTH, HEIGHT]);
  const pen: Pen = {
    page,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    y: HEIGHT - MARGIN - 8,
  };

  text(pen, report.site.name, MARGIN, 18, { bold: true });
  text(pen, 'Chokh', MARGIN, 10, { color: MUTED, right: WIDTH - MARGIN });
  pen.y -= 16;
  text(
    pen,
    `${periodWords(report)}${report.previous === null ? '' : ', against the period before'}`,
    MARGIN,
    10,
    { color: MUTED },
  );

  heading(pen, 'THE NUMBERS');
  const tiles = headline(report);
  const tileWidth = (WIDTH - MARGIN * 2) / tiles.length;
  const rowY = pen.y;
  tiles.forEach((tile, index) => {
    const x = MARGIN + index * tileWidth;
    pen.y = rowY;
    text(pen, tile.label, x, 9, { color: MUTED });
    pen.y = rowY - 18;
    text(pen, tile.value, x, 16, { bold: true });
    pen.y = rowY - 32;
    text(pen, tile.change, x, 9, { color: tile.change.startsWith('+') ? ACCENT : MUTED });
  });
  pen.y = rowY - 44;

  heading(pen, report.cadence === 'daily' ? 'THE DAY' : 'THE WEEK');
  bars(pen, report);

  heading(pen, 'TOP PAGES');
  lines(pen, topLines('page', report.pages), MARGIN, WIDTH - MARGIN * 2, false);

  const half = (WIDTH - MARGIN * 2 - 24) / 2;
  heading(pen, 'SOURCES AND COUNTRIES');
  const listTop = pen.y;
  lines(pen, topLines('channel', report.channels), MARGIN, half, false);
  const afterChannels = pen.y;
  pen.y = listTop;
  lines(pen, topLines('country', report.countries), MARGIN + half + 24, half, false);
  pen.y = Math.min(pen.y, afterChannels);

  heading(pen, 'GOALS');
  lines(
    pen,
    report.goals.map((goal) => ({
      label: goal.name,
      value: `${count(goal.conversion.visitors)} converted`,
      change: rate(goal.conversion.rate),
    })),
    MARGIN,
    WIDTH - MARGIN * 2,
    true,
  );

  if (report.annotations.length > 0) {
    heading(pen, 'MARKS ON THE CHART');
    lines(
      pen,
      report.annotations.map((mark) => ({ label: `${mark.kind}: ${mark.text}`, value: '', change: '' })),
      MARGIN,
      WIDTH - MARGIN * 2,
      false,
    );
  }

  // Plain content streams, so what the page says can be read back by a test
  // and by anybody with a text editor; the file is a page, not an archive.
  return doc.save({ useObjectStreams: false });
}
