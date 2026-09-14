/**
 * The two external processes the command surface drives: the `derivon` graph CLI and the
 * sibling bundled tools (crosslink, render, textbook export, id minting). Both are spawned
 * rather than imported so the bundles stay self-contained and the CLI stays the single
 * implementation of `derivon.graph/v1`.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptsRoot = path.dirname(scriptsDirectory);

function toolPath(name) {
  return path.join(scriptsRoot, name);
}

/** Run `derivon` with a graph on stdin. */
export function runDerivon(args, { input } = {}) {
  return spawnSync('derivon', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Run one sibling script with the current Node executable. */
export function runTool(name, args, { input } = {}) {
  return spawnSync(process.execPath, [toolPath(name), ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}
