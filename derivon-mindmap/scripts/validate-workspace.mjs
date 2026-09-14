#!/usr/bin/env node

/**
 * Read-only audit of one workspace manifest. The reference rules live in
 * `lib/workspace-validator.mjs`, shared with the command surface; this file is the CLI over
 * them. Diagnostics always carry a stable code, so `--json` output is consumable as is.
 *
 * Usage: node validate-workspace.mjs [--json] [--manifest <candidate.json>] <workspace>
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CODE, issue } from './lib/envelope.mjs';
import { manifestPathFor } from './lib/fs.mjs';
import { auditWorkspace } from './lib/workspace-validator.mjs';

const args = process.argv.slice(2);
const jsonOutput = takeFlag(args, '--json');
const manifestArg = takeValue(args, '--manifest');
if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
  console.log('Usage: node validate-workspace.mjs [--json] [--manifest <candidate.json>] <workspace>');
  process.exit(0);
}
const root = path.resolve(args.shift() ?? '.');
if (args.length) failUsage(`Unexpected argument: ${args[0]}`);
const manifestPath = manifestPathFor(root, manifestArg);

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  finish([issue(CODE.INVALID_JSON, '.derivon/workspace.json', error.message)], 0, 0);
}

const { issues, concepts, derivations } = await auditWorkspace({ root, manifest });
finish(issues, concepts, derivations);

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function takeValue(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value || value.startsWith('--')) failUsage(`Missing value for ${flag}`);
  values.splice(index, 2);
  return value;
}

function failUsage(message) {
  console.error(message);
  process.exit(2);
}

function finish(found, concepts, derivations) {
  const valid = found.length === 0;
  if (jsonOutput) {
    console.log(JSON.stringify({ valid, workspace: root, issues: found }, null, 2));
  } else if (valid) {
    console.log(`Derivon workspace is valid: ${concepts} concept(s), ${derivations} derivation(s).`);
  } else {
    console.error(`Derivon workspace has ${found.length} error(s):`);
    for (const entry of found) console.error(`- ${entry.path}: ${entry.message} [${entry.code}]`);
  }
  process.exit(valid ? 0 : 1);
}
