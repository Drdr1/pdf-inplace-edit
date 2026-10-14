// Reads what the engine needs from a PDF font dictionary: how string bytes
// split into codes, code -> CID -> GID, widths, ToUnicode, and the embedded
// font program (if any).
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { Encodings, Font as StdFont, type IFontNames } from '@pdf-lib/standard-fonts';

export type FontKind = 'type0' | 'simple';

export interface PdfFont {
  key: string;
  ref: PDFRef | undefined;
  dict: PDFDict;
  kind: FontKind;
  baseFont: string;
  bold: boolean;
  /** Type0 with Identity-H / Identity-V: 2-byte codes, code == CID. */
  identity: boolean;
  /** Advance width of a code in glyph space (1/1000 text space unit). */
  widthOf(code: number): number;
  /** CID -> GID for Type0 fonts; for simple fonts, the code itself. */
  gidOf(code: number): number | undefined;
  toUnicode: Map<number, string>;
  hasToUnicodeStream: boolean;
  /** TrueType/OpenType font program bytes, if embedded and usable by HarfBuzz. */
  program: Uint8Array | undefined;
  /** Unicode -> code, for simple fonts with a known encoding. */
  encodeSimple?: (cp: number) => number | undefined;
  /** Standard-14 font (not embedded). */
  standard14: boolean;
  /** FontDescriptor Flags bit 3: codes address the font's built-in (symbol) cmap directly. */
  symbolic: boolean;
  splitCodes(bytes: Uint8Array): number[];
  /** CIDToGIDMap as an explicit array when it is a stream; undefined = Identity. */
  cidToGidArray: Uint16Array | undefined;
  descendant: PDFDict | undefined;
}

const num = (o: PDFObject | undefined): number | undefined => (o instanceof PDFNumber ? o.asNumber() : undefined);

export function lookup(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

export function streamBytes(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | undefined {
  const s = lookup(ctx, o);
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) return s.getContents();
  return undefined;
}

export function parseToUnicode(bytes: Uint8Array): Map<number, string> {
  const text = new TextDecoder('latin1').decode(bytes);
  const map = new Map<number, string>();
  const hexToStr = (h: string): string => {
    let s = '';
    for (let k = 0; k + 4 <= h.length; k += 4) s += String.fromCharCode(parseInt(h.substr(k, 4), 16));
    if (h.length === 2) s = String.fromCharCode(parseInt(h, 16));
    return s;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1]!, 16), hexToStr(m[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    for (const m of body.matchAll(re)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (m[4] !== undefined) {
        const base = m[4];
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          const s = hexToStr(base);
          const last = s.charCodeAt(s.length - 1) + (c - lo);
          map.set(c, s.slice(0, -1) + String.fromCharCode(last));
        }
      } else if (m[5] !== undefined) {
        const items = [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]!));
        items.forEach((s, k) => map.set(lo + k, s));
      }
    }
  }
  return map;
}

function parseW(ctx: PDFContext, w: PDFObject | undefined): Map<number, number> {
  const out = new Map<number, number>();
  const arr = lookup(ctx, w);
  if (!(arr instanceof PDFArray)) return out;
  const items = arr.asArray().map((x) => lookup(ctx, x));
  for (let k = 0; k < items.length; ) {
    const first = num(items[k]);
    const next = items[k + 1];
    if (first === undefined) break;
    if (next instanceof PDFArray) {
      next.asArray().forEach((x, j) => {
        const v = num(lookup(ctx, x));
        if (v !== undefined) out.set(first + j, v);
      });
      k += 2;
    } else {
      const last = num(next);
      const v = num(items[k + 2]);
      if (last === undefined || v === undefined) break;
      for (let c = first; c <= last; c++) out.set(c, v);
      k += 3;
    }
  }
  return out;
}

const STD14 = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold',
  'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
]);

function winAnsiTables(): { toUni: Map<number, string>; fromUni: Map<number, number>; names: Map<number, string> } {
  const toUni = new Map<number, string>();
  const fromUni = new Map<number, number>();
  const names = new Map<number, string>();
  for (const cp of Encodings.WinAnsi.supportedCodePoints) {
    const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
    if (!toUni.has(code)) toUni.set(code, String.fromCodePoint(cp));
    fromUni.set(cp, code);
    names.set(code, name);
  }
  return { toUni, fromUni, names };
}

export function readFont(ctx: PDFContext, resName: string, ref: PDFRef | undefined, dict: PDFDict): PdfFont {
  const subtype = (dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText() ?? '';
  const baseFont = (dict.get(PDFName.of('BaseFont')) as PDFName | undefined)?.decodeText() ?? resName;
  const key = ref ? ref.toString() : `inline:${resName}`;
  const tuBytes = streamBytes(ctx, dict.get(PDFName.of('ToUnicode')));
  const toUnicode = tuBytes ? parseToUnicode(tuBytes) : new Map<number, string>();
  const bold = /bold|black|heavy|semibold|demi/i.test(baseFont);

  if (subtype === 'Type0') {
    const enc = lookup(ctx, dict.get(PDFName.of('Encoding')));
    const encName = enc instanceof PDFName ? enc.decodeText() : '';
    const identity = encName === 'Identity-H' || encName === 'Identity-V';
    const descArr = lookup(ctx, dict.get(PDFName.of('DescendantFonts')));
    const desc = descArr instanceof PDFArray ? (lookup(ctx, descArr.get(0)) as PDFDict) : undefined;
    const widths = parseW(ctx, desc?.get(PDFName.of('W')));
    const dw = num(lookup(ctx, desc?.get(PDFName.of('DW')))) ?? 1000;
    const fd = lookup(ctx, desc?.get(PDFName.of('FontDescriptor'))) as PDFDict | undefined;
    const program = fd ? streamBytes(ctx, fd.get(PDFName.of('FontFile2'))) ?? openTypeFF3(ctx, fd) : undefined;
    const fdWeight = num(lookup(ctx, fd?.get(PDFName.of('FontWeight'))));
    const c2g = lookup(ctx, desc?.get(PDFName.of('CIDToGIDMap')));
    let cidToGidArray: Uint16Array | undefined;
    if (c2g instanceof PDFRawStream || c2g instanceof PDFStream) {
      const b = streamBytes(ctx, c2g)!;
      cidToGidArray = new Uint16Array(b.length >> 1);
      for (let k = 0; k < cidToGidArray.length; k++) cidToGidArray[k] = (b[2 * k]! << 8) | b[2 * k + 1]!;
    }
    return {
      key, ref, dict, kind: 'type0', baseFont, bold: bold || (fdWeight ?? 0) >= 600, identity,
      widthOf: (c) => widths.get(c) ?? dw,
      gidOf: (c) => (cidToGidArray ? cidToGidArray[c] : c),
      toUnicode, hasToUnicodeStream: !!tuBytes, program, standard14: false, symbolic: false,
      splitCodes: (b) => {
        const out: number[] = [];
        for (let k = 0; k + 1 < b.length; k += 2) out.push((b[k]! << 8) | b[k + 1]!);
        return out;
      },
      cidToGidArray, descendant: desc,
    };
  }

  // Simple fonts (Type1 / TrueType / MMType1). Type3 is not editable here.
  const first = num(lookup(ctx, dict.get(PDFName.of('FirstChar')))) ?? 0;
  const wArr = lookup(ctx, dict.get(PDFName.of('Widths')));
  const widths = wArr instanceof PDFArray ? wArr.asArray().map((x) => num(lookup(ctx, x)) ?? 0) : undefined;
  const fd = lookup(ctx, dict.get(PDFName.of('FontDescriptor'))) as PDFDict | undefined;
  const program = fd ? streamBytes(ctx, fd.get(PDFName.of('FontFile2'))) ?? openTypeFF3(ctx, fd) : undefined;
  const cleanBase = baseFont.replace(/^[A-Z]{6}\+/, '');
  const standard14 = !fd && STD14.has(cleanBase);
  const win = winAnsiTables();
  const enc = lookup(ctx, dict.get(PDFName.of('Encoding')));
  const codeToUni = new Map(win.toUni);
  if (enc instanceof PDFDict) {
    const diffs = lookup(ctx, enc.get(PDFName.of('Differences')));
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const item of diffs.asArray().map((x) => lookup(ctx, x))) {
        const v = num(item);
        if (v !== undefined) code = v;
        else if (item instanceof PDFName) {
          const u = glyphNameToUnicode(item.decodeText(), win.names, win.toUni);
          if (u) codeToUni.set(code, u);
          else codeToUni.delete(code);
          code++;
        }
      }
    }
  }
  for (const [c, u] of toUnicode) codeToUni.set(c, u);
  const fromUni = new Map<number, number>();
  for (const [c, u] of codeToUni) if (u.length === 1 && !fromUni.has(u.codePointAt(0)!)) fromUni.set(u.codePointAt(0)!, c);
  let stdMetrics: StdFont | undefined;
  if (standard14 && !widths) stdMetrics = StdFont.load(cleanBase as IFontNames);
  const widthOf = (c: number): number => {
    if (widths && c >= first && c < first + widths.length) return widths[c - first]!;
    if (stdMetrics) {
      const name = win.names.get(c);
      return name ? stdMetrics.getWidthOfGlyph(name) ?? 0 : 0;
    }
    return num(lookup(ctx, fd?.get(PDFName.of('MissingWidth')))) ?? 0;
  };
  return {
    key, ref, dict, kind: 'simple', baseFont, bold, identity: false,
    widthOf, gidOf: (c) => c, toUnicode: codeToUni, hasToUnicodeStream: !!tuBytes, program, standard14,
    symbolic: ((num(lookup(ctx, fd?.get(PDFName.of('Flags')))) ?? 0) & 4) !== 0,
    encodeSimple: (cp) => fromUni.get(cp),
    splitCodes: (b) => Array.from(b), cidToGidArray: undefined, descendant: undefined,
  };
}

function openTypeFF3(ctx: PDFContext, fd: PDFDict): Uint8Array | undefined {
  const s = lookup(ctx, fd.get(PDFName.of('FontFile3')));
  if (!(s instanceof PDFRawStream)) return undefined;
  const st = (s.dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText();
  return st === 'OpenType' ? decodePDFRawStream(s).decode() : undefined; // bare CFF is not usable by HarfBuzz
}

function glyphNameToUnicode(name: string, names: Map<number, string>, toUni: Map<number, string>): string | undefined {
  const m = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  for (const [c, n] of names) if (n === name) return toUni.get(c);
  return undefined;
}

export function pdfStringText(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFHexString || o instanceof PDFString) return o.decodeText();
  return undefined;
}
