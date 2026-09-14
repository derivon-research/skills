/**
 * Filesystem discipline for the command surface: hashing a manifest for compare-and-swap,
 * atomic replacement through a temporary sibling, and containment checks that walk the real
 * path instead of comparing string prefixes.
 *
 * A prefix comparison is what lets `/mnt/finance/data-archived` pass an allowance of
 * `/mnt/finance/data`; `path.relative` after `realpath` cannot be fooled that way, and it
 * also resolves `..` and symbolic links before the decision.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/* A leftover temporary is attributable to its target, and a crash cannot hand a later process
 * the same name: the token mixes the process id, a start time and randomness. It carries the
 * same marker the application's own replacement uses, so one artifact has one discipline. */
const TEMPORARY_MARKER = '.derivon-part-';
const TEMPORARY_TOKEN = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let temporaryCounter = 0;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function manifestPathFor(root, manifestArg) {
  return manifestArg ? path.resolve(manifestArg) : path.join(root, '.derivon', 'workspace.json');
}

/** Read the manifest as text, so its hash covers exactly the bytes on disk. */
export async function readManifest(file) {
  const text = await readFile(file, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    error.code = 'invalid-json';
    throw error;
  }
  return { text, hash: sha256(text), manifest };
}

/**
 * Replace a file by writing a temporary sibling and renaming it over the target, so a reader
 * observes the whole previous file or the whole new one and never a truncated prefix.
 *
 * `temporaryDirectory` defaults to the target's own directory (same filesystem, next to the
 * target). The manifest passes the workspace root instead: the application hashes the whole
 * tree including `.derivon`, and the workspace root is the nearest point outside `.derivon`
 * that still renames on the same filesystem.
 *
 * Remove the temporary on every failing path. A removal that itself fails is reported as a
 * second failure rather than hidden.
 */
export async function replaceFileAtomically(target, content, { temporaryDirectory = path.dirname(target), beforeReplace } = {}) {
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = path.join(
    temporaryDirectory,
    `${path.basename(target)}${TEMPORARY_MARKER}${TEMPORARY_TOKEN}-${temporaryCounter++}`,
  );
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    try {
      const info = await stat(target);
      await chmod(temporary, info.mode);
    } catch {
      /* A missing target keeps the newly created file's default permissions. */
    }
    if (beforeReplace) await beforeReplace();
    await rename(temporary, target);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanup) {
      throw new Error(`${error.message}; temporary file cleanup also failed: ${cleanup.message}`);
    }
    throw error;
  }
}

/** The real path of the workspace root, which every containment check is measured against. */
export async function realWorkspaceRoot(root) {
  return realpath(root);
}

/**
 * Is `candidate` strictly inside `realRoot`? Both must already be real paths. A candidate equal
 * to the root is not inside it.
 */
export function insideRealRoot(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Classify one workspace-relative path for reading or creation. The longest existing prefix is
 * resolved with `realpath` and checked for containment; only then may the rest be created. This
 * catches a symlinked parent directory that would otherwise carry a `mkdir -p` outside the
 * workspace, and it never compares string prefixes.
 *
 * Returns `{ status: 'unsafe' }` for a malformed path, `{ status: 'outside' }` when an existing
 * prefix resolves outside the root, and `{ status: 'inside', real, missing }` when the path
 * stays inside, with the still-missing trailing segments (empty when the path exists).
 */
export async function classifyWorkspacePath(realRoot, root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) {
    return { status: 'unsafe' };
  }
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return { status: 'unsafe' };
  for (let length = segments.length; length >= 1; length -= 1) {
    let real;
    try {
      real = await realpath(path.join(root, ...segments.slice(0, length)));
    } catch {
      continue;
    }
    const info = await stat(real).catch(() => null);
    if (!info?.isDirectory()) return { status: 'unsafe' };
    return insideRealRoot(realRoot, real)
      ? { status: 'inside', real, missing: segments.slice(length) }
      : { status: 'outside', real };
  }
  /* Nothing below the root exists yet; creation starts at the workspace root, which is inside
   * by definition. */
  return { status: 'inside', real: realRoot, missing: segments };
}
