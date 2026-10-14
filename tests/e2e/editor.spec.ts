import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { qpdfCheck, pdftotext, rasterise, diffLine } from '../helpers';
import { PdfTextEditor } from '../../src/engine';
import { nodeDeps } from '../node-deps';
// @ts-expect-error plain JS module
import { render, sampleHtml, SAMPLE_LINES } from '../../scripts/make-fixtures.mjs';

type Lines = typeof SAMPLE_LINES;
interface Box { x0: number; y0: number; x1: number; y1: number }
interface ApiLine { id: number; text: string; dir: string; bbox: Box; fonts: string[] }

const words = (s: string): string => s.split(' ').filter(Boolean).sort().join(' ');
const sampleB64 = readFileSync('fixtures/sample.pdf').toString('base64');

async function boot(page: Page): Promise<string[]> {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) external.push(r.url());
  });
  await page.goto('/');
  await page.waitForFunction(() => '__editorApi' in window);
  return external;
}

const cases = [
  { name: 'English bold heading', line: 0, from: 'Quarterly', to: 'Annual', key: 'heading' as const, ref: 'heading' },
  { name: 'Arabic word in place', line: 2, from: 'السنوي', to: 'الشهري', key: 'arabic' as const, ref: 'arabic' },
  { name: 'mixed Arabic, English and digits', line: 3, from: '250 درهم لملف PDF', to: '1,499 درهم لملف Word', key: 'mixed' as const, ref: 'mixed' },
];

for (const c of cases) {
  test(`in-browser engine: ${c.name}`, async ({ page }) => {
    const external = await boot(page);
    await page.evaluate((b64) => (window as never as { __editorApi: { open(b: string): Promise<void> } }).__editorApi.open(b64), sampleB64);
    const before = (await page.evaluate(() => (window as never as { __editorApi: { lines(): ApiLine[] } }).__editorApi.lines())) as ApiLine[];
    const report = await page.evaluate(
      ([id, a, b]) => (window as never as { __editorApi: { replaceWord(i: number, a: string, b: string): unknown } }).__editorApi.replaceWord(id as number, a as string, b as string),
      [c.line, c.from, c.to],
    ) as { runs: { mode: string; font: string }[]; warnings: string[] };
    const out = Buffer.from(await page.evaluate(() => (window as never as { __editorApi: { save(): Promise<string> } }).__editorApi.save()), 'base64');
    const bytes = new Uint8Array(out);

    const expected = SAMPLE_LINES[c.key].replace(c.from, c.to);
    const ref = new Uint8Array(readFileSync(`fixtures/expected/${c.ref}.pdf`));

    expect(() => qpdfCheck(bytes)).not.toThrow();
    for (const r of report.runs) expect(['original', 'original-extended']).toContain(r.mode);
    expect(report.warnings).toEqual([]);
    const got = pdftotext(bytes);
    const orig = pdftotext(new Uint8Array(readFileSync('fixtures/sample.pdf')));
    expect(words(got[c.line]!)).toBe(words(expected));
    orig.forEach((t, k) => k !== c.line && expect(got[k]).toBe(t));
    const deps = await nodeDeps();
    const mine = (await PdfTextEditor.open(bytes, deps)).lines(0)[c.line]!;
    const theirs = (await PdfTextEditor.open(ref, deps)).lines(0)[c.line]!;
    expect(diffLine(rasterise(bytes), mine.bbox, rasterise(ref), theirs.bbox, mine.dir === 'rtl' ? 'right' : 'left')).toBeLessThan(0.08);
    void before;
    expect(external).toEqual([]);
  });
}

test('UI: click the Arabic line, change one word, save', async ({ page }) => {
  const external = await boot(page);
  await page.click('#sample');
  await expect(page.locator('#status')).toContainText('text lines found');
  const arabicLine = page.locator(`.line[title="${SAMPLE_LINES.arabic}"]`);
  await arabicLine.click();
  await expect(page.locator('#text')).toHaveValue(SAMPLE_LINES.arabic);
  await expect(page.locator('#text')).toHaveAttribute('dir', 'rtl');
  await page.fill('#text', SAMPLE_LINES.arabic.replace('السنوي', 'الشهري'));
  await page.click('#apply');
  await expect(page.locator('#status')).toHaveText('Edit applied.');
  await expect(page.locator('#report')).toContainText('NotoNaskhArabic-Regular');
  await expect(page.locator(`.line[title="${SAMPLE_LINES.arabic.replace('السنوي', 'الشهري')}"]`)).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  const bytes = new Uint8Array(readFileSync(await download.path()));
  expect(() => qpdfCheck(bytes)).not.toThrow();
  // poppler splits Chromium-style dotted Naskh oddly ("ف ي"), so compare with
  // what it extracts from Chromium typesetting the same sentence
  expect(pdftotext(bytes)[2]).toBe(SAMPLE_LINES.arabic.replace('السنوي', 'الشهري'));
  await page.screenshot({ path: 'test-results/ui-after-edit.png' });
  expect(external).toEqual([]);
});
