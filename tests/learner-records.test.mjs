/**
 * Learner records through the script command surface: the application data directory path, the
 * two record protocols, `basis` and the compare-and-swap write. No client runs in any of these
 * tests — that is the point of the surface — and every one of them points the application data
 * directory at a temporary directory, so a test can never touch a real learner's records.
 *
 * The `BASIS` constants were computed with the **application's own** `masteryBasis` and
 * `routeBasis` (`derivon-mindmap/src/learner-records/basis.ts`) against exactly this fixture.
 * They are what holds the two implementations to one hash: a record this surface writes has to
 * stay alive when the application recomputes its basis, and a divergence in the encoded stream,
 * the two digest domains, the canonical JSON or the file inventory shows up here.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applicationDataRoot, learnerRecordPath } from '../derivon-mindmap/scripts/lib/learner-records.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(repo, 'derivon-mindmap/scripts/derivon-workspace.mjs');

const MANIFEST = {
  schema: 'derivon.workspace/v1',
  id: 'learner-fixture',
  document: { title: 'Learner fixture', description: '' },
  graph: {
    points: [
      { id: 'A', data: { label: 'Alpha', document: 'docs/a' } },
      { id: 'B', data: { label: 'Beta', document: 'docs/b' } },
      { id: 'C', data: { label: 'Gamma', document: 'docs/c' } },
    ],
    hyperedges: [
      { id: 'h-ab', weight: 1.5, tails: ['A'], head: 'B', data: { document: 'docs/h-ab' } },
    ],
  },
};

const DOCUMENTS = [
  ['docs/a/document.md', '# Alpha\n\nGrounded alpha.\n'],
  ['docs/a/notes.txt', 'extra asset\n'],
  ['docs/b/document.md', '# Beta\n\nGrounded beta.\n'],
  ['docs/h-ab/document.md', '# Alpha to Beta\n\nAlpha establishes beta.\n'],
];

const BASIS = {
  /** `docs/a` holds `document.md` and `notes.txt`; `docs/c` does not exist at all. */
  A: 'ce84341cfb8e775379dddab4ad946c35ee35e98ab44c07bef504cf76989bfb22',
  C: 'd99cec2e036a0ccd341e0e49e8c25ff8d70bd0b8a4d45e5bc5e846e87f87839c',
  /** The entries of A, B and h-ab, and nothing else: a route's coverage has no files. */
  route: 'c18d6e71d244bcd6851761dea7551977be9633f3b1dca17b65fa10f2ece4b6c0',
  /** The same route after an object it names is gone: the surviving entries only. Refusing
   * instead would make this surface unable to recompute a basis the application recomputes. */
  routeWithDeletedObject: 'bd2458f0a18ed61448149bf87cec887dd71b004e103167971b4b144bbdf6a9ce',
};

async function fixture({ manifest = MANIFEST } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-learner-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'derivon-appdata-'));
  for (const [relative, text] of DOCUMENTS) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, dataRoot };
}

function run(args, input, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } });
}

function envelope(result) {
  assert.ok(result.stdout, `no envelope: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** A run that has to succeed, with the envelope it produced. */
function ok(args, input, env) {
  const result = run(args, input, env);
  const output = envelope(result);
  assert.equal(result.status, 0, `${args.join(' ')}: ${JSON.stringify(output.issues)}`);
  return output;
}

function state(body) {
  return JSON.stringify({ schema: 'derivon.learning/v1', concepts: {}, derivations: {}, ...body });
}

async function stateRecord(dataRoot, id = MANIFEST.id) {
  return JSON.parse(await readFile(learnerRecordPath(dataRoot, id, 'state'), 'utf8'));
}

async function routesRecord(dataRoot, id = MANIFEST.id) {
  return JSON.parse(await readFile(learnerRecordPath(dataRoot, id, 'routes'), 'utf8'));
}

async function exists(target) {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the application data directory */

test('the application data directory is the platform data directory joined with the bundle identifier', () => {
  const home = path.join(path.sep, 'home', 'learner');
  assert.equal(
    applicationDataRoot({ platform: 'darwin', env: {}, home }),
    path.join(home, 'Library', 'Application Support', 'net.derivon.mindmap'),
  );
  assert.equal(
    applicationDataRoot({ platform: 'linux', env: {}, home }),
    path.join(home, '.local', 'share', 'net.derivon.mindmap'),
  );
  assert.equal(
    applicationDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: path.join(path.sep, 'data') }, home }),
    path.join(path.sep, 'data', 'net.derivon.mindmap'),
  );
  /* A relative XDG_DATA_HOME is not a data directory, and the fallback is the home one. */
  assert.equal(
    applicationDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: 'relative/data' }, home }),
    path.join(home, '.local', 'share', 'net.derivon.mindmap'),
  );
  assert.equal(
    applicationDataRoot({ platform: 'win32', env: { APPDATA: path.join(path.sep, 'roaming') }, home }),
    path.join(path.sep, 'roaming', 'net.derivon.mindmap'),
  );
  /* No home and no APPDATA is no data directory, and the caller reports that rather than
   * guessing one. */
  assert.equal(applicationDataRoot({ platform: 'linux', env: {}, home: '' }), null);
  assert.equal(applicationDataRoot({ platform: 'win32', env: {}, home }), null);

  const dataRoot = applicationDataRoot({ platform: 'darwin', env: {}, home });
  assert.equal(
    learnerRecordPath(dataRoot, 'learner-fixture', 'routes'),
    path.join(dataRoot, 'learner-records', 'learner-fixture', 'routes.json'),
  );
  /* The key becomes a directory name, so a segment that could escape is refused before the join. */
  for (const id of ['../escape', 'a/b', '', 'UPPER', 'con']) {
    assert.throws(() => learnerRecordPath(dataRoot, id, 'state'), /workspace id/, `\`${id}\` should be refused`);
  }
});

test('the command computes the path itself, from the platform directory and the workspace id', async (t) => {
  const { root } = await fixture();
  const home = await mkdtemp(path.join(os.tmpdir(), 'derivon-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  /* No `--data-dir`: the command derives the root from the platform, so the child is given a
   * home of its own and an empty XDG_DATA_HOME rather than being able to reach the real one. */
  const env = { HOME: home, XDG_DATA_HOME: '' };
  const written = ok(
    ['write-learner-record', root, '--expected-version', 'missing'],
    state({ concepts: { A: { status: 'complete', data: { selfReported: true } } } }),
    env,
  );
  const expected = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'net.derivon.mindmap', 'learner-records', MANIFEST.id, 'state.json')
    : path.join(home, '.local', 'share', 'net.derivon.mindmap', 'learner-records', MANIFEST.id, 'state.json');
  assert.equal(written.result.path, expected);
  assert.equal(JSON.parse(await readFile(expected, 'utf8')).concepts.A.basis, BASIS.A);

  const read = ok(['read-learner-record', root], undefined, env);
  assert.equal(read.result.present, true);
  assert.equal(read.result.path, expected);
});

/* ------------------------------------------------------------------ read and write, no client */

test('a record written without a client reads back, with the basis the application computes', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const absent = ok(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.deepEqual(absent.result, {
    file: 'state',
    path: learnerRecordPath(dataRoot, MANIFEST.id, 'state'),
    present: false,
    version: null,
    text: null,
  });
  assert.deepEqual(absent.changed, { manifest: false, objects: [], documents: [], learnerRecord: null });
  assert.equal(absent.artifact, 'learner-records');
  assert.equal(await exists(path.join(dataRoot, 'learner-records')), false, 'reading creates nothing');

  const written = ok(
    ['write-learner-record', root, '--data-dir', dataRoot, '--expected-version', 'missing'],
    state({ concepts: { A: { status: 'complete', data: { selfReported: true } } } }),
  );
  assert.equal(written.changed.learnerRecord, 'state.json');
  assert.equal(written.result.file, 'state');
  assert.match(written.result.version, /^[0-9a-f]{64}$/);

  const stored = await stateRecord(dataRoot);
  assert.deepEqual(stored, {
    schema: 'derivon.learning/v1',
    concepts: { A: { status: 'complete', basis: BASIS.A, data: { selfReported: true } } },
    derivations: {},
  });

  const read = ok(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(read.result.present, true);
  assert.equal(read.result.version, written.result.version);
  assert.equal(read.result.text, await readFile(learnerRecordPath(dataRoot, MANIFEST.id, 'state'), 'utf8'));

  /* An object whose document directory is already gone owns no files: the basis is its entry. */
  const orphanish = ok(
    ['write-learner-record', root, '--data-dir', dataRoot, '--expected-version', written.result.version],
    state({ concepts: { A: { status: 'complete', basis: BASIS.A, data: { selfReported: true } }, C: { status: 'incomplete', data: { notes: 'not reached yet' } } } }),
  );
  assert.equal(orphanish.status, 'ok');
  assert.equal((await stateRecord(dataRoot)).concepts.C.basis, BASIS.C);
});

test('the basis follows the workspace content and only the object it judges', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const args = ['write-learner-record', root, '--data-dir', dataRoot];
  const claim = state({ concepts: { A: { status: 'complete', data: { selfReported: true } } } });

  const first = ok([...args, '--expected-version', 'missing'], claim);
  assert.equal((await stateRecord(dataRoot)).concepts.A.basis, BASIS.A);

  /* An unrelated object changing does not touch A's judgement. */
  await writeFile(path.join(root, 'docs/b/document.md'), '# Beta\n\nRewritten beta.\n');
  const second = ok([...args, '--expected-version', first.result.version], claim);
  assert.equal((await stateRecord(dataRoot)).concepts.A.basis, BASIS.A);

  /* The manifest rewritten with the same values — different indentation, different key order —
   * still keeps the judgement alive: a basis covers values, not bytes. */
  const reformatted = {
    graph: MANIFEST.graph,
    document: MANIFEST.document,
    id: MANIFEST.id,
    schema: MANIFEST.schema,
  };
  await writeFile(path.join(root, '.derivon/workspace.json'), JSON.stringify(reformatted, null, 4).replace(/\n/g, '\r\n'));
  const third = ok([...args, '--expected-version', second.result.version], claim);
  assert.equal((await stateRecord(dataRoot)).concepts.A.basis, BASIS.A);

  /* A changing asset under A's own directory retires it. */
  await writeFile(path.join(root, 'docs/a/notes.txt'), 'changed asset\n');
  const fourth = ok([...args, '--expected-version', third.result.version], claim);
  const moved = (await stateRecord(dataRoot)).concepts.A.basis;
  assert.match(moved, /^[0-9a-f]{64}$/);
  assert.notEqual(moved, BASIS.A);

  /* A basis the caller supplies is kept as supplied: it is evidence of what a judgement was
   * made against, so re-writing a file must never silently refresh it. */
  const supplied = 'a'.repeat(64);
  const fifth = ok([...args, '--expected-version', fourth.result.version], state({
    concepts: { A: { status: 'complete', basis: supplied, data: { selfReported: true } } },
  }));
  assert.equal(fifth.status, 'ok');
  assert.equal((await stateRecord(dataRoot)).concepts.A.basis, supplied);
});

test('a route is stored as a reference-only subgraph and carries no completion marker', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const args = ['write-learner-record', root, '--file', 'routes', '--data-dir', dataRoot];

  const route = {
    id: 'r-k7f3q2',
    description: '从 Alpha 走到 Beta',
    targets: ['B'],
    known: ['A'],
    conceptIds: ['A', 'B'],
    derivationIds: ['h-ab'],
    order: ['h-ab'],
    cost: 1.5,
  };
  const written = ok([...args, '--expected-version', 'missing'], JSON.stringify({ schema: 'derivon.routes/v1', routes: [route] }));
  assert.equal(written.changed.learnerRecord, 'routes.json');
  assert.deepEqual(await routesRecord(dataRoot), {
    schema: 'derivon.routes/v1',
    routes: [{ ...route, basis: BASIS.route }],
  });

  const read = ok(['read-learner-record', root, '--file', 'routes', '--data-dir', dataRoot]);
  assert.equal(read.result.file, 'routes');
  assert.equal(read.result.version, written.result.version);

  /* The two files are independent: writing routes left state alone, and vice versa. */
  assert.equal(await exists(learnerRecordPath(dataRoot, MANIFEST.id, 'state')), false);

  /* Deleting a confirmed route is writing the file without it. */
  ok([...args, '--expected-version', written.result.version], JSON.stringify({ schema: 'derivon.routes/v1', routes: [] }));
  assert.deepEqual((await routesRecord(dataRoot)).routes, []);
});

test('a route naming an object the graph no longer has keeps the basis of what remains', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  /* The application's own routeBasis covers the entries that are there and skips the ones that
   * are not, so a route confirmed before an object was deleted stays readable and re-writable.
   * The script has to recompute the same value, so it skips for the same reason. */
  const route = {
    id: 'r-k7f3q2',
    description: 'A route that outlived one of its objects',
    targets: ['B'],
    known: [],
    conceptIds: ['A', 'GHOST'],
    derivationIds: [],
    order: [],
    cost: 1,
  };
  const written = ok(
    ['write-learner-record', root, '--file', 'routes', '--data-dir', dataRoot, '--expected-version', 'missing'],
    JSON.stringify({ schema: 'derivon.routes/v1', routes: [route] }),
  );
  assert.equal(written.status, 'ok', JSON.stringify(written.issues));
  assert.equal((await routesRecord(dataRoot)).routes[0].basis, BASIS.routeWithDeletedObject);
});

/* ------------------------------------------------------------------ write discipline */

test('a losing precondition refuses the whole write and leaves the file as it was', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const args = ['write-learner-record', root, '--data-dir', dataRoot];
  const claim = state({ concepts: { A: { status: 'complete', data: { selfReported: true } } } });

  const written = ok([...args, '--expected-version', 'missing'], claim);
  const before = await readFile(learnerRecordPath(dataRoot, MANIFEST.id, 'state'), 'utf8');

  const conflict = run([...args, '--expected-version', 'missing'], claim);
  assert.equal(conflict.status, 1);
  const refused = envelope(conflict);
  assert.equal(refused.status, 'diagnostics');
  assert.equal(refused.issues[0].code, 'conflict-precondition');
  assert.equal(refused.changed.learnerRecord, null);
  assert.equal(await readFile(learnerRecordPath(dataRoot, MANIFEST.id, 'state'), 'utf8'), before);

  const stale = run([...args, '--expected-version', '0'.repeat(64)], claim);
  assert.equal(stale.status, 1);
  assert.equal(envelope(stale).issues[0].code, 'conflict-precondition');

  const missingFlag = run(args, claim);
  assert.equal(missingFlag.status, 2);
  assert.equal(envelope(missingFlag).issues[0].code, 'usage');

  const badVersion = run([...args, '--expected-version', 'nope'], claim);
  assert.equal(badVersion.status, 2);
  assert.equal(envelope(badVersion).issues[0].code, 'usage');

  /* Nothing temporary is left behind, in the record directory or beside it. */
  const listed = await readdir(path.dirname(learnerRecordPath(dataRoot, MANIFEST.id, 'state')));
  assert.deepEqual(listed.filter((name) => name.includes('.derivon-part-')), []);

  /* The version the read reported is what the next write has to carry. */
  const read = ok(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(read.result.version, written.result.version);
  ok([...args, '--expected-version', read.result.version], state({ concepts: { A: { status: 'incomplete', data: { notes: 'reconsidered' } } } }));
});

test('the write enforces the record protocol before anything reaches the disk', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const args = ['write-learner-record', root, '--data-dir', dataRoot, '--expected-version', 'missing'];

  const cases = [
    ['wrong schema', JSON.stringify({ schema: 'derivon.learning/v2', concepts: {}, derivations: {} }), 'learner-record-unreadable'],
    ['unknown top-level key', state({ progress: {} }), 'learner-record-invalid'],
    ['unknown record key', state({ concepts: { A: { status: 'complete', cursor: 3 } } }), 'learner-record-invalid'],
    ['incomplete with empty data', state({ concepts: { A: { status: 'incomplete', data: {} } } }), 'learner-record-invalid'],
    ['incomplete with no data', state({ concepts: { A: { status: 'incomplete' } } }), 'learner-record-invalid'],
    ['unknown status', state({ concepts: { A: { status: 'known' } } }), 'learner-record-invalid'],
    ['empty object id', state({ concepts: { '': { status: 'complete' } } }), 'learner-record-invalid'],
    ['unknown object', state({ concepts: { GHOST: { status: 'complete' } } }), 'unknown-object'],
    ['not an object', JSON.stringify([1, 2]), 'invalid-payload'],
  ];
  for (const [name, payload, code] of cases) {
    const result = run(args, payload);
    assert.equal(result.status, 1, name);
    assert.equal(envelope(result).issues[0].code, code, `${name}: ${result.stdout}`);
  }
  assert.equal(await exists(path.join(dataRoot, 'learner-records')), false, 'a refused write creates nothing');

  const routeArgs = ['write-learner-record', root, '--file', 'routes', '--data-dir', dataRoot, '--expected-version', 'missing'];
  const route = { id: 'r-k7f3q2', description: 'x', targets: ['B'], known: [], conceptIds: ['A'], derivationIds: [], order: [], cost: 1 };
  const routeCases = [
    ['a completion marker', { ...route, completed: true }, 'learner-record-invalid'],
    ['a step cursor', { ...route, stepState: { cursor: 1 } }, 'learner-record-invalid'],
    ['a bad route id', { ...route, id: 'route-1' }, 'learner-record-invalid'],
    ['a cost with two decimals', { ...route, cost: 1.25 }, 'learner-record-invalid'],
    ['a numeric id in a reference list', { ...route, conceptIds: ['A', 7] }, 'learner-record-invalid'],
    ['an empty string in a reference list', { ...route, known: ['  '] }, 'learner-record-invalid'],
    ['a missing reference list', { ...route, order: undefined }, 'learner-record-invalid'],
  ];
  for (const [name, entry, code] of routeCases) {
    const result = run(routeArgs, JSON.stringify({ schema: 'derivon.routes/v1', routes: [entry] }));
    assert.equal(result.status, 1, name);
    assert.equal(envelope(result).issues[0].code, code, `${name}: ${result.stdout}`);
  }
  assert.equal(await exists(path.join(dataRoot, 'learner-records')), false);

  const badFile = run([...args.slice(0, 3), '--file', 'orientation'], state({}));
  assert.equal(badFile.status, 2);
  assert.equal(envelope(badFile).issues[0].code, 'usage');
});

test('a broken record file is reported as read, never replaced with an empty record', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const target = learnerRecordPath(dataRoot, MANIFEST.id, 'state');
  await mkdir(path.dirname(target), { recursive: true });

  await writeFile(target, '{ not json');
  const unparseable = run(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(unparseable.status, 1);
  assert.equal(envelope(unparseable).issues[0].code, 'learner-record-unreadable');

  await writeFile(target, JSON.stringify({ schema: 'derivon.routes/v1', routes: [] }));
  const foreign = run(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(foreign.status, 1);
  assert.equal(envelope(foreign).issues[0].code, 'learner-record-unreadable');

  await writeFile(target, JSON.stringify({ schema: 'derivon.learning/v1', concepts: { A: { status: 'maybe' } }, derivations: {} }));
  const malformed = run(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(malformed.status, 1);
  const output = envelope(malformed);
  assert.equal(output.issues[0].code, 'learner-record-invalid');
  assert.equal(output.result.present, true, 'the record is still returned for the caller to see');
  assert.match(output.result.text, /maybe/);
  assert.equal(await readFile(target, 'utf8'), JSON.stringify({ schema: 'derivon.learning/v1', concepts: { A: { status: 'maybe' } }, derivations: {} }), 'a read never rewrites the file');
});

test('a workspace without a usable id has no learner record, and nothing is written for it', async (t) => {
  const { root, dataRoot } = await fixture({ manifest: { ...MANIFEST, id: '../escape' } });
  const missingId = await fixture({ manifest: { graph: MANIFEST.graph, document: MANIFEST.document, schema: MANIFEST.schema } });
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  t.after(() => rm(missingId.root, { recursive: true, force: true }));
  t.after(() => rm(missingId.dataRoot, { recursive: true, force: true }));

  for (const [name, workspace] of [['unsafe id', { root, dataRoot }], ['missing id', missingId]]) {
    for (const command of ['read-learner-record', 'write-learner-record']) {
      const args = [command, workspace.root, '--data-dir', workspace.dataRoot];
      const result = run(command === 'write-learner-record' ? [...args, '--expected-version', 'missing'] : args, command === 'write-learner-record' ? state({}) : undefined);
      assert.equal(result.status, 1, `${name} / ${command}`);
      assert.equal(envelope(result).issues[0].code, 'invalid-id', `${name} / ${command}: ${result.stdout}`);
    }
    assert.equal(await exists(path.join(workspace.dataRoot, 'learner-records')), false, name);
  }
});

test('a symlink inside a document directory refuses the basis rather than hashing a partial one', async (t) => {
  const { root, dataRoot } = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), 'derivon-learner-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'loose.txt'), 'outside\n');
  await symlink(path.join(external, 'loose.txt'), path.join(root, 'docs/a/loose.txt'));

  const result = run(
    ['write-learner-record', root, '--data-dir', dataRoot, '--expected-version', 'missing'],
    state({ concepts: { A: { status: 'complete' } } }),
  );
  assert.equal(result.status, 1);
  assert.equal(envelope(result).issues[0].code, 'basis-uncomputable');
  assert.equal(await exists(path.join(dataRoot, 'learner-records')), false);
});
