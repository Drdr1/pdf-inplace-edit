import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmp(bytes: Uint8Array, name = 'doc.pdf'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdfedit-'));
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** qpdf --check; throws with qpdf's output on failure. Returns warnings text. */
export function qpdfCheck(bytes: Uint8Array): string {
  try {
    return execFileSync('qpdf', ['--check', tmp(bytes)], { encoding: 'utf8' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    // exit code 3 = warnings only
    if (err.status === 3) return (err.stdout ?? '') + (err.stderr ?? '');
    throw new Error(`qpdf --check failed:\n${err.stdout}\n${err.stderr}`);
  }
}

/** Text as extracted by poppler's pdftotext, bidi marks stripped, spaces collapsed. */
export function pdftotext(bytes: Uint8Array): string[] {
  const out = execFileSync('pdftotext', [tmp(bytes), '-'], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) =>
      l
        .replace(/[\u0000‎‏\f]/g, '')
        .replace(/[‪-‮]/g, ' ') // poppler wraps bidi runs in embedding controls
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export interface Gray {
  w: number;
  h: number;
  px: Uint8Array;
}

/** Rasterise page 1 with poppler (independent of our engine and of pdf.js). */
export function rasterise(bytes: Uint8Array, dpi = 110): Gray {
  const p = tmp(bytes);
  const prefix = p.replace(/\.pdf$/, '');
  execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-f', '1', '-l', '1', p, prefix]);
  const dir = prefix.slice(0, prefix.lastIndexOf('/'));
  const file = readdirSync(dir).find((f) => f.endsWith('.pgm'))!;
  const buf = readFileSync(join(dir, file));
  // P5 header
  let i = 0;
  const fields: string[] = [];
  while (fields.length < 4) {
    while (buf[i] === 0x20 || buf[i] === 0x0a) i++;
    let s = '';
    while (buf[i] !== 0x20 && buf[i] !== 0x0a) s += String.fromCharCode(buf[i++]!);
    fields.push(s);
  }
  i++;
  return { w: +fields[1]!, h: +fields[2]!, px: new Uint8Array(buf.subarray(i)) };
}

/** PDF user-space box -> fraction of differing pixels (ink-normalised). */
export function diffRegion(a: Gray, b: Gray, box: { x0: number; y0: number; x1: number; y1: number }, dpi = 110, pageH = 841.92): number {
  const k = dpi / 72;
  const X0 = Math.max(0, Math.floor(box.x0 * k) - 2);
  const X1 = Math.min(a.w, Math.ceil(box.x1 * k) + 2);
  const Y0 = Math.max(0, Math.floor((pageH - box.y1) * k) - 2);
  const Y1 = Math.min(a.h, Math.ceil((pageH - box.y0) * k) + 2);
  let diff = 0;
  let ink = 0;
  for (let y = Y0; y < Y1; y++)
    for (let x = X0; x < X1; x++) {
      const pa = a.px[y * a.w + x]!;
      const pb = b.px[y * b.w + x]!;
      if (pa < 128 || pb < 128) ink++;
      if (Math.abs(pa - pb) > 96) diff++;
    }
  return ink ? diff / ink : 0;
}

/**
 * Compare one text line in two renderings that may sit at slightly different
 * page positions (e.g. a different Chromium version laid out the reference).
 * Each line is cropped to its own ink box, the crops are aligned on the given
 * edge, and the fraction of mismatching ink pixels is returned.
 */
export function diffLine(
  a: Gray,
  boxA: { x0: number; y0: number; x1: number; y1: number },
  b: Gray,
  boxB: { x0: number; y0: number; x1: number; y1: number },
  align: 'left' | 'right',
  dpi = 110,
  pageH = 841.92,
): number {
  const ink = (g: Gray, box: typeof boxA) => {
    const k = dpi / 72;
    const X0 = Math.max(0, Math.floor(box.x0 * k) - 4);
    const X1 = Math.min(g.w, Math.ceil(box.x1 * k) + 4);
    const Y0 = Math.max(0, Math.floor((pageH - box.y1) * k) - 4);
    const Y1 = Math.min(g.h, Math.ceil((pageH - box.y0) * k) + 4);
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = Y0; y < Y1; y++)
      for (let x = X0; x < X1; x++)
        if (g.px[y * g.w + x]! < 128) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    return { x0, y0, x1, y1 };
  };
  const ia = ink(a, boxA);
  const ib = ink(b, boxB);
  const w = Math.max(ia.x1 - ia.x0, ib.x1 - ib.x0) + 1;
  const h = Math.max(ia.y1 - ia.y0, ib.y1 - ib.y0) + 1;
  const ox0 = align === 'left' ? ib.x0 - ia.x0 : ib.x1 - ia.x1;
  const oy0 = ib.y1 - ia.y1; // align bottoms
  const sx = align === 'left' ? ia.x0 : ia.x1 - w + 1;
  // ink boxes can be off by a pixel or two (anti-aliasing, a different
  // descender); take the best alignment in a small window
  let best = 1;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      let diff = 0, inkCount = 0;
      for (let y = ia.y1 - h - 1; y <= ia.y1 + 2; y++)
        for (let x = sx - 2; x < sx + w + 2; x++) {
          const pa = a.px[y * a.w + x] ?? 255;
          const pb = b.px[(y + oy0 + dy) * b.w + (x + ox0 + dx)] ?? 255;
          if (pa < 128 || pb < 128) inkCount++;
          if (Math.abs(pa - pb) > 96) diff++;
        }
      if (inkCount) best = Math.min(best, diff / inkCount);
    }
  return best;
}
