import type { ReportSessionRow } from '../modules/reports/reports.repository';

/** Header row shared by both formats. */
const COLUMNS = [
  'sessao',
  'testador',
  'status',
  'inicio',
  'fim',
  'duracao_ms',
  'valida',
  'nota_media',
] as const;

function rowValues(s: ReportSessionRow): string[] {
  return [
    s.sessionId,
    s.testerName,
    s.status,
    s.startedAt.toISOString(),
    s.endedAt?.toISOString() ?? '',
    s.durationMs === null ? '' : String(s.durationMs),
    s.valid === null ? '' : s.valid ? 'sim' : 'nao',
    s.averageRating === null ? '' : s.averageRating.toFixed(2),
  ];
}

/**
 * Neutralises spreadsheet formula injection: a cell that starts with one of
 * `= + - @` (or a tab/CR) is executed as a formula by Excel/Sheets. Tester
 * names are user-controlled, so those cells get a leading apostrophe.
 */
export function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC 4180 field quoting. */
function csvField(value: string): string {
  const safe = neutraliseFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function renderCsv(sessions: ReportSessionRow[]): Buffer {
  const lines = [COLUMNS.join(','), ...sessions.map((s) => rowValues(s).map(csvField).join(','))];
  // UTF-8 BOM so Excel opens accented names correctly.
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

/* ----------------------------------- PDF ----------------------------------- */

const PAGE_WIDTH = 595; // A4 @ 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const LINE_HEIGHT = 14;
const FONT_SIZE = 9;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT);
const MAX_LINE_CHARS = 95;

/**
 * Unicode → WinAnsi (cp1252) for the 0x80–0x9F block, where WinAnsi differs
 * from Latin-1. Everything else in 32–255 maps to itself; anything not
 * representable becomes '?'.
 */
const WIN_ANSI_EXTRAS: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

function toWinAnsi(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (WIN_ANSI_EXTRAS[code] !== undefined) bytes.push(WIN_ANSI_EXTRAS[code]);
    else if (code >= 32 && code <= 126) bytes.push(code);
    else if (code >= 160 && code <= 255) bytes.push(code);
    else bytes.push(63);
  }
  return Buffer.from(bytes);
}

function pdfEscape(text: string): string {
  return toWinAnsi(text)
    .toString('latin1')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Hard-wraps a line so no column is ever dropped; continuation lines are indented. */
function wrap(text: string): string[] {
  if (text.length <= MAX_LINE_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  let first = true;
  while (rest.length > 0) {
    const width = first ? MAX_LINE_CHARS : MAX_LINE_CHARS - 4;
    const cut = rest.length <= width ? rest.length : cutPoint(rest, width);
    out.push((first ? '' : '    ') + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    first = false;
  }
  return out;
}

/** Prefers breaking after a ' | ' separator; falls back to a hard cut. */
function cutPoint(text: string, width: number): number {
  const idx = text.lastIndexOf(' | ', width);
  return idx > 0 ? idx + 2 : width;
}

/**
 * Minimal, dependency-free PDF: one built-in Helvetica font, a text-only
 * table paginated by line count. Enough for a tabular export; anything
 * richer (charts, images) is a real reason to add a PDF library later.
 */
export function renderPdf(title: string, sessions: ReportSessionRow[]): Buffer {
  const lines = [
    title,
    '',
    COLUMNS.join(' | '),
    ...sessions.map((s) => rowValues(s).join(' | ')),
  ].flatMap(wrap);

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([title]);

  // Object layout: 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length; // 1-based object number
  };

  add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  add('PLACEHOLDER'); // 2 (filled once page ids are known)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3

  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const stream = [
      'BT',
      `/F1 ${FONT_SIZE} Tf`,
      `${LINE_HEIGHT} TL`,
      `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`,
      ...pageLines.map((l) => `(${pdfEscape(l)}) Tj T*`),
      'ET',
    ].join('\n');
    const streamBuf = Buffer.from(stream, 'latin1');
    const contentId = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${streamBuf.length} >>\nstream\n`, 'latin1'),
        streamBuf,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    'latin1',
  );

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(obj);
    position += obj.length;
  });

  const xrefStart = position;
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}
