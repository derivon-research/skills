#!/usr/bin/env node

/**
 * Mint an object id for a workspace, in the shape the Mindmap application generates:
 * `c-` or `h-` plus six lowercase characters, from an alphabet without `0 1 i l o u` so an
 * id survives being read aloud or copied by hand. Random rather than counted, so a deleted
 * id is never handed out again. Ids need only be unique inside one graph.
 *
 * Usage: node new-object-id.mjs --manifest <workspace.json> --kind concept|derivation
 */
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import process from 'node:process';

const ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 6;

const args = process.argv.slice(2);
const take = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args.splice(index, 2)[1];
};

const manifestPath = take('--manifest');
const kind = take('--kind') ?? 'concept';
if (!manifestPath || !['concept', 'derivation'].includes(kind)) {
  console.error('Usage: node new-object-id.mjs --manifest <workspace.json> --kind concept|derivation');
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read ${manifestPath}: ${error.message}`);
  process.exit(1);
}

const used = new Set([
  ...(manifest?.graph?.points ?? []).map((point) => point?.id),
  ...(manifest?.graph?.hyperedges ?? []).map((edge) => edge?.id),
]);

const prefix = kind === 'concept' ? 'c' : 'h';
for (;;) {
  const id = `${prefix}-${Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
  if (!used.has(id)) {
    process.stdout.write(`${id}\n`);
    break;
  }
}
