import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PdfTextEditor } from '../../src/engine';
import { nodeDeps } from '../node-deps';
import { qpdfCheck, pdftotext, rasterise, diffRegion, diffLine } from '../helpers';
// @ts-expect-error plain JS module
import { render, sampleHtml, SAMPLE_LINES } from '../../scripts/make-fixtures.mjs';

const sample = new Uint8Array(readFileSync('fixtures/sample.pdf'));
// golden references, typeset by the same Chromium that produced the fixture
const golden = (name: string): Uint8Array => new Uint8Array(readFileSync(`fixtures/expected/${name}.pdf`));

async function edit(lineIdx: number, from: string, to: string, deps?: Awaited<ReturnType<typeof nodeDeps>>) {
  const ed = await PdfTextEditor.open(sample, deps ?? (await nodeDeps()));
  const before = ed.lines(0);
  const report = ed.replaceWord(0, lineIdx, from, to);
  const out = await ed.save();
  const reopened = await PdfTextEditor.open(out, await nodeDeps());
  return { before, report, out, after: reopened.lines(0) };
}

/** poppler prints an RTL line as bidi runs; compare as a bag of words */
function normaliseBidi(s: string): string {
  return s.split(' ').filter(Boolean).sort().join(' ');
}


describe('fixture analysis', () => {
  it('reads all four lines in logical order with direction', async () => {
    const ed = await PdfTextEditor.open(sample, await nodeDeps());
    const lines = ed.lines(0);
    expect(lines.map((l) => [l.text, l.dir])).toEqual([
      [SAMPLE_LINES.heading, 'ltr'],
      [SAMPLE_LINES.body, 'ltr'],
      [SAMPLE_LINES.arabic, 'rtl'],
      [SAMPLE_LINES.mixed, 'rtl'],
    ]);
  });
});

describe.each([
  { name: 'English bold heading', line: 0, from: 'Quarterly', to: 'Annual', key: 'heading' as const, ref: 'heading' },
  { name: 'Arabic word', line: 2, from: 'السنوي', to: 'الشهري', key: 'arabic' as const, ref: 'arabic' },
  { name: 'Arabic word already in the subset', line: 2, from: 'السنوي', to: 'التقرير', key: 'arabic' as const, ref: 'arabic-in-subset' },
  { name: 'mixed Arabic / English / digits', line: 3, from: '250 درهم لملف PDF', to: '1,499 درهم لملف Word', key: 'mixed' as const, ref: 'mixed' },
])('$name', ({ line, from, to, key, ref: refName }) => {
  let res: Awaited<ReturnType<typeof edit>>;
  let ref: Uint8Array;
  const expected = SAMPLE_LINES[key].replace(from, to);
  beforeAll(async () => {
    res = await edit(line, from, to);
    ref = golden(refName);
  });

  it('passes qpdf --check', () => {
    expect(() => qpdfCheck(res.out)).not.toThrow();
  });

  it('keeps the original font (no substitution)', () => {
    for (const r of res.report.runs) expect(['original', 'original-extended']).toContain(r.mode);
    expect(res.report.warnings).toEqual([]);
  });

  it('round-trips: re-opened file reads the new logical text', () => {
    expect(res.after[line]!.text).toBe(expected);
    // untouched lines unchanged
    res.before.forEach((l, k) => k !== line && expect(res.after[k]!.text).toBe(l.text));
  });

  it('extracts correctly with an independent extractor (pdftotext)', () => {
    const got = pdftotext(res.out);
    const orig = pdftotext(sample);
    // the edited line: exact logical text (poppler emits bidi runs; normalise word order)
    expect(normaliseBidi(got[line]!)).toBe(normaliseBidi(expected));
    // untouched lines: exactly what poppler extracted from the original file
    orig.forEach((t, k) => k !== line && expect(got[k]).toBe(t));
    void ref;
  });

  it('keeps the anchor edge (right for RTL, left for LTR)', () => {
    const b0 = res.before[line]!.bbox;
    const b1 = res.after[line]!.bbox;
    if (res.before[line]!.dir === 'rtl') expect(b1.x1).toBeCloseTo(b0.x1, 1);
    else expect(b1.x0).toBeCloseTo(b0.x0, 1);
    expect(b1.y0).toBeCloseTo(b0.y0, 1);
  });

  it('renders like Chromium typesetting the new text (shaping, joining, order)', async () => {
    // locate the line in the reference independently: its page position may
    // differ slightly between Chromium versions
    const refLines = (await PdfTextEditor.open(ref, await nodeDeps())).lines(0);
    const align = res.after[line]!.dir === 'rtl' ? 'right' : 'left';
    expect(refLines[line]!.text, `reference lines: ${JSON.stringify(refLines.map((l) => [l.text, l.fonts]))}`).toBe(expected);
    expect(diffLine(rasterise(res.out), res.after[line]!.bbox, rasterise(ref), refLines[line]!.bbox, align)).toBeLessThan(0.08);
  });

  it('leaves every other line pixel-identical', () => {
    const a = rasterise(res.out);
    const o = rasterise(sample);
    res.before.forEach((l, k) => k !== line && expect(diffRegion(a, o, l.bbox)).toBe(0));
  });
});

describe('producer drift', () => {
  it('reads every line of a PDF printed by the Chromium installed right now', async () => {
    const fresh: Uint8Array = await render(sampleHtml());
    const lines = (await PdfTextEditor.open(fresh, await nodeDeps())).lines(0);
    expect(lines.map((l) => l.text)).toEqual(Object.values(SAMPLE_LINES));
  });

  it('keeps mark glyphs placed far from the baseline on their line', async () => {
    // exaggerate every vertical Td (Chromium positions Arabic dots with Td)
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const { tokenize, fmtNum } = await import('../../src/engine/lexer');
    const doc = await PDFDocument.load(sample);
    const page = doc.getPages()[0]!;
    const ref = page.node.get(PDFName.of('Contents'));
    const raw = doc.context.lookup(ref) as import('pdf-lib').PDFRawStream;
    const { decodePDFRawStream } = await import('pdf-lib');
    const bytes = decodePDFRawStream(raw).decode();
    let out = '';
    let last = 0;
    const dec = new TextDecoder('latin1');
    for (const op of tokenize(bytes)) {
      if (op.op === 'Td' && op.operands[1]?.t === 'num' && op.operands[1].v !== 0 && op.operands[0]?.t === 'num') {
        const [x, y] = [op.operands[0].v, op.operands[1].v * 1.9];
        out += dec.decode(bytes.subarray(last, op.start)) + `${fmtNum(x)} ${fmtNum(y)} Td`;
        last = op.end;
      }
    }
    out += dec.decode(bytes.subarray(last));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(Uint8Array.from(out, (c) => c.charCodeAt(0)))));
    const lines = (await PdfTextEditor.open(await doc.save(), await nodeDeps())).lines(0);
    expect(lines.map((l) => l.text)).toEqual(Object.values(SAMPLE_LINES));
  });
});

describe('missing glyphs', () => {
  it('extends the original subset when the font is identified', async () => {
    // "Annual": A and n are not in the original "Quarterly Report Summary" subset
    const res = await edit(0, 'Quarterly', 'Annual');
    expect(res.report.runs[0]!.mode).toBe('original-extended');
    expect(res.report.runs[0]!.font).toBe('AAAAAA+DejaVuSans-Bold');
  });

  it('substitutes a bundled font (and says so) when the original font is unknown', async () => {
    // library without DejaVu: the Latin fonts cannot be identified
    const deps = await nodeDeps(['naskh-regular', 'naskh-bold', 'dejavu-regular']);
    const ed = await PdfTextEditor.open(sample, deps);
    const r = ed.replaceWord(0, 0, 'Quarterly', 'Annual');
    expect(r.runs.some((x) => x.mode === 'substitute')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/substituted/);
    const out = await ed.save();
    expect(() => qpdfCheck(out)).not.toThrow();
    expect(pdftotext(out)[0]).toBe('Annual Report Summary');
  });

  it('a second edit on an already-edited line still works', async () => {
    const ed = await PdfTextEditor.open(sample, await nodeDeps());
    ed.replaceWord(0, 2, 'السنوي', 'الشهري');
    ed.replaceWord(0, 2, 'للشركة', 'للمؤسسة');
    const out = await ed.save();
    expect(() => qpdfCheck(out)).not.toThrow();
    const again = await PdfTextEditor.open(out, await nodeDeps());
    expect(again.lines(0)[2]!.text).toBe('مرحبا بكم في التقرير الشهري للمؤسسة');
  });
});
