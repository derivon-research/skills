import { renderDocument } from './render-document.mjs';
import { auditDocumentMedia, formatMediaIssue, MediaPreflightError } from './media-preflight.mjs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const usage = `Usage:
  node render-documents.mjs [--stdout] [--manifest <candidate.json>] <workspace> [object-id-or-document ...]

Read-only Markdown/media validation. No workspace HTML files are read or written.
With --stdout, renders exactly one selected document to stdout for a transient preview.
The script is self-contained and needs no workspace npm dependencies.`;
const args = process.argv.slice(2);
if (takeFlag(args, '--write')) throw new Error('--write is no longer supported: workspace documents persist only document.md.');
const stdout = takeFlag(args, '--stdout');
const manifestArg = takeValue(args, '--manifest');
if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
  console.log(usage);
  process.exit(0);
}
const workspaceRoot = path.resolve(args.shift() ?? '.');
const selectors = new Set(args.map((value) => value.replace(/\/$/, '')));
const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(workspaceRoot, '.derivon', 'workspace.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const objects = [
  ...(manifest.graph?.points ?? []).map((object) => ({ ...object, kind: 'concept' })),
  ...(manifest.graph?.hyperedges ?? []).map((object) => ({ ...object, kind: 'derivation' })),
];
const selected = objects.filter((object) => !selectors.size
  || selectors.has(object.id)
  || selectors.has(object.data?.document)
  || selectors.has(`${object.data?.document}/document.md`));
if (selectors.size) {
  const matched = new Set(selected.flatMap((object) => [object.id, object.data?.document, `${object.data?.document}/document.md`]));
  const unknown = [...selectors].filter((selector) => !matched.has(selector));
  if (unknown.length) throw new Error(`Unknown object selector(s): ${unknown.join(', ')}`);
}

if (stdout && selected.length !== 1) throw new Error('--stdout requires exactly one selected object.');
const publications = [];
const mediaIssues = [];
for (const object of selected) {
  const directory = await safeWorkspacePath(workspaceRoot, object.data.document);
  const sourcePath = path.join(directory, 'document.md');
  const source = await readFile(sourcePath, 'utf8');
  try {
    const media = await auditDocumentMedia({
      markdown: source,
      objectId: object.id,
      sourcePath: `${object.data.document}/document.md`,
      objectDirectory: directory,
    });
    publications.push({ object, markdown: source, media });
  } catch (error) {
    if (!(error instanceof MediaPreflightError)) throw error;
    mediaIssues.push(...error.issues);
  }
}

if (mediaIssues.length) {
  console.error(mediaIssues.map(formatMediaIssue).join('\n\n'));
  process.exitCode = 1;
} else {
  for (const { object, markdown, media } of publications) {
    if (stdout) process.stdout.write(renderDocument(markdown, object.data.label || object.id));
    else if (media.assets.length) console.log(`Media [${object.id}] ${media.assets.length} local image(s): ${media.assets.join(', ')}`);
  }
  if (!stdout) console.log(`Validated ${selected.length} Markdown document(s).`);
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
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  values.splice(index, 2);
  return value;
}

async function safeWorkspacePath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error(`Unsafe document path: ${String(relative)}`);
  }
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe document path: ${relative}`);
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(resolved)]);
  if (realDirectory === realRoot || !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Document path resolves outside the workspace: ${relative}`);
  }
  return realDirectory;
}
