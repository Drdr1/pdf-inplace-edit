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
import { tokenize, fmtNum, hexStr, serializeOperand, type Op, type Operand } from './lexer';
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

export type FontMode = 'original' | 'original-extended' | 'original-with-supplement' | 'same-font-supplement' | 'substitute';

export interface EditReport {
  oldText: string;
  newText: string;
  runs: { text: string; font: string; mode: FontMode }[];
  oldWidth: number;
  newWidth: number;
  /** font substitutions and anything that may not look identical */
  warnings: string[];
  /** informational: e.g. following text moved because the new text is wider */
  notes: string[];
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
  /** cluster index owning each character of `text` */
  owner: number[];
  clusterGlyphs: Glyph[][];
  /** producer writes bidi runs in logical (not visual) stream order */
  streamLogical: boolean;
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
  simpleCodes?: Map<number, number>;
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
  edited?: boolean;
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
  /** logical start of the bidi run this glyph belongs to */
  runStart?: number;
}

// ---------------------------------------------------------------- editor

export class PdfTextEditor {
  private pages: PageModel[] = [];
  private handles = new Map<string, OrigHandle>();
  private supp = new Map<string, SuppHandle>();
  private tagSeq = 0;

  private original: Uint8Array = new Uint8Array();
  private snapshot = new Map<string, string>();

  private constructor(
    readonly doc: PDFDocument,
    private readonly library: FontLibrary,
    private readonly subsetter: Subsetter,
  ) {}

  static async open(bytes: Uint8Array, deps: { library: FontLibrary; subsetter: Subsetter }): Promise<PdfTextEditor> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ed = new PdfTextEditor(doc, deps.library, deps.subsetter);
    ed.original = bytes.slice();
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) ed.snapshot.set(ref.toString(), serialise(obj));
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

  /**
   * Replace a line's text. Only the words that actually change are rewritten:
   * every other glyph keeps its original bytes; content on the growing side
   * of the edit moves by exactly the width difference (no reflow).
   */
  replaceLine(pageIndex: number, lineId: number, newTextRaw: string): EditReport {
    const pm = this.page(pageIndex);
    const line = pm.lines[lineId];
    if (!line) throw new Error(`no line ${lineId}`);
    const oldText = line.text;
    const newText = newTextRaw.normalize('NFC');
    if (newText === oldText) return { oldText, newText, runs: [], oldWidth: 0, newWidth: 0, warnings: [], notes: [] };
    // smallest changed span, widened to whole words (Arabic joining, kerning)
    let p = 0;
    while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
    let q = 0;
    while (q < oldText.length - p && q < newText.length - p && oldText[oldText.length - 1 - q] === newText[newText.length - 1 - q]) q++;
    let A = p;
    while (A > 0 && !/\s/u.test(oldText[A - 1]!)) A--;
    let B = oldText.length - q;
    while (B < oldText.length && !/\s/u.test(oldText[B]!)) B++;
    if (B <= A) B = Math.min(oldText.length, A + 1);
    const nB = B + (newText.length - oldText.length);
    const warnings: string[] = [];
    const notes: string[] = [];
    const { placed, runs } = this.layout(pm, line, newText, warnings, [A, nB]);
    const { bytes, newWidth, oldWidth } = this.spliceRange(pm, line, A, B, placed, notes);
    pm.content = bytes;
    pm.edited = true;
    this.reanalyse(pageIndex);
    return { oldText, newText, runs, oldWidth, newWidth, warnings, notes };
  }

  /**
   * Save as an incremental update: the original file bytes are kept verbatim
   * and only changed/new objects are appended with a new xref section
   * (/Prev points at the original one). Nothing is re-exported.
   */
  async save(): Promise<Uint8Array> {
    const ctx = this.doc.context;
    for (const h of this.handles.values()) if (h.dirty) this.writeOrigFont(h);
    for (const s of this.supp.values()) this.writeSuppFont(s);
    for (const pm of this.pages) {
      if (!pm.edited) continue;
      const stream = ctx.flateStream(pm.content);
      pm.contentRef ??= ctx.nextRef();
      ctx.assign(pm.contentRef, stream);
      pm.page.node.set(PDFName.of('Contents'), pm.contentRef);
    }
    const tail = new TextDecoder('latin1').decode(this.original.subarray(Math.max(0, this.original.length - 1024)));
    const prev = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)?.[1];
    const prevIsTable = prev !== undefined && new TextDecoder('latin1').decode(this.original.subarray(+prev, +prev + 4)) === 'xref';
    if (!prev || !prevIsTable) return this.doc.save({ useObjectStreams: false }); // xref-stream originals: full write

    const changed: [PDFRef, PDFObject][] = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (this.snapshot.get(ref.toString()) !== serialise(obj)) changed.push([ref, obj]);
    }
    // Nothing changed since the last save: an empty xref section is invalid, so
    // return the current bytes unchanged.
    if (changed.length === 0) return this.original.slice();
    changed.sort((a, b) => a[0].objectNumber - b[0].objectNumber);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [this.original];
    let offset = this.original.length;
    const push = (b: Uint8Array): void => {
      parts.push(b);
      offset += b.length;
    };
    if (this.original[this.original.length - 1] !== 0x0a) push(enc.encode('\n'));
    const offsets = new Map<number, [number, number]>();
    for (const [ref, obj] of changed) {
      offsets.set(ref.objectNumber, [offset, ref.generationNumber]);
      const body = new Uint8Array(obj.sizeInBytes());
      obj.copyBytesInto(body, 0);
      push(enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
      push(body);
      push(enc.encode('\nendobj\n'));
    }
    const xrefAt = offset;
    let x = 'xref\n';
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
      x += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const [o, g] = offsets.get(nums[k]!)!;
        x += `${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} n\r\n`;
      }
      i = j + 1;
    }
    const t = ctx.trailerInfo;
    const trailer = ctx.obj({});
    trailer.set(PDFName.of('Size'), PDFNumber.of(ctx.largestObjectNumber + 1));
    if (t.Root) trailer.set(PDFName.of('Root'), t.Root);
    if (t.Info) trailer.set(PDFName.of('Info'), t.Info);
    if (t.ID) trailer.set(PDFName.of('ID'), t.ID);
    if (t.Encrypt) trailer.set(PDFName.of('Encrypt'), t.Encrypt);
    trailer.set(PDFName.of('Prev'), PDFNumber.of(+prev));
    x += `trailer\n${serialise(trailer)}\nstartxref\n${xrefAt}\n%%EOF\n`;
    push(enc.encode(x));
    const out = new Uint8Array(offset);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    // later saves append on top of this one
    this.original = out.slice();
    this.snapshot = new Map([...ctx.enumerateIndirectObjects()].map(([r, ob]) => [r.toString(), serialise(ob)]));
    return out;
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
    next.edited = pm.edited;
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

  /**
   * Group glyphs into editable lines in two phases:
   *  1. rows: glyphs sharing a baseline (marks such as Arabic dots may sit far
   *     off it and follow the glyph drawn before them);
   *  2. within a row, stream-contiguous chunks are merged only when they touch
   *     horizontally. Producers like LibreOffice write one visual line as
   *     several text objects in logical order, while table cells on the same
   *     baseline are separated by real gaps and stay separate.
   */
  private groupLines(pm: PageModel): Line[] {
    interface Row { u: [number, number]; v: [number, number]; basePerps: number[]; glyphs: Glyph[] }
    const rows: Row[] = [];
    const rowOf = new Map<number, Row>();
    const geom = (g: Glyph) => {
      const ul = Math.hypot(g.trm[0], g.trm[1]);
      const vl = Math.hypot(g.trm[2], g.trm[3]);
      const u: [number, number] = [g.trm[0] / ul, g.trm[1] / ul];
      const v: [number, number] = [g.trm[2] / vl, g.trm[3] / vl];
      const along = g.x * u[0] + g.y * u[1];
      const adv = g.dx * u[0] + g.dy * u[1];
      return { ul, vl, u, v, along, adv, perp: g.x * v[0] + g.y * v[1], isMark: Math.abs(adv) < 0.05 * vl };
    };
    // pass 1: base glyphs define rows; pass 2: marks join the row they sit over
    const usable = pm.interp.glyphs.filter((g) => geom(g).ul > 0 && geom(g).vl > 0);
    const sameDir = (m: ReturnType<typeof geom>, r: Row) => Math.abs(m.u[0] - r.u[0]) < 1e-3 && Math.abs(m.u[1] - r.u[1]) < 1e-3;
    for (const pass of [false, true]) {
      for (const g of usable) {
        const m = geom(g);
        if (m.isMark !== pass) continue;
        let row: Row | undefined;
        if (m.isMark) {
          let best: { r: Row; d: number } | undefined;
          for (const r of rows) {
            if (!sameDir(m, r) || !r.basePerps.length) continue;
            const d = Math.abs(m.perp - median(r.basePerps));
            if (d > 1.1 * m.vl) continue;
            const over = r.glyphs.some((x) => {
              const gm = geom(x);
              return !gm.isMark && m.along >= Math.min(gm.along, gm.along + gm.adv) - 0.5 * m.vl && m.along <= Math.max(gm.along, gm.along + gm.adv) + 0.5 * m.vl;
            });
            if (over && (!best || d < best.d)) best = { r, d };
          }
          row = best?.r;
        } else {
          for (let k = rows.length - 1; k >= 0 && k >= rows.length - 40; k--) {
            const r = rows[k]!;
            if (sameDir(m, r) && Math.abs(m.perp - median(r.basePerps)) <= 0.45 * m.vl) {
              row = r;
              break;
            }
          }
        }
        if (!row) {
          row = { u: m.u, v: m.v, basePerps: [], glyphs: [] };
          rows.push(row);
        }
        row.glyphs.push(g);
        if (!m.isMark) row.basePerps.push(m.perp);
        rowOf.set(g.index, row);
      }
    }
    for (const r of rows) r.glyphs.sort((x, y) => x.index - y.index);

    const lines: Line[] = [];
    for (const row of rows) {
      // phase 2a: chunks = stream-contiguous glyphs of one text object
      interface Chunk { glyphs: Glyph[]; lo: number; hi: number; bt: number; size: number }
      const chunks: Chunk[] = [];
      let c: Chunk | undefined;
      for (const g of row.glyphs) {
        const m = geom(g);
        const lo = Math.min(m.along, m.along + m.adv);
        const hi = Math.max(m.along, m.along + m.adv);
        if (m.isMark) {
          // a mark joins the chunk it sits over; it never widens a chunk
          const host = [...chunks].reverse().find((x) => m.along >= x.lo - 0.5 * m.vl && m.along <= x.hi + 0.5 * m.vl);
          if (host) host.glyphs.push(g);
          else chunks.push({ glyphs: [g], lo, hi, bt: g.btIndex, size: m.vl });
          continue;
        }
        const gap = c ? Math.max(0, lo - c.hi, c.lo - hi) : 0;
        if (!c || g.btIndex !== c.bt || gap > 1.5 * m.vl) {
          c = { glyphs: [], lo, hi, bt: g.btIndex, size: m.vl };
          chunks.push(c);
        }
        c.glyphs.push(g);
        c.lo = Math.min(c.lo, lo);
        c.hi = Math.max(c.hi, hi);
      }
      // phase 2b: merge chunks that touch
      chunks.sort((x, y) => x.lo - y.lo);
      const groups: Chunk[][] = [];
      let hiEnd = -Infinity;
      for (const ch of chunks) {
        const last = groups[groups.length - 1];
        if (last && ch.lo - hiEnd <= 0.1 * ch.size) {
          last.push(ch);
          hiEnd = Math.max(hiEnd, ch.hi);
        } else {
          groups.push([ch]);
          hiEnd = ch.hi;
        }
      }
      for (const grp of groups) {
        const gl = grp.flatMap((x) => x.glyphs).sort((x, y) => x.index - y.index);
        const perps = gl.filter((x) => !geom(x).isMark).map((x) => geom(x).perp);
        lines.push(this.finishLine(pm, lines.length, gl, row.u, row.v, perps.length ? perps : gl.map((x) => geom(x).perp)));
      }
    }
    // reading order: top to bottom, then left to right
    lines.sort((a, b) => b.basePerp * b.v[1] - a.basePerp * a.v[1] || a.left - b.left);
    lines.forEach((l, k) => (l.id = k));
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
    // clusters: one per ActualText span, else one per glyph that carries text;
    // marks / text-less glyphs join the cluster they sit over
    interface Cl { pos: number; text: string; bt: number; glyphs: Glyph[] }
    const clusters: Cl[] = [];
    const seenSpan = new Map<number, number>();
    const charFonts = new Map<number, PdfFont>();
    const scriptFonts = new Map<Script, PdfFont>();
    const orphans: Glyph[] = [];
    for (const g of glyphs) {
      let text: string;
      if (g.actualSpan !== undefined) {
        const k = seenSpan.get(g.actualSpan);
        if (k !== undefined) {
          clusters[k]!.pos = Math.min(clusters[k]!.pos, along(g) + advAlong(g) / 2);
          clusters[k]!.glyphs.push(g);
          continue;
        }
        text = g.actualText ?? '';
        seenSpan.set(g.actualSpan, clusters.length);
      } else {
        text = this.glyphText(pm, g);
        // a zero-width glyph can only be a mark: keep real combining marks,
        // drop letters some producers attach to separate dot glyphs
        if (Math.abs(advAlong(g)) < 0.05 * Math.hypot(g.trm[2], g.trm[3])) text = [...text].filter((ch) => /[\p{M}\s]/u.test(ch)).join('');
      }
      text = text.replace(/\u0000/g, '');
      if (text === '' && g.actualSpan === undefined) {
        orphans.push(g);
        continue;
      }
      clusters.push({ pos: along(g) + advAlong(g) / 2, text, bt: g.btIndex, glyphs: [g] });
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (!charFonts.has(cp)) charFonts.set(cp, g.font);
        const sc = scriptOf(cp);
        if (sc !== 'common' && !scriptFonts.has(sc)) scriptFonts.set(sc, g.font);
      }
    }
    for (const g of orphans) {
      const x = along(g) + advAlong(g) / 2;
      let best: Cl | undefined;
      for (const c of clusters) {
        const base = c.glyphs[0]!;
        const lo = Math.min(along(base), along(base) + advAlong(base));
        const hi = Math.max(along(base), along(base) + advAlong(base));
        const d = x < lo ? lo - x : x > hi ? x - hi : 0;
        if (!best || d < (best as unknown as { _d: number })._d) {
          best = c;
          (best as unknown as { _d: number })._d = d;
        }
      }
      if (best) best.glyphs.push(g);
      else clusters.push({ pos: x, text: '', bt: g.btIndex, glyphs: [g] });
    }
    const visualIdx = clusters.map((_, k) => k).sort((a, b) => clusters[a]!.pos - clusters[b]!.pos || a - b);
    const v2l = visualToLogical(visualIdx.map((k) => clusters[k]!.text));
    let dir = v2l.dir;
    let order = v2l.order.map((k) => visualIdx[k]!);
    let streamLogical = false;
    // Some producers (LibreOffice) write each bidi run as its own text object
    // in LOGICAL order. If the runs are not written left-to-right, trust that
    // order: logical text = runs in stream order, each run read on its own.
    const runs: number[][] = [];
    let lastPos = -Infinity;
    let lastBt = NaN;
    clusters.forEach((c, k) => {
      if (!runs.length || c.bt !== lastBt || c.pos < lastPos - 0.5 * this.lineSize(glyphs)) runs.push([]);
      runs[runs.length - 1]!.push(k);
      lastPos = c.pos;
      lastBt = c.bt;
    });
    const span = (r: number[]): [number, number] => [Math.min(...r.map((k) => clusters[k]!.pos)), Math.max(...r.map((k) => clusters[k]!.pos))];
    // a run of only spaces/punctuation drawn inside another run's span (e.g. a
    // fallback-font space) belongs to that run, not to the logical sequence
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k]!;
      if (r.some((c) => /[\p{L}\p{N}]/u.test(clusters[c]!.text))) continue;
      const [lo, hi] = span(r);
      const host = runs.find((o) => o !== r && span(o)[0] < lo && span(o)[1] > hi);
      if (host) {
        host.push(...r);
        runs.splice(k, 1);
      }
    }
    if (runs.length > 1) {
      const starts = runs.map((r) => span(r)[0]);
      const leftToRight = starts.every((x, k) => k === 0 || x >= starts[k - 1]!);
      if (!leftToRight) {
        streamLogical = true;
        order = runs.flatMap((r) => {
          const vis = [...r].sort((a, b) => clusters[a]!.pos - clusters[b]!.pos || a - b);
          return visualToLogical(vis.map((k) => clusters[k]!.text)).order.map((k) => vis[k]!);
        });
      }
    }
    // logical text with a per-character owner (cluster index); collapse and trim whitespace
    const chars: { ch: string; owner: number }[] = [];
    for (const k of order) for (const ch of clusters[k]!.text) {
      const ws = /\s/u.test(ch);
      if (ws && (chars.length === 0 || /\s/u.test(chars[chars.length - 1]!.ch))) continue;
      chars.push({ ch: ws ? ' ' : ch, owner: k });
    }
    while (chars.length && chars[chars.length - 1]!.ch === ' ') chars.pop();
    const text = chars.map((c) => c.ch).join('');
    const fontCount = new Map<PdfFont, number>();
    for (const g of glyphs) fontCount.set(g.font, (fontCount.get(g.font) ?? 0) + 1);
    const fonts = [...fontCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
    const first = glyphs.find((g) => Math.abs(g.x * v[0] + g.y * v[1] - basePerp) < 1e-6) ?? glyphs[0]!;
    return { id, glyphs, text, dir, u, v, basePerp, left, right, size: Math.hypot(first.trm[2], first.trm[3]), first, charFonts, scriptFonts, fonts, owner: chars.map((c) => c.owner), clusterGlyphs: clusters.map((c) => c.glyphs), streamLogical };
  }

  private lineSize(glyphs: Glyph[]): number {
    return median(glyphs.map((g) => Math.hypot(g.trm[2], g.trm[3])));
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
    if (h.pdf.kind === 'simple') return !isArabicCp(cp) && h.pdf.encodeSimple?.(cp) !== undefined && h.pdf.widthOf(h.pdf.encodeSimple(cp)!) > 0;
    if (h.embedded) return h.embedded.unicodes.has(cp) && (!isArabicCp(cp) || h.embedded.hasArabicGsub);
    return false;
  }

  private layout(pm: PageModel, line: Line, text: string, warnings: string[], editSpan: [number, number] = [0, text.length]): { placed: Placed[]; runs: EditReport['runs'] } {
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
    // keep only the edited range (shaping still sees the whole line as context)
    const clipped = runs.flatMap((r) => {
      const a = Math.max(r.start, editSpan[0]);
      const b = Math.min(r.end, editSpan[1]);
      return a < b ? [{ ...r, start: a, end: b }] : [];
    });
    runs.length = 0;
    runs.push(...clipped);
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
      for (const p of out.placed) placed.push({ ...p, cluster: p.cluster + clusterBase, runStart: run.start });
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
    const segment = text.slice(start, end);

    // ---- unidentified single-byte font: encode per character, no shaping
    if ('kind' in choice.h && choice.h.kind === 'orig' && choice.h.pdf.kind === 'simple' && !choice.h.ident) {
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

    // ---- everything else is shaped with HarfBuzz, then each glyph is placed
    // in the original font when it has that glyph, otherwise in a subset of
    // the same full font (identified) or of a bundled substitute
    let shaping: ShapingFont;
    let orig: OrigHandle | undefined;
    let lib: LibFont | undefined;
    if ('kind' in choice.h) {
      const h = choice.h;
      if (h.kind === 'supp') {
        lib = h.lib;
        shaping = h.lib.font;
      } else if (h.ident) {
        orig = h;
        lib = h.ident.lib;
        shaping = lib.font;
      } else if (h.embedded) {
        orig = h;
        shaping = h.embedded;
        if (shaping.shape(text, dir, undefined, start, end - start).some((g) => g.gid === 0)) {
          lib = this.library.pick(text.codePointAt(start)!, h.pdf.bold);
          if (!lib) throw new Error('missing glyphs and no substitute font');
          warnings.push(`"${h.pdf.baseFont}" lacks glyphs for "${segment}" and is not a known font; substituted ${lib.psName}.`);
          orig = undefined;
          shaping = lib.font;
        }
      } else throw new Error(`font ${h.pdf.baseFont} has no usable program`);
    } else {
      lib = choice.h;
      shaping = lib.font;
      warnings.push(`No font on this line can draw "${segment}"; substituted ${lib.psName}.`);
    }

    const glyphs = shaping.shape(text, dir, undefined, start, end - start);
    const starts = [...new Set(glyphs.map((g) => g.cluster))].sort((a, b) => a - b);
    const ct = new Map<number, string>();
    starts.forEach((c, k) => ct.set(c, text.slice(c, starts[k + 1] ?? end)));
    const bases = new Map<number, number>();
    glyphs.forEach((g, k) => {
      const b = bases.get(g.cluster);
      if (b === undefined || shaping.advance(g.gid) > shaping.advance(glyphs[b]!.gid)) bases.set(g.cluster, k);
    });
    const scale = 1000 / shaping.upem;

    // Type0 original that is missing glyphs: grow its subset in place if safe
    if (orig && orig.pdf.kind === 'type0' && orig.ident && !orig.upgraded && orig.ident.upgradable && glyphs.some((g) => !orig!.ident!.fullToSub.has(g.gid))) this.upgrade(orig);

    const sizeHandle = 'kind' in choice.h ? choice.h : undefined;
    const size = sizeHandle ? sizeOf(sizeHandle) : line.first.size;
    let used = { orig: 0, supp: 0 };
    const placed: Placed[] = glyphs.map((g, k) => {
      const textForGlyph = bases.get(g.cluster) === k ? ct.get(g.cluster)! : MARK_TEXT;
      const width = Math.round(shaping.advance(g.gid) * scale);
      const common = { size, adv: g.xAdvance * scale, xOff: g.xOffset * scale, yOff: g.yOffset * scale, cluster: g.cluster, clusterText: ct.get(g.cluster)! };
      if (orig) {
        if (orig.pdf.kind === 'simple') {
          const sub = orig.ident ? orig.ident.fullToSub.get(g.gid) : g.gid;
          const code = sub === undefined ? undefined : this.simpleCode(orig, sub);
          // a single-byte code has one fixed ToUnicode meaning; reuse it only if
          // that meaning is right here (e.g. the shared body of س/ش is not)
          const tu = code === undefined ? undefined : (orig.pdf.toUnicode.get(code) ?? '').replace(/\u0000/g, '');
          const want = textForGlyph === MARK_TEXT ? '' : textForGlyph;
          const meaningOk = tu !== undefined && (want === '' ? tu === '' || /^\p{M}+$/u.test(tu) : tu === want);
          if (code !== undefined && meaningOk) {
            used.orig++;
            return { ...common, handle: orig, resName: this.resNameOf(pm, orig), code, twoByte: false, pdfW: orig.pdf.widthOf(code), isSpaceCode: code === 32 };
          }
        } else {
          const gid = orig.upgraded || !orig.ident ? g.gid : orig.ident.fullToSub.get(g.gid);
          if (gid !== undefined) {
            used.orig++;
            const code = this.allocCid(orig, gid, textForGlyph, width);
            return { ...common, handle: orig, resName: this.resNameOf(pm, orig), code, twoByte: true, pdfW: orig.aliases.get(code)?.width ?? orig.pdf.widthOf(code), isSpaceCode: false };
          }
        }
      }
      if (!lib) throw new Error('internal: no font for missing glyph');
      used.supp++;
      const supp = this.suppFor(lib);
      const code = this.allocCid(supp, g.gid, textForGlyph, width);
      return { ...common, handle: supp, resName: this.resNameOf(pm, supp), code, twoByte: true, pdfW: width, isSpaceCode: false };
    });
    let mode: FontMode;
    if (!orig) mode = 'kind' in choice.h && choice.h.kind === 'supp' ? 'same-font-supplement' : 'substitute';
    else if (used.supp === 0) mode = orig.upgraded ? 'original-extended' : 'original';
    else {
      mode = 'original-with-supplement';
      warnings.push(`${used.supp} glyph(s) for "${segment}" are not in the embedded "${orig.pdf.baseFont}" subset; they come from a subset of the same font (${lib!.psName}).`);
    }
    const fontName = orig ? orig.pdf.baseFont : lib!.psName;
    void used;
    return { placed, mode, fontName };
  }

  /** code that draws embedded glyph `gid` in a single-byte font, if any */
  private simpleCode(h: OrigHandle, gid: number): number | undefined {
    if (!h.simpleCodes) {
      h.simpleCodes = new Map();
      if (h.embedded) {
        for (const cp of [...h.embedded.unicodes].sort((a, b) => a - b)) {
          const g = h.embedded.hbFont.nominalGlyph(cp);
          if (g === undefined) continue;
          let code: number | undefined;
          if (cp >= 0xf000 && cp <= 0xf0ff) code = cp - 0xf000;
          else if (h.pdf.symbolic) code = cp <= 0xff ? cp : undefined;
          else code = h.pdf.encodeSimple?.(cp);
          if (code === undefined || h.simpleCodes.has(g)) continue;
          if (h.pdf.widthOf(code) <= 0 && h.embedded.hasOutline(g)) continue;
          h.simpleCodes.set(g, code);
        }
      }
    }
    return h.simpleCodes.get(gid);
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

  private spliceRange(pm: PageModel, line: Line, A: number, B: number, placed: Placed[], notes: string[]): { bytes: Uint8Array; newWidth: number; oldWidth: number } {
    const { ops, states } = pm.interp;
    const along = (g: Glyph): number => g.x * line.u[0] + g.y * line.u[1];
    const adv = (g: Glyph): number => g.dx * line.u[0] + g.dy * line.u[1];
    const removedClusters = new Set(line.owner.slice(A, B));
    const removed = new Set<number>();
    for (const c of removedClusters) for (const g of line.clusterGlyphs[c]!) removed.add(g.index);
    // whitespace right at the range edges stays; but a cluster that is only
    // whitespace inside the range is removed too (it was part of the edit)
    const removedGlyphs = line.glyphs.filter((g) => removed.has(g.index));
    if (!removedGlyphs.length) throw new Error('nothing to replace');
    const ext = removedGlyphs.filter((g) => Math.abs(adv(g)) > 1e-6);
    const x0 = Math.min(...(ext.length ? ext : removedGlyphs).map((g) => Math.min(along(g), along(g) + adv(g))));
    const x1 = Math.max(...(ext.length ? ext : removedGlyphs).map((g) => Math.max(along(g), along(g) + adv(g))));
    const oldWidth = x1 - x0;

    // where the new word goes: after the last operator that drew removed glyphs
    const insOp = Math.max(...removedGlyphs.map((g) => g.opIndex));
    const st = states[insOp + 1] ?? pm.interp.after;
    const F0 = mul(st.tm, st.ctm);
    const sx = Math.hypot(F0[0], F0[1]);
    const th = st.ts.tz / 100;
    let newWidthTs = 0;
    for (const p of placed) newWidthTs += ((p.adv / 1000) * p.size + st.ts.tc + (p.isSpaceCode ? st.ts.tw : 0)) * th;
    const newWidth = newWidthTs * sx;
    // differences below 0.1 pt are rounding between layout engines, not a
    // real width change: leave everything else exactly where it was
    const delta = Math.abs(newWidth - oldWidth) < 0.1 ? 0 : newWidth - oldWidth;
    const rtl = line.dir === 'rtl';
    const startAlong = rtl ? x1 - newWidth : x0;

    // glyphs beyond the edit on the growing side move by delta (with their marks)
    const shift = new Map<number, number>();
    if (Math.abs(delta) > 1e-4) {
      line.clusterGlyphs.forEach((cg, c) => {
        if (removedClusters.has(c)) return;
        const base = cg.find((g) => Math.abs(adv(g)) > 1e-6) ?? cg[0]!;
        const lo = Math.min(along(base), along(base) + adv(base));
        const hi = Math.max(along(base), along(base) + adv(base));
        const moves = rtl ? hi <= x0 + 1e-3 : lo >= x1 - 1e-3;
        if (moves) for (const g of cg) shift.set(g.index, rtl ? -delta : delta);
      });
    }
    if (delta !== 0) notes.push(`The new text is ${delta > 0 ? 'wider' : 'narrower'} by ${Math.abs(delta).toFixed(1)} pt; the rest of the line after it moves by that amount (no reflow).`);
    if (false) notes.push(`The new text is ${(newWidth - oldWidth).toFixed(1)} pt wider; following text on this line moves by that amount (no reflow).`);

    const edits: { start: number; end: number; text: string }[] = [];
    // marked-content pairs that only wrapped removed glyphs (stale ActualText)
    const deletedPairs = new Set<number>();
    for (const [open, close] of matchMarkedContent(ops)) {
      // only text-replacement wrappers go; structure (MCID) wrappers stay so the
      // tagged-PDF structure tree keeps pointing at valid content
      const o = ops[open]!;
      const props = o.op === 'BDC' ? o.operands[1] : undefined;
      const hasMcid = props?.t === 'dict' && props.v.has('MCID');
      const replacing = (props?.t === 'dict' && props.v.has('ActualText')) || (o.operands[0]?.t === 'name' && o.operands[0].v === 'ReversedChars');
      if (hasMcid || !replacing) continue;
      const inner = pm.interp.glyphs.filter((g) => g.opIndex > open && g.opIndex < close);
      if (inner.length > 0 && inner.every((g) => removed.has(g.index))) {
        deletedPairs.add(open);
        edits.push({ start: ops[open]!.start, end: ops[open]!.end, text: '' });
        edits.push({ start: ops[close]!.start, end: ops[close]!.end, text: '' });
      }
    }

    // the new text: each bidi run positioned absolutely, written in logical
    // order (stream-order extractors such as pdf.js then read it correctly)
    const btIndex = lastIndexBefore(ops, insOp + 1, 'BT');
    const toClose = st.mc.filter((e) => !deletedPairs.has(e.openIndex) && e.openIndex > btIndex && (e.actualText !== undefined || e.tag === 'ReversedChars'));
    let ins = '\n';
    for (let k = 0; k < toClose.length; k++) ins += 'EMC\n';
    const devAdv = (p: Placed): number => ((p.adv / 1000) * p.size + st.ts.tc + (p.isSpaceCode ? st.ts.tw : 0)) * th * sx;
    const segs: { runStart: number; x: number; glyphs: Placed[] }[] = [];
    let cx = startAlong;
    for (const p of placed) {
      const last = segs[segs.length - 1];
      if (last && last.runStart === (p.runStart ?? 0)) last.glyphs.push(p);
      else segs.push({ runStart: p.runStart ?? 0, x: cx, glyphs: [p] });
      cx += devAdv(p);
    }
    // follow the producer's convention for run order in the stream
    if (line.streamLogical) segs.sort((a, b) => a.runStart - b.runStart);
    for (const seg of segs) {
      const P: [number, number] = [seg.x * line.u[0] + line.basePerp * line.v[0], seg.x * line.u[1] + line.basePerp * line.v[1]];
      ins += `${mat(mul([F0[0], F0[1], F0[2], F0[3], P[0], P[1]], invert(st.ctm)))} Tm\n`;
      let k = 0;
      while (k < seg.glyphs.length) {
        const p0 = seg.glyphs[k]!;
        let e = k;
        while (e + 1 < seg.glyphs.length && seg.glyphs[e + 1]!.resName === p0.resName && seg.glyphs[e + 1]!.size === p0.size) e++;
        const group = seg.glyphs.slice(k, e + 1);
        const rtlGroup = group.some((p) => /[\u0590-\u08ff\ufb1d-\ufefc]/.test(p.clusterText));
        ins += `/${p0.resName} ${fmtNum(p0.size)} Tf\n`;
        if (rtlGroup) ins += '/ReversedChars BMC\n';
        ins += emitGroup(group, st.ts.ts);
        if (rtlGroup) ins += 'EMC\n';
        k = e + 1;
      }
    }

    // rewrite every operator that draws a removed or shifted glyph; the one
    // holding the last removed glyph is split there and the new text goes in
    // between, so stream order follows reading order
    const touched = new Set<number>();
    for (const g of line.glyphs) if (removed.has(g.index) || shift.has(g.index)) touched.add(g.opIndex);
    touched.add(insOp);
    const lastRemoved = Math.max(...removedGlyphs.filter((g) => g.opIndex === insOp).map((g) => g.index));
    for (const oi of touched) {
      const op = ops[oi]!;
      const opGlyphs = pm.interp.glyphs.filter((g) => g.opIndex === oi);
      if (oi !== insOp) {
        edits.push({ start: op.start, end: op.end, text: rewriteShowOp(op, opGlyphs, states[oi]!, removed, shift).before });
        continue;
      }
      const parts = rewriteShowOp(op, opGlyphs, states[oi]!, removed, shift, lastRemoved);
      const after = states[oi + 1] ?? pm.interp.after;
      let text = parts.before + ins;
      if (parts.after && parts.resumeAt) {
        // back to where the original pen was for the first glyph after the edit
        const [e, f] = apply(invert(after.ctm), parts.resumeAt.x, parts.resumeAt.y);
        text += restoreState({ ...after, tm: [after.tm[0], after.tm[1], after.tm[2], after.tm[3], e, f] });
        for (const m of [...toClose]) text += `/${m.tag} ${m.props ? serializeOperand(m.props) + ' BDC' : 'BMC'}\n`;
        text += parts.after;
      } else {
        text += restoreState(after);
        for (const m of [...toClose]) text += `/${m.tag} ${m.props ? serializeOperand(m.props) + ' BDC' : 'BMC'}\n`;
      }
      edits.push({ start: op.start, end: op.end, text });
    }

    // underline / strike-through rules drawn under the line follow its new extent
    if (Math.abs(delta) > 1e-4) this.moveRules(pm, line, rtl ? line.left : line.right, rtl ? -delta : delta, edits);

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

  /**
   * Horizontal rules (underlines) drawn just below the line as a stroked
   * segment or a thin filled rectangle: move the endpoint at the line's
   * growing edge by `d` so the rule keeps matching the text.
   */
  private moveRules(pm: PageModel, line: Line, edge: number, d: number, edits: { start: number; end: number; text: string }[]): void {
    const { ops, states } = pm.interp;
    const upright = Math.abs(line.u[1]) < 1e-3 && line.u[0] > 0;
    if (!upright) return;
    const yBase = line.basePerp * line.v[1];
    const near = (y: number) => y <= yBase + 0.1 * line.size && y >= yBase - 0.4 * line.size;
    const spans = (a: number, b: number) => Math.min(b, line.right) - Math.max(a, line.left) >= 0.6 * (line.right - line.left);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      const ctm = states[i]!.ctm;
      if (states[i]!.inBT) continue;
      const nums = op.operands.map((o) => (o.t === 'num' ? o.v : NaN));
      if (op.op === 'm' && ops[i + 1]?.op === 'l') {
        const l = ops[i + 1]!;
        const ln = l.operands.map((o) => (o.t === 'num' ? o.v : NaN));
        const [ax, ay] = apply(ctm, nums[0]!, nums[1]!);
        const [bx, by] = apply(ctm, ln[0]!, ln[1]!);
        if (Math.abs(ay - by) > 0.05 || !near(ay) || !spans(Math.min(ax, bx), Math.max(ax, bx))) continue;
        const inv = invert(ctm);
        const moveA = Math.abs(ax - edge) < Math.abs(bx - edge);
        const [nx, ny] = moveA ? apply(inv, ax + d, ay) : apply(inv, bx + d, by);
        const target = moveA ? op : l;
        edits.push({ start: target.start, end: target.end, text: `${fmtNum(nx)} ${fmtNum(ny)} ${target.op}` });
        i++;
      } else if (op.op === 're' && nums.length === 4) {
        const [x, y, w, h] = nums as [number, number, number, number];
        const [ax, ay] = apply(ctm, x, y);
        const [bx, by] = apply(ctm, x + w, y + h);
        const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
        if (Math.abs(by - ay) > 0.15 * line.size || !near(Math.min(ay, by)) || !spans(lo, hi)) continue;
        const nlo = Math.abs(lo - edge) < Math.abs(hi - edge) ? lo + d : lo;
        const nhi = Math.abs(hi - edge) <= Math.abs(lo - edge) ? hi + d : hi;
        const inv = invert(ctm);
        const [px, py] = apply(inv, nlo, Math.min(ay, by));
        const [qx, qy] = apply(inv, nhi, Math.max(ay, by));
        edits.push({ start: op.start, end: op.end, text: `${fmtNum(px)} ${fmtNum(py)} ${fmtNum(qx - px)} ${fmtNum(qy - py)} re` });
      }
    }
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

function serialise(obj: PDFObject): string {
  const b = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(b, 0);
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

function suppKey(s: SuppHandle): string {
  return s.ref.toString();
}

function suppAsPdfFont(s: SuppHandle): PdfFont {
  const tu = new Map<number, string>([...s.aliases].map(([c, a]) => [c, a.text]));
  return {
    key: suppKey(s), ref: s.ref, dict: undefined as unknown as PDFDict, kind: 'type0', baseFont: `${s.tag}+${s.lib.psName}`, bold: s.lib.bold, identity: true,
    widthOf: (c) => s.aliases.get(c)?.width ?? 0, gidOf: (c) => s.aliases.get(c)?.gid, toUnicode: tu, hasToUnicodeStream: true,
    program: s.lib.font.bytes, standard14: false, symbolic: false,
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

/**
 * Re-emit a text-showing operator, dropping `removed` glyphs (their advance is
 * kept as a TJ adjustment) and moving glyphs in `shift` by a device-space
 * amount along the baseline. Untouched glyphs keep their exact codes and
 * relative positions.
 */
function rewriteShowOp(
  op: Op,
  glyphs: Glyph[],
  st: OpState,
  removed: Set<number>,
  shift: Map<number, number>,
  splitAfter?: number,
): { before: string; after: string; resumeAt?: Glyph } {
  const a = op.operands;
  let prefix = '';
  let items: Operand[];
  if (op.op === 'Tj') items = [a[0]!];
  else if (op.op === "'") {
    prefix = 'T* ';
    items = [a[0]!];
  } else if (op.op === '"') {
    prefix = `${serializeOperand(a[0]!)} Tw ${serializeOperand(a[1]!)} Tc T* `;
    items = [a[2]!];
  } else items = a[0]?.t === 'arr' ? a[0].v : [];
  const size = glyphs[0]?.size ?? st.ts.size;
  const th = st.ts.tz / 100;
  const M = mul(st.tm, st.ctm);
  const sx = Math.hypot(M[0], M[1]) || 1;
  const toNum = (txUnits: number): number => (-txUnits * 1000) / (size * th);
  const twoByte = glyphs[0]?.font.kind === 'type0';
  const parts: string[][] = [[]];
  let out = parts[0]!;
  let pendingCodes: number[] = [];
  let resumeAt: Glyph | undefined;
  let split = false;
  const flushCodes = (): void => {
    if (!pendingCodes.length) return;
    out.push(hexStr(pendingCodes.flatMap((c) => (twoByte ? [c >> 8, c & 0xff] : [c]))));
    pendingCodes = [];
  };
  let offset = 0; // extra displacement applied so far, text space units
  const closePart = (): void => {
    flushCodes();
    if (Math.abs(offset) > 1e-6) out.push(fmtNum(toNum(-offset)));
    offset = 0;
  };
  let gi = 0;
  for (const item of items) {
    if (item.t === 'num') {
      if (split && out.length === 0 && pendingCodes.length === 0) continue; // spacing before the split point is already in the pen
      flushCodes();
      out.push(fmtNum(item.v));
      continue;
    }
    if (item.t !== 'str') continue;
    const codes = glyphs[gi]?.font.splitCodes(item.v) ?? [];
    for (let c = 0; c < codes.length; c++, gi++) {
      const g = glyphs[gi];
      if (!g) break;
      if (splitAfter !== undefined && !split && g.index > splitAfter) {
        closePart();
        split = true;
        resumeAt = g;
        parts.push([]);
        out = parts[1]!;
      }
      if (removed.has(g.index)) {
        flushCodes();
        out.push(fmtNum(toNum(g.advTs * th)));
        continue;
      }
      const want = (shift.get(g.index) ?? 0) / sx;
      if (Math.abs(want - offset) > 1e-6) {
        flushCodes();
        out.push(fmtNum(toNum(want - offset)));
        offset = want;
      }
      pendingCodes.push(g.code);
    }
  }
  closePart();
  const tj = (xs: string[]): string => (xs.length ? `[${xs.join(' ')}] TJ` : '');
  return { before: prefix + tj(parts[0]!), after: split ? tj(parts[1]!) : '', resumeAt };
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
