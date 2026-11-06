#!/usr/bin/env node
// Print regex match contexts inside a text file (analysis helper for pinned
// rc.5 sources). Read-only; used while writing evidence, not at runtime.
// Usage: node context.mjs <file> <regex> [before] [after] [max] [--list]
import {readFileSync} from 'node:fs';

const [file, pattern, beforeArg = '200', afterArg = '300', maxArg = '10'] = process.argv.slice(2);
const before = Number(beforeArg);
const after = Number(afterArg);
const max = Number(maxArg);
const text = readFileSync(file, 'utf8');
const regex = new RegExp(pattern, 'g');
let match;
let count = 0;
while ((match = regex.exec(text)) !== null && count < max) {
  const start = Math.max(0, match.index - before);
  const end = Math.min(text.length, match.index + match[0].length + after);
  process.stdout.write(`\n--- match ${count} at ${match.index} ---\n${text.slice(start, end)}\n`);
  count += 1;
  if (match[0].length === 0) regex.lastIndex += 1;
}
if (count === 0) process.stdout.write('no match\n');
