#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const values = process.argv.slice(2);
if (values.includes('--help') || values.includes('-h')) {
  usage();
  process.exit(0);
}

const command = values.shift();
const workspaceArg = values.shift();
if (!command || !workspaceArg) failUsage('Expected a command and workspace path');
if (!['start', 'show', 'record-round', 'reconcile', 'close', 'validate'].includes(command)) {
  failUsage(`Unknown command: ${command}`);
}

const targetPointIds = takeValues(values, '--target');
const expectedRevision = takeValue(values, '--expected-revision');
const roundFile = takeValue(values, '--round-file');
if (values.length) failUsage(`Unexpected argument: ${values[0]}`);

try {
  const context = await loadWorkspace(workspaceArg, command === 'start');
  context.statePath = path.join(context.teachingDirectory, 'state.json');

  switch (command) {
    case 'start':
      requireOnly({ targets: true, expected: 'optional' });
      await startAssessment(context, targetPointIds, expectedRevision);
      break;
    case 'show':
      requireOnly({});
      printState(await readState(context, true));
      break;
    case 'record-round':
      requireOnly({ expected: true, round: true });
      await recordRound(context, expectedRevision, roundFile);
      break;
    case 'reconcile':
      requireOnly({ expected: true });
      await reconcileState(context, expectedRevision);
      break;
    case 'close':
      requireOnly({ expected: true });
      await closeAssessment(context, expectedRevision);
      break;
    case 'validate': {
      requireOnly({});
      const current = await readState(context, true);
      console.log(JSON.stringify({ valid: true, revision: current.revision, statePath: context.statePath }, null, 2));
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function requireOnly({ targets = false, expected = false, round = false }) {
  if (targets && targetPointIds.length === 0) failUsage('start requires at least one --target');
  if (!targets && targetPointIds.length) failUsage(`--target is not valid for ${command}`);
  if (expected === true && !expectedRevision) failUsage(`${command} requires --expected-revision`);
  if (expected === false && expectedRevision) failUsage(`--expected-revision is not valid for ${command}`);
  if (expectedRevision && !/^[a-f0-9]{64}$/.test(expectedRevision)) failUsage('--expected-revision must be a SHA-256 hex digest');
  if (round && !roundFile) failUsage('record-round requires --round-file');
  if (!round && roundFile) failUsage(`--round-file is not valid for ${command}`);
}

async function loadWorkspace(input, createTeachingDirectory) {
  const root = await realpath(path.resolve(input));
  const derivonDirectory = path.join(root, '.derivon');
  const derivonInfo = await lstat(derivonDirectory).catch(() => null);
  if (!derivonInfo?.isDirectory() || derivonInfo.isSymbolicLink()) {
    throw new Error('Expected a real .derivon directory inside the workspace');
  }

  const manifestPath = path.join(derivonDirectory, 'workspace.json');
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error('Expected a real .derivon/workspace.json file');
  }
  const manifest = parseJson(await readFile(manifestPath, 'utf8'), manifestPath);
  if (manifest?.schema !== 'derivon.authoring/v0.3.0') {
    throw new Error('Teaching state requires derivon.authoring/v0.3.0');
  }
  if (!Array.isArray(manifest?.graph?.points) || !Array.isArray(manifest?.graph?.hyperedges)) {
    throw new Error('Workspace manifest has no valid graph arrays');
  }

  const objects = new Map();
  const pointIds = new Set();
  for (const point of manifest.graph.points) {
    addObject(objects, point, 'point');
    pointIds.add(point.id);
  }
  for (const hyperedge of manifest.graph.hyperedges) addObject(objects, hyperedge, 'hyperedge');

  const teachingDirectory = path.join(derivonDirectory, 'teaching');
  const teachingInfo = await lstat(teachingDirectory).catch(() => null);
  if (teachingInfo) await checkTeachingDirectory(root, teachingDirectory, teachingInfo);
  else if (!createTeachingDirectory) throw new Error('No .derivon/teaching directory exists in this workspace');

  return { root, manifestPath, teachingDirectory, manifest, objects, pointIds };
}

async function checkTeachingDirectory(root, directory, info) {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Expected .derivon/teaching to be a real directory');
  }
  const realTeaching = await realpath(directory);
  if (!inside(root, realTeaching)) throw new Error('.derivon/teaching resolves outside the workspace');
}

function addObject(objects, object, kind) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || typeof object.id !== 'string') {
    throw new Error(`Workspace contains an invalid ${kind}`);
  }
  if (objects.has(object.id)) throw new Error(`Workspace contains duplicate object ID ${object.id}`);
  objects.set(object.id, { kind, object });
}

async function startAssessment(context, targets, expected) {
  for (const target of targets) requirePoint(context, target, 'target');
  if (new Set(targets).size !== targets.length) throw new Error('Target point IDs must be unique');
  const teachingInfo = await lstat(context.teachingDirectory).catch(() => null);
  if (!teachingInfo) await mkdir(context.teachingDirectory, { mode: 0o700 });
  await checkTeachingDirectory(context.root, context.teachingDirectory, await lstat(context.teachingDirectory));

  let state;
  let previousRevision = null;
  const existing = await readState(context, false);
  if (existing) {
    if (!expected) throw new Error('Existing teaching state requires --expected-revision from show');
    assertRevision(existing.revision, expected);
    state = existing.state;
    previousRevision = existing.revision;
    if (state.activeAssessmentId) {
      throw new Error(`Teaching state already has active assessment ${state.activeAssessmentId}; close or continue it first`);
    }
  } else {
    if (expected) throw new Error('No teaching state exists for the supplied expected revision');
    const now = timestamp();
    state = {
      schema: 'derivon.teaching/v1',
      workspaceManifest: '.derivon/workspace.json',
      createdAt: now,
      updatedAt: now,
      activeAssessmentId: null,
      assessments: [],
      rounds: [],
      concepts: {},
    };
  }

  const now = timestamp();
  const assessmentId = nextId('assessment', state.assessments.map((item) => item.id));
  state.assessments.push({
    id: assessmentId,
    targetPointIds: [...targets],
    status: 'active',
    startedAt: now,
    closedAt: null,
    frontierPointIds: [...targets],
    roundCount: 0,
  });
  state.activeAssessmentId = assessmentId;
  state.updatedAt = now;
  await saveAndPrint(context, state, previousRevision);
}

async function recordRound(context, expected, inputPath) {
  const current = await readState(context, true);
  assertRevision(current.revision, expected);
  const state = current.state;
  const assessment = activeAssessment(state);
  const input = parseJson(await readFile(path.resolve(inputPath), 'utf8'), inputPath);
  validateRoundInput(input, context);

  const now = timestamp();
  const roundId = nextId('round', state.rounds.map((item) => item.id));
  const items = [];
  for (const item of input.items) {
    const basis = [];
    for (const objectId of item.basisObjectIds) {
      basis.push({ objectId, fingerprint: await objectFingerprint(context, objectId) });
    }
    const stored = {
      pointId: item.pointId,
      status: item.status,
      evidence: item.evidence,
      taskType: item.taskType,
      gap: item.gap ?? null,
      basis,
      stale: false,
    };
    items.push(stored);
    const previous = state.concepts[item.pointId];
    state.concepts[item.pointId] = {
      status: item.status,
      evidence: item.evidence,
      gap: item.gap ?? null,
      taskTypes: [...new Set([...(previous?.taskTypes ?? []), item.taskType])],
      updatedAt: now,
      roundId,
      basis,
      stale: false,
    };
  }

  const nextNumber = assessment.roundCount + 1;
  state.rounds.push({
    id: roundId,
    assessmentId: assessment.id,
    number: nextNumber,
    recordedAt: now,
    summary: input.summary ?? '',
    items,
    frontierPointIds: [...input.frontierPointIds],
  });
  assessment.frontierPointIds = [...input.frontierPointIds];
  assessment.roundCount = nextNumber;
  state.updatedAt = now;
  await saveAndPrint(context, state, current.revision);
}

async function reconcileState(context, expected) {
  const current = await readState(context, true);
  assertRevision(current.revision, expected);
  const state = current.state;
  let changed = false;
  const itemByRoundPoint = new Map();

  for (const round of state.rounds) {
    for (const item of round.items) {
      let stale = false;
      for (const basis of item.basis) {
        const fingerprint = await objectFingerprint(context, basis.objectId).catch(() => null);
        if (fingerprint !== basis.fingerprint) stale = true;
      }
      if (item.stale !== stale) {
        item.stale = stale;
        changed = true;
      }
      itemByRoundPoint.set(`${round.id}\0${item.pointId}`, item);
    }
  }

  for (const [pointId, concept] of Object.entries(state.concepts)) {
    const item = itemByRoundPoint.get(`${concept.roundId}\0${pointId}`);
    const stale = item ? item.stale : true;
    if (concept.stale !== stale) {
      concept.stale = stale;
      changed = true;
    }
  }

  if (changed) {
    state.updatedAt = timestamp();
    await saveAndPrint(context, state, current.revision);
  } else {
    printState(current);
  }
}

async function closeAssessment(context, expected) {
  const current = await readState(context, true);
  assertRevision(current.revision, expected);
  const state = current.state;
  const assessment = activeAssessment(state);
  const now = timestamp();
  assessment.status = 'closed';
  assessment.closedAt = now;
  state.activeAssessmentId = null;
  state.updatedAt = now;
  await saveAndPrint(context, state, current.revision);
}

function validateRoundInput(input, context) {
  strictObject(input, 'round', ['summary', 'items', 'frontierPointIds'], ['items', 'frontierPointIds']);
  if ('summary' in input && typeof input.summary !== 'string') throw new Error('round.summary must be a string');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('round.items must be a non-empty array');
  if (!Array.isArray(input.frontierPointIds)) throw new Error('round.frontierPointIds must be an array');
  uniqueStrings(input.frontierPointIds, 'round.frontierPointIds');
  for (const pointId of input.frontierPointIds) requirePoint(context, pointId, 'frontier');

  const assessed = new Set();
  for (const [index, item] of input.items.entries()) {
    const location = `round.items[${index}]`;
    strictObject(item, location, ['pointId', 'status', 'evidence', 'taskType', 'gap', 'basisObjectIds'], ['pointId', 'status', 'evidence', 'taskType', 'basisObjectIds']);
    requirePoint(context, item.pointId, `${location}.pointId`);
    if (assessed.has(item.pointId)) throw new Error(`${location}.pointId is duplicated in this round`);
    assessed.add(item.pointId);
    if (!['demonstrated', 'partial', 'not-demonstrated'].includes(item.status)) throw new Error(`${location}.status is invalid`);
    if (typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error(`${location}.evidence must be a non-empty summary`);
    if (typeof item.taskType !== 'string' || !item.taskType.trim()) throw new Error(`${location}.taskType must be non-empty`);
    if ('gap' in item && item.gap !== null && typeof item.gap !== 'string') throw new Error(`${location}.gap must be string or null`);
    if (!Array.isArray(item.basisObjectIds) || item.basisObjectIds.length === 0) throw new Error(`${location}.basisObjectIds must be non-empty`);
    uniqueStrings(item.basisObjectIds, `${location}.basisObjectIds`);
    if (!item.basisObjectIds.includes(item.pointId)) throw new Error(`${location}.basisObjectIds must include the assessed point`);
    for (const objectId of item.basisObjectIds) {
      if (!context.objects.has(objectId)) throw new Error(`${location}.basisObjectIds contains unknown object ${objectId}`);
    }
  }
}

async function readState(context, required) {
  const info = await lstat(context.statePath).catch(() => null);
  if (!info) {
    if (required) throw new Error('No teaching state exists in this workspace');
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Teaching state must be a real file');
  const realState = await realpath(context.statePath);
  if (!inside(context.root, realState)) throw new Error('Teaching state resolves outside the workspace');
  const raw = await readFile(context.statePath, 'utf8');
  const state = parseJson(raw, context.statePath);
  validateState(state);
  return { state, revision: digest(raw) };
}

async function saveAndPrint(context, state, previousRevision) {
  validateState(state);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const temporary = path.join(context.teachingDirectory, `.state.${randomUUID()}.tmp`);
  const lockPath = path.join(context.teachingDirectory, '.state.lock');
  let lock;
  let handle;
  try {
    lock = await open(lockPath, 'wx', 0o600).catch(() => {
      throw new Error(`Teaching state is locked by another writer: ${lockPath}`);
    });
    if (previousRevision === null) {
      const existing = await lstat(context.statePath).catch(() => null);
      if (existing) throw new Error('Teaching state was created by another writer; show it before retrying');
    } else {
      const latest = await readState(context, true);
      assertRevision(latest.revision, previousRevision);
    }

    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, context.statePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
    }
    await rm(temporary, { force: true }).catch(() => {});
  }
  printState({ state, revision: digest(text) });
}

function validateState(state) {
  strictObject(state, 'state', ['schema', 'workspaceManifest', 'createdAt', 'updatedAt', 'activeAssessmentId', 'assessments', 'rounds', 'concepts']);
  if (state.schema !== 'derivon.teaching/v1') throw new Error('state.schema must be derivon.teaching/v1');
  if (state.workspaceManifest !== '.derivon/workspace.json') throw new Error('state.workspaceManifest is invalid');
  validDate(state.createdAt, 'state.createdAt');
  validDate(state.updatedAt, 'state.updatedAt');
  if (state.activeAssessmentId !== null && typeof state.activeAssessmentId !== 'string') throw new Error('state.activeAssessmentId must be string or null');
  if (!Array.isArray(state.assessments) || !Array.isArray(state.rounds)) throw new Error('state assessments and rounds must be arrays');
  if (!state.concepts || typeof state.concepts !== 'object' || Array.isArray(state.concepts)) throw new Error('state.concepts must be an object');

  const assessmentIds = new Set();
  let activeCount = 0;
  for (const [index, assessment] of state.assessments.entries()) {
    const location = `state.assessments[${index}]`;
    strictObject(assessment, location, ['id', 'targetPointIds', 'status', 'startedAt', 'closedAt', 'frontierPointIds', 'roundCount']);
    validRecordId(assessment.id, 'assessment', location);
    if (assessmentIds.has(assessment.id)) throw new Error(`${location}.id is duplicated`);
    assessmentIds.add(assessment.id);
    uniqueObjectIds(assessment.targetPointIds, `${location}.targetPointIds`, true);
    uniqueObjectIds(assessment.frontierPointIds, `${location}.frontierPointIds`);
    if (!['active', 'closed'].includes(assessment.status)) throw new Error(`${location}.status is invalid`);
    validDate(assessment.startedAt, `${location}.startedAt`);
    if (assessment.closedAt !== null) validDate(assessment.closedAt, `${location}.closedAt`);
    if (!Number.isSafeInteger(assessment.roundCount) || assessment.roundCount < 0) throw new Error(`${location}.roundCount is invalid`);
    if (assessment.status === 'active') {
      activeCount += 1;
      if (assessment.closedAt !== null) throw new Error(`${location}.closedAt must be null while active`);
    } else if (assessment.closedAt === null) throw new Error(`${location}.closedAt is required when closed`);
  }
  if (activeCount > 1) throw new Error('state has more than one active assessment');
  if (state.activeAssessmentId !== null) {
    const active = state.assessments.find((item) => item.id === state.activeAssessmentId);
    if (!active || active.status !== 'active') throw new Error('state.activeAssessmentId does not identify an active assessment');
  } else if (activeCount !== 0) throw new Error('state has an active assessment without activeAssessmentId');

  const roundIds = new Set();
  const roundCounts = new Map();
  const roundPointKeys = new Set();
  for (const [index, round] of state.rounds.entries()) {
    const location = `state.rounds[${index}]`;
    strictObject(round, location, ['id', 'assessmentId', 'number', 'recordedAt', 'summary', 'items', 'frontierPointIds']);
    validRecordId(round.id, 'round', location);
    if (roundIds.has(round.id)) throw new Error(`${location}.id is duplicated`);
    roundIds.add(round.id);
    if (!assessmentIds.has(round.assessmentId)) throw new Error(`${location}.assessmentId is unknown`);
    if (!Number.isSafeInteger(round.number) || round.number < 1) throw new Error(`${location}.number is invalid`);
    validDate(round.recordedAt, `${location}.recordedAt`);
    if (typeof round.summary !== 'string') throw new Error(`${location}.summary must be a string`);
    if (!Array.isArray(round.items) || round.items.length === 0) throw new Error(`${location}.items must be non-empty`);
    uniqueObjectIds(round.frontierPointIds, `${location}.frontierPointIds`);
    const key = `${round.assessmentId}\0${round.number}`;
    if (roundCounts.has(key)) throw new Error(`${location}.number is duplicated for its assessment`);
    roundCounts.set(key, true);
    const roundPoints = new Set();
    for (const [itemIndex, item] of round.items.entries()) {
      validateStoredItem(item, `${location}.items[${itemIndex}]`);
      if (roundPoints.has(item.pointId)) throw new Error(`${location}.items repeats point ${item.pointId}`);
      roundPoints.add(item.pointId);
      roundPointKeys.add(`${round.id}\0${item.pointId}`);
    }
  }
  for (const assessment of state.assessments) {
    const numbers = state.rounds.filter((round) => round.assessmentId === assessment.id).map((round) => round.number).sort((left, right) => left - right);
    if (assessment.roundCount !== numbers.length) throw new Error(`assessment ${assessment.id} roundCount does not match history`);
    if (numbers.some((number, index) => number !== index + 1)) throw new Error(`assessment ${assessment.id} round numbers are not contiguous`);
  }

  for (const [pointId, concept] of Object.entries(state.concepts)) {
    if (!validObjectId(pointId)) throw new Error(`state.concepts has invalid point ID ${pointId}`);
    strictObject(concept, `state.concepts.${pointId}`, ['status', 'evidence', 'gap', 'taskTypes', 'updatedAt', 'roundId', 'basis', 'stale']);
    validStatus(concept.status, `state.concepts.${pointId}.status`);
    if (typeof concept.evidence !== 'string' || typeof concept.gap !== 'string' && concept.gap !== null) throw new Error(`state.concepts.${pointId} has invalid evidence or gap`);
    uniqueStrings(concept.taskTypes, `state.concepts.${pointId}.taskTypes`, true);
    validDate(concept.updatedAt, `state.concepts.${pointId}.updatedAt`);
    if (!roundIds.has(concept.roundId) || !roundPointKeys.has(`${concept.roundId}\0${pointId}`)) throw new Error(`state.concepts.${pointId}.roundId has no matching item`);
    validateBasis(concept.basis, `state.concepts.${pointId}.basis`);
    if (typeof concept.stale !== 'boolean') throw new Error(`state.concepts.${pointId}.stale must be boolean`);
  }
}

function validateStoredItem(item, location) {
  strictObject(item, location, ['pointId', 'status', 'evidence', 'taskType', 'gap', 'basis', 'stale']);
  if (!validObjectId(item.pointId)) throw new Error(`${location}.pointId is invalid`);
  validStatus(item.status, `${location}.status`);
  if (typeof item.evidence !== 'string' || !item.evidence) throw new Error(`${location}.evidence is invalid`);
  if (typeof item.taskType !== 'string' || !item.taskType) throw new Error(`${location}.taskType is invalid`);
  if (item.gap !== null && typeof item.gap !== 'string') throw new Error(`${location}.gap is invalid`);
  validateBasis(item.basis, `${location}.basis`);
  if (typeof item.stale !== 'boolean') throw new Error(`${location}.stale must be boolean`);
}

function validateBasis(basis, location) {
  if (!Array.isArray(basis) || basis.length === 0) throw new Error(`${location} must be non-empty`);
  const ids = new Set();
  for (const [index, entry] of basis.entries()) {
    strictObject(entry, `${location}[${index}]`, ['objectId', 'fingerprint']);
    if (!validObjectId(entry.objectId) || ids.has(entry.objectId)) throw new Error(`${location}[${index}].objectId is invalid or duplicated`);
    ids.add(entry.objectId);
    if (typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) throw new Error(`${location}[${index}].fingerprint is invalid`);
  }
}

async function objectFingerprint(context, objectId) {
  const entry = context.objects.get(objectId);
  if (!entry) throw new Error(`Unknown basis object ${objectId}`);
  const hash = createHash('sha256');
  hash.update(stableStringify({ kind: entry.kind, object: entry.object }));
  const document = entry.object?.data?.document;
  if (typeof document !== 'string' || !safeRelativeDirectory(document)) throw new Error(`Object ${objectId} has an unsafe document directory`);
  const directory = await realpath(path.join(context.root, document));
  if (!inside(context.root, directory)) throw new Error(`Object ${objectId} document resolves outside the workspace`);
  await hashDirectory(hash, directory, '');
  return hash.digest('hex');
}

async function hashDirectory(hash, directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Document contains symbolic link ${relative}`);
    hash.update(`\0${relative}\0${info.isDirectory() ? 'd' : 'f'}\0`);
    if (info.isDirectory()) await hashDirectory(hash, absolute, relative);
    else if (info.isFile()) hash.update(await readFile(absolute));
    else throw new Error(`Document contains unsupported file ${relative}`);
  }
}

function activeAssessment(state) {
  if (!state.activeAssessmentId) throw new Error('Teaching state has no active assessment');
  const assessment = state.assessments.find((item) => item.id === state.activeAssessmentId);
  if (!assessment) throw new Error('Active assessment is missing');
  return assessment;
}

function requirePoint(context, pointId, location) {
  if (typeof pointId !== 'string' || !context.pointIds.has(pointId)) throw new Error(`${location} references unknown point ${String(pointId)}`);
}

function assertRevision(actual, expected) {
  if (actual !== expected) throw new Error(`Revision conflict: expected ${expected}, current ${actual}`);
}

function strictObject(value, location, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${location}.${key} is not allowed`);
  for (const key of required) if (!(key in value)) throw new Error(`${location}.${key} is required`);
}

function uniqueStrings(value, location, nonEmpty = false) {
  if (!Array.isArray(value) || nonEmpty && value.length === 0 || value.some((item) => typeof item !== 'string')) throw new Error(`${location} must be ${nonEmpty ? 'a non-empty ' : 'an '}array of strings`);
  if (new Set(value).size !== value.length) throw new Error(`${location} contains duplicates`);
}

function uniqueObjectIds(value, location, nonEmpty = false) {
  uniqueStrings(value, location, nonEmpty);
  if (value.some((item) => !validObjectId(item))) throw new Error(`${location} contains an invalid object ID`);
}

function validStatus(value, location) {
  if (!['demonstrated', 'partial', 'not-demonstrated'].includes(value)) throw new Error(`${location} is invalid`);
}

function validDate(value, location) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${location} must be a canonical ISO date string`);
  }
}

function validRecordId(value, prefix, location) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[1-9][0-9]*$`).test(value)) throw new Error(`${location}.id is invalid`);
}

function validObjectId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function safeRelativeDirectory(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.length >= 2 && parts[0] !== '.derivon' && parts.every((part) => part && part !== '.' && part !== '..');
}
function inside(root, candidate) { return candidate !== root && candidate.startsWith(`${root}${path.sep}`); }
function parseJson(text, source) {
  try { return JSON.parse(text); } catch (error) { throw new Error(`${source}: ${error.message}`); }
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function timestamp() { return new Date().toISOString(); }
function nextId(prefix, existing) {
  const used = new Set(existing);
  let number = 1;
  while (used.has(`${prefix}-${number}`)) number += 1;
  return `${prefix}-${number}`;
}
function printState(current) {
  console.log(JSON.stringify({ revision: current.revision, state: current.state }, null, 2));
}
function takeValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) failUsage(`Missing value for ${flag}`);
  args.splice(index, 2);
  return value;
}
function takeValues(args, flag) {
  const found = [];
  let index;
  while ((index = args.indexOf(flag)) >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) failUsage(`Missing value for ${flag}`);
    found.push(value);
    args.splice(index, 2);
  }
  return found;
}
function failUsage(message) { console.error(message); usage(); process.exit(2); }
function usage() {
  console.error(`Usage:
  assessment-state.mjs start <workspace> --target <point-id>... [--expected-revision <sha256>]
  assessment-state.mjs show <workspace>
  assessment-state.mjs record-round <workspace> --expected-revision <sha256> --round-file <json>
  assessment-state.mjs reconcile <workspace> --expected-revision <sha256>
  assessment-state.mjs close <workspace> --expected-revision <sha256>
  assessment-state.mjs validate <workspace>`);
}
