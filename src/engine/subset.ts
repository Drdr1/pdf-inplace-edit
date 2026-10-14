// Thin wrapper over HarfBuzz's hb-subset (WASM) used to embed only the glyphs
// an edit needs. We retain glyph IDs so CIDToGIDMap can point straight at the
// full font's glyph numbers, which keeps the bookkeeping simple and exact.

interface SubsetExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_data(b: number, lenPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_glyph_set(i: number): number;
  hb_subset_input_set_flags(i: number, flags: number): void;
  hb_set_add(s: number, v: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x2;

export class Subsetter {
  private constructor(private readonly x: SubsetExports) {}

  static async create(wasm: ArrayBuffer | Uint8Array): Promise<Subsetter> {
    const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    const module = await WebAssembly.compile(bytes as BufferSource);
    const instance = await WebAssembly.instantiate(module, {});
    return new Subsetter(instance.exports as unknown as SubsetExports);
  }

  /** Subset `font` to `gids` (+ .notdef), keeping original glyph IDs. */
  subset(font: Uint8Array, gids: Iterable<number>): Uint8Array {
    const x = this.x;
    const ptr = x.malloc(font.length);
    new Uint8Array(x.memory.buffer, ptr, font.length).set(font);
    const blob = x.hb_blob_create(ptr, font.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
    const face = x.hb_face_create(blob, 0);
    const input = x.hb_subset_input_create_or_fail();
    if (!input) throw new Error('hb_subset_input_create_or_fail failed');
    const set = x.hb_subset_input_glyph_set(input);
    x.hb_set_add(set, 0);
    for (const g of gids) x.hb_set_add(set, g);
    x.hb_subset_input_set_flags(input, HB_SUBSET_FLAGS_RETAIN_GIDS);
    const out = x.hb_subset_or_fail(face, input);
    if (!out) throw new Error('hb_subset_or_fail failed');
    const outBlob = x.hb_face_reference_blob(out);
    const lenPtr = x.malloc(4);
    const dataPtr = x.hb_blob_get_data(outBlob, lenPtr);
    const len = new Uint32Array(x.memory.buffer, lenPtr, 1)[0]!;
    const result = new Uint8Array(x.memory.buffer, dataPtr, len).slice();
    x.free(lenPtr);
    x.hb_blob_destroy(outBlob);
    x.hb_face_destroy(out);
    x.hb_subset_input_destroy(input);
    x.hb_face_destroy(face);
    x.hb_blob_destroy(blob);
    x.free(ptr);
    return result;
  }
}
