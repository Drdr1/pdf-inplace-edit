import { readFileSync } from 'node:fs';
import { FontLibrary, Subsetter, BUNDLED_FONTS } from '../src/engine';

export async function nodeDeps(only?: string[]): Promise<{ library: FontLibrary; subsetter: Subsetter }> {
  const library = new FontLibrary();
  for (const f of BUNDLED_FONTS) if (!only || only.includes(f.id)) library.add(f.id, f.family, f.psName, f.bold, new Uint8Array(readFileSync(`fonts/${f.file}`)));
  const subsetter = await Subsetter.create(readFileSync('node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'));
  return { library, subsetter };
}
