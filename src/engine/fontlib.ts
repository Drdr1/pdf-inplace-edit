// Bundled/known full fonts, HarfBuzz shaping, and identification of an
// embedded subset against a full font by comparing glyph outlines. A subset
// usually renumbers glyphs and drops cmap/GSUB, so outline matching is how we
// recover "this embedded font IS Noto Naskh Arabic Regular" and map every
// subset glyph back to the full font's glyph IDs.
import * as hb from 'harfbuzzjs';
import fontkit from '@pdf-lib/fontkit';

type FkFont = ReturnType<typeof fontkit.create>;

export interface ShapedGlyph {
  gid: number;
  cluster: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

export class ShapingFont {
  readonly hbFont: hb.Font;
  readonly face: hb.Face;
  readonly upem: number;
  readonly unicodes: Set<number>;
  readonly hasArabicGsub: boolean;
  private fk: FkFont | undefined;
  private keys: Map<number, string> = new Map();

  constructor(readonly bytes: Uint8Array) {
    this.face = new hb.Face(new hb.Blob(bytes));
    this.hbFont = new hb.Font(this.face);
    this.upem = this.face.upem;
    this.unicodes = new Set(this.face.collectUnicodes());
    let scripts: string[] = [];
    try {
      scripts = this.face.getTableScriptTags('GSUB');
    } catch {
      scripts = [];
    }
    this.hasArabicGsub = scripts.includes('arab');
  }

  get fontkit(): FkFont {
    this.fk ??= fontkit.create(this.bytes);
    return this.fk;
  }

  get numGlyphs(): number {
    return this.fontkit.numGlyphs;
  }

  /** Outline + advance fingerprint; component glyph IDs do not matter. */
  outlineKey(gid: number): string {
    let k = this.keys.get(gid);
    if (k === undefined) {
      const g = this.fontkit.getGlyph(gid);
      const path = (g.path as unknown as { commands: { command: string; args: number[] }[] }).commands.map((c: { command: string; args: number[] }) => c.command[0] + c.args.map((a) => Math.round(a)).join(',')).join('');
      k = path + '|' + g.advanceWidth;
      this.keys.set(gid, k);
    }
    return k;
  }

  private rev: Map<number, number> | undefined;
  /** glyph -> first code point mapped to it by the font's cmap */
  reverseCmap(): Map<number, number> {
    if (!this.rev) {
      this.rev = new Map();
      for (const cp of [...this.unicodes].sort((a, b) => a - b)) {
        const g = this.hbFont.nominalGlyph(cp);
        if (g !== undefined && !this.rev.has(g)) this.rev.set(g, cp);
      }
    }
    return this.rev;
  }

  hasOutline(gid: number): boolean {
    return !this.outlineKey(gid).startsWith('|');
  }

  advance(gid: number): number {
    return this.hbFont.glyphHAdvance(gid);
  }

  shape(text: string, dir: 'ltr' | 'rtl', script?: string, start = 0, length = text.length): ShapedGlyph[] {
    const buf = new hb.Buffer();
    buf.addText(text, start, length);
    buf.setDirection(dir === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
    if (script) buf.setScript(script);
    buf.guessSegmentProperties();
    hb.shape(this.hbFont, buf);
    const infos = buf.getGlyphInfos();
    const pos = buf.getGlyphPositions();
    return infos.map((g, k) => ({
      gid: g.codepoint,
      cluster: g.cluster,
      xAdvance: pos[k]!.xAdvance,
      xOffset: pos[k]!.xOffset,
      yOffset: pos[k]!.yOffset,
    }));
  }
}

export interface LibFont {
  id: string;
  family: string;
  bold: boolean;
  /** PostScript-ish name used for BaseFont of supplementary subsets. */
  psName: string;
  font: ShapingFont;
}

export class FontLibrary {
  readonly fonts: LibFont[] = [];
  private keyIndex = new Map<string, Map<string, number[]>>();

  add(id: string, family: string, psName: string, bold: boolean, bytes: Uint8Array): void {
    this.fonts.push({ id, family, psName, bold, font: new ShapingFont(bytes) });
  }

  private index(lib: LibFont): Map<string, number[]> {
    let idx = this.keyIndex.get(lib.id);
    if (!idx) {
      idx = new Map();
      for (let g = 0; g < lib.font.numGlyphs; g++) {
        const k = lib.font.outlineKey(g);
        const list = idx.get(k);
        if (list) list.push(g);
        else idx.set(k, [g]);
      }
      this.keyIndex.set(lib.id, idx);
    }
    return idx;
  }

  /**
   * Try to recognise an embedded font program as a subset of a library font.
   * Returns full-GID -> embedded-GID for every glyph the subset contains.
   */
  identify(embedded: ShapingFont, nameHint: string): { lib: LibFont; fullToSub: Map<number, number>; score: number } | undefined {
    const hint = nameHint.replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[-_ ]/g, '');
    const candidates = [...this.fonts].sort((a, b) => Number(hint.includes(b.psName.toLowerCase().replace(/[-_ ]/g, ''))) - Number(hint.includes(a.psName.toLowerCase().replace(/[-_ ]/g, ''))));
    let best: { lib: LibFont; fullToSub: Map<number, number>; score: number } | undefined;
    for (const lib of candidates) {
      if (lib.font.upem !== embedded.upem) continue;
      const idx = this.index(lib);
      let outlined = 0;
      let matched = 0;
      const fullToSub = new Map<number, number>();
      for (let g = 0; g < embedded.numGlyphs; g++) {
        const k = embedded.outlineKey(g);
        const isOutlined = !k.startsWith('|');
        if (isOutlined) outlined++;
        const hits = idx.get(k);
        if (hits) {
          if (isOutlined) matched++;
          for (const h of hits) if (!fullToSub.has(h)) fullToSub.set(h, g);
        }
      }
      if (outlined === 0) continue;
      const score = matched / outlined;
      if (score >= 0.9 && (!best || score > best.score)) best = { lib, fullToSub, score };
      if (score === 1) break;
    }
    return best;
  }

  pick(cp: number, bold: boolean, prefer?: (l: LibFont) => boolean): LibFont | undefined {
    const ok = this.fonts.filter((f) => f.font.unicodes.has(cp));
    return ok.find((f) => f.bold === bold && (!prefer || prefer(f))) ?? ok.find((f) => f.bold === bold) ?? ok[0];
  }
}
