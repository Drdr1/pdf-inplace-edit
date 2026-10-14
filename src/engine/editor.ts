// In-place text editing for existing PDF text (English, Arabic, mixed).
//
// Pipeline for one edit:
//   1. interpret the page content stream -> glyphs with exact positions
//   2. group glyphs into visual lines, rebuild the logical text
//   3. bidi-itemise the new text, pick a font per run (prefer the fonts the
//      line already uses), shape with HarfBuzz
//   4. map shaped glyphs into the ORIGINAL embedded font when possible;
//      otherwise grow the original subset (same font, identified by outline
//      match) or, as a last resort, embed a bundled substitute subset
//   5. splice the content stream: delete the old show operators, insert new
//      TJ operators at the old anchor (right edge for RTL, left for LTR),
//      restore text state so untouched content keeps its exact position
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFPage,
  PDFString,
  type PDFObject,
} from 'pdf-lib';
import bidiFactory from 'bidi-js';
import { tokenize, fmtNum, hexStr, serializeOperand, type Operand } from './lexer';
import { interpret, invert, mul, apply, isShowOp, type Glyph, type Interpretation, type Mat, type OpState } from './interp';
import { readFont, lookup, streamBytes, type PdfFont } from './pdffont';
import { FontLibrary, ShapingFont, type LibFont, type ShapedGlyph } from './fontlib';
import { Subsetter } from './subset';
import { isArabicCp, scriptOf, visualToLogical, type Script } from './text';

const bidi = bidiFactory();
// Text for glyphs that carry no characters of their own (e.g. separate dot
// glyphs). U+0000 is what Chromium/Skia writes; pdf.js and poppler drop it.
const MARK_TEXT = '\u0000';

// ---------------------------------------------------------------- types

export interface LineInfo {
  id: number;
  text: string;
  dir: 'ltr' | 'rtl';
  /** axis-aligned box in PDF user space */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  fonts: string[];
}

export type FontMode = 'original' | 'original-extended' | 'same-font-supplement' | 'substitute';

export interface EditReport {
  oldText: string;
  newText: string;
  runs: { text: string; font: string; mode: FontMode }[];
  oldWidth: number;
  newWidth: number;
  warnings: string[];
}

interface Line {
  id: number;
  glyphs: Glyph[];
  text: string;
  dir: 'ltr' | 'rtl';
  u: [number, number];
  v: [number, number];
  basePerp: number;
  left: number;
  right: number;
  size: number;
  first: Glyph;
  /** code point -> font that drew it on this line */
  charFonts: Map<number, PdfFont>;
  scriptFonts: Map<Script, PdfFont>;
  fonts: PdfFont[];
}

interface Alias {
  gid: number;
  text: string;
  width: number;
}

/** Edit-time state for an original font dictionary. */
interface OrigHandle {
  kind: 'orig';
  pdf: PdfFont;
  embedded: ShapingFont | undefined;
  ident: { lib: LibFont; fullToSub: Map<number, number>; subToFull: Map<number, number>; upgradable: boolean } | undefined;
  upgraded: boolean;
  aliases: Map<number, Alias>;
  aliasKey: Map<string, number>;
  nextCid: number;
  dirty: boolean;
  origW: PDFObject[] | undefined;
}

/** A font we add (subset of a library font). CIDs are ours, GIDs are full-font GIDs. */
interface SuppHandle {
  kind: 'supp';
  lib: LibFont;
  ref: PDFRef;
  tag: string;
  aliases: Map<number, Alias>;
  aliasKey: Map<string, number>;
  nextCid: number;
}

type Handle = OrigHandle | SuppHandle;

interface PageModel {
  page: PDFPage;
  content: Uint8Array;
  fonts: Map<string, PdfFont>;
  handlesByRes: Map<string, Handle>;
  interp: Interpretation;
  lines: Line[];
  contentRef?: PDFRef;
}

// glyph placed by the writer
interface Placed {
  handle: Handle;
  resName: string;
  size: number;
  code: number;
  twoByte: boolean;
  pdfW: number; // width the viewer will use (glyph space)
  adv: number; // desired advance (glyph space)
  xOff: number;
  yOff: number;
  cluster: number; // global cluster key
  clusterText: string;
  isSpaceCode: boolean;
}

// ---------------------------------------------------------------- editor

export class PdfTextEditor {
  private pages: PageModel[] = [];
  private handles = new Map<string, OrigHandle>();
  private supp = new Map<string, SuppHandle>();
  private tagSeq = 0;

  private constructor(
    readonly doc: PDFDocument,
    private readonly library: FontLibrary,
    private readonly subsetter: Subsetter,
  ) {}

  static async open(bytes: Uint8Array, deps: { library: FontLibrary; subsetter: Subsetter }): Promise<PdfTextEditor> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ed = new PdfTextEditor(doc, deps.library, deps.subsetter);
    doc.getPages().forEach((p) => ed.pages.push(ed.loadPage(p, pageContent(doc, p))));
    return ed;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  lines(pageIndex: number): LineInfo[] {
    return this.page(pageIndex).lines.map((l) => this.info(l));
  }

  lineAt(pageIndex: number, x: number, y: number): LineInfo | undefined {
    const hits = this.lines(pageIndex).filter((l) => x >= l.bbox.x0 && x <= l.bbox.x1 && y >= l.bbox.y0 && y <= l.bbox.y1);
    return hits.sort((a, b) => a.bbox.y1 - a.bbox.y0 - (b.bbox.y1 - b.bbox.y0))[0];
  }

  replaceWord(pageIndex: number, lineId: number, oldWord: string, newWord: string): EditReport {
    const line = this.page(pageIndex).lines[lineId];
    if (!line) throw new Error(`no line ${lineId}`);
    const at = line.text.indexOf(oldWord);
    if (at < 0) throw new Error(`"${oldWord}" not found in line "${line.text}"`);
    return this.replaceLine(pageIndex, lineId, line.text.slice(0, at) + newWord + line.text.slice(at + oldWord.length));
  }

  replaceLine(pageIndex: number, lineId: number, newText: string): EditReport {
    const pm = this.page(pageIndex);
    const line = pm.lines[lineId];
    if (!line) throw new Error(`no line ${lineId}`);
    const warnings: string[] = [];
    const { placed, runs } = this.layout(pm, line, newText.normalize('NFC'), warnings);
    const { bytes, newWidth, oldWidth } = this.splice(pm, line, placed, warnings);
    pm.content = bytes;
    this.reanalyse(pageIndex);
    return { oldText: line.text, newText, runs, oldWidth, newWidth, warnings };
  }

  async save(): Promise<Uint8Array> {
    const ctx = this.doc.context;
    for (const h of this.handles.values()) if (h.dirty) this.writeOrigFont(h);
    for (const s of this.supp.values()) this.writeSuppFont(s);
    for (const pm of this.pages) {
      const stream = ctx.flateStream(pm.content);
      pm.contentRef ??= ctx.nextRef();
      ctx.assign(pm.contentRef, stream);
      pm.page.node.set(PDFName.of('Contents'), pm.contentRef);
    }
    return this.doc.save({ useObjectStreams: false });
  }

  // ------------------------------------------------------------ analysis

  private page(i: number): PageModel {
    const p = this.pages[i];
    if (!p) throw new Error(`no page ${i}`);
    return p;
  }

  private reanalyse(i: number): void {
    const pm = this.page(i);
    const next = this.loadPage(pm.page, pm.content);
    next.contentRef = pm.contentRef;
    this.pages[i] = next;
  }

  private loadPage(page: PDFPage, content: Uint8Array): PageModel {
    const ctx = this.doc.context;
    const fontDict = page.node.Resources()?.lookup(PDFName.of('Font'));
    const fonts = new Map<string, PdfFont>();
    const handlesByRes = new Map<string, Handle>();
    if (fontDict instanceof PDFDict) {
      for (const [k, v] of fontDict.entries()) {
        const name = k.decodeText();
        const ref = v instanceof PDFRef ? v : undefined;
        const supp = ref ? [...this.supp.values()].find((s) => s.ref === ref) : undefined;
        if (supp) {
          fonts.set(name, suppAsPdfFont(supp));
          handlesByRes.set(name, supp);
          continue;
        }
        const d = lookup(ctx, v);
        if (!(d instanceof PDFDict)) continue;
        const pdf = readFont(ctx, name, ref, d);
        const h = this.origHandle(pdf);
        fonts.set(name, patchedFont(h));
        handlesByRes.set(name, h);
      }
    }
    const props = page.node.Resources()?.lookup(PDFName.of('Properties'));
    const resolveProps = (n: string): Operand | undefined => {
      if (!(props instanceof PDFDict)) return undefined;
      const d = lookup(ctx, props.get(PDFName.of(n)));
      if (!(d instanceof PDFDict)) return undefined;
      const at = d.get(PDFName.of('ActualText'));
      const m = new Map<string, Operand>();
      if (at && 'asBytes' in at) m.set('ActualText', { t: 'str', v: (at as unknown as { asBytes(): Uint8Array }).asBytes(), hex: true });
      return { t: 'dict', v: m };
    };
    const interp = interpret(tokenize(content), fonts, resolveProps);
    const pm: PageModel = { page, content, fonts, handlesByRes, interp, lines: [] };
    pm.lines = this.groupLines(pm);
    return pm;
  }

  private origHandle(pdf: PdfFont): OrigHandle {
    let h = this.handles.get(pdf.key);
    if (h) return h;
    let embedded: ShapingFont | undefined;
    if (pdf.program) {
      try {
        embedded = new ShapingFont(pdf.program);
      } catch {
        embedded = undefined;
      }
    }
    let ident: OrigHandle['ident'];
    if (embedded) {
      const id = this.library.identify(embedded, pdf.baseFont);
      if (id) {
        const subToFull = new Map<number, number>();
        for (const [full, sub] of id.fullToSub) if (!subToFull.has(sub)) subToFull.set(sub, full);
        let upgradable = true;
        let emptyFull: number | undefined;
        for (let g = 0; g < id.lib.font.numGlyphs && emptyFull === undefined; g++) if (g > 0 && !id.lib.font.hasOutline(g)) emptyFull = g;
        for (let g = 0; g < embedded.numGlyphs; g++) {
          if (subToFull.has(g)) continue;
          if (!embedded.hasOutline(g) && emptyFull !== undefined) subToFull.set(g, g === 0 ? 0 : emptyFull);
          else if (g !== 0) upgradable = false;
        }
        subToFull.set(0, 0);
        ident = { lib: id.lib, fullToSub: id.fullToSub, subToFull, upgradable: upgradable && pdf.kind === 'type0' && pdf.identity };
      }
    }
    const maxCid = Math.max(embedded?.numGlyphs ?? 0, pdf.cidToGidArray?.length ?? 0, ...pdf.toUnicode.keys());
    const wNow = lookup(this.doc.context, pdf.descendant?.get(PDFName.of('W')));
    const origW = wNow instanceof PDFArray ? [...wNow.asArray()] : undefined;
    h = { kind: 'orig', pdf, embedded, ident, upgraded: false, aliases: new Map(), aliasKey: new Map(), nextCid: maxCid + 1, dirty: false, origW };
    this.handles.set(pdf.key, h);
    return h;
  }

  private gidOfHandle(h: Handle, code: number): number | undefined {
    if (h.kind === 'supp') return h.aliases.get(code)?.gid;
    const a = h.aliases.get(code);
    if (a) return a.gid; // in current gid space
    const g = h.pdf.gidOf(code);
    if (g === undefined) return undefined;
    return h.upgraded ? h.ident!.subToFull.get(g) : g;
  }

  private glyphText(pm: PageModel, g: Glyph): string {
    const tu = g.font.toUnicode.get(g.code);
    if (tu !== undefined) return tu;
    const h = [...pm.handlesByRes.values()].find((x) => (x.kind === 'orig' ? x.pdf.key === g.font.key : suppKey(x) === g.font.key));
    if (!h) return '';
    const gid = this.gidOfHandle(h, g.code);
    if (gid === undefined) return '';
    let cp: number | undefined;
    if (h.kind === 'supp') cp = h.lib.font.reverseCmap().get(gid);
    else if (h.ident) {
      const full = h.upgraded ? gid : h.ident.subToFull.get(gid);
      if (full !== undefined) cp = h.ident.lib.font.reverseCmap().get(full);
    }
    if (cp === undefined && h.kind === 'orig' && h.embedded && !h.upgraded) cp = h.embedded.reverseCmap().get(gid);
    return cp === undefined ? '' : String.fromCodePoint(cp);
  }

  private groupLines(pm: PageModel): Line[] {
    const lines: Line[] = [];
    // Base glyphs (non-zero advance) define the baseline. Zero-advance glyphs
    // are positioned marks (Arabic dots, harakat) that producers may place
    // well above/below the baseline; they join the line by pen continuity.
    let cur: { glyphs: Glyph[]; u: [number, number]; v: [number, number]; basePerps: number[]; allPerps: number[]; lastAlong: number } | undefined;
    const flush = (): void => {
      if (cur && cur.glyphs.length) lines.push(this.finishLine(pm, lines.length, cur.glyphs, cur.u, cur.v, cur.basePerps.length ? cur.basePerps : cur.allPerps));
      cur = undefined;
    };
    for (const g of pm.interp.glyphs) {
      const ul = Math.hypot(g.trm[0], g.trm[1]);
      const vl = Math.hypot(g.trm[2], g.trm[3]);
      if (ul === 0 || vl === 0) continue;
      const u: [number, number] = [g.trm[0] / ul, g.trm[1] / ul];
      const v: [number, number] = [g.trm[2] / vl, g.trm[3] / vl];
      const perp = g.x * v[0] + g.y * v[1];
      const along = g.x * u[0] + g.y * u[1];
      const isMark = Math.abs(g.dx * u[0] + g.dy * u[1]) < 0.05 * vl;
      if (cur) {
        const c = cur;
        const sameDir = Math.abs(u[0] - c.u[0]) < 1e-3 && Math.abs(u[1] - c.u[1]) < 1e-3;
        const alongs = c.glyphs.map((x) => x.x * c.u[0] + x.y * c.u[1]);
        const inSpan = along >= Math.min(...alongs) - 6 * vl && along <= Math.max(...alongs) + 6 * vl;
        let joins: boolean;
        if (!sameDir || !inSpan) joins = false;
        else if (isMark) joins = Math.abs(perp - median(c.basePerps.length ? c.basePerps : c.allPerps)) <= 1.1 * vl && Math.abs(along - c.lastAlong) <= 2 * vl;
        else if (c.basePerps.length) joins = Math.abs(perp - median(c.basePerps)) <= 0.45 * vl;
        else joins = Math.abs(perp - median(c.allPerps)) <= 1.1 * vl; // line so far is only marks
        if (!joins) flush();
      }
      if (!cur) cur = { glyphs: [], u, v, basePerps: [], allPerps: [], lastAlong: along };
      cur.glyphs.push(g);
      cur.allPerps.push(perp);
      if (!isMark) cur.basePerps.push(perp);
      cur.lastAlong = along + g.dx * u[0] + g.dy * u[1];
    }
    flush();
    return lines;
  }

  private finishLine(pm: PageModel, id: number, glyphs: Glyph[], u: [number, number], v: [number, number], perps: number[]): Line {
    const basePerp = median(perps);
    const along = (g: Glyph): number => g.x * u[0] + g.y * u[1];
    const advAlong = (g: Glyph): number => g.dx * u[0] + g.dy * u[1];
    let left = Infinity;
    let right = -Infinity;
    for (const g of glyphs) {
      const a = along(g);
      left = Math.min(left, a, a + advAlong(g));
      right = Math.max(right, a, a + advAlong(g));
    }
    // clusters in visual order: one per ActualText span, else one per glyph
    const clusters: { pos: number; text: string }[] = [];
    const seenSpan = new Map<number, number>();
    const charFonts = new Map<number, PdfFont>();
    const scriptFonts = new Map<Script, PdfFont>();
    for (const g of glyphs) {
      let text: string;
      if (g.actualSpan !== undefined) {
        const k = seenSpan.get(g.actualSpan);
        if (k !== undefined) {
          clusters[k]!.pos = Math.min(clusters[k]!.pos, along(g) + advAlong(g) / 2);
          continue;
        }
        text = g.actualText ?? '';
        seenSpan.set(g.actualSpan, clusters.length);
      } else text = this.glyphText(pm, g);
      clusters.push({ pos: along(g) + advAlong(g) / 2, text });
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (!charFonts.has(cp)) charFonts.set(cp, g.font);
        const sc = scriptOf(cp);
        if (sc !== 'common' && !scriptFonts.has(sc)) scriptFonts.set(sc, g.font);
      }
    }
    const ordered = clusters.map((c, k) => ({ ...c, k })).sort((a, b) => a.pos - b.pos || a.k - b.k);
    const { text, dir } = visualToLogical(ordered.map((c) => c.text.replace(/\u0000/g, '')).filter((t) => t !== ''));
    const fontCount = new Map<PdfFont, number>();
    for (const g of glyphs) fontCount.set(g.font, (fontCount.get(g.font) ?? 0) + 1);
    const fonts = [...fontCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
    const first = glyphs.find((g) => Math.abs(g.x * v[0] + g.y * v[1] - basePerp) < 1e-6) ?? glyphs[0]!;
    return { id, glyphs, text: text.replace(/\s+/g, ' ').trim(), dir, u, v, basePerp, left, right, size: Math.hypot(first.trm[2], first.trm[3]), first, charFonts, scriptFonts, fonts };
  }

  private info(l: Line): LineInfo {
    const asc = 0.85 * l.size;
    const desc = 0.3 * l.size;
    const pts = [
      [l.left, l.basePerp - desc],
      [l.right, l.basePerp - desc],
      [l.left, l.basePerp + asc],
      [l.right, l.basePerp + asc],
    ].map(([a, p]) => [a! * l.u[0] + p! * l.v[0], a! * l.u[1] + p! * l.v[1]]);
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    return {
      id: l.id,
      text: l.text,
      dir: l.dir,
      bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
      fonts: l.fonts.map((f) => f.baseFont),
    };
  }

  // ------------------------------------------------------------ layout

  private handleFor(pm: PageModel, f: PdfFont): Handle | undefined {
    for (const h of pm.handlesByRes.values()) {
      if (h.kind === 'orig' && h.pdf.key === f.key) return h;
      if (h.kind === 'supp' && suppKey(h) === f.key) return h;
    }
    return undefined;
  }

  private resNameOf(pm: PageModel, h: Handle): string {
    for (const [n, x] of pm.handlesByRes) if (x === h) return n;
    // register supplementary font on this page
    if (h.kind !== 'supp') throw new Error('font not on page');
    const res = pm.page.node.Resources()!;
    let fd = res.lookup(PDFName.of('Font'));
    if (!(fd instanceof PDFDict)) {
      fd = this.doc.context.obj({});
      res.set(PDFName.of('Font'), fd as PDFDict);
    }
    let name = 'FxE1';
    for (let k = 1; (fd as PDFDict).has(PDFName.of(name)); k++) name = `FxE${k}`;
    (fd as PDFDict).set(PDFName.of(name), h.ref);
    pm.handlesByRes.set(name, h);
    pm.fonts.set(name, suppAsPdfFont(h));
    return name;
  }

  private covers(h: Handle, cp: number): boolean {
    if (h.kind === 'supp') return h.lib.font.unicodes.has(cp);
    if (h.ident) return h.ident.lib.font.unicodes.has(cp);
    if (h.pdf.kind === 'simple') return h.pdf.encodeSimple?.(cp) !== undefined && h.pdf.widthOf(h.pdf.encodeSimple(cp)!) > 0;
    if (h.embedded) return h.embedded.unicodes.has(cp) && (!isArabicCp(cp) || h.embedded.hasArabicGsub);
    return false;
  }

  private layout(pm: PageModel, line: Line, text: string, warnings: string[]): { placed: Placed[]; runs: EditReport['runs'] } {
    const dir = line.dir;
    const levels = bidi.getEmbeddingLevels(text, dir);
    const lineHandles = line.fonts.map((f) => this.handleFor(pm, f)).filter((h): h is Handle => !!h);
    const sizeOf = (h: Handle): number => {
      const g = line.glyphs.find((x) => this.handleFor(pm, x.font) === h);
      return g ? g.size : line.first.size;
    };
    const mainBold = line.fonts.some((f) => f.bold) && line.fonts.every((f) => f.bold);

    // choose a handle per UTF-16 index
    type Choice = { h: Handle | LibFont; sub: boolean };
    const choices: (Choice | undefined)[] = new Array(text.length);
    let prev: Choice | undefined;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      const len = cp > 0xffff ? 2 : 1;
      const sc = scriptOf(cp);
      let pick: Choice | undefined;
      const tryH = (h: Handle | undefined): boolean => {
        if (h && this.covers(h, cp)) {
          pick = { h, sub: false };
          return true;
        }
        return false;
      };
      const byChar = line.charFonts.get(cp);
      const byScript = sc !== 'common' ? line.scriptFonts.get(sc) : undefined;
      if (!tryH(byChar ? this.handleFor(pm, byChar) : undefined) && !tryH(byScript ? this.handleFor(pm, byScript) : undefined)) {
        if (sc === 'common' && prev && !(prev.h as Handle).kind) {
          /* previous was a library pick */
        }
        if (!(sc === 'common' && prev && 'kind' in prev.h && tryH(prev.h))) {
          if (!lineHandles.some((h) => tryH(h))) {
            const lib = this.library.pick(cp, mainBold || (byScript?.bold ?? line.fonts[0]?.bold ?? false));
            if (lib) pick = { h: lib, sub: true };
          }
        }
      }
      if (!pick) throw new Error(`No available font can draw U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      choices[i] = pick;
      if (len === 2) choices[i + 1] = pick;
      if (sc !== 'common') prev = pick;
      else prev ??= pick;
      i += len;
    }
    // spaces/punctuation take the font of their neighbours when it covers them
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (scriptOf(cp) !== 'common' || line.charFonts.has(cp)) continue;
      const lv = levels.levels[i];
      const nb = levels.levels[i - 1] === lv && choices[i - 1] ? choices[i - 1] : levels.levels[i + 1] === lv ? choices[i + 1] : undefined;
      if (nb && nb !== choices[i] && ('kind' in nb.h ? this.covers(nb.h, cp) : nb.h.font.unicodes.has(cp))) choices[i] = nb;
    }

    // runs: same bidi level + same font choice
    interface Run { start: number; end: number; level: number; choice: Choice }
    const runs: Run[] = [];
    for (let i = 0; i < text.length; i++) {
      const lv = levels.levels[i]!;
      const ch = choices[i]!;
      const last = runs[runs.length - 1];
      if (last && last.level === lv && last.choice.h === ch.h) last.end = i + 1;
      else runs.push({ start: i, end: i + 1, level: lv, choice: ch });
    }
    // visual order of runs (UAX#9 L2)
    const visualIndex = new Array<number>(text.length).fill(0).map((_, k) => k);
    for (const segment of bidi.getReorderSegments(text, levels)) {
      const [a0, b0] = segment as [number, number];
      const seg = visualIndex.slice(a0, b0 + 1).reverse();
      visualIndex.splice(a0, b0 - a0 + 1, ...seg);
    }
    const posOf = new Array<number>(text.length);
    visualIndex.forEach((logical, visual) => (posOf[logical] = visual));
    const visualRuns = [...runs].sort((a, b) => Math.min(...range(a.start, a.end).map((k) => posOf[k]!)) - Math.min(...range(b.start, b.end).map((k) => posOf[k]!)));

    const placed: Placed[] = [];
    const report: EditReport['runs'] = [];
    let clusterBase = 0;
    for (const run of visualRuns) {
      const rtl = run.level % 2 === 1;
      const runText = text.slice(run.start, run.end);
      if (/^[‎‏‪-‮⁦-⁩]*$/.test(runText)) continue;
      const out = this.shapeRun(pm, line, text, run.start, run.end, rtl, run.choice, sizeOf, warnings);
      for (const p of out.placed) placed.push({ ...p, cluster: p.cluster + clusterBase });
      clusterBase += text.length + 1;
      report.push({ text: runText, font: out.fontName, mode: out.mode });
    }
    return { placed, runs: report };
  }

  private shapeRun(
    pm: PageModel,
    line: Line,
    text: string,
    start: number,
    end: number,
    rtl: boolean,
    choice: { h: Handle | LibFont; sub: boolean },
    sizeOf: (h: Handle) => number,
    warnings: string[],
  ): { placed: Placed[]; mode: FontMode; fontName: string } {
    const dir = rtl ? 'rtl' : 'ltr';
    const clusterTexts = (glyphs: ShapedGlyph[]): Map<number, string> => {
      const starts = [...new Set(glyphs.map((g) => g.cluster))].sort((a, b) => a - b);
      const m = new Map<number, string>();
      starts.forEach((c, k) => m.set(c, text.slice(c, starts[k + 1] ?? end)));
      return m;
    };
    const baseOfCluster = (glyphs: ShapedGlyph[], font: ShapingFont): Map<number, number> => {
      // the glyph carrying the cluster's text: the one with the largest advance
      const best = new Map<number, number>();
      glyphs.forEach((g, k) => {
        const b = best.get(g.cluster);
        if (b === undefined || font.advance(g.gid) > font.advance(glyphs[b]!.gid)) best.set(g.cluster, k);
      });
      return best;
    };

    // ---- simple (single-byte) original font: no shaping, encode via its encoding
    if ('kind' in choice.h && choice.h.kind === 'orig' && choice.h.pdf.kind === 'simple') {
      const h = choice.h;
      const resName = this.resNameOf(pm, h);
      const size = sizeOf(h);
      const placed: Placed[] = [];
      for (let i = start; i < end; ) {
        const cp = text.codePointAt(i)!;
        const code = h.pdf.encodeSimple!(cp)!;
        const w = h.pdf.widthOf(code);
        placed.push({ handle: h, resName, size, code, twoByte: false, pdfW: w, adv: w, xOff: 0, yOff: 0, cluster: i, clusterText: String.fromCodePoint(cp), isSpaceCode: code === 32 });
        i += cp > 0xffff ? 2 : 1;
      }
      if (rtl) placed.reverse();
      return { placed, mode: 'original', fontName: h.pdf.baseFont };
    }

    // ---- Type0 original / identified / substitute
    let shaping: ShapingFont;
    let target: Handle;
    let mode: FontMode;
    let gidMap: (fullGid: number) => number | undefined = (g) => g;
    if ('kind' in choice.h) {
      const h = choice.h;
      if (h.kind === 'supp') {
        shaping = h.lib.font;
        target = h;
        mode = 'same-font-supplement';
      } else if (h.ident) {
        shaping = h.ident.lib.font;
        const glyphs = shaping.shape(text, dir, undefined, start, end - start);
        const inSubset = glyphs.every((g) => h.upgraded || h.ident!.fullToSub.has(g.gid));
        if (inSubset) {
          target = h;
          mode = 'original';
          gidMap = h.upgraded ? (g) => g : (g) => h.ident!.fullToSub.get(g);
        } else if (h.ident.upgradable) {
          this.upgrade(h);
          target = h;
          mode = 'original-extended';
          gidMap = (g) => g;
        } else {
          target = this.suppFor(h.ident.lib);
          mode = 'same-font-supplement';
          warnings.push(`"${h.pdf.baseFont}" subset is missing glyphs and could not be extended safely; added a separate subset of the same font.`);
        }
      } else if (h.embedded) {
        shaping = h.embedded;
        target = h;
        mode = 'original';
        const glyphs = shaping.shape(text, dir, undefined, start, end - start);
        if (glyphs.some((g) => g.gid === 0)) {
          const lib = this.library.pick(text.codePointAt(start)!, h.pdf.bold);
          if (!lib) throw new Error('missing glyphs and no substitute font');
          warnings.push(`"${h.pdf.baseFont}" lacks glyphs for "${text.slice(start, end)}" and is not a known font; substituted ${lib.psName}.`);
          shaping = lib.font;
          target = this.suppFor(lib);
          mode = 'substitute';
        }
      } else {
        throw new Error(`font ${h.pdf.baseFont} has no usable program`);
      }
    } else {
      shaping = choice.h.font;
      target = this.suppFor(choice.h);
      mode = 'substitute';
      warnings.push(`No font on this line covers "${text.slice(start, end)}"; substituted ${choice.h.psName}.`);
    }

    const glyphs = shaping.shape(text, dir, undefined, start, end - start);
    const ct = clusterTexts(glyphs);
    const bases = baseOfCluster(glyphs, shaping);
    const resName = this.resNameOf(pm, target);
    const sizeHandle = 'kind' in choice.h ? choice.h : target;
    const size = sizeHandle.kind === 'orig' || pm.handlesByRes.has(resName) ? sizeOf(sizeHandle) : line.first.size;
    const scale = 1000 / shaping.upem;
    const placed: Placed[] = glyphs.map((g, k) => {
      const gid = gidMap(g.gid);
      if (gid === undefined) throw new Error('internal: glyph mapping failed');
      const isBase = bases.get(g.cluster) === k;
      const textForGlyph = isBase ? ct.get(g.cluster)! : MARK_TEXT;
      const width = Math.round(shaping.advance(g.gid) * scale);
      const code = this.allocCid(target, gid, textForGlyph, width);
      return {
        handle: target, resName, size, code, twoByte: true,
        pdfW: target.aliases.get(code)?.width ?? (target.kind === 'orig' ? target.pdf.widthOf(code) : width),
        adv: g.xAdvance * scale, xOff: g.xOffset * scale, yOff: g.yOffset * scale,
        cluster: g.cluster, clusterText: ct.get(g.cluster)!, isSpaceCode: false,
      };
    });
    const fontName = target.kind === 'orig' ? target.pdf.baseFont : `${target.tag}+${target.lib.psName}`;
    return { placed, mode, fontName };
  }

  private allocCid(h: Handle, gid: number, text: string, width: number): number {
    if (h.kind === 'orig' && !h.upgraded && h.pdf.identity) {
      // reuse the identity CID when it already means the same thing
      const cid = h.pdf.cidToGidArray ? h.pdf.cidToGidArray.indexOf(gid) : gid;
      if (cid >= 0 && !h.aliases.has(cid)) {
        const tu = h.pdf.toUnicode.get(cid);
        if (tu === text || (!h.pdf.hasToUnicodeStream && text === '' )) return cid;
      }
    }
    const key = `${gid}\u0000${text}`;
    const have = h.aliasKey.get(key);
    if (have !== undefined) return have;
    const cid = h.nextCid++;
    if (cid > 0xffff) throw new Error('CID space exhausted');
    h.aliases.set(cid, { gid, text, width });
    h.aliasKey.set(key, cid);
    if (h.kind === 'orig') h.dirty = true;
    return cid;
  }

  private upgrade(h: OrigHandle): void {
    if (h.upgraded) return;
    // existing aliases were in subset gid space; move them to full space
    for (const a of h.aliases.values()) a.gid = h.ident!.subToFull.get(a.gid) ?? 0;
    h.aliasKey = new Map([...h.aliases].map(([cid, a]) => [`${a.gid}\u0000${a.text}`, cid]));
    h.upgraded = true;
    h.dirty = true;
  }

  private suppFor(lib: LibFont): SuppHandle {
    let s = this.supp.get(lib.id);
    if (!s) {
      const ref = this.doc.context.nextRef();
      const tag = subsetTag(this.tagSeq++);
      s = { kind: 'supp', lib, ref, tag, aliases: new Map(), aliasKey: new Map(), nextCid: 1 };
      this.doc.context.assign(ref, this.doc.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: `${tag}+${lib.psName}`, Encoding: 'Identity-H' }));
      this.supp.set(lib.id, s);
    }
    return s;
  }

  // ------------------------------------------------------------ splice

  private splice(pm: PageModel, line: Line, placed: Placed[], warnings: string[]): { bytes: Uint8Array; newWidth: number; oldWidth: number } {
    const { ops, states, glyphs } = pm.interp;
    const opSet = new Set(line.glyphs.map((g) => g.opIndex));
    for (const oi of opSet) {
      const all = glyphs.filter((g) => g.opIndex === oi);
      if (all.some((g) => !line.glyphs.includes(g))) throw new Error('A text operator mixes this line with other text; splitting it is not supported in phase 1.');
    }
    const sorted = [...opSet].sort((a, b) => a - b);
    const firstOp = sorted[0]!;
    const lastOp = sorted[sorted.length - 1]!;
    const edits: { start: number; end: number; text: string }[] = [];

    // delete show operators (keep the positioning side effects of ' and ")
    for (const oi of sorted) {
      const op = ops[oi]!;
      let rep = '';
      if (op.op === "'") rep = 'T*';
      else if (op.op === '"') rep = `${serializeOperand(op.operands[0]!)} Tw ${serializeOperand(op.operands[1]!)} Tc T*`;
      edits.push({ start: op.start, end: op.end, text: rep });
    }

    // marked-content pairs that only wrap deleted text (stale ActualText / ReversedChars)
    const pairs = matchMarkedContent(ops);
    const deletedPairs = new Set<number>();
    for (const [open, close] of pairs) {
      if (open < firstOp - 64 || close > lastOp + 64) continue;
      const inner = ops.slice(open + 1, close).map((o, k) => ({ o, k: open + 1 + k })).filter(({ o }) => isShowOp(o.op));
      if (inner.length > 0 && inner.every(({ k }) => opSet.has(k))) {
        deletedPairs.add(open);
        edits.push({ start: ops[open]!.start, end: ops[open]!.end, text: '' });
        edits.push({ start: ops[close]!.start, end: ops[close]!.end, text: '' });
      }
    }

    // geometry
    const st = states[firstOp]!;
    const F0 = mul(st.tm, st.ctm);
    const sx = Math.hypot(F0[0], F0[1]);
    const th = st.ts.tz / 100;
    let newWidthTs = 0;
    for (const p of placed) newWidthTs += ((p.adv / 1000) * p.size + st.ts.tc + (p.isSpaceCode ? st.ts.tw : 0)) * th;
    const newWidth = newWidthTs * sx;
    const oldWidth = line.right - line.left;
    const startAlong = line.dir === 'rtl' ? line.right - newWidth : line.left;
    const P: [number, number] = [startAlong * line.u[0] + line.basePerp * line.v[0], startAlong * line.u[1] + line.basePerp * line.v[1]];
    const tmNew = mul([F0[0], F0[1], F0[2], F0[3], P[0], P[1]], invert(st.ctm));
    if (newWidth > oldWidth * 1.15 + line.size) warnings.push(`New text is ${(newWidth - oldWidth).toFixed(1)} pt wider than the original; it may overlap nearby content (no reflow in phase 1).`);

    // build insertion
    const btIndex = lastIndexBefore(ops, firstOp, 'BT');
    const toClose = st.mc.filter((e) => !deletedPairs.has(e.openIndex) && e.openIndex > btIndex && (e.actualText !== undefined || e.tag === 'ReversedChars'));
    let s = '\n';
    for (let k = 0; k < toClose.length; k++) s += 'EMC\n';
    s += `${mat(tmNew)} Tm\n`;
    let k = 0;
    while (k < placed.length) {
      const p0 = placed[k]!;
      let e = k;
      while (e + 1 < placed.length && placed[e + 1]!.resName === p0.resName && placed[e + 1]!.size === p0.size) e++;
      const group = placed.slice(k, e + 1);
      const rtlGroup = group.some((p) => /[֐-ࣿיִ-ﻼ]/.test(p.clusterText));
      s += `/${p0.resName} ${fmtNum(p0.size)} Tf\n`;
      if (rtlGroup) s += '/ReversedChars BMC\n';
      s += emitGroup(group, st.ts.ts);
      if (rtlGroup) s += 'EMC\n';
      k = e + 1;
    }
    s += restoreState(st);
    for (const e of [...toClose]) s += `/${e.tag} ${e.props ? serializeOperand(e.props) + ' BDC' : 'BMC'}\n`;
    edits.push({ start: ops[firstOp]!.start, end: ops[firstOp]!.start, text: s });

    // after the last deleted op: if text continues in the same BT without
    // repositioning, put Tm back where the original would have left it
    const nextShow = ops.slice(lastOp + 1).findIndex((o) => isShowOp(o.op) || ['ET', 'Td', 'TD', 'Tm', 'T*', "'", '"', 'BT'].includes(o.op));
    if (nextShow >= 0 && isShowOp(ops[lastOp + 1 + nextShow]!.op) && ops[lastOp + 1 + nextShow]!.op !== "'" && ops[lastOp + 1 + nextShow]!.op !== '"') {
      edits.push({ start: ops[lastOp]!.end, end: ops[lastOp]!.end, text: '\n' + restoreState(states[lastOp + 1] ?? pm.interp.after) });
    }

    // apply edits back to front
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let bytes = pm.content;
    const enc = new TextEncoder();
    for (const ed of edits) {
      const ins = enc.encode(ed.text);
      const out = new Uint8Array(bytes.length - (ed.end - ed.start) + ins.length);
      out.set(bytes.subarray(0, ed.start), 0);
      out.set(ins, ed.start);
      out.set(bytes.subarray(ed.end), ed.start + ins.length);
      bytes = out;
    }
    return { bytes, newWidth, oldWidth };
  }

  // ------------------------------------------------------------ font writing

  private writeOrigFont(h: OrigHandle): void {
    const ctx = this.doc.context;
    const desc = h.pdf.descendant;
    if (!desc) return;
    const maxCid = h.nextCid - 1;
    const baseLen = Math.max(h.pdf.cidToGidArray?.length ?? 0, h.embedded?.numGlyphs ?? 0);
    const map = new Uint8Array((maxCid + 1) * 2);
    const gids = new Set<number>();
    for (let cid = 0; cid <= maxCid; cid++) {
      let gid: number;
      const a = h.aliases.get(cid);
      if (a) gid = a.gid;
      else if (cid < baseLen) {
        const g0 = h.pdf.gidOf(cid) ?? 0;
        gid = h.upgraded ? h.ident!.subToFull.get(g0) ?? 0 : g0;
      } else gid = 0;
      map[cid * 2] = gid >> 8;
      map[cid * 2 + 1] = gid & 0xff;
      gids.add(gid);
    }
    desc.set(PDFName.of('CIDToGIDMap'), ctx.register(ctx.flateStream(map)));

    // widths: append alias entries
    const wArr = ctx.obj([...(h.origW ?? [])]);
    for (const [cid, a] of [...h.aliases].sort((x, y) => x[0] - y[0])) {
      wArr.push(PDFNumber.of(cid));
      wArr.push(ctx.obj([a.width]));
    }
    desc.set(PDFName.of('W'), wArr);

    // ToUnicode: keep every existing mapping, add aliases
    const tu = new Map(h.pdf.toUnicode);
    if (!h.pdf.hasToUnicodeStream && h.embedded) {
      // derive what we safely can for existing CIDs from the font's own cmap
      const rev = h.ident ? undefined : h.embedded.reverseCmap();
      for (let cid = 0; cid < baseLen; cid++) {
        const g = h.pdf.gidOf(cid);
        if (g === undefined) continue;
        const cp = rev ? rev.get(g) : h.ident ? h.ident.lib.font.reverseCmap().get(h.ident.subToFull.get(g) ?? -1) : undefined;
        if (cp !== undefined && !isArabicCp(cp)) tu.set(cid, String.fromCodePoint(cp));
      }
    }
    for (const [cid, a] of h.aliases) tu.set(cid, a.text);
    h.pdf.dict.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(toUnicodeCMap(tu))));

    if (h.upgraded) {
      const fd = lookup(ctx, desc.get(PDFName.of('FontDescriptor')));
      if (fd instanceof PDFDict) {
        const program = this.subsetter.subset(h.ident!.lib.font.bytes, gids);
        fd.set(PDFName.of('FontFile2'), ctx.register(ctx.flateStream(program, { Length1: program.length })));
        fd.delete(PDFName.of('CIDSet')); // would be stale
      }
    }
  }

  private writeSuppFont(s: SuppHandle): void {
    const ctx = this.doc.context;
    const lib = s.lib;
    const f = lib.font;
    const scale = 1000 / f.upem;
    const gids = new Set([...s.aliases.values()].map((a) => a.gid));
    const program = this.subsetter.subset(f.bytes, gids);
    const maxCid = s.nextCid - 1;
    const map = new Uint8Array((maxCid + 1) * 2);
    const w: PDFObject[] = [];
    for (const [cid, a] of [...s.aliases].sort((x, y) => x[0] - y[0])) {
      map[cid * 2] = a.gid >> 8;
      map[cid * 2 + 1] = a.gid & 0xff;
      w.push(PDFNumber.of(cid), ctx.obj([a.width]));
    }
    const tu = new Map<number, string>([...s.aliases].map(([cid, a]) => [cid, a.text]));
    const fk = f.fontkit;
    const bbox = fk.bbox;
    const name = `${s.tag}+${lib.psName}`;
    const fd = ctx.obj({
      Type: 'FontDescriptor',
      FontName: name,
      Flags: 4,
      FontBBox: [bbox.minX * scale, bbox.minY * scale, bbox.maxX * scale, bbox.maxY * scale].map(Math.round),
      ItalicAngle: fk.italicAngle ?? 0,
      Ascent: Math.round(fk.ascent * scale),
      Descent: Math.round(fk.descent * scale),
      CapHeight: Math.round((fk.capHeight || fk.ascent) * scale),
      StemV: lib.bold ? 120 : 80,
      FontWeight: lib.bold ? 700 : 400,
      FontFile2: ctx.register(ctx.flateStream(program, { Length1: program.length })),
    });
    const cid = ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: name,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: ctx.register(fd),
      DW: 0,
      W: w,
      CIDToGIDMap: ctx.register(ctx.flateStream(map)),
    });
    const font = ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: name,
      Encoding: 'Identity-H',
      DescendantFonts: [ctx.register(cid)],
      ToUnicode: ctx.register(ctx.flateStream(toUnicodeCMap(tu))),
    });
    ctx.assign(s.ref, font);
  }
}

// ---------------------------------------------------------------- helpers

function suppKey(s: SuppHandle): string {
  return s.ref.toString();
}

function suppAsPdfFont(s: SuppHandle): PdfFont {
  const tu = new Map<number, string>([...s.aliases].map(([c, a]) => [c, a.text]));
  return {
    key: suppKey(s), ref: s.ref, dict: undefined as unknown as PDFDict, kind: 'type0', baseFont: `${s.tag}+${s.lib.psName}`, bold: s.lib.bold, identity: true,
    widthOf: (c) => s.aliases.get(c)?.width ?? 0, gidOf: (c) => s.aliases.get(c)?.gid, toUnicode: tu, hasToUnicodeStream: true,
    program: s.lib.font.bytes, standard14: false,
    splitCodes: (b) => {
      const out: number[] = [];
      for (let k = 0; k + 1 < b.length; k += 2) out.push((b[k]! << 8) | b[k + 1]!);
      return out;
    },
    cidToGidArray: undefined, descendant: undefined,
  };
}

function patchedFont(h: OrigHandle): PdfFont {
  const base = h.pdf;
  const tu = new Map(base.toUnicode);
  for (const [c, a] of h.aliases) tu.set(c, a.text);
  return {
    ...base,
    widthOf: (c) => h.aliases.get(c)?.width ?? base.widthOf(c),
    gidOf: (c) => {
      const a = h.aliases.get(c);
      if (a) return a.gid;
      const g = base.gidOf(c);
      return h.upgraded && g !== undefined ? h.ident!.subToFull.get(g) : g;
    },
    toUnicode: tu,
  };
}

function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array {
  const ctx = doc.context;
  const c = page.node.get(PDFName.of('Contents'));
  const parts: Uint8Array[] = [];
  const obj = lookup(ctx, c);
  if (obj instanceof PDFArray) for (const x of obj.asArray()) parts.push(streamBytes(ctx, x) ?? new Uint8Array());
  else {
    const b = streamBytes(ctx, c);
    if (b) parts.push(b);
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

function matchMarkedContent(ops: { op: string }[]): [number, number][] {
  const stack: number[] = [];
  const pairs: [number, number][] = [];
  ops.forEach((o, i) => {
    if (o.op === 'BMC' || o.op === 'BDC') stack.push(i);
    else if (o.op === 'EMC') {
      const s = stack.pop();
      if (s !== undefined) pairs.push([s, i]);
    }
  });
  return pairs;
}

function lastIndexBefore(ops: { op: string }[], i: number, name: string): number {
  for (let k = i - 1; k >= 0; k--) if (ops[k]!.op === name) return k;
  return -1;
}

function mat(m: Mat): string {
  return m.map(fmtNum).join(' ');
}

function restoreState(st: OpState): string {
  let s = '';
  if (st.ts.fontRes) s += `/${st.ts.fontRes} ${fmtNum(st.ts.size)} Tf\n`;
  s += `${fmtNum(st.ts.ts)} Ts\n`;
  s += `${mat(st.tlm)} Tm\n`;
  const [tx, ty] = apply(invert(st.tlm), st.tm[4], st.tm[5]);
  if (Math.abs(tx) > 1e-4 && st.ts.size) s += `[${fmtNum((-tx * 1000) / (st.ts.size * (st.ts.tz / 100)))}] TJ\n`;
  void ty;
  return s;
}

// One TJ per rise level. Every glyph we write has an exact ToUnicode entry
// (base glyph -> its cluster's text, marks -> empty), so no ActualText spans
// are needed and extractors see whole words in a single text operator.
function emitGroup(group: Placed[], baseRise: number): string {
  let s = '';
  let rise = baseRise;
  let items: string[] = [];
  const flush = (): void => {
    if (items.length) s += `[${items.join(' ')}] TJ\n`;
    items = [];
  };
  for (const p of group) {
    const r = baseRise + (p.yOff / 1000) * p.size;
    if (Math.abs(r - rise) > 1e-4) {
      flush();
      s += `${fmtNum(r)} Ts\n`;
      rise = r;
    }
    if (Math.abs(p.xOff) > 1e-3) items.push(fmtNum(-p.xOff));
    items.push(hexStr(p.twoByte ? [p.code >> 8, p.code & 0xff] : [p.code]));
    const after = p.pdfW - p.adv + p.xOff;
    if (Math.abs(after) > 1e-3) items.push(fmtNum(after));
  }
  flush();
  if (Math.abs(rise - baseRise) > 1e-4) s += `${fmtNum(baseRise)} Ts\n`;
  return s;
}

function toUnicodeCMap(map: Map<number, string>): Uint8Array {
  const entries = [...map].sort((a, b) => a[0] - b[0]);
  let s = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let k = 0; k < entries.length; k += 100) {
    const chunk = entries.slice(k, k + 100);
    s += `${chunk.length} beginbfchar\n`;
    for (const [c, t] of chunk) {
      let hex = '';
      for (let i = 0; i < t.length; i++) hex += t.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
      s += `<${c.toString(16).padStart(4, '0').toUpperCase()}> <${hex}>\n`;
    }
    s += 'endbfchar\n';
  }
  s += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  return new TextEncoder().encode(s);
}

function subsetTag(n: number): string {
  let s = '';
  let v = n + 7;
  for (let k = 0; k < 6; k++) {
    s += String.fromCharCode(65 + (v % 26));
    v = Math.floor(v / 26) + k * 3 + 1;
  }
  return s;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a }, (_, k) => a + k);
}
