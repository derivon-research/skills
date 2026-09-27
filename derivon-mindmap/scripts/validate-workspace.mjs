#!/usr/bin/env node

/**
 * Read-only audit of one workspace manifest. The reference rules live in
 * `lib/workspace-validator.mjs`, shared with the command surface; this file is the CLI over
 * them. Diagnostics always carry a stable code, so `--json` output is consumable as is.
 *
 * Label advisories (`lib/label-review.mjs`) are notes, not errors: they are printed after a clean
 * run, carried in `--json` as `labelReviews`, and never change the exit code. A malformed
 * `.derivon/label-review.json` is an error.
 *
 * Usage: node validate-workspace.mjs [--json] [--manifest <candidate.json>] <workspace>
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CODE, issue } from './lib/envelope.mjs';
import { manifestPathFor } from './lib/fs.mjs';
import { auditWorkspace } from './lib/workspace-validator.mjs';
import { auditLabelReview } from './lib/label-review.mjs';

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
const labels = await auditLabelReview({ root, manifest });
finish([...issues, ...labels.issues], concepts, derivations, labels);

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

function finish(found, concepts, derivations, labels = { labelReviews: [], acknowledged: 0, stale: 0 }) {
  const valid = found.length === 0;
  if (jsonOutput) {
    console.log(JSON.stringify({
      valid,
      workspace: root,
      issues: found,
      labelReviews: labels.labelReviews,
      acknowledgedLabelReviews: labels.acknowledged,
      staleLabelReviews: labels.stale,
    }, null, 2));
  } else if (valid) {
    console.log(`Derivon workspace is valid: ${concepts} concept(s), ${derivations} derivation(s).`);
    if (labels.labelReviews.length) {
      console.log(`Note: ${labels.labelReviews.length} label advisory(ies) to resolve (split, shorten, or acknowledge with review-label):`);
      for (const entry of labels.labelReviews) console.log(`- ${entry.id} "${entry.label}" [${entry.check}]: ${entry.message}`);
    }
    if (labels.acknowledged || labels.stale) {
      console.log(`Note: ${labels.acknowledged} acknowledged label advisory(ies), ${labels.stale} stale acknowledgement(s).`);
    }
  } else {
    console.error(`Derivon workspace has ${found.length} error(s):`);
    for (const entry of found) console.error(`- ${entry.path}: ${entry.message} [${entry.code}]`);
  }
  process.exit(valid ? 0 : 1);
}
