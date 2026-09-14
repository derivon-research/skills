/**
 * The content basis of a learner record: the one value a judgement carries to answer *does
 * this still count?* It is fixed by `derivon-mindmap`'s learner-records specification, and the
 * application computes it with a second implementation in TypeScript. **The two must produce
 * the same hash or every record this surface writes reads as stale in the application**, so
 * the stream, the domains, the canonical encoding and the file inventory are mirrored here
 * rather than approximated.
 *
 * Two coverages live here and they are deliberately different:
 *
 * - `routeBasis` covers the manifest entries of every concept and derivation a route names,
 *   and nothing else, so an unrelated graph edit never invalidates a route;
 * - `masteryBasis` covers one object's manifest entry plus every file under its document
 *   directory, so a document or asset edit retires the judgement whose object owns it.
 *
 * A basis this host cannot compute refuses instead of hashing a partial one: two writers must
 * never disagree about what a basis covers, and a record written against a hash nobody can
 * reproduce is worse than no record.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CODE } from './envelope.mjs';
import { insideRealRoot } from './fs.mjs';
import { safeRelativeDirectory } from './workspace-validator.mjs';

const ENTRY_DOMAIN = Buffer.from('entry', 'utf8');
const FILE_DOMAIN = Buffer.from('file', 'utf8');

/** One refusal the caller turns into a diagnostic: a code, the path it concerns, and why. */
export class BasisError extends Error {
  constructor(code, subject, message) {
    super(message);
    this.code = code;
    this.subject = subject;
  }
}

function digest(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Ascending code-unit order: what the basis stream is defined over, and the order the
 * application takes both its records and its file inventory in. */
function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * JSON with object keys in ascending code-unit order, no insignificant whitespace, arrays in
 * their recorded order and numbers in ECMAScript's shortest round-tripping form. This is the
 * application's `canonicalJson` written twice on purpose: the manifest's *values* are what a
 * basis covers, so indentation, key order and a `2.0` written as `2` must all keep a judgement
 * alive.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareNames(left, right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** The one stream both coverages share: name length, name bytes and digest per record. */
function basisStream(records) {
  const sorted = [...records].sort((left, right) => compareNames(left.name, right.name));
  const parts = [];
  for (const record of sorted) {
    const name = Buffer.from(record.name, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(name.length));
    parts.push(length, name, record.digest);
  }
  return digest(Buffer.concat(parts)).toString('hex');
}

function entryOf(manifest, id) {
  const points = Array.isArray(manifest?.graph?.points) ? manifest.graph.points : [];
  const hyperedges = Array.isArray(manifest?.graph?.hyperedges) ? manifest.graph.hyperedges : [];
  return [...points, ...hyperedges].find((object) => object?.id === id) ?? null;
}

/**
 * A manifest entry contributes one record named `.derivon/workspace.json#<id>` — a name no
 * document file can claim, because an object's document directory is never under `.derivon/`.
 * An object the graph no longer has contributes nothing, which is exactly what makes a record
 * whose object was deleted stale.
 */
function entryRecord(manifest, id) {
  const entry = entryOf(manifest, id);
  if (entry === null) return null;
  return {
    name: `.derivon/workspace.json#${id}`,
    digest: digest(ENTRY_DOMAIN, Buffer.from(canonicalJson(entry), 'utf8')),
  };
}

/**
 * Every file under one object's document directory, recursively, as workspace-relative paths.
 * The walk mirrors the application's own inventory: it resolves the directory's real path and
 * stays inside the workspace, refuses a symlink rather than following it, and treats a
 * directory that is already gone as owning zero files rather than as a failure.
 *
 * Paths are measured against the **real** workspace root, as the application measures them. A
 * workspace opened through a symlinked path (`/tmp` on macOS resolves to `/private/tmp`) would
 * otherwise name every file with a `../` prefix and hash a basis nobody else can reproduce.
 */
async function ownedFilePaths(realRoot, directory) {
  if (!safeRelativeDirectory(directory)) {
    throw new BasisError(CODE.DOCUMENT_UNSAFE, directory, 'not a safe workspace-relative document directory');
  }
  let realDirectory;
  try {
    realDirectory = await realpath(path.join(realRoot, directory));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new BasisError(CODE.IO_ERROR, directory, error.message);
  }
  if (realDirectory === realRoot || !insideRealRoot(realRoot, realDirectory)) {
    throw new BasisError(CODE.DOCUMENT_UNSAFE, directory, 'document directory resolves outside the workspace');
  }
  if (!(await stat(realDirectory)).isDirectory()) {
    throw new BasisError(CODE.DOCUMENT_UNSAFE, directory, 'document directory is not a directory');
  }
  const files = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new BasisError(CODE.BASIS_UNCOMPUTABLE, path.relative(realRoot, absolute), 'symbolic link in a document directory');
      }
      if (info.isDirectory()) { await walk(absolute); continue; }
      if (info.isFile()) files.push(path.relative(realRoot, absolute).split(path.sep).join('/'));
    }
  };
  await walk(realDirectory);
  return files;
}

/**
 * The basis of a judgement about `objectId`: its manifest entry plus every file under its
 * document directory, recursively. An unknown object refuses — there is no entry to judge
 * against — and so does a file that cannot be read.
 */
export async function masteryBasis({ realRoot, manifest, objectId }) {
  const entry = entryOf(manifest, objectId);
  if (entry === null) {
    throw new BasisError(CODE.UNKNOWN_OBJECT, objectId, `no object ${objectId} in the manifest to take a basis of`);
  }
  const records = [entryRecord(manifest, objectId)];
  const directory = entry.data?.document;
  if (directory === undefined) {
    throw new BasisError(CODE.DOCUMENT_UNSAFE, objectId, `object ${objectId} has no document directory`);
  }
  for (const relative of await ownedFilePaths(realRoot, directory)) {
    let bytes;
    try {
      bytes = await readFile(path.join(realRoot, relative));
    } catch (error) {
      /* The specification defines a digest for a file that cannot be read; the application's own
       * basis acquisition refuses instead, because a hash nobody can recompute leaves the
       * judgement permanently unconfirmed. Refusing is the choice that keeps the two writers in
       * agreement, so it is mirrored here rather than "fixed" into a hash of our own. */
      throw new BasisError(CODE.BASIS_UNCOMPUTABLE, relative, `cannot read ${relative}: ${error.message}`);
    }
    records.push({ name: relative, digest: digest(FILE_DOMAIN, bytes) });
  }
  return basisStream(records);
}

/**
 * The basis of a route: the manifest entry of each object it references, and nothing else.
 * An object the manifest no longer has contributes nothing, exactly as it does in the
 * application's `routeBasis`: a route confirmed before an object was deleted is still readable
 * and re-writable, and its basis covers the entries that remain. Refusing instead would make
 * the script unable to recompute a basis the application recomputes, which is the one thing the
 * two writers may never disagree about.
 */
export function routeBasis({ manifest, objectIds }) {
  const records = [];
  for (const id of [...new Set(objectIds)]) {
    const record = entryRecord(manifest, id);
    if (record) records.push(record);
  }
  return basisStream(records);
}
