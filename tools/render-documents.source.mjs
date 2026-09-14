import { renderDocument } from './render-document.mjs';
import { auditDocumentMedia, formatMediaIssue, MediaPreflightError } from './media-preflight.mjs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const REPORT_SCHEMA = 'derivon.render-report/v1';
const usage = `Usage:
  node render-documents.mjs [--json] [--stdout] [--manifest <candidate.json>] <workspace> [object-id-or-document ...]

Read-only Markdown/media validation. No workspace HTML files are read or written.
With --stdout, renders exactly one selected document to stdout for a transient preview.
With --json, prints a ${REPORT_SCHEMA} report instead of prose.
The script is self-contained and needs no workspace npm dependencies.`;

const args = process.argv.slice(2);
const json = takeFlag(args, '--json');
const stdout = takeFlag(args, '--stdout');
const manifestArg = takeValue(args, '--manifest');
if (takeFlag(args, '--write')) fail('--write is no longer supported: workspace documents persist only document.md.');
if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
  console.log(usage);
  process.exit(0);
}
if (json && stdout) failUsage('--json and --stdout cannot be combined.');

const workspaceRoot = path.resolve(args.shift() ?? '.');
const selectors = args.map((value) => value.replace(/\/$/, ''));

try {
  const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(workspaceRoot, '.derivon', 'workspace.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw codedError(error.message, error instanceof SyntaxError ? 'invalid-json' : 'io-error');
  }
  const objects = [
    ...(manifest.graph?.points ?? []).map((object) => ({ ...object, kind: 'concept' })),
    ...(manifest.graph?.hyperedges ?? []).map((object) => ({ ...object, kind: 'derivation' })),
  ];
  const wanted = new Set(selectors);
  const selected = objects.filter((object) => !wanted.size
    || wanted.has(object.id)
    || wanted.has(object.data?.document)
    || wanted.has(`${object.data?.document}/document.md`));
  if (wanted.size) {
    const matched = new Set(selected.flatMap((object) => [object.id, object.data?.document, `${object.data?.document}/document.md`]));
    const unknown = [...wanted].filter((selector) => !matched.has(selector));
    if (unknown.length) throw codedError(`Unknown object selector(s): ${unknown.join(', ')}`, 'unknown-object');
  }
  if (stdout && selected.length !== 1) throw codedError('--stdout requires exactly one selected object.', 'usage');

  const documents = [];
  const mediaIssues = [];
  const html = [];
  for (const object of selected) {
    const directory = await safeWorkspacePath(workspaceRoot, object.data.document);
    let markdown;
    try {
      markdown = await readFile(path.join(directory, 'document.md'), 'utf8');
    } catch (error) {
      throw codedError(error.message, 'document-missing');
    }
    try {
      const media = await auditDocumentMedia({
        markdown,
        objectId: object.id,
        sourcePath: `${object.data.document}/document.md`,
        objectDirectory: directory,
      });
      documents.push({ id: object.id, mediaCount: media.assets.length, assets: media.assets });
      if (stdout) html.push(renderDocument(markdown, object.data.label || object.id));
    } catch (error) {
      if (!(error instanceof MediaPreflightError)) throw error;
      mediaIssues.push(...error.issues);
    }
  }

  if (mediaIssues.length) {
    if (json) emitReport(documents, mediaIssues.map(mediaIssue), 1);
    else console.error(mediaIssues.map(formatMediaIssue).join('\n\n'));
    process.exitCode = 1;
  } else if (stdout) {
    /* Written through the stream, not `writeSync`: a pipe write can be partial, and the process
     * must drain it before exiting. */
    process.stdout.write(html[0]);
    process.exitCode = 0;
  } else if (json) {
    emitReport(documents, [], 0);
    process.exitCode = 0;
  } else {
    for (const entry of documents) {
      if (entry.mediaCount) console.log(`Media [${entry.id}] ${entry.mediaCount} local image(s): ${entry.assets.join(', ')}`);
    }
    console.log(`Validated ${documents.length} Markdown document(s).`);
    process.exitCode = 0;
  }
} catch (error) {
  if (json) emitReport([], [{ code: error.code ?? 'media-invalid', path: '.', message: error.message }], 1);
  else console.error(error.message);
  process.exitCode = 1;
}

function mediaIssue(entry) {
  return {
    code: entry.code ?? 'media-invalid',
    path: entry.sourcePath,
    message: `${entry.line}: ${entry.message} Fix: ${entry.repair}`,
  };
}

function emitReport(documents, issues, status) {
  process.stdout.write(`${JSON.stringify({ schema: REPORT_SCHEMA, documents, issues }, null, 2)}\n`);
  process.exitCode = status;
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function safeWorkspacePath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) {
    throw codedError(`Unsafe document path: ${String(relative)}`, 'document-unsafe');
  }
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw codedError(`Unsafe document path: ${relative}`, 'document-unsafe');
  let realRoot;
  let realDirectory;
  try {
    [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(resolved)]);
  } catch (error) {
    throw codedError(error.message, error.code === 'ENOENT' ? 'document-missing' : 'io-error');
  }
  if (realDirectory === realRoot || !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw codedError(`Document path resolves outside the workspace: ${relative}`, 'document-unsafe');
  }
  return realDirectory;
}

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

function fail(message) {
  console.error(message);
  process.exit(1);
}

function failUsage(message) {
  console.error(message);
  process.exit(2);
}
