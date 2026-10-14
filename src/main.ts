import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import { PdfTextEditor, FontLibrary, Subsetter, BUNDLED_FONTS, type LineInfo } from './engine';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const fontUrls = import.meta.glob('../fonts/*.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const overlay = $<HTMLDivElement>('overlay');
const status = $<HTMLSpanElement>('status');
const panel = $<HTMLElement>('panel');
const input = $<HTMLInputElement>('text');
const report = $<HTMLPreElement>('report');

let editor: PdfTextEditor | undefined;
let current: LineInfo | undefined;
let deps: Promise<{ library: FontLibrary; subsetter: Subsetter }> | undefined;
const SCALE = 1.5;

function loadDeps(): Promise<{ library: FontLibrary; subsetter: Subsetter }> {
  deps ??= (async () => {
    const library = new FontLibrary();
    for (const f of BUNDLED_FONTS) {
      const url = fontUrls[`../fonts/${f.file}`];
      if (!url) throw new Error(`missing font ${f.file}`);
      library.add(f.id, f.family, f.psName, f.bold, new Uint8Array(await (await fetch(url)).arrayBuffer()));
    }
    const subsetter = await Subsetter.create(await (await fetch(subsetWasmUrl)).arrayBuffer());
    return { library, subsetter };
  })();
  return deps;
}

async function open(bytes: Uint8Array): Promise<void> {
  status.textContent = 'Loading…';
  editor = await PdfTextEditor.open(bytes, await loadDeps());
  await render(bytes);
  $<HTMLButtonElement>('save').disabled = false;
  status.textContent = `${editor.lines(0).length} text lines found. Click one to edit.`;
}

async function render(bytes: Uint8Array): Promise<void> {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: SCALE });
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvas, viewport: vp }).promise;
  overlay.innerHTML = '';
  for (const l of editor!.lines(0)) {
    const [x0, y0] = vp.convertToViewportPoint(l.bbox.x0, l.bbox.y0) as [number, number];
    const [x1, y1] = vp.convertToViewportPoint(l.bbox.x1, l.bbox.y1) as [number, number];
    const el = document.createElement('div');
    el.className = 'line' + (current?.id === l.id ? ' sel' : '');
    el.dataset.line = String(l.id);
    el.title = l.text;
    Object.assign(el.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    el.onclick = () => select(l);
    overlay.appendChild(el);
  }
  (window as unknown as { __rendered: number }).__rendered = ((window as unknown as { __rendered?: number }).__rendered ?? 0) + 1;
}

function select(l: LineInfo): void {
  current = l;
  panel.hidden = false;
  input.value = l.text;
  input.dir = l.dir;
  report.textContent = `Fonts: ${l.fonts.join(', ')}\nDirection: ${l.dir}`;
  overlay.querySelectorAll('.line').forEach((e) => e.classList.toggle('sel', (e as HTMLElement).dataset.line === String(l.id)));
  input.focus();
}

$('apply').onclick = async () => {
  if (!editor || !current) return;
  try {
    const r = editor.replaceLine(0, current.id, input.value);
    report.textContent = r.runs.map((x) => `“${x.text}” → ${x.font} (${x.mode})`).join('\n') + (r.warnings.length ? '\n⚠ ' + r.warnings.join('\n⚠ ') : '');
    const bytes = await editor.save();
    current = editor.lines(0)[current.id];
    await render(bytes);
    status.textContent = 'Edit applied.';
  } catch (e) {
    report.textContent = `Error: ${(e as Error).message}`;
  }
};
$('cancel').onclick = () => {
  panel.hidden = true;
  current = undefined;
  overlay.querySelectorAll('.sel').forEach((e) => e.classList.remove('sel'));
};
$('save').onclick = async () => {
  if (!editor) return;
  const bytes = await editor.save();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  a.download = 'edited.pdf';
  a.click();
};
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await open(new Uint8Array(await f.arrayBuffer()));
};
$('sample').onclick = async () => open(new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}sample.pdf`)).arrayBuffer()));

// test hook: lets Playwright drive the engine on the exact same build
(window as unknown as Record<string, unknown>).__editorApi = {
  open: async (b64: string) => open(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
  lines: () => editor?.lines(0),
  replaceWord: (id: number, a: string, b: string) => editor!.replaceWord(0, id, a, b),
  save: async () => {
    const b = await editor!.save();
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  },
};
