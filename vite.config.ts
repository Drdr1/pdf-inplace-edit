import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// harfbuzzjs loads harfbuzz.wasm next to its own JS chunk; make sure the
// built output has it there (no CDN, no runtime network beyond same origin).
function harfbuzzWasm(): Plugin {
  return {
    name: 'harfbuzz-wasm',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/harfbuzz.wasm', source: readFileSync(resolve('node_modules/harfbuzzjs/dist/harfbuzz.wasm')) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [harfbuzzWasm()],
  optimizeDeps: { exclude: ['harfbuzzjs'] },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { include: ['tests/unit/**/*.test.ts'], testTimeout: 60000 },
} as never);
