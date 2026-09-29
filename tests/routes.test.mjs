/**
 * Routes (`derivon.route/v1`): the protocol's reading of a route on the graph, and workspace
 * routes through the script command surface. The normative text is derivon-mindmap's
 * `docs/routes.md`; the application implements the same rules in TypeScript, and both must
 * accept and refuse the same files with the same codes. Personal routes, which are learner
 * records, are covered in `learner-records.test.mjs`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseRoute, serializeRoute, validateRoute } from '../derivon-mindmap/scripts/lib/routes.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(repo, 'derivon-mindmap/scripts/derivon-workspace.mjs');

const point = (id) => ({ id, data: { label: id.toUpperCase(), document: `docs/${id}` } });
const edge = (id, tails, head, weight = 1) => ({ id, weight, tails, head, data: { document: `docs/${id}` } });

/**
 * k is known. Two accounts of y: through x (h-kx, h-xy) or directly (h-ky). t needs y and z.
 * z is concluded by h-wz only, whose premise w nothing concludes; h-zq leans on z.
 */
const MANIFEST = {
  schema: 'derivon.workspace/v1',
  id: 'route-fixture',
  document: { title: 'Route fixture', description: '' },
  graph: {
    points: ['k', 'x', 'y', 'z', 'w', 'q', 't'].map(point),
    hyperedges: [
      edge('h-kx', ['k'], 'x', 1),
      edge('h-xy', ['x'], 'y', 2),
      edge('h-ky', ['k'], 'y', 0.5),
      edge('h-kz', ['k'], 'z', 0.2),
      edge('h-wz', ['w'], 'z', 1),
      edge('h-yzt', ['y', 'z'], 't', 1.1),
      edge('h-zq', ['z'], 'q', 1),
    ],
  },
};

function route(body = {}) {
  return { schema: 'derivon.route/v1', id: 'r-k7f3q2', label: 'k to t', known: ['k'], targets: ['t'], steps: ['h-kx', 'h-xy', 'h-kz', 'h-yzt'], ordered: false, ...body };
}

const read = (body, location = 'workspace', manifest = MANIFEST) => validateRoute(manifest, route(body), { location, fileName: 'r-k7f3q2.json' });
const codes = (diagnostics) => diagnostics.map((entry) => entry.code);

/* ------------------------------------------------------------------ reading on the graph */

test('a route that reaches its targets is ready, with its display order, concepts and cost', () => {
  const reading = read({ steps: ['h-yzt', 'h-xy', 'h-kz', 'h-kx'] });
  assert.equal(reading.status, 'ready');
  assert.deepEqual(reading.errors, []);
  assert.deepEqual(reading.warnings, []);
  /* Computed: list-order passes, a step fired earlier in a pass in hand for the later ones. */
  assert.deepEqual(reading.order, ['h-kz', 'h-kx', 'h-xy', 'h-yzt']);
  assert.equal(reading.orderSource, 'computed');
  assert.deepEqual(reading.conceptIds.sort(), ['k', 't', 'x', 'y', 'z']);
  assert.equal(reading.cost, 4.3);
});

test('an unreached target names its gaps, who wants each, and what could fill it', () => {
  const reading = read({ steps: ['h-kx', 'h-xy', 'h-wz', 'h-yzt'] });
  assert.equal(reading.status, 'invalid');
  assert.deepEqual(codes(reading.errors), ['target-unreached']);
  assert.deepEqual(reading.errors[0].gaps, [{ conceptId: 'w', wantedBy: 'h-wz', candidates: [] }]);

  const missingProducer = read({ steps: ['h-kx', 'h-xy', 'h-yzt'] });
  assert.deepEqual(missingProducer.errors[0].gaps, [{ conceptId: 'z', wantedBy: 'h-yzt', candidates: ['h-kz', 'h-wz'] }]);
  /* Only the root cause: h-wz never fires on its own account; h-yzt waits on it and is counted. */
  assert.deepEqual(codes(reading.warnings), ['never-fires']);
  assert.equal(reading.warnings[0].derivationId, 'h-wz');
  assert.equal(reading.blocked, 1);

  const bare = read({ steps: [] });
  assert.deepEqual(bare.errors[0].gaps, [{ conceptId: 't', wantedBy: 't', candidates: ['h-yzt'] }]);
});

test('steps that only wait on each other in a cycle name the first on the cycle as the root', () => {
  /* h-ba needs b, which only h-ab concludes; h-ab needs a, which only h-ba concludes. */
  const manifest = {
    ...MANIFEST,
    graph: {
      points: [...MANIFEST.graph.points, point('a'), point('b')],
      hyperedges: [...MANIFEST.graph.hyperedges, edge('h-ba', ['b'], 'a'), edge('h-ab', ['a'], 'b')],
    },
  };
  const reading = read({ targets: ['a'], steps: ['h-ba', 'h-ab'] }, 'workspace', manifest);
  assert.deepEqual(codes(reading.errors), ['target-unreached']);
  assert.deepEqual(codes(reading.warnings), ['never-fires']);
  assert.equal(reading.warnings[0].derivationId, 'h-ba');
  assert.deepEqual(reading.warnings[0].missing, ['b']);
  assert.equal(reading.blocked, 1);
});

test('no idle step is reported while a target is unreached, and a detour is idle once it is', () => {
  const unreached = read({ steps: ['h-kx', 'h-zq', 'h-kz'], targets: ['t'] });
  assert.deepEqual(codes(unreached.errors), ['target-unreached']);
  assert.ok(!codes(unreached.warnings).includes('idle'));

  const detour = read({ steps: ['h-kx', 'h-xy', 'h-kz', 'h-zq', 'h-yzt'] });
  assert.equal(detour.status, 'ready');
  assert.deepEqual(detour.warnings.map(({ code, derivationId }) => [code, derivationId]), [['idle', 'h-zq']]);
});

test('parallel derivations are legal: a duplicate-head warning, never an error, and not also idle', () => {
  const reading = read({ steps: ['h-kx', 'h-xy', 'h-ky', 'h-kz', 'h-yzt'] });
  assert.equal(reading.status, 'ready');
  assert.deepEqual(reading.order, ['h-kx', 'h-xy', 'h-ky', 'h-kz', 'h-yzt']);
  assert.deepEqual(reading.warnings.map(({ code, derivationId, position, earlierDerivationId, earlierPosition }) => [code, derivationId, position, earlierDerivationId, earlierPosition]), [['duplicate-head', 'h-ky', 3, 'h-xy', 2]]);
});

test('a written order reports the step, its position, and where each missing concept is concluded', () => {
  const reading = read({ ordered: true, steps: ['h-kx', 'h-yzt', 'h-xy', 'h-kz'] });
  assert.equal(reading.orderSource, 'written');
  assert.deepEqual(reading.order, ['h-kx', 'h-yzt', 'h-xy', 'h-kz']);
  assert.deepEqual(reading.errors.map(({ code, derivationId, position, needs }) => ({ code, derivationId, position, needs })), [{
    code: 'order-not-executable',
    derivationId: 'h-yzt',
    position: 2,
    needs: [{ conceptId: 'y', producedAt: 3 }, { conceptId: 'z', producedAt: 4 }],
  }]);
  /* The same set, left unordered, is executable. */
  assert.equal(read({ ordered: false, steps: ['h-kx', 'h-yzt', 'h-xy', 'h-kz'] }).status, 'ready');
  /* A written order includes steps that never fire, which are never order errors. */
  const neverFires = read({ ordered: true, steps: ['h-wz', 'h-kx', 'h-xy', 'h-kz', 'h-yzt'] });
  assert.deepEqual(codes(neverFires.errors), []);
  assert.deepEqual(neverFires.order[0], 'h-wz');
  assert.deepEqual(codes(neverFires.warnings), ['never-fires', 'duplicate-head']);
});

test('shape and graph errors are all reported, and the location decides basis and basedOn', () => {
  const reading = read({ label: '  ', targets: [], known: ['ghost'], steps: ['h-kx', 'h-gone', 'h-kx', 'h-kx'], basedOn: 'r-sv4d2m', basis: 'a'.repeat(64) });
  assert.deepEqual(codes(reading.errors), ['empty-label', 'empty-targets', 'duplicate-step', 'forbidden-field', 'forbidden-field', 'dangling-concept', 'dangling-derivation']);

  /* known and targets are sets: a repeated id means one occurrence, and is diagnosed once. */
  const repeated = read({ known: ['k', 'ghost', 'ghost', 'k'], targets: ['t', 'gone', 't', 'gone'], steps: ['h-kx', 'h-gone', 'h-gone', 'h-xy', 'h-kz', 'h-yzt'] });
  assert.deepEqual(repeated.errors.map(({ code, path: at }) => [code, at]), [
    ['duplicate-step', '#/steps/2'],
    ['dangling-concept', '#/known/1'],
    ['dangling-concept', '#/targets/1'],
    ['dangling-derivation', '#/steps/1'],
  ]);

  const mismatch = validateRoute(MANIFEST, route(), { location: 'workspace', fileName: 'r-222222.json' });
  assert.deepEqual(codes(mismatch.errors), ['id-mismatch']);

  assert.deepEqual(codes(read({}, 'personal').errors), ['missing-basis']);
  assert.deepEqual(codes(read({ basis: 'a'.repeat(64), basedOn: 'r-sv4d2m' }, 'personal').errors), []);
});

test('a file that does not decode is unreadable, with every condition that holds', () => {
  const unreadable = (text) => codes(parseRoute(text).issues);
  assert.deepEqual(unreadable('{ nope'), ['unreadable']);
  assert.deepEqual(unreadable('[]'), ['unreadable']);
  assert.deepEqual(unreadable(JSON.stringify({ ...route(), schema: 'derivon.routes/v1' })), ['wrong-schema']);
  assert.deepEqual(unreadable(JSON.stringify({ ...route(), completed: true, cost: 3 })), ['unknown-key', 'unknown-key']);
  const { ordered, steps, ...partial } = route();
  assert.deepEqual(unreadable(JSON.stringify(partial)), ['missing-field', 'missing-field']);
  assert.deepEqual(
    unreadable(JSON.stringify(route({ id: 'route-1', basedOn: 7, basis: 'ABC', label: 1, description: null, known: 'k', ordered: 'yes' }))),
    ['invalid-field', 'invalid-field', 'invalid-field', 'invalid-field', 'invalid-field', 'invalid-field', 'invalid-field'],
  );
  /* Concept and derivation ids are not checked against a pattern: an empty string is a
   * dangling id, not an unreadable file. */
  const empty = parseRoute(JSON.stringify(route({ known: ['k', ''] })));
  assert.deepEqual(empty.issues, []);
  assert.deepEqual(codes(validateRoute(MANIFEST, empty.route, { location: 'workspace' }).errors), ['dangling-concept']);
});

test('the canonical text orders the keys, omits empty optional fields and refuses an invalid route', () => {
  const text = serializeRoute(route({ description: '', basedOn: 'r-sv4d2m', basis: 'b'.repeat(64) }), { location: 'personal' });
  assert.equal(text, `${JSON.stringify({
    schema: 'derivon.route/v1', id: 'r-k7f3q2', label: 'k to t', known: ['k'], targets: ['t'], steps: ['h-kx', 'h-xy', 'h-kz', 'h-yzt'], ordered: false, basedOn: 'r-sv4d2m', basis: 'b'.repeat(64),
  }, null, 2)}\n`);
  assert.deepEqual(parseRoute(text).route, JSON.parse(text));
  assert.throws(() => serializeRoute(route({ basis: 'b'.repeat(64) }), { location: 'workspace' }), /forbidden-field/);
  assert.throws(() => serializeRoute(route({ cost: 1 }), { location: 'workspace' }), /unknown-key/);
});

/* ------------------------------------------------------------------ workspace routes, no client */

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-routes-'));
  for (const object of [...MANIFEST.graph.points, ...MANIFEST.graph.hyperedges]) {
    await mkdir(path.join(root, object.data.document), { recursive: true });
    await writeFile(path.join(root, object.data.document, 'document.md'), `# ${object.id}\n`);
  }
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  return root;
}

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input });
}

function envelope(result) {
  assert.ok(result.stdout, `no envelope: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function ok(args, input) {
  const result = run(args, input);
  const output = envelope(result);
  assert.equal(result.status, 0, `${args.join(' ')}: ${JSON.stringify(output.issues)}`);
  return output;
}

const routeFile = (root, id = 'r-k7f3q2') => path.join(root, '.derivon/routes', `${id}.json`);

test('a workspace route is written, read, listed and deleted by the version it was read at', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(ok(['list-routes', root]).result.routes, []);
  const absent = ok(['read-route', root, 'r-k7f3q2']);
  assert.deepEqual([absent.result.present, absent.result.version], [false, null]);
  await assert.rejects(readdir(path.join(root, '.derivon/routes')), { code: 'ENOENT' }, 'reading creates nothing');

  const written = ok(['write-route', root, 'r-k7f3q2', '--expected-version', 'missing'], JSON.stringify(route({ description: '' })));
  assert.equal(written.capability, 'write-structure');
  assert.deepEqual(written.changed, { manifest: false, objects: [], documents: [], routes: ['r-k7f3q2'], learnerRecord: null });
  assert.equal(await readFile(routeFile(root), 'utf8'), serializeRoute(route(), { location: 'workspace' }));
  assert.deepEqual(written.result.reading.order, ['h-kx', 'h-xy', 'h-kz', 'h-yzt']);
  assert.deepEqual(await readdir(root).then((names) => names.filter((name) => name.includes('.derivon-part-'))), []);

  const again = ok(['read-route', root, 'r-k7f3q2']);
  assert.equal(again.result.version, written.result.version);
  assert.equal(again.result.text, await readFile(routeFile(root), 'utf8'));
  assert.equal(again.result.reading.status, 'ready');

  /* A write carrying a version it did not read is refused, and the file is left as it was. */
  const conflict = run(['write-route', root, 'r-k7f3q2', '--expected-version', 'missing'], JSON.stringify(route({ label: 'renamed' })));
  assert.equal(conflict.status, 1);
  assert.equal(envelope(conflict).issues[0].code, 'conflict-precondition');
  const renamed = ok(['write-route', root, 'r-k7f3q2', '--expected-version', written.result.version], JSON.stringify(route({ label: 'renamed' })));

  const listed = ok(['list-routes', root]);
  assert.deepEqual(listed.result.routes.map(({ id, label, status, ordered, steps, cost, version }) => ({ id, label, status, ordered, steps, cost, version })), [
    { id: 'r-k7f3q2', label: 'renamed', status: 'ready', ordered: false, steps: 4, cost: 4.3, version: renamed.result.version },
  ]);

  const stale = run(['delete-route', root, 'r-k7f3q2', '--expected-version', written.result.version]);
  assert.equal(envelope(stale).issues[0].code, 'conflict-precondition');
  const deleted = ok(['delete-route', root, 'r-k7f3q2', '--expected-version', renamed.result.version]);
  assert.equal(deleted.capability, 'delete');
  assert.deepEqual(deleted.changed.routes, ['r-k7f3q2']);
  await assert.rejects(readFile(routeFile(root)), { code: 'ENOENT' });
  assert.equal(run(['delete-route', root, 'r-k7f3q2', '--expected-version', 'missing']).status, 2, 'a delete names the version it read');
});

test('a workspace route with any error is refused before anything reaches the disk', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = ['write-route', root, 'r-k7f3q2', '--expected-version', 'missing'];
  const cases = [
    ['a basis', route({ basis: 'a'.repeat(64) }), 'forbidden-field'],
    ['a basedOn', route({ basedOn: 'r-sv4d2m' }), 'forbidden-field'],
    ['an id that is not the file name', route({ id: 'r-222222' }), 'id-mismatch'],
    ['a stored cost', route({ cost: 4.3 }), 'unknown-key'],
    ['no targets', route({ targets: [] }), 'empty-targets'],
    ['a repeated step', route({ steps: ['h-kx', 'h-kx', 'h-xy', 'h-kz', 'h-yzt'] }), 'duplicate-step'],
    ['a derivation the graph lacks', route({ steps: ['h-kx', 'h-xy', 'h-kz', 'h-yzt', 'h-gone'] }), 'dangling-derivation'],
    ['an unreached target', route({ steps: ['h-kx', 'h-xy', 'h-yzt'] }), 'target-unreached'],
    ['a written order that does not execute', route({ ordered: true, steps: ['h-yzt', 'h-kx', 'h-xy', 'h-kz'] }), 'order-not-executable'],
    ['the old protocol', { schema: 'derivon.routes/v1', routes: [] }, 'wrong-schema'],
  ];
  for (const [name, payload, code] of cases) {
    const result = run(args, JSON.stringify(payload));
    assert.equal(result.status, 1, name);
    assert.equal(envelope(result).issues[0].code, code, `${name}: ${result.stdout}`);
  }
  assert.equal(envelope(run(args, '{ nope')).issues[0].code, 'unreadable');
  assert.equal(envelope(run(['write-route', root, '../escape', '--expected-version', 'missing'], JSON.stringify(route()))).issues[0].code, 'invalid-id');
  await assert.rejects(readdir(path.join(root, '.derivon/routes')), { code: 'ENOENT' });

  /* Warnings never refuse: a detour and a parallel derivation are saved. */
  const kept = ok(args, JSON.stringify(route({ steps: ['h-kx', 'h-xy', 'h-ky', 'h-kz', 'h-zq', 'h-yzt'] })));
  assert.deepEqual(codes(kept.result.reading.warnings), ['duplicate-head', 'idle']);
});

test('validate reads every route file against the graph and reports invalid ones, dropping none', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'derivon-routes-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  ok(['write-route', root, 'r-k7f3q2', '--expected-version', 'missing'], JSON.stringify(route()));
  assert.equal(ok(['validate', root]).result.routes[0].status, 'ready');

  const directory = path.join(root, '.derivon/routes');
  await writeFile(path.join(directory, 'r-222222.json'), '{ broken');
  await writeFile(path.join(directory, 'draft.json'), JSON.stringify(route()));
  /* Not route files: another name, a leftover temporary, a subdirectory. */
  await writeFile(path.join(directory, 'README.md'), 'notes\n');
  await writeFile(path.join(directory, 'r-k7f3q2.json.derivon-part-1-a-0'), 'partial');
  await mkdir(path.join(directory, 'archive'));
  await writeFile(path.join(directory, 'archive/r-333333.json'), '{ broken');

  const result = run(['validate', root]);
  assert.equal(result.status, 1);
  const output = envelope(result);
  assert.deepEqual(output.result.routes.map(({ file, status }) => [file, status]), [
    ['.derivon/routes/draft.json', 'invalid'],
    ['.derivon/routes/r-222222.json', 'invalid'],
    ['.derivon/routes/r-k7f3q2.json', 'ready'],
  ]);
  assert.deepEqual(output.issues.map(({ code, path: at }) => [code, at]), [
    ['id-mismatch', '.derivon/routes/draft.json#/id'],
    ['unreadable', '.derivon/routes/r-222222.json#'],
  ]);

  /* The graph moves on: the route is invalid now, reported and left exactly as it was. */
  const before = await readFile(routeFile(root), 'utf8');
  const edited = structuredClone(MANIFEST);
  edited.graph.hyperedges = edited.graph.hyperedges.filter((object) => object.id !== 'h-kz');
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify(edited, null, 2)}\n`);
  const listed = ok(['list-routes', root]);
  const moved = listed.result.routes.find((entry) => entry.file === '.derivon/routes/r-k7f3q2.json');
  assert.equal(moved.status, 'invalid');
  assert.deepEqual(codes(moved.errors), ['dangling-derivation', 'target-unreached']);
  assert.equal(await readFile(routeFile(root), 'utf8'), before);

  /* A symbolic link is refused, never followed. */
  await writeFile(path.join(outside, 'r-444444.json'), JSON.stringify(route({ id: 'r-444444' })));
  await symlink(path.join(outside, 'r-444444.json'), path.join(directory, 'r-444444.json'));
  const linked = envelope(run(['list-routes', root]));
  assert.deepEqual(linked.issues.map(({ code, path: at }) => [code, at]), [['document-unsafe', '.derivon/routes/r-444444.json']]);
  assert.equal(linked.result.routes.some((entry) => entry.file.endsWith('r-444444.json')), false);
  const refused = run(['write-route', root, 'r-444444', '--expected-version', 'missing'], JSON.stringify(route({ id: 'r-444444', targets: ['y'], steps: ['h-ky'] })));
  assert.equal(envelope(refused).issues[0].code, 'document-unsafe');
});
