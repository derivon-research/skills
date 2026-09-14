/**
 * The workspace reference rules, importable so the command surface and the standalone
 * `validate-workspace.mjs` share one implementation. The graph protocol itself stays the
 * `derivon` CLI's: this module shells out to `derivon validate` rather than reimplementing it.
 *
 * Every issue carries a stable code (`lib/envelope.mjs`) plus a JSON-pointer or
 * workspace-relative `path` and a human message. An unknown workspace schema is a broken
 * workspace, not an input dialect.
 */

import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CODE, issue } from './envelope.mjs';
import { insideRealRoot } from './fs.mjs';

/** Point and hyperedge ids share one case-sensitive namespace. */
export const OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const WORKSPACE_ID_MAX_LENGTH = 64;
const WORKSPACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESERVED_WORKSPACE_IDS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Is this workspace id a name a directory can take? It becomes one under the application data
 * directory, so this is the same rule the manifest validator enforces, exported once for the
 * learner-record path instead of being written a second time there.
 */
export function isUsableWorkspaceId(id) {
  return typeof id === 'string'
    && id.length <= WORKSPACE_ID_MAX_LENGTH
    && WORKSPACE_ID_PATTERN.test(id)
    && !RESERVED_WORKSPACE_IDS.has(id);
}

/**
 * Audit one in-memory manifest against a workspace root. Returns coded issues and the object
 * counts. The root must be an absolute path that exists.
 */
export async function auditWorkspace({ root, manifest }) {
  const issues = [];
  const realRoot = await realpath(root);
  const points = [];
  const hyperedges = [];

  const add = (pointer, message, code) => issues.push(issue(code, pointer, message));

  checkObject(manifest, '', ['schema', 'id', 'document', 'graph', 'tags'], ['schema', 'id', 'document', 'graph'], add);
  if (manifest?.schema !== 'derivon.workspace/v1') add('/schema', 'expected derivon.workspace/v1', CODE.SCHEMA_UNKNOWN);
  checkWorkspaceId(manifest?.id, add);
  checkObject(manifest?.document, '/document', ['title', 'description'], undefined, add);
  if (typeof manifest?.document?.title !== 'string') add('/document/title', 'expected string', CODE.SCHEMA_INVALID);
  if (typeof manifest?.document?.description !== 'string') add('/document/description', 'expected string', CODE.SCHEMA_INVALID);
  checkObject(manifest?.graph, '/graph', ['points', 'hyperedges'], undefined, add);
  if (Array.isArray(manifest?.graph?.points)) points.push(...manifest.graph.points);
  else add('/graph/points', 'expected array', CODE.SCHEMA_INVALID);
  if (Array.isArray(manifest?.graph?.hyperedges)) hyperedges.push(...manifest.graph.hyperedges);
  else add('/graph/hyperedges', 'expected array', CODE.SCHEMA_INVALID);
  checkTags(manifest?.tags, add);

  const cli = spawnSync('derivon', ['validate'], {
    input: JSON.stringify({ points, hyperedges }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (cli.error?.code === 'ENOENT') add('/graph', 'derivon CLI is not installed or not on PATH', CODE.EXTERNAL_TOOL);
  else if (cli.status !== 0) add('/graph', `derivon validate failed: ${(cli.stderr || cli.stdout).trim()}`, CODE.GRAPH_INVALID);

  const pointIds = new Set();
  const allIds = new Set();
  const owners = new Map();
  for (const [index, point] of points.entries()) {
    const location = `/graph/points/${index}`;
    checkObject(point, location, ['id', 'data'], undefined, add);
    checkId(point?.id, `${location}/id`, allIds, add);
    if (typeof point?.id === 'string') pointIds.add(point.id);
    await checkDocument(root, realRoot, point, 'concept', location, owners, add);
  }
  for (const [index, edge] of hyperedges.entries()) {
    const location = `/graph/hyperedges/${index}`;
    checkObject(edge, location, ['id', 'weight', 'tails', 'head', 'data'], undefined, add);
    checkId(edge?.id, `${location}/id`, allIds, add);
    await checkDocument(root, realRoot, edge, 'derivation', location, owners, add);
  }

  return { issues, concepts: points.length, derivations: hyperedges.length };
}

function checkWorkspaceId(id, add) {
  if (id === undefined) return;
  if (typeof id !== 'string') {
    add('/id', 'expected string', CODE.SCHEMA_INVALID);
    return;
  }
  if (id.length > WORKSPACE_ID_MAX_LENGTH || !WORKSPACE_ID_PATTERN.test(id)) {
    add('/id', 'expected lowercase ASCII letters, digits and hyphens, starting and ending with a letter or digit, at most 64 characters', CODE.INVALID_ID);
    return;
  }
  if (RESERVED_WORKSPACE_IDS.has(id)) add('/id', `expected a directory name Windows accepts; ${id} is a reserved device name`, CODE.INVALID_ID);
}

function checkTags(tags, add) {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) {
    add('/tags', 'expected array', CODE.SCHEMA_INVALID);
    return;
  }
  const declared = new Set();
  for (const [index, tag] of tags.entries()) {
    const location = `/tags/${index}`;
    checkObject(tag, location, ['id', 'label'], undefined, add);
    if (typeof tag?.id !== 'string' || !tag.id.trim()) add(`${location}/id`, 'expected non-empty string', CODE.SCHEMA_INVALID);
    else if (declared.has(tag.id)) add(`${location}/id`, `duplicate tag ID ${tag.id}`, CODE.DUPLICATE_TAG);
    else declared.add(tag.id);
    if (typeof tag?.label !== 'string' || !tag.label.trim()) add(`${location}/label`, 'expected non-empty string', CODE.SCHEMA_INVALID);
  }
}

function checkConceptTags(tags, location, add) {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) {
    add(location, 'expected array of tag IDs', CODE.SCHEMA_INVALID);
    return;
  }
  const seen = new Set();
  for (const [index, tag] of tags.entries()) {
    if (typeof tag !== 'string' || !tag.trim()) add(`${location}/${index}`, 'expected non-empty string', CODE.SCHEMA_INVALID);
    else if (seen.has(tag)) add(`${location}/${index}`, `duplicate tag ${tag}`, CODE.SCHEMA_INVALID);
    else seen.add(tag);
  }
}

async function checkDocument(root, realRoot, object, kind, location, owners, add) {
  const data = object?.data;
  const required = kind === 'concept' ? ['label', 'document'] : ['document'];
  const fields = kind === 'concept' ? [...required, 'description', 'tags'] : [...required, 'label', 'description'];
  checkObject(data, `${location}/data`, fields, required, add);
  if (kind === 'concept') checkConceptTags(data?.tags, `${location}/data/tags`, add);
  if (typeof data?.label !== 'string' && (kind === 'concept' || data?.label !== undefined)) {
    add(`${location}/data/label`, 'expected string', CODE.SCHEMA_INVALID);
  }
  if (data?.description !== undefined && typeof data.description !== 'string') {
    add(`${location}/data/description`, 'expected string', CODE.SCHEMA_INVALID);
  }
  if (!safeRelativeDirectory(data?.document)) {
    add(`${location}/data/document`, 'expected a safe workspace-relative directory', CODE.DOCUMENT_UNSAFE);
    return;
  }
  if (owners.has(data.document)) add(`${location}/data/document`, `also owned by ${owners.get(data.document)}`, CODE.DUPLICATE_DOCUMENT);
  else owners.set(data.document, object.id);
  let realDirectory;
  try {
    realDirectory = await realpath(path.join(root, data.document));
  } catch {
    add(`${location}/data/document`, `missing directory ${data.document}`, CODE.DOCUMENT_MISSING);
    return;
  }
  if (!insideRealRoot(realRoot, realDirectory)) {
    add(`${location}/data/document`, 'document directory resolves outside the workspace', CODE.DOCUMENT_UNSAFE);
    return;
  }
  await checkSymbolicLinks(realRoot, realDirectory, location, root, add);
  await requireFile(root, `${data.document}/document.md`, location, add);
}

async function checkSymbolicLinks(realRoot, directory, location, root, add) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    const info = await lstat(current);
    if (info.isSymbolicLink()) add(location, `symbolic link is not allowed in document directory: ${path.relative(root, current)}`, CODE.DOCUMENT_UNSAFE);
    else if (info.isDirectory()) await checkSymbolicLinks(realRoot, current, location, root, add);
  }
}

async function requireFile(root, relative, location, add) {
  try {
    await access(path.join(root, relative));
  } catch {
    add(location, `missing file ${relative}`, CODE.DOCUMENT_MISSING);
  }
}

function checkObject(value, location, allowed, required, add) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add(location || '/', 'expected object', CODE.SCHEMA_INVALID);
    return;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${location}/${escapeJsonPointer(key)}`, 'unknown field', CODE.SCHEMA_INVALID);
  for (const key of (required ?? allowed)) if (!(key in value)) add(`${location}/${escapeJsonPointer(key)}`, 'missing field', CODE.SCHEMA_INVALID);
}

function checkId(id, location, all, add) {
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) add(location, 'invalid object ID', CODE.INVALID_ID);
  else if (all.has(id)) add(location, `duplicate object ID ${id}`, CODE.DUPLICATE_ID);
  else all.add(id);
}

export function safeRelativeDirectory(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || /\.(md|html)$/i.test(value)) return false;
  const parts = value.split('/');
  return parts.length >= 2 && parts[0] !== '.derivon' && parts.every((part) => part && part !== '.' && part !== '..');
}

/** A JSON pointer segment for a key that may contain `/` or `~`. Shared with the learner-record
 * validator, so a key is reported the same way wherever it appears. */
export function escapeJsonPointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
