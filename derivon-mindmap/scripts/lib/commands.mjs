/**
 * The command surface: one entry point, one result envelope per call, one call per commit.
 *
 * Every command's first argument is the workspace root, then command-specific flags and
 * selectors. Each command declares the capability it changes in the artifact's meaning and
 * the shape of its argv and stdin; `--capabilities` is generated from this table, so the table
 * is the only place a client learns what exists — the client does not keep a second list.
 *
 * A structural command builds its candidate in memory, writes the documents it owns first,
 * validates the whole candidate against the graph protocol and the workspace reference rules,
 * re-reads the manifest and refuses if it changed, and only then replaces the manifest by
 * temporary sibling and rename. Correctness never depends on the caller running a check first;
 * the read-only commands exist as an audit surface, not as a required step.
 *
 * The surface governs two artifact categories, and every command declares which one it belongs
 * to (`artifact`) beside the capability it exercises. Learner records are the second: they are
 * not workspace content, they live in the application data directory keyed by the workspace id,
 * and their commands compute that path themselves rather than being told it. The write boundary
 * and the capability vocabulary are `derivon-mindmap`'s ADR-0011
 * (https://github.com/derivon-research/derivon-mindmap/blob/main/docs/adr/0011-change-workspace-content-through-the-script-command-surface.md).
 */

import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CODE, issue } from './envelope.mjs';
import { classifyWorkspacePath, manifestPathFor, readManifest, realWorkspaceRoot, replaceFileAtomically, sha256 } from './fs.mjs';
import { BasisError } from './basis.mjs';
import {
  LEARNER_RECORD_FILE_NAMES, MISSING_VERSION, applicationDataRoot, isBasis, learnerRecordFile,
  learnerRecordPath, parseLearnerRecord,
} from './learner-records.mjs';
import { OBJECT_ID_PATTERN, auditWorkspace, isUsableWorkspaceId, safeRelativeDirectory } from './workspace-validator.mjs';
import { runDerivon, runTool } from './derivon.mjs';

const MANIFEST_LABEL = '.derivon/workspace.json';

export const COMMANDS = [
  {
    name: 'validate',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Audit a workspace manifest, its graph and its referenced documents.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'manifest', flag: '--manifest', kind: 'path', required: false, description: 'Audit this manifest instead of <workspace>/.derivon/workspace.json.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'concepts', description: 'Concept count.' }, { name: 'derivations', description: 'Derivation count.' }] },
    run: runValidate,
  },
  {
    name: 'render',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Validate Markdown and media without writing anything, optionally for selected objects.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'objects', positional: true, kind: 'id', required: false, repeatable: true, description: 'Object ids, document directories, or document.md paths.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'documents', description: 'Validated documents with their media counts.' }] },
    run: runRender,
  },
  {
    name: 'crosslink',
    artifact: 'workspace',
    capability: 'write-document',
    summary: 'Add exact-label crosslinks to documents; --check reports them without writing.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'selectors', positional: true, kind: 'id', required: false, repeatable: true, description: 'Object ids, document directories, or document.md paths.' },
      { name: 'all', flag: '--all', kind: 'boolean', required: false, description: 'Select every object.' },
      { name: 'check', flag: '--check', kind: 'boolean', required: false, description: 'Report missing crosslinks without writing them.' },
    ],
    stdin: null,
    result: { changed: ['documents'], fields: [{ name: 'selectedDocuments', description: 'Documents examined.' }, { name: 'insertionCount', description: 'Crosslinks added or pending.' }] },
    run: runCrosslink,
  },
  {
    name: 'new-object-id',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Mint an object id in the same shape the application generates.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'kind', flag: '--kind', kind: 'string', required: false, values: ['concept', 'derivation'], description: 'Defaults to concept.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'id', description: 'The minted id.' }] },
    run: runNewObjectId,
  },
  {
    name: 'export-textbook',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Export a solved route as a static textbook outside the workspace.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'output', flag: '--output', kind: 'path', required: true, description: 'Textbook output directory.' },
      { name: 'start', flag: '--start', kind: 'id', required: false, repeatable: true, description: 'Route start point.' },
      { name: 'target', flag: '--target', kind: 'id', required: true, repeatable: true, description: 'Route target point.' },
      { name: 'max-nodes', flag: '--max-nodes', kind: 'number', required: false, description: 'Search node budget.' },
      { name: 'max-millis', flag: '--max-millis', kind: 'number', required: false, description: 'Search time budget.' },
      { name: 'max-references', flag: '--max-references', kind: 'number', required: false, description: 'Reference-closure bound.' },
      { name: 'allow-approximate', flag: '--allow-approximate', kind: 'boolean', required: false, description: 'Accept a route not proven optimal.' },
      { name: 'force', flag: '--force', kind: 'boolean', required: false, description: 'Replace a recognized textbook output.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'output', description: 'Output directory.' }, { name: 'chapters', description: 'Exported chapters.' }, { name: 'references', description: 'Exported reference closure.' }] },
    run: runExportTextbook,
  },
  {
    name: 'add-concept',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Add one concept and write its document first, then replace the manifest.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-add-concept/v1', description: '{ id, data, markdown? } — data requires label and document.' },
    result: { changed: ['manifest', 'objects', 'documents'], fields: [{ name: 'id', description: 'The added object id.' }] },
    run: runAddConcept,
  },
  {
    name: 'add-derivation',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Add one derivation and write its document first, then replace the manifest.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-add-derivation/v1', description: '{ id, tails, head, weight, data, markdown? } — data requires document.' },
    result: { changed: ['manifest', 'objects', 'documents'], fields: [{ name: 'id', description: 'The added object id.' }] },
    run: runAddDerivation,
  },
  {
    name: 'set-metadata',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Replace workspace metadata, tag declarations, or object data.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-set-metadata/v1', description: '{ document?, tags?, objects? } — objects maps an id to { data }.' },
    result: { changed: ['manifest', 'objects'], fields: [{ name: 'objects', description: 'Ids whose data was replaced.' }] },
    run: runSetMetadata,
  },
  {
    name: 'write-document',
    artifact: 'workspace',
    capability: 'write-document',
    summary: 'Replace one object document.md with compare-and-swap on the file.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-write-document/v1', description: '{ object, markdown }.' },
    result: { changed: ['documents'], fields: [{ name: 'object', description: 'The object id.' }, { name: 'document', description: 'The document directory.' }] },
    run: runWriteDocument,
  },
  {
    name: 'delete-object',
    artifact: 'workspace',
    capability: 'delete',
    summary: 'Remove graph objects without deleting their document directories.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'ids', positional: true, kind: 'id', required: true, repeatable: true, description: 'Object ids to remove.' },
      { name: 'cascade', flag: '--cascade', kind: 'boolean', required: false, description: 'Also remove dependents of a removed point.' },
    ],
    stdin: null,
    result: { changed: ['manifest', 'objects'], fields: [{ name: 'documents', description: 'Document directories left untouched.' }] },
    run: runDeleteObject,
  },
  {
    name: 'import',
    artifact: 'workspace',
    capability: 'import',
    summary: 'Validate a complete manifest on stdin and replace the current one atomically.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace/v1', description: 'A complete workspace manifest.' },
    result: { changed: ['manifest'], fields: [{ name: 'id', description: 'Workspace id.' }, { name: 'concepts', description: 'Concept count.' }, { name: 'derivations', description: 'Derivation count.' }] },
    run: runImport,
  },
  {
    name: 'read-learner-record',
    artifact: 'learner-records',
    capability: 'read-learner-record',
    summary: 'Read one learner record file from the application data directory, keyed by the workspace id.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the record.' },
      { name: 'file', flag: '--file', kind: 'string', required: false, values: [...LEARNER_RECORD_FILE_NAMES], description: 'Which record: state (mastery) or routes. Defaults to state.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'file', description: 'The record that was read.' }, { name: 'path', description: 'The absolute path the record was read from.' }, { name: 'present', description: 'Whether the file exists; an absent record is not an error.' }, { name: 'version', description: 'The version a later write has to carry, or null when there is no file.' }, { name: 'text', description: 'The file verbatim, so a caller can rewrite it without losing anything.' }] },
    run: runReadLearnerRecord,
  },
  {
    name: 'write-learner-record',
    artifact: 'learner-records',
    capability: 'write-learner-record',
    summary: 'Validate one learner record document, fill in any basis it leaves out, and replace the file atomically.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the record and supplies the basis.' },
      { name: 'file', flag: '--file', kind: 'string', required: false, values: [...LEARNER_RECORD_FILE_NAMES], description: 'Which record: state (mastery) or routes. Defaults to state.' },
      { name: 'expected-version', flag: '--expected-version', kind: 'string', required: true, description: 'The version you read: a 64-character lowercase hex digest, or the word missing when there was no file.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: { required: true, schema: 'derivon.learning/v1 (--file state) or derivon.routes/v1 (--file routes)', description: 'A complete record document. A record that omits basis has it computed from the workspace; a basis you supply is kept as supplied. A write carries no completion marker for a route.' },
    result: { changed: ['learnerRecord'], fields: [{ name: 'file', description: 'The record that was written.' }, { name: 'path', description: 'The absolute path replaced.' }, { name: 'version', description: 'The new version, for the next write.' }] },
    run: runWriteLearnerRecord,
  },
];

export function findCommand(name) {
  return COMMANDS.find((command) => command.name === name) ?? null;
}

/* --------------------------------------------------------------------------------------- */
/* Argument and payload helpers                                                              */
/* --------------------------------------------------------------------------------------- */

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
  if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
  values.splice(index, 2);
  return value;
}

export class UsageError extends Error {}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve the workspace root, its real path, and the manifest bytes it currently holds. A
 * missing manifest is not fatal here: `validate` can audit a candidate and `import` can create
 * the first one. Read and parse failures are captured so a command can report the right code. */
export async function loadContext(workspaceArg) {
  if (typeof workspaceArg !== 'string' || !workspaceArg) throw new UsageError('a workspace root is required');
  const root = path.resolve(workspaceArg);
  const manifestPath = manifestPathFor(root, null);
  const realRoot = await realWorkspaceRoot(root);
  let current = null;
  let manifestError = null;
  try {
    current = await readManifest(manifestPath);
  } catch (error) {
    manifestError = error.code === 'ENOENT'
      ? issue(CODE.IO_ERROR, MANIFEST_LABEL, 'workspace manifest not found')
      : issue(CODE.INVALID_JSON, MANIFEST_LABEL, error.message);
  }
  return { root, realRoot, manifestPath, current, manifest: current?.manifest ?? null, manifestError };
}

function requireManifest(context) {
  return context.current ? null : (context.manifestError ?? issue(CODE.IO_ERROR, MANIFEST_LABEL, 'workspace manifest not found'));
}

function parseObject(stdin, allowed) {
  if (!stdin.trim()) return { error: issue(CODE.INVALID_PAYLOAD, '.', 'a JSON payload on stdin is required') };
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return { error: issue(CODE.INVALID_JSON, '.', error.message) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: issue(CODE.INVALID_PAYLOAD, '.', 'expected a JSON object') };
  }
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length) return { error: issue(CODE.INVALID_PAYLOAD, '.', `unknown field(s): ${unknown.join(', ')}`) };
  return { payload };
}

/* --------------------------------------------------------------------------------------- */
/* Read-only commands                                                                        */
/* --------------------------------------------------------------------------------------- */

async function runValidate({ argv, context }) {
  const manifestArg = takeValue(argv, '--manifest');
  if (argv.length) throw new UsageError(`Unexpected argument: ${argv[0]}`);
  const manifestPath = manifestArg ? path.resolve(manifestArg) : context.manifestPath;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    const code = error.code === 'ENOENT' ? CODE.IO_ERROR : CODE.INVALID_JSON;
    return { issues: [issue(code, relativeLabel(context.root, manifestPath), error.message)] };
  }
  const { issues, concepts, derivations } = await auditWorkspace({ root: context.root, manifest });
  return { result: { concepts, derivations }, issues };
}

async function runRender({ argv, context }) {
  const report = runJsonTool('render-documents.mjs', ['--json', context.root, ...argv]);
  if (report.error) return { issues: [report.error] };
  return { result: { documents: report.value.documents ?? [] }, issues: report.value.issues ?? [] };
}

async function runCrosslink({ argv, context }) {
  const all = takeFlag(argv, '--all');
  const check = takeFlag(argv, '--check');
  if (all && argv.length) throw new UsageError('Choose either --all or explicit selectors, not both');
  if (!all && !argv.length) throw new UsageError('crosslink requires --all or at least one selector');
  const toolArgs = ['--json'];
  if (!check) toolArgs.push('--write');
  toolArgs.push(context.root);
  if (all) toolArgs.push('--all');
  else toolArgs.push(...argv);
  const report = runJsonTool('crosslink-documents.mjs', toolArgs);
  if (report.error) return { issues: [report.error] };
  const value = report.value;
  const issues = (value.issues ?? []).map((entry) => issue(entry.code ?? CODE.CROSSLINK_PARSE_ERROR, entry.source, entry.message));
  const sources = [...new Set((value.insertions ?? []).map((entry) => entry.source.replace(/\/document\.md$/, '')))];
  if (check) {
    for (const entry of value.insertions ?? []) {
      issues.push(issue(CODE.CROSSLINK_MISSING, entry.source, `missing crosslink to ${entry.targetId} for ${JSON.stringify(entry.display)}`));
    }
  }
  return {
    changed: { documents: check ? [] : sources },
    result: {
      selectedDocuments: value.selectedDocuments ?? 0,
      insertionCount: value.insertionCount ?? 0,
      changedDocuments: value.changedDocuments ?? 0,
    },
    issues,
  };
}

async function runNewObjectId({ argv, context }) {
  const kind = takeValue(argv, '--kind') ?? 'concept';
  if (!['concept', 'derivation'].includes(kind)) throw new UsageError('--kind must be concept or derivation');
  if (argv.length) throw new UsageError(`Unexpected argument: ${argv[0]}`);
  const result = runTool('new-object-id.mjs', ['--manifest', context.manifestPath, '--kind', kind]);
  if (result.status !== 0) {
    return { issues: [issue(CODE.IO_ERROR, MANIFEST_LABEL, (result.stderr || result.stdout).trim())] };
  }
  return { result: { id: result.stdout.trim() } };
}

async function runExportTextbook({ argv, context }) {
  if (argv.includes('--serve') || argv.includes('--port')) {
    throw new UsageError('the preview server is not part of the command surface; run scripts/export-route-textbook.mjs directly with --serve');
  }
  const report = runJsonTool('export-route-textbook.mjs', ['--json', context.root, ...argv]);
  if (report.error) return { issues: [report.error] };
  const value = report.value;
  return {
    result: { output: value.output ?? null, chapters: value.chapters ?? [], references: value.references ?? [] },
    issues: value.issues ?? [],
  };
}

/* --------------------------------------------------------------------------------------- */
/* Structural commands                                                                       */
/* --------------------------------------------------------------------------------------- */

async function runAddConcept({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'id', 'data', 'markdown']);
  if (parsed.error) return { issues: [parsed.error] };
  const { id, data, markdown } = parsed.payload;
  const issues = [];
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) issues.push(issue(CODE.INVALID_ID, '.', 'expected a workspace object id'));
  else if (findObject(context.manifest, id)) issues.push(issue(CODE.DUPLICATE_ID, '.', `object ${id} already exists`));
  if (!data || typeof data !== 'object' || Array.isArray(data)) issues.push(issue(CODE.INVALID_PAYLOAD, '/data', 'expected an object'));
  if (markdown !== undefined && typeof markdown !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, '/markdown', 'expected a string'));
  if (issues.length) return { issues };
  return addObject(context, { id, markdown, data, object: { id, data }, kind: 'concept' });
}

async function runAddDerivation({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'id', 'tails', 'head', 'weight', 'data', 'markdown']);
  if (parsed.error) return { issues: [parsed.error] };
  const { id, tails, head, weight, data, markdown } = parsed.payload;
  const issues = [];
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) issues.push(issue(CODE.INVALID_ID, '.', 'expected a workspace object id'));
  else if (findObject(context.manifest, id)) issues.push(issue(CODE.DUPLICATE_ID, '.', `object ${id} already exists`));
  if (!data || typeof data !== 'object' || Array.isArray(data)) issues.push(issue(CODE.INVALID_PAYLOAD, '/data', 'expected an object'));
  if (!Array.isArray(tails) || tails.some((tail) => typeof tail !== 'string')) issues.push(issue(CODE.INVALID_PAYLOAD, '/tails', 'expected an array of point ids'));
  if (typeof head !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, '/head', 'expected a point id'));
  if (typeof weight !== 'number' || !Number.isFinite(weight)) issues.push(issue(CODE.INVALID_PAYLOAD, '/weight', 'expected a finite number'));
  if (markdown !== undefined && typeof markdown !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, '/markdown', 'expected a string'));
  if (issues.length) return { issues };
  return addObject(context, { id, markdown, data, object: { id, weight, tails, head, data }, kind: 'derivation' });
}

async function runSetMetadata({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'document', 'tags', 'objects']);
  if (parsed.error) return { issues: [parsed.error] };
  const { document, tags, objects } = parsed.payload;
  const issues = [];
  const candidate = structuredClone(context.manifest);
  const changedObjects = [];
  if (document !== undefined) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      issues.push(issue(CODE.INVALID_PAYLOAD, '/document', 'expected an object'));
    } else {
      for (const key of Object.keys(document)) {
        if (!['title', 'description'].includes(key)) issues.push(issue(CODE.INVALID_PAYLOAD, `/document/${key}`, 'unknown field'));
        else if (typeof document[key] !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, `/document/${key}`, 'expected a string'));
        else candidate.document[key] = document[key];
      }
    }
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) issues.push(issue(CODE.INVALID_PAYLOAD, '/tags', 'expected an array'));
    else candidate.tags = tags;
  }
  if (objects !== undefined) {
    if (!objects || typeof objects !== 'object' || Array.isArray(objects)) {
      issues.push(issue(CODE.INVALID_PAYLOAD, '/objects', 'expected an object'));
    } else {
      for (const [id, value] of Object.entries(objects)) {
        const target = findObject(candidate, id);
        if (!target) { issues.push(issue(CODE.UNKNOWN_OBJECT, '/objects', `unknown object ${id}`)); continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('data' in value)) {
          issues.push(issue(CODE.INVALID_PAYLOAD, `/objects/${id}`, 'expected { data }'));
          continue;
        }
        target.data = value.data;
        changedObjects.push(id);
      }
    }
  }
  if (issues.length) return { issues };
  const committed = await commitManifest(context, candidate, { objects: changedObjects, documents: [] });
  if (committed.issues?.length) return committed;
  return { ...committed, result: { objects: changedObjects } };
}

async function runWriteDocument({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'object', 'markdown']);
  if (parsed.error) return { issues: [parsed.error] };
  const { object: objectId, markdown } = parsed.payload;
  if (typeof objectId !== 'string' || !objectId) return { issues: [issue(CODE.INVALID_PAYLOAD, '/object', 'expected an object id')] };
  if (typeof markdown !== 'string') return { issues: [issue(CODE.INVALID_PAYLOAD, '/markdown', 'expected a string')] };
  const target = findObject(context.manifest, objectId);
  if (!target) return { issues: [issue(CODE.UNKNOWN_OBJECT, '.', `unknown object ${objectId}`)] };
  const document = target.data?.document;
  if (!safeRelativeDirectory(document)) return { issues: [issue(CODE.DOCUMENT_UNSAFE, '.', `object ${objectId} has no safe document directory`)] };
  const placement = await classifyWorkspacePath(context.realRoot, context.root, document);
  if (placement.status === 'unsafe' || placement.status === 'outside') {
    return { issues: [issue(CODE.DOCUMENT_UNSAFE, '.', `document path for ${objectId} does not stay inside the workspace on its real path`)] };
  }
  if (placement.missing.length) {
    return { issues: [issue(CODE.DOCUMENT_MISSING, `${document}/document.md`, `document directory ${document} does not exist`)] };
  }
  const documentPath = path.join(placement.real, 'document.md');
  let before;
  try {
    before = await readFile(documentPath, 'utf8');
  } catch (error) {
    return { issues: [issue(CODE.DOCUMENT_MISSING, `${document}/document.md`, error.message)] };
  }
  const beforeHash = sha256(before);
  try {
    await replaceFileAtomically(documentPath, markdown, {
      beforeReplace: async () => {
        const latest = await readFile(documentPath, 'utf8');
        if (sha256(latest) !== beforeHash) throw conflictError('the document changed while the command ran; re-read and retry');
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, `${document}/document.md`, error.message)] };
  }
  return { changed: { documents: [document] }, result: { object: objectId, document } };
}

async function runDeleteObject({ argv, context }) {
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const cascade = takeFlag(argv, '--cascade');
  const ids = argv;
  if (!ids.length) throw new UsageError('delete-object requires at least one object id');
  for (const id of ids) {
    if (!findObject(context.manifest, id)) return { issues: [issue(CODE.UNKNOWN_OBJECT, '.', `unknown object ${id}`)] };
  }
  const documents = ids.map((id) => findObject(context.manifest, id).data?.document).filter(Boolean);
  let graph = graphOf(context.manifest);
  for (const id of ids) {
    const isPoint = graph.points.some((point) => point.id === id);
    let args;
    if (isPoint) {
      args = ['point', 'remove', id];
      if (cascade) args.push('--cascade');
    } else {
      args = ['hyperedge', 'remove', id];
    }
    const result = runDerivon(args, { input: JSON.stringify(graph) });
    if (result.error?.code === 'ENOENT') return { issues: [issue(CODE.EXTERNAL_TOOL, '.', 'derivon CLI is not installed or not on PATH')] };
    if (result.status !== 0) return { issues: [issue(CODE.GRAPH_INVALID, '.', (result.stderr || result.stdout).trim())] };
    try {
      graph = JSON.parse(result.stdout);
    } catch (error) {
      return { issues: [issue(CODE.GRAPH_INVALID, '.', `derivon returned no usable graph: ${error.message}`)] };
    }
  }
  const committed = await commitManifest(context, { ...context.manifest, graph }, { objects: ids, documents: [] });
  if (committed.issues?.length) return committed;
  return { ...committed, result: { documents, note: 'document directories are never deleted' } };
}

async function runImport({ argv, context, stdin }) {
  assertNoArguments(argv);
  if (!stdin.trim()) return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'a workspace manifest on stdin is required')] };
  let manifest;
  try {
    manifest = JSON.parse(stdin);
  } catch (error) {
    return { issues: [issue(CODE.INVALID_JSON, '.', error.message)] };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'expected a JSON object')] };
  }
  const committed = await commitManifest(context, manifest, { objects: [], documents: [] });
  if (committed.issues?.length) return committed;
  return {
    ...committed,
    result: {
      id: manifest.id,
      concepts: Array.isArray(manifest.graph?.points) ? manifest.graph.points.length : 0,
      derivations: Array.isArray(manifest.graph?.hyperedges) ? manifest.graph.hyperedges.length : 0,
    },
  };
}

/* --------------------------------------------------------------------------------------- */
/* Learner-record commands                                                                   */
/*                                                                                           */
/* Learner records are not workspace content. The two questions they answer — what has this   */
/* learner reached, and which routes did they confirm — live beside each other in the          */
/* application data directory, keyed by the workspace id, and are read and replaced            */
/* independently. The command computes that path itself: the workspace root supplies the id,   */
/* and the platform supplies the data directory.                                              */
/* --------------------------------------------------------------------------------------- */

/** The workspace id is the record's whole key on disk, and it becomes a directory name. */
function learnerRecordKey(context) {
  const id = context.manifest?.id;
  if (typeof id !== 'string' || !isUsableWorkspaceId(id)) {
    return { issue: issue(CODE.INVALID_ID, '/id', 'the manifest has no usable workspace id; learner records are keyed by it, and a workspace without one is a broken workspace') };
  }
  return { id };
}

function takeRecordFile(argv) {
  const name = takeValue(argv, '--file') ?? 'state';
  const file = learnerRecordFile(name);
  if (!file) throw new UsageError('--file must be state or routes');
  return file;
}

function takeDataRoot(argv) {
  const explicit = takeValue(argv, '--data-dir');
  if (explicit !== null) return { root: path.resolve(explicit) };
  const root = applicationDataRoot();
  return root === null
    ? { issue: issue(CODE.IO_ERROR, '.', 'no application data directory on this platform; pass --data-dir') }
    : { root };
}

/** The version of a record file: the SHA-256 of its bytes, or `null` when it is not there. A
 * record an unreadable-file error hides is not a missing record, so only `ENOENT` is `null`. */
async function recordVersion(target) {
  try {
    return sha256(await readFile(target));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runReadLearnerRecord({ argv, context }) {
  const file = takeRecordFile(argv);
  const dataRoot = takeDataRoot(argv);
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const key = learnerRecordKey(context);
  if (key.issue) return { issues: [key.issue] };
  if (dataRoot.issue) return { issues: [dataRoot.issue] };
  const target = learnerRecordPath(dataRoot.root, key.id, file.name);

  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') return { issues: [issue(CODE.IO_ERROR, target, error.message)] };
    /* An absent record is an absent record: this learner has assessed nothing here, which is
     * not the same as a record that says so, and not an error. */
    return { result: { file: file.name, path: target, present: false, version: null, text: null } };
  }
  const version = sha256(bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return {
      result: { file: file.name, path: target, present: true, version, text: null },
      issues: [issue(CODE.LEARNER_RECORD_UNREADABLE, target, `not valid UTF-8: ${error.message}`)],
    };
  }
  /* The record is returned either way: a broken file is reported, never silently replaced or
   * hidden behind an empty record. */
  const parsed = parseLearnerRecord(text, file);
  return {
    result: { file: file.name, path: target, present: true, version, text },
    issues: parsed.unreadable ? [parsed.unreadable] : parsed.issues,
  };
}

async function runWriteLearnerRecord({ argv, context, stdin }) {
  const file = takeRecordFile(argv);
  const expected = takeValue(argv, '--expected-version');
  const dataRoot = takeDataRoot(argv);
  assertNoArguments(argv);
  if (expected === null) throw new UsageError(`--expected-version is required: the version you read, or the word ${MISSING_VERSION}`);
  if (expected !== MISSING_VERSION && !isBasis(expected)) {
    throw new UsageError(`--expected-version must be a 64-character lowercase hex digest or the word ${MISSING_VERSION}`);
  }
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const key = learnerRecordKey(context);
  if (key.issue) return { issues: [key.issue] };
  if (dataRoot.issue) return { issues: [dataRoot.issue] };

  if (!stdin.trim()) return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'a record document on stdin is required')] };
  let document;
  try {
    document = JSON.parse(stdin);
  } catch (error) {
    return { issues: [issue(CODE.INVALID_JSON, '.', error.message)] };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'expected a JSON object')] };
  }
  if (document.schema !== file.schema) {
    return { issues: [issue(CODE.LEARNER_RECORD_UNREADABLE, '/schema', `expected ${file.schema}, found ${JSON.stringify(document.schema ?? null)}`)] };
  }
  /* Basis is checked in both passes: a supplied one has to be a hash to start with, and every
   * record has to have one to finish. Only a missing one is filled. */
  const shape = file.validate(document, { requireBasis: false });
  if (shape.length) return { issues: shape };
  try {
    await file.fill(document, { realRoot: context.realRoot, manifest: context.manifest });
  } catch (error) {
    if (error instanceof BasisError) return { issues: [issue(error.code, error.subject, error.message)] };
    return { issues: [issue(CODE.IO_ERROR, '.', error?.message ?? String(error))] };
  }
  const complete = file.validate(document, { requireBasis: true });
  if (complete.length) return { issues: complete };
  const text = file.serialize(document);
  const target = learnerRecordPath(dataRoot.root, key.id, file.name);
  const expectedVersion = expected === MISSING_VERSION ? null : expected;

  let current;
  try {
    current = await recordVersion(target);
  } catch (error) {
    return { issues: [issue(CODE.IO_ERROR, target, error.message)] };
  }
  if (current !== expectedVersion) {
    return { issues: [issue(CODE.CONFLICT_PRECONDITION, target, 'the learner record changed since it was read; re-read it and retry')] };
  }
  try {
    await replaceFileAtomically(target, text, {
      beforeReplace: async () => {
        if (await recordVersion(target) !== expectedVersion) {
          throw conflictError('the learner record changed while the command ran; re-read it and retry');
        }
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, target, error.message)] };
  }
  return {
    changed: { learnerRecord: file.file },
    result: { file: file.name, path: target, version: sha256(text) },
  };
}

/* --------------------------------------------------------------------------------------- */
/* Shared structural-command machinery                                                       */
/* --------------------------------------------------------------------------------------- */

/**
 * Add one graph object and its document. The document is written before the manifest, so a
 * failure never leaves a manifest naming a document that does not exist — the reverse (an
 * unreferenced document) is inert. A document or directory this command created is removed
 * again when the commit is refused, so a refusal is not a partial add.
 */
async function addObject(context, { id, markdown, data, object, kind }) {
  const document = data?.document;
  if (!safeRelativeDirectory(document)) {
    return { issues: [issue(CODE.DOCUMENT_UNSAFE, '/data/document', 'expected a safe workspace-relative directory')] };
  }
  const placement = await classifyWorkspacePath(context.realRoot, context.root, document);
  if (placement.status === 'unsafe' || placement.status === 'outside') {
    return { issues: [issue(CODE.DOCUMENT_UNSAFE, '/data/document', 'document path does not stay inside the workspace on its real path')] };
  }
  const directoryExists = placement.missing.length === 0;
  const documentDirectory = directoryExists ? placement.real : path.join(placement.real, ...placement.missing);
  const documentPath = path.join(documentDirectory, 'document.md');
  let documentExists = false;
  if (directoryExists) {
    try {
      const info = await lstat(documentPath);
      documentExists = info.isFile() && !info.isSymbolicLink();
    } catch {
      documentExists = false;
    }
  }
  if (documentExists && markdown !== undefined) {
    return { issues: [issue(CODE.DUPLICATE_DOCUMENT, '/data/document', `${document}/document.md already exists; use write-document to change it`)] };
  }
  if (!documentExists && markdown === undefined) {
    return { issues: [issue(CODE.DOCUMENT_MISSING, '/data/document', `${document}/document.md does not exist and no markdown was supplied`)] };
  }

  let createdDirectory = false;
  let createdDocument = false;
  if (markdown !== undefined) {
    await mkdir(documentDirectory, { recursive: true });
    createdDirectory = !directoryExists;
    await replaceFileAtomically(documentPath, markdown);
    createdDocument = true;
  }
  /* `missing[0]` is the first path segment this command created, so removing it removes the
   * whole chain the command made, not just the leaf. */
  const createdRoot = createdDirectory ? path.join(placement.real, placement.missing[0]) : null;

  const rollbackIssues = [];
  const rollback = async () => {
    try {
      if (createdRoot) await rm(createdRoot, { recursive: true, force: true });
      else if (createdDocument) await rm(documentPath, { force: true });
    } catch (error) {
      rollbackIssues.push(issue(CODE.IO_ERROR, document, `could not roll back the new document: ${error.message}`));
    }
  };

  const graph = graphOf(context.manifest);
  const candidate = {
    ...context.manifest,
    graph: kind === 'concept'
      ? { ...graph, points: [...graph.points, object] }
      : { ...graph, hyperedges: [...graph.hyperedges, object] },
  };

  const committed = await commitManifest(context, candidate, { objects: [id], documents: [document] });
  if (committed.issues?.length) {
    await rollback();
    return { ...committed, issues: [...committed.issues, ...rollbackIssues] };
  }
  return { ...committed, result: { id, document } };
}

/**
 * Validate, re-read, compare-and-swap, replace. The candidate is built in memory; the only
 * file written before the manifest is the replacement's own temporary sibling, and the
 * manifest temporary lives in the workspace root rather than in `.derivon`.
 */
async function commitManifest(context, candidate, changed) {
  const audit = await auditWorkspace({ root: context.root, manifest: candidate });
  if (audit.issues.length) return { issues: audit.issues };
  const expectedHash = context.current?.hash ?? null;
  const readLatest = async () => {
    try {
      const latest = await readManifest(context.manifestPath);
      return latest.hash;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  let latest;
  try {
    latest = await readLatest();
  } catch (error) {
    return { issues: [issue(CODE.IO_ERROR, MANIFEST_LABEL, error.message)] };
  }
  if (latest !== expectedHash) {
    return { issues: [issue(CODE.CONFLICT_PRECONDITION, MANIFEST_LABEL, 'the manifest changed while the command ran; re-read it and retry')] };
  }
  try {
    await replaceFileAtomically(context.manifestPath, `${JSON.stringify(candidate, null, 2)}\n`, {
      temporaryDirectory: context.root,
      beforeReplace: async () => {
        if (await readLatest() !== expectedHash) throw conflictError('the manifest changed while the command ran; re-read and retry');
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, MANIFEST_LABEL, error.message)] };
  }
  return { changed: { manifest: true, objects: [], documents: [], ...changed } };
}

/* --------------------------------------------------------------------------------------- */
/* Small helpers                                                                             */
/* --------------------------------------------------------------------------------------- */

function conflictError(message) {
  const error = new Error(message);
  error.code = CODE.CONFLICT_PRECONDITION;
  return error;
}

function assertNoArguments(argv) {
  if (argv.length) throw new UsageError(`Unexpected argument: ${argv[0]}`);
}

function graphOf(manifest) {
  return {
    points: Array.isArray(manifest?.graph?.points) ? manifest.graph.points : [],
    hyperedges: Array.isArray(manifest?.graph?.hyperedges) ? manifest.graph.hyperedges : [],
  };
}

function findObject(manifest, id) {
  return [
    ...(manifest?.graph?.points ?? []),
    ...(manifest?.graph?.hyperedges ?? []),
  ].find((object) => object?.id === id) ?? null;
}

function relativeLabel(root, target) {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? target : relative;
}

/**
 * Run one bundled tool with `--json` and parse its report. A tool that crashes without a
 * report becomes one diagnostic instead of a bare stack; that is what retires the
 * `render-documents` stack trace from the surface.
 */
function runJsonTool(name, args) {
  const result = runTool(name, args);
  const text = (result.stdout ?? '').trim();
  if (text) {
    try {
      return { value: JSON.parse(text) };
    } catch {
      /* Fall through to the stderr diagnostic. */
    }
  }
  const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
  return { error: issue(CODE.IO_ERROR, '.', `${name}: ${detail}`) };
}
