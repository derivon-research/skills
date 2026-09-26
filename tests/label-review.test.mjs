import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coordinationSignals, labelWidth } from '../derivon-mindmap/scripts/lib/label-review.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(repo, 'derivon-mindmap/scripts/derivon-workspace.mjs');
const validator = path.join(repo, 'derivon-mindmap/scripts/validate-workspace.mjs');

const LABELS = {
  short: '零空间',
  bundle: '样本均值与方差',
  long: '零空间的维数等于列数减去秩',
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-label-review-'));
  const points = Object.entries(LABELS).map(([id, label]) => ({ id, data: { label, document: `docs/${id}` } }));
  for (const { id, data } of points) {
    await mkdir(path.join(root, 'docs', id), { recursive: true });
    await writeFile(path.join(root, 'docs', id, 'document.md'), `# ${data.label}\n\nGrounded.\n`);
  }
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify({
    schema: 'derivon.workspace/v1',
    id: 'label-review-fixture',
    document: { title: 'Fixture', description: '' },
    graph: { points, hyperedges: [] },
  }, null, 2)}\n`);
  return root;
}

function surface(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input });
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

function reviews(envelope) {
  return envelope.result.labelReviews.map(({ id, check }) => `${id}:${check}`).sort();
}

async function rename(root, id, label) {
  const file = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.graph.points.find((point) => point.id === id).data.label = label;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('label width counts wide characters as one unit and the rest as half', () => {
  assert.equal(labelWidth('零空间维数公式'), 7);
  assert.equal(labelWidth('Cauchy'), 3);
  assert.equal(labelWidth('𝐅^{m,n} 同构'), 6);
  assert.equal(labelWidth('é'), 0.5, 'a combining mark takes no width');
  assert.equal(labelWidth('（实、复）'), 5, 'fullwidth punctuation is wide');
});

test('coordination signals ignore sums, verbs and bracketed argument lists', () => {
  assert.deepEqual(coordinationSignals('样本均值与方差'), ['与']);
  assert.deepEqual(coordinationSignals('Sum and product'), ['and']);
  assert.deepEqual(coordinationSignals('主元，自由变量'), ['，']);
  assert.deepEqual(coordinationSignals('平方和'), []);
  assert.deepEqual(coordinationSignals('调和级数'), []);
  assert.deepEqual(coordinationSignals('子空间的和是直和'), []);
  assert.deepEqual(coordinationSignals('线性映射空间 ℒ(V, W)'), []);
  assert.deepEqual(coordinationSignals('Android'), [], '`and` is matched as a word');
});

test('validate reports label advisories without failing, on both validate paths', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { status, envelope } = surface(['validate', root]);
  assert.equal(status, 0);
  assert.equal(envelope.status, 'ok');
  assert.deepEqual(envelope.issues, []);
  assert.deepEqual(reviews(envelope), ['bundle:coordination', 'long:length']);
  const length = envelope.result.labelReviews.find((entry) => entry.check === 'length');
  assert.equal(length.label, LABELS.long);
  assert.match(length.message, /split the point/);
  assert.match(length.message, /data\.description/);
  assert.match(length.message, /review-label/);
  assert.equal(envelope.result.acknowledgedLabelReviews, 0);

  const standalone = spawnSync(process.execPath, [validator, '--json', root], { encoding: 'utf8' });
  assert.equal(standalone.status, 0);
  const report = JSON.parse(standalone.stdout);
  assert.equal(report.valid, true);
  assert.deepEqual(report.labelReviews.map(({ id, check }) => `${id}:${check}`).sort(), ['bundle:coordination', 'long:length']);

  const text = spawnSync(process.execPath, [validator, root], { encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /is valid/);
  assert.match(text.stdout, /2 label advisory/);
  assert.match(text.stdout, /bundle "样本均值与方差" \[coordination\]/);
});

test('an acknowledgement silences an advisory until the label changes', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const written = surface(['review-label', root], JSON.stringify({
    entries: [{ id: 'long', check: 'length', reason: 'The theorem has no shorter conventional name.' }],
  }));
  assert.equal(written.status, 0, JSON.stringify(written.envelope.issues));
  assert.deepEqual(written.envelope.result.recorded, [{ id: 'long', label: LABELS.long, check: 'length' }]);
  const record = JSON.parse(await readFile(path.join(root, '.derivon/label-review.json'), 'utf8'));
  assert.equal(record.schema, 'derivon.label-review/v1');
  assert.deepEqual(record.entries, [{ id: 'long', label: LABELS.long, check: 'length', reason: 'The theorem has no shorter conventional name.' }]);

  let validated = surface(['validate', root]).envelope;
  assert.deepEqual(reviews(validated), ['bundle:coordination']);
  assert.equal(validated.result.acknowledgedLabelReviews, 1);
  assert.equal(validated.result.staleLabelReviews, 0);

  await rename(root, 'long', `${LABELS.long}的结论`);
  validated = surface(['validate', root]).envelope;
  assert.equal(validated.status, 'ok');
  assert.deepEqual(reviews(validated), ['bundle:coordination', 'long:length'], 'a rename re-opens the review');
  assert.equal(validated.result.staleLabelReviews, 1);

  const again = surface(['review-label', root], JSON.stringify({
    entries: [{ id: 'bundle', check: 'coordination', reason: 'Test-only acknowledgement.' }],
  }));
  assert.equal(again.status, 0);
  assert.equal(again.envelope.result.pruned, 1, 'the stale entry is pruned');
  assert.equal(again.envelope.result.entries, 1);
});

test('a malformed label-review record is a validate error', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.derivon/label-review.json');

  for (const [content, pointer] of [
    ['{not json', ''],
    [JSON.stringify({ schema: 'derivon.label-review/v1', entries: [{ id: 'long', label: LABELS.long, check: 'width', reason: 'x' }] }), '/entries/0/check'],
    [JSON.stringify({ schema: 'derivon.label-review/v1', entries: [{ id: 'long', label: LABELS.long, check: 'length', reason: ' ' }] }), '/entries/0/reason'],
  ]) {
    await writeFile(file, content);
    const { status, envelope } = surface(['validate', root]);
    assert.equal(status, 1);
    assert.equal(envelope.status, 'diagnostics');
    assert.ok(envelope.issues.some((entry) => entry.code === 'label-review-invalid' && entry.path === `.derivon/label-review.json#${pointer}`), JSON.stringify(envelope.issues));
    const standalone = spawnSync(process.execPath, [validator, '--json', root], { encoding: 'utf8' });
    assert.equal(standalone.status, 1);

    const refused = surface(['review-label', root], JSON.stringify({ entries: [{ id: 'long', check: 'length', reason: 'x' }] }));
    assert.equal(refused.status, 1);
    assert.equal(refused.envelope.issues[0].code, 'label-review-invalid');
    assert.equal(await readFile(file, 'utf8'), content, 'a malformed record is never overwritten');
  }
});

test('review-label refuses an unknown id or an advisory that does not apply, and writes nothing', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.derivon/label-review.json');

  for (const [entries, code] of [
    [[{ id: 'missing', check: 'length', reason: 'x' }], 'unknown-object'],
    [[{ id: 'short', check: 'length', reason: 'x' }], 'label-review-not-applicable'],
    [[{ id: 'long', check: 'coordination', reason: 'x' }], 'label-review-not-applicable'],
    [[{ id: 'long', check: 'length', reason: 'x' }, { id: 'short', check: 'coordination', reason: 'x' }], 'label-review-not-applicable'],
    [[{ id: 'long', check: 'length', reason: '' }], 'invalid-payload'],
    [[{ id: 'long', check: 'size', reason: 'x' }], 'invalid-payload'],
    [[], 'invalid-payload'],
  ]) {
    const { status, envelope } = surface(['review-label', root], JSON.stringify({ entries }));
    assert.equal(status, 1, JSON.stringify(entries));
    assert.ok(envelope.issues.some((entry) => entry.code === code), `${JSON.stringify(entries)}: ${JSON.stringify(envelope.issues)}`);
    await assert.rejects(readFile(file), { code: 'ENOENT' }, 'a refused batch writes nothing');
  }
});
