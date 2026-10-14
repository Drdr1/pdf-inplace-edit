// Minimal, lossless PDF content-stream tokenizer.
// Every operator keeps its [start, end) byte range in the original stream so
// edits can splice bytes instead of re-serialising (and possibly damaging)
// content we do not touch.

export type Operand =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array; hex: boolean }
  | { t: 'arr'; v: Operand[] }
  | { t: 'dict'; v: Map<string, Operand> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' };

export interface Op {
  op: string;
  operands: Operand[];
  start: number; // byte offset of first operand (or operator)
  end: number; // byte offset just after the operator
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export function tokenize(src: Uint8Array): Op[] {
  let i = 0;
  const n = src.length;
  const ops: Op[] = [];
  let pending: Operand[] = [];
  let pendingStart = -1;

  const skipWs = (): void => {
    for (;;) {
      while (i < n && WS.has(src[i]!)) i++;
      if (i < n && src[i] === 0x25) {
        while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i++;
        continue;
      }
      return;
    }
  };

  const readRegular = (): string => {
    const s = i;
    while (i < n && !WS.has(src[i]!) && !DELIM.has(src[i]!)) i++;
    return String.fromCharCode(...src.subarray(s, i));
  };

  const readName = (): string => {
    i++; // '/'
    const raw = readRegular();
    return raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  };

  const readLiteral = (): Uint8Array => {
    i++; // '('
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = src[i++]!;
      if (c === 0x5c) {
        const e = src[i++]!;
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (e in map) out.push(map[e]!);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && i < n && src[i]! >= 0x30 && src[i]! <= 0x37; k++) v = v * 8 + (src[i++]! - 0x30);
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (src[i] === 0x0a) i++;
        } else if (e !== 0x0a) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  };

  const readHex = (): Uint8Array => {
    i++; // '<'
    let hex = '';
    while (i < n && src[i] !== 0x3e) {
      const c = src[i++]!;
      if (!WS.has(c)) hex += String.fromCharCode(c);
    }
    i++; // '>'
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16);
    return out;
  };

  const readObject = (): Operand | { t: 'kw'; v: string } | null => {
    skipWs();
    if (i >= n) return null;
    const c = src[i]!;
    if (c === 0x2f) return { t: 'name', v: readName() };
    if (c === 0x28) return { t: 'str', v: readLiteral(), hex: false };
    if (c === 0x3c) {
      if (src[i + 1] === 0x3c) {
        i += 2;
        const d = new Map<string, Operand>();
        for (;;) {
          skipWs();
          if (src[i] === 0x3e && src[i + 1] === 0x3e) {
            i += 2;
            break;
          }
          const k = readObject();
          const v = readObject();
          if (!k || !v || k.t !== 'name' || v.t === 'kw') break;
          d.set(k.v, v);
        }
        return { t: 'dict', v: d };
      }
      return { t: 'str', v: readHex(), hex: true };
    }
    if (c === 0x5b) {
      i++;
      const arr: Operand[] = [];
      for (;;) {
        skipWs();
        if (src[i] === 0x5d) {
          i++;
          break;
        }
        if (i >= n) break;
        const o = readObject();
        if (!o || o.t === 'kw') break;
        arr.push(o);
      }
      return { t: 'arr', v: arr };
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x29) {
      i++; // stray delimiter, skip
      return readObject();
    }
    const word = readRegular();
    if (word === '') {
      i++;
      return readObject();
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: parseFloat(word) };
    if (word === 'true' || word === 'false') return { t: 'bool', v: word === 'true' };
    if (word === 'null') return { t: 'null' };
    return { t: 'kw', v: word };
  };

  for (;;) {
    skipWs();
    if (i >= n) break;
    const start = i;
    const o = readObject();
    if (!o) break;
    if (pendingStart < 0) pendingStart = start;
    if (o.t !== 'kw') {
      pending.push(o);
      continue;
    }
    if (o.v === 'BI') {
      // inline image: skip to EI preceded by whitespace
      const idx = findEI(src, i);
      i = idx;
      ops.push({ op: 'BI', operands: [], start: pendingStart, end: i });
    } else {
      ops.push({ op: o.v, operands: pending, start: pendingStart, end: i });
    }
    pending = [];
    pendingStart = -1;
  }
  return ops;
}

function findEI(src: Uint8Array, from: number): number {
  for (let k = from; k < src.length - 2; k++) {
    if (src[k] === 0x45 && src[k + 1] === 0x49 && WS.has(src[k - 1]!) && (k + 2 >= src.length || WS.has(src[k + 2]!))) return k + 2;
  }
  return src.length;
}

// ---------- serialisation helpers ----------
export function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function hexStr(bytes: Uint8Array | number[]): string {
  let s = '<';
  for (const b of bytes) s += b.toString(16).padStart(2, '0').toUpperCase();
  return s + '>';
}

export function serializeOperand(o: Operand): string {
  switch (o.t) {
    case 'num':
      return fmtNum(o.v);
    case 'name':
      return '/' + o.v.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    case 'str':
      return hexStr(o.v);
    case 'arr':
      return '[' + o.v.map(serializeOperand).join(' ') + ']';
    case 'dict':
      return '<<' + [...o.v].map(([k, v]) => serializeOperand({ t: 'name', v: k }) + ' ' + serializeOperand(v)).join(' ') + '>>';
    case 'bool':
      return String(o.v);
    case 'null':
      return 'null';
  }
}

export function utf16beHex(text: string): string {
  let s = '<FEFF';
  for (let k = 0; k < text.length; k++) s += text.charCodeAt(k).toString(16).padStart(4, '0').toUpperCase();
  return s + '>';
}
