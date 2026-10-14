// Script helpers and visual -> logical reconstruction for extracted lines.

export const isRtlCp = (cp: number): boolean =>
  (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefc);
export const isArabicCp = (cp: number): boolean =>
  (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefc);
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

export type Script = 'arabic' | 'latin' | 'common';
export function scriptOf(cp: number): Script {
  if (isArabicCp(cp)) {
    // Arabic-Indic digits and punctuation behave as common for font choice
    if ((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9) || cp === 0x060c || cp === 0x061b || cp === 0x061f) return 'common';
    return 'arabic';
  }
  const ch = String.fromCodePoint(cp);
  if (LETTER.test(ch)) return 'latin';
  return 'common';
}

type Dir = 'rtl' | 'ltr' | 'num' | 'neutral';
function classOf(text: string): Dir {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isRtlCp(cp) && LETTER.test(ch)) return 'rtl';
    if (LETTER.test(ch)) return 'ltr';
    if (DIGIT.test(ch)) return 'num';
  }
  return 'neutral';
}

export function baseDirection(text: string): 'rtl' | 'ltr' {
  let r = 0;
  let l = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    if (isRtlCp(ch.codePointAt(0)!)) r++;
    else l++;
  }
  return r > l ? 'rtl' : 'ltr';
}

/**
 * Rebuild logical order from clusters listed in visual (left-to-right) order.
 * Each cluster's own text is already logical (ActualText / ToUnicode).
 */
export function visualToLogical(clusters: string[]): { text: string; dir: 'rtl' | 'ltr' } {
  const dir = baseDirection(clusters.join(''));
  const cls = clusters.map(classOf);
  const order = clusters.map((_, k) => k);
  // Reverse maximal runs of the "other" direction. Inside an RTL line, letters
  // and numbers form separate LTR runs when only neutrals separate them
  // (UAX#9 N1 treats numbers as R there); adjacent ones ("A4") stay together.
  const reverseRuns = (seq: number[], isOther: (c: Dir) => boolean, sameKind: boolean): number[] => {
    const out = [...seq];
    let k = 0;
    while (k < out.length) {
      const c0 = cls[out[k]!]!;
      if (!isOther(c0)) {
        k++;
        continue;
      }
      let e = k;
      let lastStrong = c0;
      for (let j = k + 1; j < out.length; j++) {
        const c = cls[out[j]!]!;
        if (c === 'neutral') continue;
        if (!isOther(c)) break;
        const adjacent = j === e + 1;
        if (sameKind && !adjacent && c !== lastStrong) break;
        e = j;
        lastStrong = c;
      }
      const seg = out.slice(k, e + 1).reverse();
      out.splice(k, e - k + 1, ...seg);
      k = e + 1;
    }
    return out;
  };
  let seq: number[];
  if (dir === 'rtl') seq = reverseRuns(order.reverse(), (c) => c === 'ltr' || c === 'num', true);
  else seq = reverseRuns(order, (c) => c === 'rtl', false);
  return { text: seq.map((k) => clusters[k]).join(''), dir };
}
