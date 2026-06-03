/**
 * LOCAL-ONLY esbuild bundler for the Loophole Kit `.ablx` (ARCHITECTURE_DECISIONS §6).
 *
 * This is NOT run in CI and is NOT the committed `package.json` `build` script (that
 * stays a no-op placeholder so the SDK-free CI `pnpm -r build` passes). It is the real
 * bundle the licensee runs locally, with the Ableton Extensions SDK installed from
 * their own `.tgz` (the SDK is bundled INTO the `.ablx`, which the license permits;
 * ARCHITECTURE_DECISIONS §1 right b). It mirrors the official examples' `build.ts`:
 * one entry (`src/extension.ts`), CJS, Node platform, `bundle: true`, and the crucial
 * `.html` text loader so the per-extension webview HTML is inlined as a string (exactly
 * how `examples/modal-dialog/build.ts` inlines its `interface.html`).
 *
 * Run locally (after installing the SDK + CLI `.tgz` per ARCHITECTURE_DECISIONS §4 and
 * the extension README; the committed tree stays SDK-free):
 *   pnpm --filter @othmanadi/loophole-extension run build:live      // dev bundle
 *   pnpm --filter @othmanadi/loophole-extension run package:live    // production + .ablx
 *
 * `build:live` runs `tsc -p tsconfig.live.json --noEmit` (the accuracy proof against the
 * real extracted SDK types) and then this script. `package:live` runs this script with
 * `--production` and then `extensions-cli package` to produce the `.ablx`. None of the
 * resulting manifest/lockfile changes are committed (the tree stays SDK-free).
 */

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

interface Manifest {
  readonly entry: string;
}

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8')) as Manifest;
const production = process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: manifest.entry,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  sourcesContent: false,
  logLevel: 'info',
  minify: production,
  sourcemap: !production,
  // Inline the per-extension webview HTML as strings (the modal-dialog example pattern).
  loader: { '.html': 'text' },
});
