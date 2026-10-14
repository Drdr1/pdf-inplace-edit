// A second producer: pdf-lib. Exercises single-byte (WinAnsi, standard-14
// Helvetica, not embedded) fonts and a Type0 font that already has ToUnicode.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PdfTextEditor } from '../../src/engine';
import { nodeDeps } from '../node-deps';
import { qpdfCheck, pdftotext } from '../helpers';

async function makeDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.HelveticaBold);
  const dv = await doc.embedFont(readFileSync('fonts/DejaVuSans.ttf'), { subset: true });
  page.drawText('Invoice Number 1042', { x: 50, y: 780, size: 24, font: helv });
  page.drawText('Payment due within thirty days', { x: 50, y: 740, size: 14, font: dv });
  return doc.save();
}

describe('pdf-lib produced file', () => {
  it('edits a standard-14 Helvetica-Bold line (single-byte encoding, AFM widths)', async () => {
    const ed = await PdfTextEditor.open(await makeDoc(), await nodeDeps());
    expect(ed.lines(0).map((l) => l.text)).toEqual(['Invoice Number 1042', 'Payment due within thirty days']);
    const r = ed.replaceWord(0, 0, '1042', '2099');
    expect(r.runs[0]!.mode).toBe('original');
    expect(r.runs[0]!.font).toBe('Helvetica-Bold');
    const out = await ed.save();
    expect(() => qpdfCheck(out)).not.toThrow();
    expect(pdftotext(out)[0]).toBe('Invoice Number 2099');
    const again = await PdfTextEditor.open(out, await nodeDeps());
    expect(again.lines(0)[0]!.bbox.x0).toBeCloseTo(ed.lines(0)[0]!.bbox.x0, 1);
  });

  it('edits a Type0 font that has its own ToUnicode, extending its subset', async () => {
    const ed = await PdfTextEditor.open(await makeDoc(), await nodeDeps());
    const r = ed.replaceWord(0, 1, 'thirty', 'fifteen');
    expect(['original', 'original-extended']).toContain(r.runs[0]!.mode);
    const out = await ed.save();
    expect(() => qpdfCheck(out)).not.toThrow();
    expect(pdftotext(out)[1]).toBe('Payment due within fifteen days');
  });

  it('refuses characters the single-byte encoding cannot express, by substituting (and saying so)', async () => {
    const ed = await PdfTextEditor.open(await makeDoc(), await nodeDeps());
    const r = ed.replaceWord(0, 0, 'Number', 'رقم');
    expect(r.runs.some((x) => x.mode === 'substitute')).toBe(true);
    const out = await ed.save();
    expect(() => qpdfCheck(out)).not.toThrow();
    expect(pdftotext(out)[0]!.split(' ').sort()).toEqual(['1042', 'Invoice', 'رقم'].sort());
  });
});
