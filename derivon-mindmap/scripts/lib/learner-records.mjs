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
 * Two files, read and replaced independently:
 *   <application data directory>/learner-records/<workspace id>/state.json   — mastery
 *   <application data directory>/learner-records/<workspace id>/routes.json  — confirmed routes
 *
 * The key is the workspace id from the manifest, never the folder. Copy a workspace and the
 * copy shares the record; a workspace without an id is a broken workspace and never reaches
 * this directory.
 */

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { masteryBasis, routeBasis } from './basis.mjs';
import { CODE, issue } from './envelope.mjs';
import { escapeJsonPointer, isUsableWorkspaceId } from './workspace-validator.mjs';

const LEARNING_SCHEMA = 'derivon.learning/v1';
const ROUTES_SCHEMA = 'derivon.routes/v1';

/** The Tauri bundle identifier. The application data directory is the platform data directory
 * joined with it, so one constant names the directory both writers compute. */
const APPLICATION_IDENTIFIER = 'net.derivon.mindmap';
const LEARNER_RECORDS_DIRECTORY = 'learner-records';

/**
 * The two files, each carrying its own protocol: the shape it validates, the text it serializes
 * to, and how a `basis` it leaves out is computed. A third record protocol is a third entry
 * here, not a new branch in the commands.
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
  {
    name: 'routes',
    file: 'routes.json',
    schema: ROUTES_SCHEMA,
    validate: validateRoutesDocument,
    serialize: serializeRoutesDocument,
    fill: fillRoutesBasis,
  },
];

export const LEARNER_RECORD_FILE_NAMES = LEARNER_RECORD_FILES.map((entry) => entry.name);

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

/* --------------------------------------------------------------------------------------- */
/* Protocol validation                                                                       */
/* --------------------------------------------------------------------------------------- */

const BASIS_PATTERN = /^[0-9a-f]{64}$/;
const ROUTE_ID_PATTERN = /^r-[23456789abcdefghjkmnpqrstvwxyz]{6}$/;
const WEIGHT_SCALE = 10;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isBasis(value) {
  return typeof value === 'string' && BASIS_PATTERN.test(value);
}

/** A manifest weight's rule, reused for a route's solved cost: non-negative, one decimal place. */
function isValidCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  const scaled = Math.round(value * WEIGHT_SCALE);
  return Number.isSafeInteger(scaled) && Math.abs(value - scaled / WEIGHT_SCALE) < 1e-10;
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

/**
 * The application's `readStringList`: an array of non-empty strings, and nothing else. Kept
 * exactly as strict, because a writer here may not produce a file the application's reader
 * refuses — "both must produce a file the same reader accepts".
 */
function checkStringList(value, pointer, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue(CODE.LEARNER_RECORD_INVALID, pointer, 'expected an array of strings'));
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/${index}`, 'expected a non-empty string'));
    }
  });
}

const ROUTE_FIELDS = ['id', 'description', 'targets', 'known', 'basis', 'conceptIds', 'derivationIds', 'order', 'cost'];

/** `derivon.routes/v1`: several routes, each a reference-only solved subgraph. A route carries
 * **no completion marker of any kind** — no step state, no cursor, no per-derivation flag —
 * and an unknown key is reported, so a marker is refused by name rather than ignored. */
function validateRoutesDocument(value, { requireBasis }) {
  const issues = [];
  unknownKeys(value, ['schema', 'routes'], '', issues);
  if (!Array.isArray(value.routes)) {
    issues.push(issue(CODE.LEARNER_RECORD_INVALID, '/routes', 'expected an array (write an empty array when no route has been confirmed)'));
    return issues;
  }
  const ids = new Set();
  value.routes.forEach((route, index) => {
    const pointer = `/routes/${index}`;
    if (!isRecord(route)) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, pointer, 'expected an object'));
      return;
    }
    unknownKeys(route, ROUTE_FIELDS, pointer, issues);
    for (const field of ['targets', 'known', 'conceptIds', 'derivationIds', 'order']) {
      checkStringList(route[field], `${pointer}/${field}`, issues);
    }
    if (typeof route.id !== 'string' || !ROUTE_ID_PATTERN.test(route.id)) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/id`, 'expected r- plus six characters of the object id alphabet'));
    } else if (ids.has(route.id)) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/id`, `duplicate route id ${route.id}`));
    } else {
      ids.add(route.id);
    }
    if (typeof route.description !== 'string' || !route.description.trim()) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/description`, 'expected a non-empty string'));
    }
    checkBasis(route, pointer, requireBasis, issues, 'this route was solved against');
    if (!isValidCost(route.cost)) {
      issues.push(issue(CODE.LEARNER_RECORD_INVALID, `${pointer}/cost`, 'expected a finite, non-negative number with at most one decimal place'));
    }
  });
  return issues;
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

/** The canonical `routes.json` text. */
function serializeRoutesDocument(value) {
  return `${JSON.stringify({
    schema: ROUTES_SCHEMA,
    routes: value.routes.map((route) => ({
      id: route.id,
      description: route.description,
      targets: [...route.targets],
      known: [...route.known],
      basis: route.basis,
      conceptIds: [...route.conceptIds],
      derivationIds: [...route.derivationIds],
      order: [...route.order],
      cost: route.cost,
    })),
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

async function fillRoutesBasis(document, context) {
  for (const route of document.routes) {
    if (route.basis === undefined) {
      route.basis = routeBasis({ manifest: context.manifest, objectIds: [...route.conceptIds, ...route.derivationIds] });
    }
  }
}
