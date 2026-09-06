#!/usr/bin/env node

import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const jsonOutput = takeFlag(args, '--json');
const manifestArg = takeValue(args, '--manifest');
if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
  console.log('Usage: node validate-workspace.mjs [--json] [--manifest <candidate.json>] <workspace>');
  process.exit(0);
}
const root = path.resolve(args.shift() ?? '.');
if (args.length) failUsage(`Unexpected argument: ${args[0]}`);
const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(root, '.derivon', 'workspace.json');
const realRoot = await realpath(root);
const issues = [];
let points = [];
let hyperedges = [];
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  finish([{ path: '.derivon/workspace.json', message: error.message }]);
}

// `derivon.workspace/v1` is the only workspace protocol. It has no released predecessor,
// so a schema string this validator does not know is a broken workspace rather than an old
// one, and `view` is a field v1 does not have.
checkObject(manifest, '', ['schema', 'document', 'graph', 'tags'], ['schema', 'document', 'graph']);
if (manifest.schema !== 'derivon.workspace/v1') issue('/schema', 'expected derivon.workspace/v1');
checkObject(manifest.document, '/document', ['title', 'description']);
if (typeof manifest.document?.title !== 'string') issue('/document/title', 'expected string');
if (typeof manifest.document?.description !== 'string') issue('/document/description', 'expected string');
checkObject(manifest.graph, '/graph', ['points', 'hyperedges']);
points = Array.isArray(manifest.graph?.points) ? manifest.graph.points : [];
hyperedges = Array.isArray(manifest.graph?.hyperedges) ? manifest.graph.hyperedges : [];
if (!Array.isArray(manifest.graph?.points)) issue('/graph/points', 'expected array');
if (!Array.isArray(manifest.graph?.hyperedges)) issue('/graph/hyperedges', 'expected array');
checkTags(manifest.tags);

const cli = spawnSync('derivon', ['validate'], {
  input: JSON.stringify({ points, hyperedges }),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (cli.error?.code === 'ENOENT') issue('/graph', 'derivon CLI is not installed or not on PATH');
else if (cli.status !== 0) issue('/graph', `derivon validate failed: ${(cli.stderr || cli.stdout).trim()}`);

const pointIds = new Set();
const allIds = new Set();
const owners = new Map();
for (const [index, point] of points.entries()) {
  const location = `/graph/points/${index}`;
  checkObject(point, location, ['id', 'data']);
  checkId(point?.id, `${location}/id`, allIds);
  if (typeof point?.id === 'string') pointIds.add(point.id);
  await checkDocument(point, 'concept', location);
}
for (const [index, edge] of hyperedges.entries()) {
  const location = `/graph/hyperedges/${index}`;
  checkObject(edge, location, ['id', 'weight', 'tails', 'head', 'data']);
  checkId(edge?.id, `${location}/id`, allIds);
  await checkDocument(edge, 'derivation', location);
}

finish(issues);

/**
 * Workspace-level tag declarations. They carry no colour: mapping a tag to a colour is a
 * rendering decision, and putting it on disk would move that decision off the renderer.
 */
function checkTags(tags) {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) {
    issue('/tags', 'expected array');
    return;
  }
  const declared = new Set();
  for (const [index, tag] of tags.entries()) {
    const location = `/tags/${index}`;
    checkObject(tag, location, ['id', 'label', 'description'], ['id', 'label']);
    if (typeof tag?.id !== 'string' || !tag.id.trim()) issue(`${location}/id`, 'expected non-empty string');
    else if (declared.has(tag.id)) issue(`${location}/id`, `duplicate tag ID ${tag.id}`);
    else declared.add(tag.id);
    if (typeof tag?.label !== 'string' || !tag.label.trim()) issue(`${location}/label`, 'expected non-empty string');
    if (tag?.description !== undefined && typeof tag.description !== 'string') {
      issue(`${location}/description`, 'expected string');
    }
  }
}

/** Tags belong to concepts only; a derivation has none. */
function checkConceptTags(tags, location) {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) {
    issue(location, 'expected array of tag IDs');
    return;
  }
  const seen = new Set();
  for (const [index, tag] of tags.entries()) {
    if (typeof tag !== 'string' || !tag.trim()) issue(`${location}/${index}`, 'expected non-empty string');
    else if (seen.has(tag)) issue(`${location}/${index}`, `duplicate tag ${tag}`);
    else seen.add(tag);
  }
}

async function checkDocument(object, kind, location) {
  const data = object?.data;
  const required = kind === 'concept' ? ['label', 'document', 'format'] : ['document', 'format'];
  const fields = kind === 'concept' ? [...required, 'tags'] : required;
  checkObject(data, `${location}/data`, fields, required);
  if (kind === 'concept') checkConceptTags(data?.tags, `${location}/data/tags`);
  if (kind === 'concept' && typeof data?.label !== 'string') issue(`${location}/data/label`, 'expected string');
  if (!['markdown', 'html'].includes(data?.format)) issue(`${location}/data/format`, 'expected markdown or html');
  if (!safeRelativeDirectory(data?.document)) {
    issue(`${location}/data/document`, 'expected a safe workspace-relative directory');
    return;
  }
  if (owners.has(data.document)) issue(`${location}/data/document`, `also owned by ${owners.get(data.document)}`);
  else owners.set(data.document, object.id);
  try {
    const realDirectory = await realpath(path.join(root, data.document));
    if (realDirectory === realRoot || !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
      issue(`${location}/data/document`, 'document directory resolves outside the workspace');
      return;
    }
    await checkSymbolicLinks(realDirectory, location);
  } catch {
    issue(`${location}/data/document`, `missing directory ${data.document}`);
    return;
  }
  await requireFile(`${data.document}/index.html`, location);
  if (data.format === 'markdown') await requireFile(`${data.document}/document.md`, location);
}

async function checkSymbolicLinks(directory, location) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    const info = await lstat(current);
    if (info.isSymbolicLink()) issue(location, `symbolic link is not allowed in document directory: ${path.relative(root, current)}`);
    else if (info.isDirectory()) await checkSymbolicLinks(current, location);
  }
}

async function requireFile(relative, location) {
  try {
    await access(path.join(root, relative));
  } catch {
    issue(location, `missing file ${relative}`);
  }
}

function checkObject(value, location, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issue(location || '/', 'expected object');
    return;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(`${location}/${escapePointer(key)}`, 'unknown field');
  for (const key of required) if (!(key in value)) issue(`${location}/${escapePointer(key)}`, 'missing field');
}

function checkId(id, location, all) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) issue(location, 'invalid object ID');
  else if (all.has(id)) issue(location, `duplicate object ID ${id}`);
  else all.add(id);
}

function safeRelativeDirectory(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || /\.(md|html)$/i.test(value)) return false;
  const parts = value.split('/');
  return parts.length >= 2 && parts[0] !== '.derivon' && parts.every((part) => part && part !== '.' && part !== '..');
}

function issue(location, message) { issues.push({ path: location || '/', message }); }
function escapePointer(value) { return value.replaceAll('~', '~0').replaceAll('/', '~1'); }
function takeFlag(values, flag) { const i = values.indexOf(flag); if (i < 0) return false; values.splice(i, 1); return true; }
function takeValue(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value || value.startsWith('--')) failUsage(`Missing value for ${flag}`);
  values.splice(index, 2);
  return value;
}
function failUsage(message) { console.error(message); process.exit(2); }
function finish(found) {
  const result = { valid: found.length === 0, workspace: root, issues: found };
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else if (result.valid) console.log(`Derivon workspace is valid: ${points?.length ?? 0} concept(s), ${hyperedges?.length ?? 0} derivation(s).`);
  else {
    console.error(`Derivon workspace has ${found.length} error(s):`);
    for (const entry of found) console.error(`- ${entry.path}: ${entry.message}`);
  }
  process.exit(result.valid ? 0 : 1);
}
