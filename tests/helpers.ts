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
