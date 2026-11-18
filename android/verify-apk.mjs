#!/usr/bin/env node
// Reproducible native packaging check: no dependencies, no writes, no Android device required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const [input, ...extra] = process.argv.slice(2);
const fontsOnly = input === '--fonts-only';
assert(extra.length === 0 && (!input || fontsOnly || input.endsWith('.apk')),
  'Usage: node android/verify-apk.mjs [--fonts-only | path/to/app.apk]');
const apkPath = input && !fontsOnly ? path.resolve(input) : path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? files(path.join(dir, entry.name), relative + '/') : [relative];
  }).sort();
}
const names = files(dist);
const legacy = (name) => /^static\/media\/[^/]+\.(ttf|woff)$/.test(name);
const excluded = names.filter(legacy);
const expected = names.filter((name) => !legacy(name));
let fontFaces = 0;
for (const css of names.filter((name) => name.endsWith('.css'))) {
  const text = readFileSync(path.join(dist, css), 'utf8');
  for (const match of text.matchAll(/@font-face\s*\{([^}]+)\}/gs)) {
    fontFaces++;
    const first = /src\s*:\s*url\(["']?([^)'"\s]+)/.exec(match[1]);
    assert(first && /\.woff2([?#].*)?$/.test(first[1]), `${css}: first font source must be WOFF2`);
    const url = new URL(first[1], `https://appassets.androidplatform.net/assets/${css}`);
    assert(url.origin === 'https://appassets.androidplatform.net' && url.pathname.startsWith('/assets/'), `${css}: font escapes native assets path`);
    const asset = decodeURIComponent(url.pathname.slice('/assets/'.length));
    assert(expected.includes(asset), `${css}: missing WOFF2 font ${asset}`);
  }
}
assert(expected.includes('index.html'), 'Missing frontend index.html');
const stats = {
  fontFaces,
  woff2Files: expected.filter((name) => name.endsWith('.woff2')).length,
  excludedLegacyFontFiles: excluded.length,
  excludedUncompressedBytes: excluded.reduce((sum, name) => sum + readFileSync(path.join(dist, name)).length, 0),
};
if (!fontsOnly) {
  const apk = readFileSync(apkPath);
  let eocd = -1;
  for (let pos = apk.length - 22; pos >= Math.max(0, apk.length - 65557); pos--) {
    if (apk.readUInt32LE(pos) === 0x06054b50 && pos + 22 + apk.readUInt16LE(pos + 20) === apk.length) { eocd = pos; break; }
  }
  assert(eocd >= 0, 'APK ZIP end record is missing');
  const count = apk.readUInt16LE(eocd + 10);
  assert(count !== 0xffff, 'ZIP64 APK is not supported by this small checker');
  let pos = apk.readUInt32LE(eocd + 16);
  const assets = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(apk.readUInt32LE(pos), 0x02014b50, 'Invalid ZIP central entry');
    const method = apk.readUInt16LE(pos + 10);
    const packedSize = apk.readUInt32LE(pos + 20);
    const size = apk.readUInt32LE(pos + 24);
    const nameLength = apk.readUInt16LE(pos + 28);
    const name = apk.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    if (name.startsWith('assets/') && !name.endsWith('/')) {
      const local = apk.readUInt32LE(pos + 42);
      assert.equal(apk.readUInt32LE(local), 0x04034b50, 'Invalid ZIP local entry');
      const start = local + 30 + apk.readUInt16LE(local + 26) + apk.readUInt16LE(local + 28);
      const packed = apk.subarray(start, start + packedSize);
      assert(method === 0 || method === 8, 'Unsupported ZIP compression');
      const bytes = method === 8 ? inflateRawSync(packed) : packed;
      assert.equal(bytes.length, size, 'ZIP uncompressed length mismatch');
      assets.set(name.slice(7), bytes);
    }
    pos += 46 + nameLength + apk.readUInt16LE(pos + 30) + apk.readUInt16LE(pos + 32);
  }
  assert.deepEqual([...assets.keys()].sort(), expected, 'APK assets must exactly equal dist minus legacy fonts');
  for (const name of expected) {
    assert(assets.get(name).equals(readFileSync(path.join(dist, name))), `APK asset differs: ${name}`);
  }
  Object.assign(stats, {
    verifiedApkAssets: assets.size,
    uncompressedAssetBytes: [...assets.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    apkBytes: apk.length,
    apkSha256: createHash('sha256').update(apk).digest('hex'),
  });
}
console.log(JSON.stringify(stats, null, 2));
