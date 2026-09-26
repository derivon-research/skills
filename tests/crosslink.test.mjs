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
  }
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify({
    schema: 'derivon.workspace/v1',
    id: 'crosslink-fixture',
    document: { title: 'Crosslinks', description: 'Fixture' },
    graph: { points, hyperedges: [] },
  }, null, 2)}\n`);
  return root;
}

function run(args) {
  return spawnSync(process.execPath, [crosslink, ...args], { encoding: 'utf8' });
}

test('crosslink suggests first exact prose mentions and writes only the ones applied', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'docs/concept-topic/document.md');
  const source = `# Agent Loop and Tool Layer\n\n**Agent** Loop works with Tool Layer and 工具调用. Skills is plural; Skill is canonical.\n\n- Agent Loop repeats.\n\n> Tool Layer repeats.\n\n\`Agent Loop\` and $Tool Layer$ stay literal.\n\n![Agent Loop](./figure.png)\n\n<div>Agent Loop</div>\n`;
  await writeFile(sourcePath, source);

  const checked = run(['--json', root, 'topic']);
  assert.equal(checked.status, 0, 'optional suggestions alone do not fail a check');
  const report = JSON.parse(checked.stdout);
  assert.deepEqual(report.suggestions.map((entry) => entry.id).sort(), ['topic:cn', 'topic:loop', 'topic:skill', 'topic:tool']);
  assert.ok(report.suggestions.every((entry) => !entry.written));
  assert.equal(report.suggestions.find((entry) => entry.id === 'topic:cn').context, 'yer and [工具调用]. Skills');
  assert.equal(await readFile(sourcePath, 'utf8'), source);

  const unselected = run(['--write', root, 'topic']);
  assert.equal(unselected.status, 0, unselected.stderr);
  assert.equal(await readFile(sourcePath, 'utf8'), source, 'nothing is written without --apply');

  const written = run(['--write', '--apply', 'topic:loop', '--apply', 'topic:tool,topic:cn', '--apply', 'topic:skill', root, 'topic']);
  assert.equal(written.status, 0, written.stderr);
  const output = await readFile(sourcePath, 'utf8');
  assert.match(output, /\[\*\*Agent\*\* Loop\]\(\.\.\/concept-agent-loop\/document\.md\)/);
  assert.match(output, /\[Tool Layer\]\(\.\.\/nested\/concept%20tool\/document\.md\)/);
  assert.match(output, /\[工具调用\]\(\.\.\/concept-cn\/document\.md\)/);
  assert.match(output, /Skills is plural; \[Skill\]/);
  assert.match(output, /- Agent Loop repeats/);
  assert.match(output, /`Agent Loop` and \$Tool Layer\$/);
  assert.match(output, /<div>Agent Loop<\/div>/);
  assert.equal(JSON.parse(run(['--json', root, 'topic']).stdout).suggestions.length, 0);
});

test('crosslink refuses an --apply id that is not a pending suggestion', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'docs/concept-topic/document.md'), '# Topic\n\nSkill.\n');
  const result = run(['--write', '--json', '--apply', 'topic:loop', root, 'topic']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).issues.map((entry) => entry.code), ['unknown-suggestion']);
  assert.equal(await readFile(path.join(root, 'docs/concept-topic/document.md'), 'utf8'), '# Topic\n\nSkill.\n');
});

test('crosslink keeps an author link to another target and still writes the rest of the batch', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const topicPath = path.join(root, 'docs/concept-topic/document.md');
  const toolPath = path.join(root, 'docs/nested/concept tool/document.md');
  await writeFile(topicPath, '# Topic\n\nAgent Loop is useful.\n');
  const toolSource = '# Tool Layer\n\n[Agent Loop](https://example.com/wrong) is external. Agent Loop again, and Skill.\n';
  await writeFile(toolPath, toolSource);
  const result = run(['--write', '--json', '--apply', 'topic:loop', '--apply', 'tool:skill', root, 'topic', 'tool']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.notices.map((entry) => entry.code), ['kept-author-link']);
  assert.ok(!report.suggestions.some((entry) => entry.id === 'tool:loop'), 'the kept label is not suggested again');
  assert.match(await readFile(topicPath, 'utf8'), /\[Agent Loop\]\(\.\.\/concept-agent-loop\/document\.md\)/);
  const tool = await readFile(toolPath, 'utf8');
  assert.match(tool, /\[Agent Loop\]\(https:\/\/example\.com\/wrong\) is external\. Agent Loop again, and \[Skill\]/);
});

test('crosslink lets an object own label occupy its span in its own document', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const loopPath = path.join(root, 'docs/concept-agent-loop/document.md');
  await writeFile(loopPath, '# Agent Loop\n\nAn Agent Loop repeats. A lone Agent calls it.\n');
  const result = run(['--write', '--apply', 'loop:agent', root, 'loop']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(loopPath, 'utf8'), /An Agent Loop repeats\. A lone \[Agent\]\(\.\.\/concept-agent\/document\.md\) calls it\./);
});

test('crosslink detects encountered duplicate labels but ignores unused duplicates', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.graph.points.push({ id: 'loop-2', data: { label: 'Agent Loop', document: 'docs/loop-2' } });
  await mkdir(path.join(root, 'docs/loop-2'));
  await writeFile(path.join(root, 'docs/loop-2/document.md'), '# Other\n');
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
  const candidate = path.join(root, '.derivon/candidate.json');
  await writeFile(candidate, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'docs/concept-topic/document.md'), '# Topic\n\nNew Concept appears.\n');
  const result = run(['--write', '--apply', 'topic:new', '--manifest', candidate, root, 'topic']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(root, 'docs/concept-topic/document.md'), 'utf8'), /\[New Concept\]\(\.\.\/new\/document\.md\)/);
});

test('the link audit reports links to missing workspace files and nothing about derivation endpoints', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.graph.hyperedges.push({ id: 'h-loop', weight: 1, tails: ['agent', 'tool'], head: 'loop', data: { document: 'docs/h-loop' } });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(path.join(root, 'docs/h-loop'));
  await writeFile(path.join(root, 'docs/h-loop/document.md'), '# Why\n\nBy [the agent](../concept-agent/document.md), see [gone](../concept-gone/document.md), [web](https://example.com), [here](#why) and [figure](./figure.png).\n');
  const result = run(['--audit-links', '--json', root]);
  assert.equal(result.status, 1);
  const issues = JSON.parse(result.stdout).issues;
  assert.deepEqual(issues.map((entry) => `${entry.code}:${entry.objectId}`), ['dangling-link:h-loop', 'dangling-link:h-loop']);
  assert.ok(issues.some((entry) => /concept-gone/.test(entry.message)));
  await writeFile(path.join(root, 'docs/h-loop/figure.png'), 'png');
  assert.equal(JSON.parse(run(['--audit-links', '--json', root]).stdout).issues.filter((entry) => entry.code === 'dangling-link').length, 1);
});
