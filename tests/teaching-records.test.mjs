/**
 * The teaching skill's persistence contract. The skill itself is prose, so what is testable is
 * what it depends on: one round of assessment becomes **one** learner-record write, it lands
 * outside the workspace, and the verdicts survive as the protocol's single status axis plus a
 * writer-namespaced `data`.
 *
 * The regression this file exists for is the old `derivon.teaching/v1` state: an assessment
 * state file inside `.derivon/teaching/`, which put every round into the workspace revision. The
 * application's revision walk skips only the root `.git`, so a round used to read as an external
 * workspace change and refuse a concurrent commit. A round must now change **no** workspace byte.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { learnerRecordPath } from '../derivon-mindmap/scripts/lib/learner-records.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(repo, 'derivon-mindmap/scripts/derivon-workspace.mjs');
const WORKSPACE_ID = 'teaching-fixture';

const MANIFEST = {
  schema: 'derivon.workspace/v1',
  id: WORKSPACE_ID,
  document: { title: 'Teaching fixture', description: '' },
  graph: {
    points: [
      { id: 'limit', data: { label: 'Limit', document: 'docs/limit' } },
      { id: 'continuity', data: { label: 'Continuity', document: 'docs/continuity' } },
    ],
    hyperedges: [
      { id: 'h-continuity', weight: 1.5, tails: ['limit'], head: 'continuity', data: { document: 'docs/h-continuity' } },
    ],
  },
};

const DOCUMENTS = [
  ['docs/limit/document.md', '# Limit\n\nGrounded limit.\n'],
  ['docs/continuity/document.md', '# Continuity\n\nGrounded continuity.\n'],
  ['docs/h-continuity/document.md', '# Limit to continuity\n\nLimit establishes continuity.\n'],
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-teaching-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'derivon-teaching-data-'));
  for (const [relative, text] of DOCUMENTS) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  return { root, dataRoot };
}

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input });
}

function ok(args, input) {
  const result = run(args, input);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, `${args.join(' ')}: ${JSON.stringify(output.issues)}`);
  return output;
}

/** Every path and byte inside the workspace, so "a round changed nothing" is one comparison. */
async function workspaceDigest(root) {
  const records = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        records.push(`${relative}/`);
        await walk(absolute);
        continue;
      }
      records.push(`${relative} ${createHash('sha256').update(await readFile(absolute)).digest('hex')}`);
    }
  };
  await walk(root);
  return records.join('\n');
}

/** One assessed concept, the way the skill records it: a verdict under its own namespace. */
function assessment(record) {
  return JSON.stringify({ schema: 'derivon.learning/v1', concepts: { limit: record }, derivations: {} });
}

test('a teaching round writes a learner record outside the workspace and no workspace file', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const before = await workspaceDigest(root);
  const args = ['write-learner-record', root, '--data-dir', dataRoot];

  /* A partial verdict is `incomplete`, which the protocol requires to carry a non-empty data. */
  const first = ok([...args, '--expected-version', 'missing'], assessment({
    status: 'incomplete',
    data: { teaching: { verdict: 'partial', taskType: 'boundary-analysis', gap: 'Does not yet test the zero case.', evidence: 'Distinguished the main cases but missed the boundary condition.' } },
  }));
  assert.equal(first.changed.learnerRecord, 'state.json');
  assert.equal(first.result.path, learnerRecordPath(dataRoot, WORKSPACE_ID, 'state'));
  assert.equal(await workspaceDigest(root), before, 'a round must not change any workspace file');
  await assert.rejects(readdir(path.join(root, '.derivon/teaching')), { code: 'ENOENT' }, 'no assessment state inside the workspace');
  await assert.rejects(readdir(path.join(root, '.derivon/learner-records')), { code: 'ENOENT' });

  /* The verdict and its evidence survive a read, and the basis was computed from the object. */
  const read = ok(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(read.result.version, first.result.version);
  const stored = JSON.parse(read.result.text);
  assert.equal(stored.concepts.limit.status, 'incomplete');
  assert.deepEqual(stored.concepts.limit.data.teaching, {
    verdict: 'partial',
    taskType: 'boundary-analysis',
    gap: 'Does not yet test the zero case.',
    evidence: 'Distinguished the main cases but missed the boundary condition.',
  });
  assert.match(stored.concepts.limit.basis, /^[0-9a-f]{64}$/);

  /* A demonstrated verdict moves the same record to the protocol's other status, while the
   * writer's namespace is what keeps the three-value vocabulary readable. */
  const second = ok([...args, '--expected-version', read.result.version], assessment({
    status: 'complete',
    data: { teaching: { verdict: 'demonstrated', taskType: 'application', evidence: 'Applied the rule and tested the zero boundary.' } },
  }));
  const updated = JSON.parse((await readFile(learnerRecordPath(dataRoot, WORKSPACE_ID, 'state'), 'utf8')));
  assert.equal(updated.concepts.limit.status, 'complete');
  assert.equal(updated.concepts.limit.data.teaching.verdict, 'demonstrated');
  assert.equal(updated.concepts.limit.data.selfReported, undefined, 'a judgement is not the learner\'s own claim');
  assert.equal(await workspaceDigest(root), before, 'a second round changes no workspace file either');

  /* Ending the assessment leaving the records alone: there is nothing to close, because there is
   * no persisted assessment to close. */
  const after = ok(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(after.result.version, second.result.version, 'reading is not a write');
});

test('the old in-workspace assessment state is gone from the skill and from a workspace', async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  /* The skill ships no assessment-state tool: the learner-record commands are the whole path. */
  await assert.rejects(readdir(path.join(repo, 'derivon-teaching/scripts')), { code: 'ENOENT' });
  const skill = await readFile(path.join(repo, 'derivon-teaching/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /derivon\.teaching/);
  assert.doesNotMatch(skill, /assessment-state/);
  assert.match(skill, /read-learner-record/);
  assert.match(skill, /write-learner-record/);
  const reference = await readFile(path.join(repo, 'derivon-teaching/references/assessment-records.md'), 'utf8');
  assert.match(reference, /derivon\.learning\/v1/);
  assert.match(reference, /incomplete.*non-empty/is);
  assert.match(reference, /never write\s+`selfReported`/i);

  /* A stray old state file is inert: nothing reads it, and it is not written to. */
  await mkdir(path.join(root, '.derivon/teaching'), { recursive: true });
  const legacy = path.join(root, '.derivon/teaching/state.json');
  await writeFile(legacy, `${JSON.stringify({ schema: 'derivon.teaching/v1', concepts: { limit: { status: 'demonstrated' } } })}\n`);
  const legacyBefore = await readFile(legacy, 'utf8');
  const read = ok(['read-learner-record', root, '--data-dir', dataRoot]);
  assert.equal(read.result.present, false, 'the old state is not a learner record');
  ok(['write-learner-record', root, '--data-dir', dataRoot, '--expected-version', 'missing'], assessment({ status: 'complete', data: { teaching: { verdict: 'demonstrated' } } }));
  assert.equal(await readFile(legacy, 'utf8'), legacyBefore, 'the old file is neither read nor rewritten');
});
