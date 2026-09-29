/**
 * Routes: `derivon.route/v1`, one route per file, in two places.
 *
 *   <workspace>/.derivon/routes/<id>.json                                         — workspace routes
 *   <application data directory>/learner-records/<workspace id>/routes/<id>.json — personal routes
 *
 * A route is a derivation subgraph (`steps`) with an optional written order (`ordered`), plus the
 * concepts it starts from (`known`) and the concepts it leads to (`targets`). It references the
 * manifest's graph by id, copies none of it, and carries no completion marker. The location
 * decides two fields: a workspace route may carry neither `basis` nor `basedOn`; a personal route
 * must carry `basis` and may carry `basedOn`.
 *
 * The normative text is `derivon-mindmap`'s `docs/routes.md`. This module is the script command
 * surface's implementation of it, beside the application's TypeScript: **one specification, two
 * writers** (`derivon-mindmap`'s ADR-0011). Both must accept and refuse the same files and report
 * the same diagnostic codes for the same subjects, so the decoding layers, the codes, the
 * execution order, the gap walk and the canonical text are mirrored here, not invented.
 * Messages are free text and are not part of the protocol.
 *
 * Reading a file is two layers. A file that fails decoding is unreadable and yields no route;
 * a file that decodes yields a route, which validation then diagnoses in full against the graph.
 * Errors make a route invalid and refuse a write; warnings are shown and never refuse anything.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { routeBasis } from './basis.mjs';
import { CODE, issue } from './envelope.mjs';
import { insideRealRoot, sha256 } from './fs.mjs';
import { escapeJsonPointer } from './workspace-validator.mjs';

export const ROUTE_SCHEMA = 'derivon.route/v1';
export const ROUTES_DIRECTORY = '.derivon/routes';

/** `r-` plus six characters of the object id alphabet. It becomes a file name, so it is checked
 * before any path join. */
export const ROUTE_ID_PATTERN = /^r-[23456789abcdefghjkmnpqrstvwxyz]{6}$/;

const BASIS_PATTERN = /^[0-9a-f]{64}$/;
const WEIGHT_SCALE = 10;
/** The ten keys, in the order a writer emits them. */
const ROUTE_KEYS = ['schema', 'id', 'label', 'description', 'known', 'targets', 'steps', 'ordered', 'basedOn', 'basis'];
const REQUIRED_KEYS = ['id', 'label', 'known', 'targets', 'steps', 'ordered'];

export const LOCATIONS = ['workspace', 'personal'];

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function isRouteId(value) {
  return typeof value === 'string' && ROUTE_ID_PATTERN.test(value);
}

/** The file name a route with this id is stored under, in either location. */
export function routeFileName(id) {
  if (!isRouteId(id)) throw new Error(`\`${id}\` is not a route id`);
  return `${id}.json`;
}

/** Is this directory entry a route file? Direct child files whose name ends in `.json`, and
 * nothing else — which keeps a temporary a crashed replacement left behind inert. */
export function isRouteFileName(name) {
  return name.endsWith('.json');
}

/* --------------------------------------------------------------------------------------- */
/* Decoding: the unreadable layer                                                            */
/* --------------------------------------------------------------------------------------- */

/**
 * Decode one JSON value as a route. Returns every unreadable-layer issue that holds —
 * `unreadable`, `wrong-schema`, `unknown-key`, `missing-field`, `invalid-field` — and an empty
 * list for a value that is a route. `basis` and `basedOn` are decoded wherever they appear;
 * whether they are allowed there is validation.
 */
export function decodeRoute(value, { prefix = '' } = {}) {
  const at = (pointer) => `${prefix}#${pointer}`;
  if (!isRecord(value)) return [issue(CODE.ROUTE_UNREADABLE, at(''), 'expected a JSON object')];
  const issues = [];
  if (value.schema !== ROUTE_SCHEMA) {
    issues.push(issue(CODE.ROUTE_WRONG_SCHEMA, at('/schema'), `expected ${ROUTE_SCHEMA}, found ${JSON.stringify(value.schema ?? null)}`));
  }
  for (const key of Object.keys(value)) {
    if (!ROUTE_KEYS.includes(key)) issues.push(issue(CODE.ROUTE_UNKNOWN_KEY, at(`/${escapeJsonPointer(key)}`), 'not defined by derivon.route/v1'));
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) issues.push(issue(CODE.ROUTE_MISSING_FIELD, at(`/${key}`), 'missing'));
  }
  const invalid = (key, message) => issues.push(issue(CODE.ROUTE_INVALID_FIELD, at(`/${key}`), message));
  if ('id' in value && !isRouteId(value.id)) invalid('id', 'expected r- plus six characters of 23456789abcdefghjkmnpqrstvwxyz');
  if ('basedOn' in value && !isRouteId(value.basedOn)) invalid('basedOn', 'expected the id of the workspace route this one was copied from');
  if ('basis' in value && !(typeof value.basis === 'string' && BASIS_PATTERN.test(value.basis))) invalid('basis', 'expected 64 lowercase hexadecimal characters');
  if ('label' in value && typeof value.label !== 'string') invalid('label', 'expected a string');
  if ('description' in value && typeof value.description !== 'string') invalid('description', 'expected a string');
  for (const key of ['known', 'targets', 'steps']) {
    if (key in value && !isStringList(value[key])) invalid(key, 'expected an array of strings');
  }
  if ('ordered' in value && typeof value.ordered !== 'boolean') invalid('ordered', 'expected true (steps are the route order) or false (steps are a set)');
  return issues;
}

/**
 * Parse one stored route file's text. Returns `{ route, issues }`: `route` is null when the file
 * is unreadable, and `issues` then holds every unreadable-layer condition.
 */
export function parseRoute(text, { prefix = '' } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { route: null, issues: [issue(CODE.ROUTE_UNREADABLE, `${prefix}#`, `not valid JSON: ${error.message}`)] };
  }
  const issues = decodeRoute(value, { prefix });
  return issues.length ? { route: null, issues } : { route: value, issues: [] };
}

/* --------------------------------------------------------------------------------------- */
/* Validation: shape errors                                                                  */
/* --------------------------------------------------------------------------------------- */

/**
 * The shape errors of a decoded route: `id-mismatch` (read from a file whose name is not
 * `<id>.json`), `empty-label`, `empty-targets`, `duplicate-step` (once per repeated id),
 * `forbidden-field` (a workspace route's `basis` or `basedOn`, per key) and `missing-basis`.
 */
export function shapeErrors(route, { location, fileName, prefix = '' }) {
  if (!LOCATIONS.includes(location)) throw new Error(`unknown route location ${location}`);
  const errors = [];
  const add = (code, pointer, message, subject) => errors.push({ code, path: `${prefix}#${pointer}`, ...subject, message });
  if (fileName !== undefined && fileName !== `${route.id}.json`) {
    add(CODE.ROUTE_ID_MISMATCH, '/id', `the route id ${route.id} does not match its file name ${fileName}`, { key: 'id' });
  }
  if (!route.label.trim()) add(CODE.ROUTE_EMPTY_LABEL, '/label', 'a route needs a name', { key: 'label' });
  if (route.targets.length === 0) add(CODE.ROUTE_EMPTY_TARGETS, '/targets', 'a route leads to at least one target', { key: 'targets' });
  const seen = new Set();
  const reported = new Set();
  route.steps.forEach((id, index) => {
    if (seen.has(id) && !reported.has(id)) {
      reported.add(id);
      add(CODE.ROUTE_DUPLICATE_STEP, `/steps/${index}`, `derivation ${id} occurs in steps more than once`, { derivationId: id });
    }
    seen.add(id);
  });
  if (location === 'workspace') {
    for (const key of ['basedOn', 'basis']) {
      if (route[key] !== undefined) add(CODE.ROUTE_FORBIDDEN_FIELD, `/${key}`, `a workspace route carries no ${key}`, { key });
    }
  } else if (route.basis === undefined) {
    add(CODE.ROUTE_MISSING_BASIS, '/basis', 'a personal route carries the basis it was saved against', { key: 'basis' });
  }
  return errors;
}

/**
 * The canonical text: two-space indentation, one trailing newline, keys in protocol order, and
 * `description` and `basedOn` omitted when they have no value. It refuses a route that does not
 * decode or has a shape error; the graph errors are the caller's to refuse first.
 */
export function serializeRoute(route, { location }) {
  const refusals = decodeRoute(route);
  if (!refusals.length) refusals.push(...shapeErrors(route, { location }));
  if (refusals.length) throw new Error(`refusing to serialize an invalid route: ${refusals.map((entry) => `${entry.code} ${entry.path}`).join('; ')}`);
  return `${JSON.stringify({
    schema: ROUTE_SCHEMA,
    id: route.id,
    label: route.label,
    ...(route.description ? { description: route.description } : {}),
    known: [...route.known],
    targets: [...route.targets],
    steps: [...route.steps],
    ordered: route.ordered,
    ...(route.basedOn ? { basedOn: route.basedOn } : {}),
    ...(route.basis === undefined ? {} : { basis: route.basis }),
  }, null, 2)}\n`;
}

/* --------------------------------------------------------------------------------------- */
/* Reading a route on the graph                                                              */
/* --------------------------------------------------------------------------------------- */

function graphIndex(manifest) {
  const points = Array.isArray(manifest?.graph?.points) ? manifest.graph.points : [];
  const hyperedges = Array.isArray(manifest?.graph?.hyperedges) ? manifest.graph.hyperedges : [];
  const concepts = new Map();
  for (const point of points) if (typeof point?.id === 'string') concepts.set(point.id, point);
  const edges = new Map();
  for (const edge of hyperedges) {
    if (typeof edge?.id !== 'string' || typeof edge.head !== 'string' || !Array.isArray(edge.tails)) continue;
    edges.set(edge.id, edge);
  }
  return { concepts, edges, hyperedges: [...edges.values()] };
}

function labelOf(index, id) {
  const label = index.concepts.get(id)?.data?.label;
  return typeof label === 'string' && label ? `${label} (${id})` : id;
}

/** The steps: entries of `steps` whose derivation is in the graph, first occurrence only. */
function stepsOf(index, route) {
  return [...new Set(route.steps)].filter((id) => index.edges.has(id));
}

/**
 * The execution order: go through the steps in list order, firing every step whose premises
 * are all in hand, until a pass fires nothing. A step fired earlier in a pass is in hand for the
 * steps after it in the same pass. Steps that never fire are returned apart, in list order.
 */
export function executableOrder(manifest, known, steps) {
  const index = graphIndex(manifest);
  return fire(index, known, [...new Set(steps)].filter((id) => index.edges.has(id)));
}

function fire(index, known, steps) {
  const have = new Set(known);
  const pending = [...steps];
  const order = [];
  for (let fired = true; fired;) {
    fired = false;
    for (const id of [...pending]) {
      const edge = index.edges.get(id);
      if (!edge.tails.every((tail) => have.has(tail))) continue;
      order.push(id);
      have.add(edge.head);
      pending.splice(pending.indexOf(id), 1);
      fired = true;
    }
  }
  return { order, unfired: pending, closure: have };
}

/**
 * Validate one decoded route against the graph: the shape errors, then the graph errors and
 * warnings, and the reading — display order, concepts, cost, blocked count. `fileName` is the
 * name of the file the route was read from, when it was read from one. `prefix` names the file
 * in each diagnostic's path.
 *
 * Errors: the shape errors, dangling-concept, dangling-derivation, target-unreached (with its
 * gaps), order-not-executable. Warnings: never-fires, idle, duplicate-head. Positions are 1-based
 * positions in the display order.
 */
export function validateRoute(manifest, route, { location, fileName, prefix = '' }) {
  const index = graphIndex(manifest);
  const errors = shapeErrors(route, { location, fileName, prefix });
  const warnings = [];
  const at = (pointer) => `${prefix}#${pointer}`;

  /* `known` and `targets` are sets, and a repeated step is diagnosed once: every diagnostic
   * below is per id, at its first occurrence. */
  const firstOccurrences = (list) => [...new Set(list)].map((id) => [id, list.indexOf(id)]);
  for (const field of ['known', 'targets']) {
    for (const [conceptId, position] of firstOccurrences(route[field])) {
      if (!index.concepts.has(conceptId)) {
        errors.push({ code: CODE.DANGLING_CONCEPT, path: at(`/${field}/${position}`), conceptId, field, message: `concept ${conceptId} in ${field} is not in the graph` });
      }
    }
  }
  for (const [derivationId, position] of firstOccurrences(route.steps)) {
    if (!index.edges.has(derivationId)) {
      errors.push({ code: CODE.DANGLING_DERIVATION, path: at(`/steps/${position}`), derivationId, message: `derivation ${derivationId} is not in the graph` });
    }
  }

  const steps = stepsOf(index, route);
  const { order: fired, unfired, closure } = fire(index, route.known, steps);
  const order = route.ordered ? steps : [...fired, ...unfired];
  const positionOf = new Map(order.map((id, position) => [id, position + 1]));
  const stepPath = (id) => at(`/steps/${route.steps.indexOf(id)}`);

  /* Gaps: walk down from each unreached target through the route's own producers, and stop at
   * each concept nothing in the route concludes. */
  const producers = new Map();
  for (const id of steps) {
    const head = index.edges.get(id).head;
    if (!producers.has(head)) producers.set(head, id);
  }
  for (const [targetId, position] of firstOccurrences(route.targets)) {
    if (!index.concepts.has(targetId) || closure.has(targetId)) continue;
    const gaps = [];
    const visited = new Set();
    const visit = (conceptId, wantedBy) => {
      if (closure.has(conceptId) || visited.has(conceptId)) return;
      visited.add(conceptId);
      const producer = producers.get(conceptId);
      if (producer) {
        for (const tail of index.edges.get(producer).tails) visit(tail, producer);
        return;
      }
      gaps.push({ conceptId, wantedBy, candidates: index.hyperedges.filter((edge) => edge.head === conceptId).map((edge) => edge.id) });
    };
    visit(targetId, targetId);
    const described = gaps.map((gap) => `${labelOf(index, gap.conceptId)}, wanted by ${gap.wantedBy === targetId ? 'the target itself' : gap.wantedBy}, concluded in the graph by ${gap.candidates.length ? gap.candidates.join(', ') : 'no derivation'}`);
    errors.push({
      code: CODE.TARGET_UNREACHED,
      path: at(`/targets/${position}`),
      targetId,
      gaps,
      message: `target ${labelOf(index, targetId)} is not reached from known through the steps${described.length ? `; missing: ${described.join('; ')}` : '; the steps leading to it form a cycle nothing outside it starts'}`,
    });
  }

  if (route.ordered) {
    const have = new Set(route.known);
    const concludedAt = new Map();
    for (const id of order) {
      const head = index.edges.get(id).head;
      if (!concludedAt.has(head)) concludedAt.set(head, positionOf.get(id));
    }
    for (const id of order) {
      const edge = index.edges.get(id);
      const missing = edge.tails.filter((tail) => !have.has(tail));
      if (missing.length && !unfired.includes(id)) {
        const needs = missing.map((conceptId) => ({ conceptId, producedAt: concludedAt.get(conceptId) ?? null }));
        errors.push({
          code: CODE.ORDER_NOT_EXECUTABLE,
          path: stepPath(id),
          derivationId: id,
          position: positionOf.get(id),
          needs,
          message: `step ${positionOf.get(id)} (${id}) uses ${needs.map((need) => `${labelOf(index, need.conceptId)}, ${need.producedAt === null ? 'which no step concludes' : `which step ${need.producedAt} concludes`}`).join('; ')}`,
        });
      }
      have.add(edge.head);
    }
  }

  /* Root causes only. A root is an unfired step missing a premise no step concludes; a step
   * that waits on a root, directly or through other waiting steps, is blocked and counted.
   * Steps left over wait only on each other in a cycle nothing outside starts: the first of
   * them in list order that lies on such a cycle is a root too, and so on until none is left. */
  const heads = new Set(steps.map((id) => index.edges.get(id).head));
  const missingOf = new Map(unfired.map((id) => [id, index.edges.get(id).tails.filter((tail) => !closure.has(tail))]));
  const waitsOn = (id) => unfired.filter((other) => missingOf.get(id).includes(index.edges.get(other).head));
  const roots = unfired.filter((id) => missingOf.get(id).some((tail) => !heads.has(tail)));
  const explained = new Set(roots);
  const explain = () => {
    for (let grew = true; grew;) {
      grew = false;
      for (const id of unfired) {
        if (explained.has(id) || !waitsOn(id).some((other) => explained.has(other))) continue;
        explained.add(id);
        grew = true;
      }
    }
  };
  const onCycle = (id) => {
    const seen = new Set();
    const stack = waitsOn(id);
    while (stack.length) {
      const next = stack.pop();
      if (next === id) return true;
      if (seen.has(next) || explained.has(next)) continue;
      seen.add(next);
      stack.push(...waitsOn(next));
    }
    return false;
  };
  const nextCycleRoot = () => unfired.find((id) => !explained.has(id) && onCycle(id));
  explain();
  for (let root = nextCycleRoot(); root; root = nextCycleRoot()) {
    roots.push(root);
    explained.add(root);
    explain();
  }
  const rootSet = new Set(roots);
  const blocked = unfired.length - rootSet.size;
  for (const id of unfired) {
    if (!rootSet.has(id)) continue;
    const missing = missingOf.get(id);
    const unobtainable = missing.filter((tail) => !heads.has(tail));
    const reason = unobtainable.length
      ? `${unobtainable.map((conceptId) => labelOf(index, conceptId)).join(', ')} never becomes available`
      : `${missing.map((conceptId) => labelOf(index, conceptId)).join(', ')} is concluded only by steps that wait on each other`;
    warnings.push({ code: CODE.NEVER_FIRES, path: stepPath(id), derivationId: id, position: positionOf.get(id), missing, message: `step ${positionOf.get(id)} (${id}) never fires: ${reason}` });
  }

  const first = new Map();
  const duplicates = new Set();
  for (const id of order) {
    const head = index.edges.get(id).head;
    const earlier = first.get(head);
    if (earlier === undefined) {
      first.set(head, id);
      continue;
    }
    duplicates.add(id);
    warnings.push({ code: CODE.DUPLICATE_HEAD, path: stepPath(id), derivationId: id, position: positionOf.get(id), conceptId: head, earlierDerivationId: earlier, earlierPosition: positionOf.get(earlier), message: `step ${positionOf.get(id)} (${id}) concludes ${labelOf(index, head)}, which step ${positionOf.get(earlier)} (${earlier}) already concludes` });
  }

  /* Needed steps, only when every target is reached. */
  if (route.targets.every((targetId) => closure.has(targetId))) {
    const known = new Set(route.known);
    const needed = new Set();
    const wanted = route.targets.filter((targetId) => !known.has(targetId));
    while (wanted.length) {
      const producer = first.get(wanted.pop());
      if (producer === undefined || needed.has(producer)) continue;
      needed.add(producer);
      for (const tail of index.edges.get(producer).tails) if (!known.has(tail)) wanted.push(tail);
    }
    for (const id of order) {
      if (unfired.includes(id) || needed.has(id) || duplicates.has(id)) continue;
      warnings.push({ code: CODE.IDLE, path: stepPath(id), derivationId: id, position: positionOf.get(id), message: `step ${positionOf.get(id)} (${id}) is not needed for any target` });
    }
  }

  const concepts = new Set(route.known);
  for (const id of order) {
    const edge = index.edges.get(id);
    for (const conceptId of [...edge.tails, edge.head]) concepts.add(conceptId);
  }
  const cost = Math.round(order.reduce((total, id) => total + (Number(index.edges.get(id).weight) || 0) * WEIGHT_SCALE, 0)) / WEIGHT_SCALE;
  return {
    status: errors.length ? 'invalid' : 'ready',
    order,
    orderSource: route.ordered ? 'written' : 'computed',
    conceptIds: [...concepts].filter((conceptId) => index.concepts.has(conceptId)),
    cost,
    blocked,
    errors,
    warnings,
  };
}

/** Diagnostics as envelope issues: code, path, message. */
export function asIssues(diagnostics) {
  return diagnostics.map((entry) => issue(entry.code, entry.path, entry.message));
}

/**
 * The objects a personal route's `basis` covers: every concept in `known` and `targets`, every
 * derivation in `steps`, and the premises and conclusion of every step in the graph. An id the
 * graph does not have contributes nothing, as in the application's `routeBasis`.
 */
export function routeObjectIds(manifest, route) {
  const index = graphIndex(manifest);
  const ids = [...route.known, ...route.targets, ...route.steps];
  for (const id of route.steps) {
    const edge = index.edges.get(id);
    if (edge) ids.push(...edge.tails, edge.head);
  }
  return [...new Set(ids)];
}

export function personalRouteBasis(manifest, route) {
  return routeBasis({ manifest, objectIds: routeObjectIds(manifest, route) });
}

/* --------------------------------------------------------------------------------------- */
/* Route directories                                                                         */
/* --------------------------------------------------------------------------------------- */

/**
 * List a route directory: its direct child files whose name ends in `.json`. Subdirectories
 * and other names are not routes and are skipped; a symbolic link is refused rather than
 * followed; an absent directory is an empty list. `realRoot`, when given, is the real root the
 * directory must stay inside.
 */
export async function listRouteFiles(directory, { realRoot = null, label = directory } = {}) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return { files: [], issues: [] };
    return { files: [], issues: [issue(CODE.IO_ERROR, label, error.message)] };
  }
  if (info.isSymbolicLink()) return { files: [], issues: [issue(CODE.DOCUMENT_UNSAFE, label, 'the route directory is a symbolic link; it is refused rather than followed')] };
  if (!info.isDirectory()) return { files: [], issues: [issue(CODE.IO_ERROR, label, 'expected a directory')] };
  if (realRoot !== null && !insideRealRoot(realRoot, await realpath(directory))) {
    return { files: [], issues: [issue(CODE.DOCUMENT_UNSAFE, label, 'the route directory resolves outside the workspace')] };
  }
  const issues = [];
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const at = `${label}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      issues.push(issue(CODE.DOCUMENT_UNSAFE, at, 'a symbolic link in the route directory is refused rather than followed'));
      continue;
    }
    if (!entry.isFile() || !isRouteFileName(entry.name)) continue;
    files.push({ name: entry.name, path: path.join(directory, entry.name), label: at });
  }
  return { files, issues };
}

/**
 * Read and validate one route file. `version` is the SHA-256 of its bytes, or null when it is
 * absent. An unreadable file is still a route file: it is returned with its diagnosis and no
 * route. `errors` are the route's errors (or its unreadable-layer issues) as envelope issues.
 */
export async function loadRouteFile(target, { location, fileName = path.basename(target), manifest, label }) {
  const none = { route: null, reading: null, warnings: [] };
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, version: null, text: null, ...none, errors: [] };
    return { present: true, version: null, text: null, ...none, errors: [issue(CODE.ROUTE_UNREADABLE, `${label}#`, error.message)] };
  }
  if (info.isSymbolicLink()) {
    return { present: true, version: null, text: null, ...none, errors: [issue(CODE.DOCUMENT_UNSAFE, label, 'a symbolic link is refused rather than followed')] };
  }
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    return { present: true, version: null, text: null, ...none, errors: [issue(CODE.ROUTE_UNREADABLE, `${label}#`, error.message)] };
  }
  const version = sha256(bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return { present: true, version, text: null, ...none, errors: [issue(CODE.ROUTE_UNREADABLE, `${label}#`, `not valid UTF-8: ${error.message}`)] };
  }
  const parsed = parseRoute(text, { prefix: label });
  if (!parsed.route) return { present: true, version, text, ...none, errors: parsed.issues };
  const reading = validateRoute(manifest, parsed.route, { location, fileName, prefix: label });
  return { present: true, version, text, route: parsed.route, reading, warnings: reading.warnings, errors: asIssues(reading.errors) };
}

/** The one-entry summary a listing gives of a loaded route file. */
export function routeSummary(file, loaded, extra = {}) {
  const { route, reading } = loaded;
  return {
    id: route?.id ?? null,
    file: file.label,
    version: loaded.version,
    label: route?.label ?? null,
    status: loaded.errors.length ? 'invalid' : 'ready',
    ordered: route?.ordered ?? null,
    steps: route ? route.steps.length : null,
    cost: reading?.cost ?? null,
    ...extra,
    errors: loaded.errors,
    warnings: loaded.warnings,
  };
}

/**
 * The validate-side audit of `.derivon/routes/`: every route file read against the manifest.
 * Every invalid or unreadable route is reported, never dropped.
 */
export async function auditWorkspaceRoutes({ root, realRoot, manifest }) {
  const listed = await listRouteFiles(path.join(root, ROUTES_DIRECTORY), { realRoot, label: ROUTES_DIRECTORY });
  const issues = [...listed.issues];
  const routes = [];
  for (const file of listed.files) {
    const loaded = await loadRouteFile(file.path, { location: 'workspace', fileName: file.name, manifest, label: file.label });
    issues.push(...loaded.errors);
    routes.push(routeSummary(file, loaded));
  }
  return { issues, routes };
}
