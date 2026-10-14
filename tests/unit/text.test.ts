import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/engine/lexer';
import { visualToLogical } from '../../src/engine/text';

describe('lexer', () => {
  it('keeps byte ranges and parses strings, arrays and dicts', () => {
    const src = new TextEncoder().encode('BT /F1 12 Tf [(Hel\\)lo) -250 <0041>] TJ /Span <</ActualText <FEFF0041>>> BDC EMC ET');
    const ops = tokenize(src);
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'TJ', 'BDC', 'EMC', 'ET']);
    const tj = ops[2]!;
    expect(new TextDecoder().decode(src.subarray(tj.start, tj.end))).toBe('[(Hel\\)lo) -250 <0041>] TJ');
  });
});

describe('visualToLogical', () => {
  it('reverses RTL, keeps embedded LTR runs', () => {
    // visual left-to-right of "السعر 250 PDF"
    const visual = ['P', 'D', 'F', ' ', '2', '5', '0', ' ', 'ر', 'ع', 'س', 'ل', 'ا'];
    expect(visualToLogical(visual)).toEqual({ text: 'السعر 250 PDF', dir: 'rtl' });
  });
});
