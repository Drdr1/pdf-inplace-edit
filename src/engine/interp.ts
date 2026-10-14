// Text-state interpreter over a tokenised content stream. It reproduces the
// PDF text positioning model (Tm/Tlm, Tc, Tw, Tz, TL, Ts, TJ adjustments, CTM)
// so every glyph gets an exact device-space origin and advance, and every
// operator remembers the state it ran in. pdf.js operator lists drop the byte
// offsets we need for in-place splicing, so we interpret the stream ourselves.
import type { Op, Operand } from './lexer';
import type { PdfFont } from './pdffont';

export type Mat = [number, number, number, number, number, number];
export const IDENT: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
export function apply(m: Mat, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export interface TextState {
  font: PdfFont | undefined;
  fontRes: string;
  size: number;
  tc: number;
  tw: number;
  tz: number;
  tl: number;
  ts: number;
  tr: number;
}

export interface McEntry {
  tag: string;
  props: Operand | undefined; // dict or name
  actualText: string | undefined;
  spanId: number;
  openIndex: number;
}

export interface OpState {
  inBT: boolean;
  tm: Mat;
  tlm: Mat;
  ctm: Mat;
  ts: TextState;
  mc: McEntry[];
}

export interface Glyph {
  opIndex: number;
  index: number; // order on page
  code: number;
  font: PdfFont;
  size: number;
  /** text space -> device at glyph origin (includes font size, Tz, rise) */
  trm: Mat;
  /** baseline origin (device), without rise */
  x: number;
  y: number;
  /** device-space advance vector */
  dx: number;
  dy: number;
  /** advance in text space units (already including Tc/Tw, before Tz) */
  advTs: number;
  actualSpan: number | undefined;
  actualText: string | undefined;
  isSpaceCode: boolean;
  /** op index of the BT that opened this glyph's text object */
  btIndex: number;
}

export interface Interpretation {
  ops: Op[];
  states: OpState[]; // state BEFORE ops[i]
  after: OpState; // state after the last op
  glyphs: Glyph[];
  spans: Map<number, { text: string; glyphs: number[] }>;
}

const SHOW = new Set(['Tj', 'TJ', "'", '"']);
export const isShowOp = (op: string): boolean => SHOW.has(op);

export function interpret(ops: Op[], fonts: Map<string, PdfFont>, resolveProps?: (name: string) => Operand | undefined): Interpretation {
  let ctm: Mat = [...IDENT];
  const gstack: { ctm: Mat; ts: TextState }[] = [];
  let ts: TextState = { font: undefined, fontRes: '', size: 0, tc: 0, tw: 0, tz: 100, tl: 0, ts: 0, tr: 0 };
  let tm: Mat = [...IDENT];
  let tlm: Mat = [...IDENT];
  let inBT = false;
  let btIndex = -1;
  let mc: McEntry[] = [];
  let spanSeq = 0;
  const states: OpState[] = [];
  const glyphs: Glyph[] = [];
  const spans = new Map<number, { text: string; glyphs: number[] }>();

  const n = (o: Operand | undefined): number => (o && o.t === 'num' ? o.v : 0);
  const translateLine = (tx: number, ty: number): void => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = [...tlm];
  };
  const nextLine = (): void => translateLine(0, -ts.tl);

  const show = (opIndex: number, bytes: Uint8Array): void => {
    const font = ts.font;
    if (!font) return;
    const th = ts.tz / 100;
    const span = [...mc].reverse().find((e) => e.actualText !== undefined);
    for (const code of font.splitCodes(bytes)) {
      const isSpaceCode = font.kind === 'simple' && code === 32;
      const w0 = font.widthOf(code) / 1000;
      const advTs = w0 * ts.size + ts.tc + (isSpaceCode ? ts.tw : 0);
      const tx = advTs * th;
      const base = mul(tm, ctm);
      const trm = mul([ts.size * th, 0, 0, ts.size, 0, ts.ts], base);
      const [x, y] = apply(base, 0, 0);
      const [x2, y2] = apply(base, tx, 0);
      const g: Glyph = {
        opIndex, index: glyphs.length, code, font, size: ts.size, trm, x, y, dx: x2 - x, dy: y2 - y, advTs,
        actualSpan: span?.spanId, actualText: span?.actualText, isSpaceCode, btIndex,
      };
      glyphs.push(g);
      if (span) spans.get(span.spanId)!.glyphs.push(g.index);
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
  };

  ops.forEach((op, i) => {
    states.push({ inBT, tm: [...tm], tlm: [...tlm], ctm: [...ctm], ts: { ...ts }, mc: [...mc] });
    const a = op.operands;
    switch (op.op) {
      case 'q':
        gstack.push({ ctm: [...ctm], ts: { ...ts } });
        break;
      case 'Q': {
        const s = gstack.pop();
        if (s) {
          ctm = s.ctm;
          ts = s.ts;
        }
        break;
      }
      case 'cm':
        ctm = mul([n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])], ctm);
        break;
      case 'BT':
        inBT = true;
        btIndex = i;
        tm = [...IDENT];
        tlm = [...IDENT];
        break;
      case 'ET':
        inBT = false;
        break;
      case 'Tf': {
        const name = a[0]?.t === 'name' ? a[0].v : '';
        ts = { ...ts, font: fonts.get(name), fontRes: name, size: n(a[1]) };
        break;
      }
      case 'Tc':
        ts = { ...ts, tc: n(a[0]) };
        break;
      case 'Tw':
        ts = { ...ts, tw: n(a[0]) };
        break;
      case 'Tz':
        ts = { ...ts, tz: n(a[0]) };
        break;
      case 'TL':
        ts = { ...ts, tl: n(a[0]) };
        break;
      case 'Ts':
        ts = { ...ts, ts: n(a[0]) };
        break;
      case 'Tr':
        ts = { ...ts, tr: n(a[0]) };
        break;
      case 'Td':
        translateLine(n(a[0]), n(a[1]));
        break;
      case 'TD':
        ts = { ...ts, tl: -n(a[1]) };
        translateLine(n(a[0]), n(a[1]));
        break;
      case 'Tm':
        tlm = [n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])];
        tm = [...tlm];
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj':
        if (a[0]?.t === 'str') show(i, a[0].v);
        break;
      case "'":
        nextLine();
        if (a[0]?.t === 'str') show(i, a[0].v);
        break;
      case '"':
        ts = { ...ts, tw: n(a[0]), tc: n(a[1]) };
        nextLine();
        if (a[2]?.t === 'str') show(i, a[2].v);
        break;
      case 'TJ':
        if (a[0]?.t === 'arr') {
          for (const item of a[0].v) {
            if (item.t === 'str') show(i, item.v);
            else if (item.t === 'num') tm = mul([1, 0, 0, 1, (-item.v / 1000) * ts.size * (ts.tz / 100), 0], tm);
          }
        }
        break;
      case 'BMC':
      case 'BDC': {
        const tag = a[0]?.t === 'name' ? a[0].v : '';
        let props = op.op === 'BDC' ? a[1] : undefined;
        if (props?.t === 'name' && resolveProps) props = resolveProps(props.v) ?? props;
        let actualText: string | undefined;
        if (props?.t === 'dict') {
          const at = props.v.get('ActualText');
          if (at?.t === 'str') actualText = decodeTextString(at.v);
        }
        const entry: McEntry = { tag, props: op.op === 'BDC' ? a[1] : undefined, actualText, spanId: spanSeq++, openIndex: i };
        if (actualText !== undefined) spans.set(entry.spanId, { text: actualText, glyphs: [] });
        mc = [...mc, entry];
        break;
      }
      case 'EMC':
        mc = mc.slice(0, -1);
        break;
    }
  });
  return { ops, states, after: { inBT, tm, tlm, ctm, ts, mc }, glyphs, spans };
}

export function decodeTextString(b: Uint8Array): string {
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let k = 2; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k]! << 8) | b[k + 1]!);
    return s;
  }
  return String.fromCharCode(...b);
}
