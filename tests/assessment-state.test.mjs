import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const assessment = path.join(repo, 'derivon-teaching/scripts/assessment-state.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-teaching-'));
  for (const [directory, title] of [['docs/a', 'A'], ['docs/b', 'B'], ['docs/h-ab', 'A to B']]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'document.md'), `# ${title}\n\nGrounded content.\n`);
    await writeFile(path.join(root, directory, 'index.html'), `<!doctype html><html><body>${title}</body></html>\n`);
  }
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify({
    schema: 'derivon.authoring/v0.3.0',
    document: { title: 'Teaching fixture', description: '' },
    graph: {
      points: [
        { id: 'A', data: { label: 'A', document: 'docs/a', format: 'markdown' } },
        { id: 'B', data: { label: 'B', document: 'docs/b', format: 'markdown' } },
      ],
      hyperedges: [
        { id: 'h-ab', weight: 1.5, tails: ['A'], head: 'B', data: { document: 'docs/h-ab', format: 'markdown' } },
      ],
    },
    view: { replacements: [] },
  }, null, 2)}\n`);
  return root;
}

function run(args) {
  return spawnSync(process.execPath, [assessment, ...args], { encoding: 'utf8' });
}

function output(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function roundFile(root, value) {
  const file = path.join(root, `round-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify(value));
  return file;
}

test('assessment state persists rounds, status changes, staleness, and close', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const documentBefore = await readFile(path.join(root, 'docs/a/document.md'), 'utf8');

  const started = output(run(['start', root, '--target', 'B']));
  assert.equal(started.state.schema, 'derivon.teaching/v1');
  assert.equal(started.state.activeAssessmentId, 'assessment-1');
  assert.deepEqual(await readdir(path.join(root, '.derivon/teaching')), ['state.json']);
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await readFile(path.join(root, 'docs/a/document.md'), 'utf8'), documentBefore);
  await assert.rejects(readFile(path.join(root, '.gitignore')));

  const firstRound = await roundFile(root, {
    summary: 'Boundary round',
    items: [{
      pointId: 'A', status: 'partial',
      evidence: 'Distinguished the main cases but missed zero.',
      taskType: 'boundary-analysis', gap: 'Zero case is missing.',
      basisObjectIds: ['A', 'h-ab'],
    }],
    frontierPointIds: ['A'],
  });
  const first = output(run(['record-round', root, '--expected-revision', started.revision, '--round-file', firstRound]));
  assert.equal(first.state.concepts.A.status, 'partial');
  assert.equal(first.state.rounds.length, 1);
  assert.doesNotMatch(JSON.stringify(first.state), /raw answer/i);

  const secondRound = await roundFile(root, {
    items: [{
      pointId: 'A', status: 'demonstrated',
      evidence: 'Applied the rule and tested the zero boundary.',
      taskType: 'application', gap: null,
      basisObjectIds: ['A', 'h-ab'],
    }],
    frontierPointIds: ['B'],
  });
  const second = output(run(['record-round', root, '--expected-revision', first.revision, '--round-file', secondRound]));
  assert.equal(second.state.concepts.A.status, 'demonstrated');
  assert.deepEqual(second.state.concepts.A.taskTypes, ['boundary-analysis', 'application']);
  assert.equal(second.state.rounds.length, 2);

  await writeFile(path.join(root, 'docs/a/document.md'), '# A\n\nChanged basis.\n');
  const reconciled = output(run(['reconcile', root, '--expected-revision', second.revision]));
  assert.equal(reconciled.state.concepts.A.stale, true);
  assert.equal(reconciled.state.rounds[0].items[0].stale, true);
  assert.equal(reconciled.state.rounds[1].items[0].stale, true);

  const validated = JSON.parse(run(['validate', root]).stdout);
  assert.equal(validated.valid, true);
  const closed = output(run(['close', root, '--expected-revision', reconciled.revision]));
  assert.equal(closed.state.activeAssessmentId, null);
  assert.equal(closed.state.assessments[0].status, 'closed');
  assert.equal(closed.state.rounds.length, 2);

  const restarted = output(run(['start', root, '--target', 'A', '--expected-revision', closed.revision]));
  assert.equal(restarted.state.activeAssessmentId, 'assessment-2');
  assert.equal(restarted.state.rounds.length, 2);
});

test('assessment state enforces its strict persisted schema', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  output(run(['start', root, '--target', 'A']));
  const statePath = path.join(root, '.derivon/teaching/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.unexpected = true;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const validated = run(['validate', root]);
  assert.equal(validated.status, 1);
  assert.match(validated.stderr, /unexpected is not allowed/);
});

test('assessment state rejects ambiguous writes, invalid input, and escaped basis documents', async (t) => {
  const root = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), 'derivon-teaching-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(external, { recursive: true, force: true }));

  assert.equal(run(['start', root, '--target', 'missing']).status, 1);
  await assert.rejects(readdir(path.join(root, '.derivon/teaching')));
  const started = output(run(['start', root, '--target', 'A']));

  const withTranscript = await roundFile(root, {
    items: [{
      pointId: 'A', status: 'partial', evidence: 'Summary', taskType: 'case',
      basisObjectIds: ['A'], rawAnswer: 'private transcript',
    }],
    frontierPointIds: [],
  });
  const rejected = run(['record-round', root, '--expected-revision', started.revision, '--round-file', withTranscript]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /rawAnswer is not allowed/);

  const validRound = await roundFile(root, {
    items: [{
      pointId: 'A', status: 'partial', evidence: 'Summary', taskType: 'case',
      basisObjectIds: ['A'],
    }],
    frontierPointIds: [],
  });
  const conflict = run(['record-round', root, '--expected-revision', '0'.repeat(64), '--round-file', validRound]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Revision conflict/);
  assert.equal(output(run(['show', root])).state.rounds.length, 0);

  const lockPath = path.join(root, '.derivon/teaching/.state.lock');
  await writeFile(lockPath, 'other writer');
  const locked = run(['record-round', root, '--expected-revision', started.revision, '--round-file', validRound]);
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /locked by another writer/);
  assert.equal(await readFile(lockPath, 'utf8'), 'other writer');
  await rm(lockPath);

  await rm(path.join(root, 'docs/a'), { recursive: true });
  await writeFile(path.join(external, 'document.md'), '# Outside\n');
  await writeFile(path.join(external, 'index.html'), '<!doctype html>\n');
  await symlink(external, path.join(root, 'docs/a'), 'dir');
  const escaped = run(['record-round', root, '--expected-revision', started.revision, '--round-file', validRound]);
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /outside the workspace/);
});
