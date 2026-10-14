// Generates test PDFs with Chromium's own PDF backend (Skia): a real-world
// producer with HarfBuzz-shaped Arabic, renumbered subset Type0 fonts without
// GSUB, per-letter ActualText spans and /ReversedChars marked content.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fontUrl = (f) => `data:font/ttf;base64,${readFileSync(resolve('fonts', f)).toString('base64')}`;
const css = `
@font-face { font-family: Naskh; src: url(${fontUrl('NotoNaskhArabic-Regular.ttf')}); }
@font-face { font-family: DejaVu; src: url(${fontUrl('DejaVuSans.ttf')}); }
@font-face { font-family: DejaVu; font-weight: bold; src: url(${fontUrl('DejaVuSans-Bold.ttf')}); }
body { margin: 48px; font-family: DejaVu; }
h1 { font-weight: bold; font-size: 28px; }
p { font-size: 20px; }
.ar { font-family: Naskh, DejaVu; direction: rtl; text-align: right; }
`;

export const SAMPLE_LINES = {
  heading: 'Quarterly Report Summary',
  body: 'This document was printed by Chromium for testing.',
  arabic: 'مرحبا بكم في التقرير السنوي للشركة',
  mixed: 'السعر 250 درهم لملف PDF واحد',
};

export const EXPECTED = {
  heading: { heading: 'Annual Report Summary' },
  arabic: { arabic: 'مرحبا بكم في التقرير الشهري للشركة' },
  'arabic-in-subset': { arabic: 'مرحبا بكم في التقرير التقرير للشركة' },
  mixed: { mixed: 'السعر 1,499 درهم لملف Word واحد' },
};

export function sampleHtml(lines = SAMPLE_LINES) {
  return `<h1>${lines.heading}</h1><p>${lines.body}</p><p class="ar">${lines.arabic}</p><p class="ar">${lines.mixed}</p>`;
}

export async function render(html, out) {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
  // load every face explicitly; newer headless Chromium may print before lazy
  // web fonts load, silently falling back to system fonts
  const loaded = await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((f) => f.load()));
    await document.fonts.ready;
    return [...document.fonts].map((f) => `${f.family}/${f.weight}:${f.status}`);
  });
  if (loaded.some((x) => !x.endsWith(':loaded'))) throw new Error(`fixture fonts failed to load: ${loaded.join(', ')}`);
  const pdf = await page.pdf({ format: 'A4', printBackground: false });
  await browser.close();
  if (out) writeFileSync(out, pdf);
  return new Uint8Array(pdf);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync('fixtures', { recursive: true });
  await render(sampleHtml(), 'fixtures/sample.pdf');
  // golden references: the same Chromium typesetting the edited sentences.
  // Committed, so golden tests do not depend on the CI's Chromium version.
  mkdirSync('fixtures/expected', { recursive: true });
  for (const [name, patch] of Object.entries(EXPECTED)) await render(sampleHtml({ ...SAMPLE_LINES, ...patch }), `fixtures/expected/${name}.pdf`);
  console.log('fixtures written');
}
