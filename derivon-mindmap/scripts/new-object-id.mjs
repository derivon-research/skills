#!/usr/bin/env node

/**
 * Mint a new object for a workspace the way the Mindmap application does (derivon-mindmap
 * `newObjectIdentity`, README 的「工作区格式」): an id, `c-` or `h-` plus six lowercase characters
 * from an alphabet without `0 1 i l o u` so it survives being read aloud or copied by hand, and
 * the document directory that goes with it, `docs/concept-` or `docs/derivation-` plus the id
 * without its prefix, suffixed `-2`, `-3`… while something already occupies it. Random rather
 * than counted, so a deleted id is never handed out again. Ids need only be unique inside one
 * graph, across concepts and derivations together.
 *
 * Prints one JSON object, `{"id": …, "document": …}`.
 *
 * Usage: node new-object-id.mjs --manifest <workspace.json> --kind concept|derivation
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import path from 'node:path';
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

const objects = [...(manifest?.graph?.points ?? []), ...(manifest?.graph?.hyperedges ?? [])];
const used = new Set(objects.map((object) => object?.id));
const usedDirectories = objects.map((object) => object?.data?.document).filter((value) => typeof value === 'string');
const root = path.dirname(path.dirname(path.resolve(manifestPath)));

const prefix = kind === 'concept' ? 'c' : 'h';
let id;
do {
  id = `${prefix}-${Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
} while (used.has(id));

const occupied = (directory) => existsSync(path.join(root, directory))
  || usedDirectories.some((owned) => owned === directory || owned.startsWith(`${directory}/`) || directory.startsWith(`${owned}/`));
const base = `docs/${kind}-${id.slice(2)}`;
let document = base;
for (let suffix = 2; occupied(document); suffix += 1) document = `${base}-${suffix}`;

process.stdout.write(`${JSON.stringify({ id, document })}\n`);
