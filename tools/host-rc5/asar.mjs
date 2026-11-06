#!/usr/bin/env node
// Read-only reader for the pinned Harness Electron archive (app.asar).
//
// The implementation of the archive format here is limited to what the T1
// evidence task needs: list entries, extract one entry, and hash one entry.
// It never executes archive content and never writes back into the archive.
//
// Usage:
//   node asar.mjs list   [--filter <substring>] [--archive <path>]
//   node asar.mjs stat   <archive-path> [--archive <path>]
//   node asar.mjs extract <archive-path> <out-file> [--archive <path>]
//   node asar.mjs sha256 <archive-path> [--archive <path>]
import {createHash} from 'node:crypto';
import {closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_ARCHIVE = 'E:/dsh/resources/app.asar';

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read);
    if (chunk === 0) throw new Error(`unexpected end of archive at ${position + read}`);
    read += chunk;
  }
  return buffer;
}

export function readArchiveHeader(archive = DEFAULT_ARCHIVE) {
  const fd = openSync(archive, 'r');
  try {
    const sizeBuf = readExact(fd, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) {
      throw new Error(`implausible asar header size ${headerSize}`);
    }
    const headerBuf = readExact(fd, headerSize, 8);
    const payloadSize = headerBuf.readUInt32LE(0);
    const stringSize = headerBuf.readUInt32LE(4);
    if (stringSize + 8 > payloadSize + 4) throw new Error('asar header string exceeds pickle payload');
    const json = headerBuf.subarray(8, 8 + stringSize).toString('utf8');
    const header = JSON.parse(json);
    return {header, dataOffset: 8 + headerSize, headerSize};
  } finally {
    closeSync(fd);
  }
}

function splitPath(entryPath) {
  return entryPath.replace(/^\/+|\/+$/g, '').split('/').filter((part) => part !== '');
}

export function lookupEntry(header, entryPath) {
  let node = {files: header.files ?? {}};
  for (const part of splitPath(entryPath)) {
    if (node?.files === undefined || !(part in node.files)) return null;
    node = node.files[part];
  }
  return node?.files === undefined ? node : null;
}

export function listEntries(header, {filter = '', max = 2000} = {}) {
  const rows = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node?.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`;
      if (entry?.files !== undefined) walk(entry, full);
      else if (rows.length < max) rows.push({path: full, size: entry.size ?? 0, unpacked: entry.unpacked === true, executable: entry.executable === true});
    }
  };
  walk({files: header.files ?? {}}, '');
  return filter === '' ? rows : rows.filter((row) => row.path.includes(filter));
}

export function readEntry(archive, header, dataOffset, entryPath) {
  const entry = lookupEntry(header, entryPath);
  if (entry === null) throw new Error(`entry not found: ${entryPath}`);
  if (entry.unpacked === true) {
    const full = resolve(dirname(archive), 'app.asar.unpacked', ...splitPath(entryPath));
    return readFileSync(full);
  }
  const fd = openSync(archive, 'r');
  try {
    return readExact(fd, entry.size, dataOffset + Number(entry.offset));
  } finally {
    closeSync(fd);
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const positional = [];
  let archive = DEFAULT_ARCHIVE;
  let filter = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--archive') archive = argv[++index];
    else if (arg === '--filter') filter = argv[++index];
    else positional.push(arg);
  }
  return {positional, archive, filter};
}

function main() {
  const {positional, archive, filter} = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (command === 'list') {
    const {header} = readArchiveHeader(archive);
    for (const row of listEntries(header, {filter})) {
      process.stdout.write(`${row.size}\t${row.unpacked ? 'unpacked' : 'packed'}\t${row.path}\n`);
    }
    return;
  }
  if (command === 'stat') {
    const {header} = readArchiveHeader(archive);
    const entry = lookupEntry(header, positional[1]);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    return;
  }
  if (command === 'extract') {
    const {header, dataOffset} = readArchiveHeader(archive);
    const bytes = readEntry(archive, header, dataOffset, positional[1]);
    mkdirSync(dirname(resolve(positional[2])), {recursive: true});
    writeFileSync(positional[2], bytes);
    process.stdout.write(`${bytes.length}\t${sha256(bytes)}\t${positional[2]}\n`);
    return;
  }
  if (command === 'sha256') {
    const {header, dataOffset} = readArchiveHeader(archive);
    const bytes = readEntry(archive, header, dataOffset, positional[1]);
    process.stdout.write(`${sha256(bytes)}\t${bytes.length}\t${positional[1]}\n`);
    return;
  }
  process.stderr.write('usage: asar.mjs list [--filter x] | stat <path> | extract <path> <out> | sha256 <path>\n');
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
