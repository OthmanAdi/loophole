// @ts-check

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const PACKAGE_NAME = '@othmanadi/ableton-mcp';
const PRIVATE_CORE = '@othmanadi/loophole-core';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const pnpmCli = process.env.npm_execpath;
const npmCliCandidates = [
  resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
];
const npmCli = npmCliCandidates.find(existsSync);

if (pnpmCli === undefined) {
  throw new Error('Run this artifact check through pnpm so its CLI path is available.');
}

if (npmCli === undefined) {
  throw new Error('Unable to locate the npm CLI bundled with this Node.js installation.');
}

/** @param {string} command @param {readonly string[]} args @param {string} cwd */
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/** @param {string} tarballPath @param {string} entryName */
function readTarEntry(tarballPath, entryName) {
  const archive = gunzipSync(readFileSync(tarballPath));
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;

    if (!Number.isFinite(size)) {
      throw new Error(`Invalid tar entry size for ${fullName}.`);
    }

    const contentStart = offset + 512;
    if (fullName === entryName) {
      return archive.subarray(contentStart, contentStart + size).toString('utf8');
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  throw new Error(`Missing ${entryName} in ${tarballPath}.`);
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : null;
}

/** @param {string} tarballPath */
function assertArtifactMetadata(tarballPath) {
  const manifest = asRecord(JSON.parse(readTarEntry(tarballPath, 'package/package.json')));
  const dependencies = asRecord(manifest?.dependencies);
  if (dependencies?.[PRIVATE_CORE] !== undefined) {
    throw new Error(`Packed manifest must not depend on ${PRIVATE_CORE}.`);
  }

  const declarations = readTarEntry(tarballPath, 'package/dist/index.d.ts');
  if (declarations.includes(PRIVATE_CORE)) {
    throw new Error(`Packed declarations must not import ${PRIVATE_CORE}.`);
  }
}

/** @param {string} consumerDirectory */
function writeConsumerSmoke(consumerDirectory) {
  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    `import { buildServer } from '${PACKAGE_NAME}';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

if (typeof buildServer !== 'function') {
  throw new Error('Public buildServer import failed.');
}

// This checks registration and the wire protocol only. No tool/resource handler is
// called, so this inert object is intentionally not an Ableton-backed LiveBridge.
const server = buildServer({});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'loophole-packed-artifact-smoke', version: '0.0.0' });

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  if (result.tools.length !== 12) {
    throw new Error(\`Expected 12 tools, received \${String(result.tools.length)}.\`);
  }
} finally {
  await client.close();
  await server.close();
}

process.stdout.write('packed artifact import and tools/list smoke passed\\n');
`,
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'loophole-mcp-artifact-'));

try {
  run(
    process.execPath,
    [pnpmCli, '--filter', PACKAGE_NAME, 'pack', '--pack-destination', temporaryDirectory],
    repositoryRoot,
  );
  const tarballs = readdirSync(temporaryDirectory).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one packed tarball, found ${String(tarballs.length)}.`);
  }

  const tarball = tarballs[0];
  if (tarball === undefined) {
    throw new Error('Packed tarball unexpectedly disappeared.');
  }
  const tarballPath = join(temporaryDirectory, tarball);
  assertArtifactMetadata(tarballPath);

  const consumerDirectory = join(temporaryDirectory, 'consumer');
  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'loophole-packed-artifact-smoke', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeConsumerSmoke(consumerDirectory);
  run(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-save',
      '--no-audit',
      '--fund=false',
      tarballPath,
    ],
    consumerDirectory,
  );
  run(process.execPath, ['smoke.mjs'], consumerDirectory);
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
