import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const crosslink = path.join(repo, 'derivon-mindmap/scripts/crosslink-documents.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-crosslink-'));
  const points = [
    ['loop', 'Agent Loop', 'docs/concept-agent-loop'],
    ['agent', 'Agent', 'docs/concept-agent'],
    ['tool', 'Tool Layer', 'docs/nested/concept tool'],
    ['skill', 'Skill', 'docs/concept-skill'],
    ['cn', '工具调用', 'docs/concept-cn'],
    ['topic', 'Topic', 'docs/concept-topic'],
    ['html', 'HTML Topic', 'docs/concept-html'],
  ].map(([id, label, document]) => ({ id, data: { label, document, format: id === 'html' ? 'html' : 'markdown' } }));
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  for (const point of points) {
    const directory = path.join(root, point.data.document);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'document.md'), `# ${point.data.label}\n\nOwn document.\n`);
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><body>stale</body></html>\n');
  }
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify({
    schema: 'derivon.workspace/v1',
    document: { title: 'Crosslinks', description: 'Fixture' },
    graph: { points, hyperedges: [] },
  }, null, 2)}\n`);
  return root;
}

function run(args) {
  return spawnSync(process.execPath, [crosslink, ...args], { encoding: 'utf8' });
}

test('crosslink check and write preserve Markdown while linking first exact prose mentions', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'docs/concept-topic/document.md');
  const source = `# Agent Loop and Tool Layer\n\n**Agent** Loop works with Tool Layer and 工具调用. Skills is plural; Skill is canonical.\n\n- Agent Loop repeats.\n\n> Tool Layer repeats.\n\n\`Agent Loop\` and $Tool Layer$ stay literal.\n\n![Agent Loop](./figure.png)\n\n<div>Agent Loop</div>\n`;
  await writeFile(sourcePath, source);

  const checked = run(['--json', root, 'topic']);
  assert.equal(checked.status, 1, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.insertionCount, 4);
  assert.deepEqual(report.insertions.map((entry) => entry.targetId).sort(), ['cn', 'loop', 'skill', 'tool']);
  assert.equal(await readFile(sourcePath, 'utf8'), source);

  const written = run(['--write', root, 'topic']);
  assert.equal(written.status, 0, written.stderr);
  const output = await readFile(sourcePath, 'utf8');
  assert.match(output, /\[\*\*Agent\*\* Loop\]\(\.\.\/concept-agent-loop\/index\.html\)/);
  assert.match(output, /\[Tool Layer\]\(\.\.\/nested\/concept%20tool\/index\.html\)/);
  assert.match(output, /\[工具调用\]\(\.\.\/concept-cn\/index\.html\)/);
  assert.match(output, /Skills is plural; \[Skill\]/);
  assert.match(output, /- Agent Loop repeats/);
  assert.match(output, /`Agent Loop` and \$Tool Layer\$/);
  assert.match(output, /<div>Agent Loop<\/div>/);
  assert.equal(run([root, 'topic']).status, 0);
});

test('crosslink write is blocked atomically by a conflicting first link', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const topicPath = path.join(root, 'docs/concept-topic/document.md');
  const toolPath = path.join(root, 'docs/nested/concept tool/document.md');
  await writeFile(topicPath, '# Topic\n\nAgent Loop is useful.\n');
  await writeFile(toolPath, '# Tool Layer\n\n[Agent Loop](https://example.com/wrong) is external.\n');
  const before = await readFile(topicPath, 'utf8');
  const result = run(['--write', root, 'topic', 'tool']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicting-link/);
  assert.equal(await readFile(topicPath, 'utf8'), before);
});

test('crosslink detects encountered duplicate labels but ignores unused duplicates', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.graph.points.push({ id: 'loop-2', data: { label: 'Agent Loop', document: 'docs/loop-2' } });
  await mkdir(path.join(root, 'docs/loop-2'));
  await writeFile(path.join(root, 'docs/loop-2/document.md'), '# Other\n');
  await writeFile(path.join(root, 'docs/loop-2/index.html'), '<html><body>Other</body></html>\n');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'docs/concept-topic/document.md'), '# Topic\n\nTool Layer only.\n');
  assert.equal(run(['--write', root, 'topic']).status, 0);
  await writeFile(path.join(root, 'docs/concept-topic/document.md'), '# Topic\n\nAgent Loop appears.\n');
  const ambiguous = run(['--write', root, 'topic']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous-label/);
});

test('crosslink rejects a document source symlink outside the workspace', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'derivon-crosslink-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const sourcePath = path.join(root, 'docs/concept-topic/document.md');
  await rm(sourcePath);
  const externalPath = path.join(outside, 'document.md');
  await writeFile(externalPath, '# Topic\n\nAgent Loop.\n');
  await symlink(externalPath, sourcePath);
  const result = run(['--write', root, 'topic']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic-link|outside the workspace/i);
  assert.equal(await readFile(externalPath, 'utf8'), '# Topic\n\nAgent Loop.\n');
});

test('crosslink supports candidate manifests and requires explicit scope', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(run([root]).status, 2);
  const manifest = JSON.parse(await readFile(path.join(root, '.derivon/workspace.json'), 'utf8'));
  manifest.graph.points.push({ id: 'new', data: { label: 'New Concept', document: 'docs/new' } });
  await mkdir(path.join(root, 'docs/new'));
  await writeFile(path.join(root, 'docs/new/document.md'), '# New Concept\n');
  await writeFile(path.join(root, 'docs/new/index.html'), '<html><body>New</body></html>\n');
  const candidate = path.join(root, '.derivon/candidate.json');
  await writeFile(candidate, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'docs/concept-topic/document.md'), '# Topic\n\nNew Concept appears.\n');
  const result = run(['--write', '--manifest', candidate, root, 'topic']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(root, 'docs/concept-topic/document.md'), 'utf8'), /\[New Concept\]\(\.\.\/new\/index\.html\)/);
});
