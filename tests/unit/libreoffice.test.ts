// LibreOffice output: every font (Arabic included) is a single-byte TrueType
// subset, each table cell is its own text object, bidi runs are written in
// logical order, underlines are separate stroked paths, and the document is
// tagged (marked content with MCIDs).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { PdfTextEditor, type LineInfo } from '../../src/engine';
import { tokenize } from '../../src/engine/lexer';
import { nodeDeps } from '../node-deps';
import { qpdfCheck, pdftotext, rasterise, diffRegion } from '../helpers';

const src = new Uint8Array(readFileSync('fixtures/libreoffice-invoice.pdf'));

async function edit(find: (l: LineInfo) => boolean, from: string, to: string, deps?: Awaited<ReturnType<typeof nodeDeps>>) {
  const ed = await PdfTextEditor.open(src, deps ?? (await nodeDeps()));
  const before = ed.lines(0);
  const line = before.find(find);
  if (!line) throw new Error('line not found');
  const report = ed.replaceWord(0, line.id, from, to);
  const out = await ed.save();
  const after = (await PdfTextEditor.open(out, await nodeDeps())).lines(0);
  return { before, line, report, out, after };
}

async function content(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const s = doc.context.lookup(doc.getPages()[0]!.node.get(PDFName.of('Contents'))) as PDFRawStream;
  return decodePDFRawStream(s).decode();
}

const others = (before: LineInfo[], edited: LineInfo, a: ReturnType<typeof rasterise>, b: ReturnType<typeof rasterise>) =>
  before.filter((l) => l.id !== edited.id && (l.bbox.y1 < edited.bbox.y0 || l.bbox.y0 > edited.bbox.y1)).map((l) => diffRegion(a, b, l.bbox));

describe('LibreOffice: analysis', () => {
  it('splits table cells, joins logical-order bidi runs, reads single-byte Arabic', async () => {
    const lines = (await PdfTextEditor.open(src, await nodeDeps())).lines(0).map((l) => l.text);
    expect(lines).toContain('Qty');
    expect(lines).toContain('Unit');
    expect(lines).toContain('24');
    expect(lines).toContain('يجب تسليم البضاعة خلال خمسة أيام عمل.');
    expect(lines).toContain('Reference 1188-2026 رقم الإشعار must be quoted on the invoice.');
  });
});

describe('LibreOffice: edits', () => {
  it('table cell number: only that cell changes, saved as an incremental update', async () => {
    const r = await edit((l) => l.text === '24', '24', '30');
    expect(r.report.runs.every((x) => x.mode === 'original')).toBe(true);
    expect(() => qpdfCheck(r.out)).not.toThrow();
    expect(Buffer.from(r.out.subarray(0, src.length)).equals(Buffer.from(src))).toBe(true);
    const a = rasterise(r.out);
    const b = rasterise(src);
    for (const l of r.before.filter((x) => x.id !== r.line.id)) expect(diffRegion(a, b, l.bbox)).toBe(0);
    expect(pdftotext(r.out).join(' ')).toContain('30 pcs');
  });

  it('bold underlined heading: stays bold, missing glyphs come from the same font, underline follows the new width', async () => {
    const r = await edit((l) => l.text === 'Delivery Instructions', 'Instructions', 'Requirements');
    expect(r.report.runs[0]!.font).toBe('DAAAAA+LiberationSerif-Bold');
    expect(['original', 'original-with-supplement']).toContain(r.report.runs[0]!.mode);
    expect(() => qpdfCheck(r.out)).not.toThrow();
    expect(pdftotext(r.out)).toContain('Delivery Requirements');
    // the underline's right end moved by exactly the width change
    const delta = r.report.newWidth - r.report.oldWidth;
    const xs = (bytes: Uint8Array) => {
      const ops = tokenize(bytes);
      return ops.flatMap((o, i) => (o.op === 'l' && ops[i - 1]?.op === 'm' && o.operands[0]?.t === 'num' ? [o.operands[0].v] : []));
    };
    const before = xs(await content(src));
    const after = xs(await content(r.out));
    const moved = after.filter((x) => !before.some((y) => Math.abs(x - y) < 1e-6));
    expect(moved).toHaveLength(1);
    expect(before.some((y) => Math.abs(y + delta - moved[0]!) < 0.01)).toBe(true);
  });

  it('Arabic word in a single-byte font: joined, other words untouched, structure tags kept', async () => {
    const r = await edit((l) => l.text.includes('خمسة'), 'خمسة', 'عشرة');
    expect(() => qpdfCheck(r.out)).not.toThrow();
    expect(r.after.find((l) => l.text.includes('عشرة'))!.text).toBe('يجب تسليم البضاعة خلال عشرة أيام عمل.');
    expect(pdftotext(r.out).join(' ').split(' ')).toContain('عشرة');
    // tagged PDF: every MCID still present
    const mcids = (b: Uint8Array) => new TextDecoder('latin1').decode(b).match(/\/MCID \d+/g)?.length ?? 0;
    expect(mcids(await content(r.out))).toBe(mcids(await content(src)));
    const a = rasterise(r.out);
    const b = rasterise(src);
    for (const d of others(r.before, r.line, a, b)) expect(d).toBe(0);
  });

  it('Arabic word whose font is unknown: bundled substitute, reported', async () => {
    const deps = await nodeDeps(['dejavu-regular', 'dejavu-bold', 'liberation-serif-bold', 'naskh-bold']);
    const r = await edit((l) => l.text.includes('خمسة'), 'خمسة', 'عشرة', deps);
    expect(r.report.runs.some((x) => x.mode === 'substitute')).toBe(true);
    expect(r.report.warnings.join(' ')).toMatch(/substituted/);
    expect(() => qpdfCheck(r.out)).not.toThrow();
  });

  it('number next to Arabic in an LTR sentence: Arabic words do not move', async () => {
    const r = await edit((l) => l.text.startsWith('Reference'), '1188-2026', '1188-2027');
    expect(() => qpdfCheck(r.out)).not.toThrow();
    expect(r.after.find((l) => l.text.startsWith('Reference'))!.text).toBe('Reference 1188-2027 رقم الإشعار must be quoted on the invoice.');
    expect(r.report.notes).toEqual([]); // same width: nothing else moves
  });

  it('two saves stack as two incremental updates', async () => {
    const ed = await PdfTextEditor.open(src, await nodeDeps());
    ed.replaceWord(0, ed.lines(0).find((l) => l.text === '24')!.id, '24', '30');
    const first = await ed.save();
    ed.replaceWord(0, ed.lines(0).find((l) => l.text === '8')!.id, '8', '9');
    const second = await ed.save();
    expect(Buffer.from(second.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true);
    expect(() => qpdfCheck(second)).not.toThrow();
    expect(pdftotext(second).join(' ')).toMatch(/30 pcs.*9 pcs/);
  });
});
