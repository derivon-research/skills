/**
 * Learner records: where they live and what shape they take. They are **not workspace content**
 * — they live in the application data directory, keyed by the workspace id, and they never
 * enter a manifest, `WorkspaceSource`, a workspace commit or its revision.
 *
 * The normative text is `derivon-mindmap`'s `docs/learner-records.md`. This module is the
 * script command surface's implementation of it, the way the application's TypeScript is the
 * client's: **one specification, two writers**, the rule in `derivon-mindmap`'s ADR-0011
 * (https://github.com/derivon-research/derivon-mindmap/blob/main/docs/adr/0011-change-workspace-content-through-the-script-command-surface.md).
 * Neither is the reference for the
 * other, and both have to produce a file the other accepts, so the shape rules, the canonical
 * text and the path layout are mirrored here rather than invented.
 *
 * One state file and one file per personal route, each read and replaced independently:
 *   <application data directory>/learner-records/<workspace id>/state.json             — mastery
 *   <application data directory>/learner-records/<workspace id>/routes/<route id>.json — personal routes
 *
 * A personal route is a `derivon.route/v1` file, the protocol a workspace route also uses; its
 * rules live in `routes.mjs`, and this module only says where the file goes.
 *
 * The key is the workspace id from the manifest, never the folder. Copy a workspace and the
 * copy shares the record; a workspace without an id is a broken workspace and never reaches
 * this directory.
 */

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { masteryBasis } from './basis.mjs';
import { CODE, issue } from './envelope.mjs';
import { routeFileName } from './routes.mjs';
import { escapeJsonPointer, isUsableWorkspaceId } from './workspace-validator.mjs';

const LEARNING_SCHEMA = 'derivon.learning/v1';

/** The Tauri bundle identifier. The application data directory is the platform data directory
 * joined with it, so one constant names the directory both writers compute. */
const APPLICATION_IDENTIFIER = 'net.derivon.mindmap';
const LEARNER_RECORDS_DIRECTORY = 'learner-records';
const PERSONAL_ROUTES_DIRECTORY = 'routes';

/**
 * The fixed-name record files, each carrying its own protocol: the shape it validates, the text
 * it serializes to, and how a `basis` it leaves out is computed. Personal routes are not here:
 * they are one file per route, named by the route id.
 */
export const LEARNER_RECORD_FILES = [
  {
    name: 'state',
    file: 'state.json',
    schema: LEARNING_SCHEMA,
    validate: validateLearningDocument,
    serialize: serializeLearningDocument,
    fill: fillLearningBasis,
  },
];


export function learnerRecordFile(name) {
  return LEARNER_RECORD_FILES.find((entry) => entry.name === name) ?? null;
}

/** `--expected-version missing` is how a caller says "I read an absent record". */
export const MISSING_VERSION = 'missing';

/**
 * The application data directory, computed the way the application computes it: the platform
 * data directory joined with the bundle identifier. This is deliberately not the configuration
 * directory that holds `models.json` and `auth.json`.
 *
 * Takes its inputs rather than reading the process, so every platform's mapping is testable.
 * `XDG_DATA_HOME` is honoured only when it is absolute, as the `dirs` crate does.
 */
export function applicationDataRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const base = platformDataRoot({ platform, env, home });
  return base === null ? null : path.join(base, APPLICATION_IDENTIFIER);
}

function platformDataRoot({ platform, env, home }) {
  if (platform === 'win32') return typeof env.APPDATA === 'string' && env.APPDATA ? path.resolve(env.APPDATA) : null;
  if (!home) return null;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === 'string' && path.isAbsolute(xdg)) return xdg;
  return path.join(home, '.local', 'share');
}

/**
 * The record path for one workspace. The id becomes a directory name under `learner-records/`,
 * so it is checked here as well as in the manifest validator: a segment that could escape the
 * directory must never reach a join.
 */
export function learnerRecordPath(dataRoot, workspaceId, file) {
  if (!isUsableWorkspaceId(workspaceId)) throw new Error(`\`${workspaceId}\` is not a usable workspace id`);
  const spec = learnerRecordFile(file);
  if (!spec) throw new Error(`\`${file}\` is not a learner record file`);
  return path.join(dataRoot, LEARNER_RECORDS_DIRECTORY, workspaceId, spec.file);
}

/** The directory holding one workspace's personal routes, one `<route id>.json` each. */
export function personalRoutesDirectory(dataRoot, workspaceId) {
  if (!isUsableWorkspaceId(workspaceId)) throw new Error(`\`${workspaceId}\` is not a usable workspace id`);
  return path.join(dataRoot, LEARNER_RECORDS_DIRECTORY, workspaceId, PERSONAL_ROUTES_DIRECTORY);
}

/** One personal route's file. The route id becomes a file name, so it is checked before the
 * join: a name that could escape `routes/` never reaches one. */
export function personalRoutePath(dataRoot, workspaceId, routeId) {
  return path.join(personalRoutesDirectory(dataRoot, workspaceId), routeFileName(routeId));
}

/* --------------------------------------------------------------------------------------- */
/* Protocol validation                                                                       */
/* --------------------------------------------------------------------------------------- */

const BASIS_PATTERN = /^[0-9a-f]{64}$/;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isBasis(value) {
  return typeof value === 'string' && BASIS_PATTERN.test(value);
}

/**
 * Parse one stored record. A `schema` string that is not the file's own is an *unreadable* file
 * — there is no input dialect — and it is reported as one rather than as a shape problem. Key
 * order and indentation are free: the record's *values* are what a `basis` covers.
 */
export function parseLearnerRecord(text, spec) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { document: null, unreadable: issue(CODE.LEARNER_RECORD_UNREADABLE, '/', `not valid JSON: ${error.message}`), issues: [] };
  }
  if (!isRecord(value)) {
    return { document: null, unreadable: issue(CODE.LEARNER_RECORD_UNREADABLE, '/', 'expected a JSON object'), issues: [] };
  }
  if (value.schema !== spec.schema) {
    return {
      document: null,
      unreadable: issue(CODE.LEARNER_RECORD_UNREADABLE, '/schema', `expected ${spec.schema}, found ${JSON.stringify(value.schema ?? null)}`),
      issues: [],
    };
  }
  return { document: value, unreadable: null, issues: spec.validate(value, { requireBasis: true }) };
}

function unknownKeys(value, allowed, pointer, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/${escapeJsonPointer(key)}`, 'not defined by this protocol'));
  }
}

/** `derivon.learning/v1`: two isomorphic maps of the same record shape, keyed by object id. */
function validateLearningDocument(value, { requireBasis }) {
  const issues = [];
  unknownKeys(value, ['schema', 'concepts', 'derivations'], '', issues);
  for (const key of ['concepts', 'derivations']) {
    const map = value[key];
    if (!isRecord(map)) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, `/${key}`, 'expected an object keyed by object id (write an empty object when there are no records)'));
      continue;
    }
    for (const [id, record] of Object.entries(map)) {
      if (!id.trim()) issues.push(issue(CODE.LEARNER_RECORD_INVALID, `/${key}`, 'an object id cannot be empty'));
      validateMasteryRecord(record, `/${key}/${escapeJsonPointer(id)}`, requireBasis, issues);
    }
  }
  return issues;
}

function validateMasteryRecord(value, pointer, requireBasis, issues) {
  if (!isRecord(value)) {
    issues.push(issue(CODE.LEARNER_RECORD_INVALID, pointer, 'expected an object'));
    return;
  }
  unknownKeys(value, ['status', 'basis', 'data'], pointer, issues);
  if (value.status !== 'complete' && value.status !== 'incomplete') {
    issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/status`, 'expected complete or incomplete'));
  }
  checkBasis(value, pointer, requireBasis, issues, 'this judgement was made against');
  let data = null;
  if (value.data !== undefined) {
    if (!isRecord(value.data)) issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/data`, 'expected an object'));
    else data = value.data;
  }
  /* A shape constraint, not a content constraint: "asked, and not reached" has to say
   * something about how it was reached. */
  if (value.status === 'incomplete' && (data === null || Object.keys(data).length === 0)) {
    issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/data`, 'an incomplete record must carry a non-empty data object'));
  }
}

/**
 * A `basis` is required in a stored file and optional in a document on its way in, which is why
 * the same check takes a flag. `suffix` names what the judgement was made against, so a caller
 * reading the message knows which file it came from.
 */
function checkBasis(value, pointer, requireBasis, issues, suffix) {
  if (value.basis === undefined) {
    if (requireBasis) issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/basis`, `missing the content basis ${suffix}`));
    return;
  }
  if (!isBasis(value.basis)) {
    issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/basis`, 'expected a 64-character lowercase hexadecimal SHA-256 hash'));
  }
}

/* --------------------------------------------------------------------------------------- */
/* Canonical text                                                                            */
/* --------------------------------------------------------------------------------------- */

/**
 * The canonical `state.json` text. Both writers serialize the same way — fixed key order, two
 * spaces, one trailing newline — so the same logical record is the same bytes whoever wrote it,
 * and a version read from one writer is meaningful to the other.
 */
function serializeLearningDocument(value) {
  const map = (records) => Object.fromEntries(Object.entries(records).map(([id, record]) => [id, {
    status: record.status,
    basis: record.basis,
    ...(record.data === undefined ? {} : { data: record.data }),
  }]));
  return `${JSON.stringify({
    schema: LEARNING_SCHEMA,
    concepts: map(value.concepts),
    derivations: map(value.derivations),
  }, null, 2)}\n`;
}

/* --------------------------------------------------------------------------------------- */
/* Filling in a basis                                                                        */
/* --------------------------------------------------------------------------------------- */

/**
 * Fill in every `basis` the caller left out, computing it from the workspace as it stands now.
 * A caller that read the file and only changed one record leaves the other records' bases
 * alone by *writing them*, which is the point: a basis is the evidence of what a judgement was
 * made against, and re-reading and re-writing a file must never silently refresh it. A basis
 * the caller supplies is kept as supplied, for the same reason.
 *
 * Throws `BasisError` — an unknown object, an uncomputable basis — which the command reports
 * without writing anything.
 */
async function fillLearningBasis(document, context) {
  for (const key of ['concepts', 'derivations']) {
    for (const [objectId, record] of Object.entries(document[key])) {
      if (record.basis === undefined) {
        record.basis = await masteryBasis({ realRoot: context.realRoot, manifest: context.manifest, objectId });
      }
    }
  }
}
