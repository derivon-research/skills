import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const skill = (name) => readFile(path.join(root, name, 'SKILL.md'), 'utf8');

test('the package exposes exactly the six accepted skill protocols', async () => {
  const directories = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      try { await readFile(path.join(root, entry.name, 'SKILL.md')); directories.push(entry.name); } catch {}
    }
  }
  assert.deepEqual(directories.sort(), [
    'derivon-book-import', 'derivon-cli', 'derivon-creation',
    'derivon-exploration', 'derivon-mindmap', 'derivon-teaching',
  ]);
});

test('book import preserves source derivations and concept atomicity', async () => {
  const text = await skill('derivon-book-import');
  assert.match(text, /one chapter transaction/i);
  assert.match(text, /Chapter order[\s\S]*not derivations/i);
  assert.match(text, /Chinese `与`, `和`, `、`, English `and`/);
  assert.match(text, /Do not create a persistent loop\/checkpoint file/);
  assert.match(text, /author's wording and\s+examples when authorized/i);
});

test('teaching is read-only, bounded, diagnostic, and non-leading', async () => {
  const text = await skill('derivon-teaching');
  assert.match(text, /do\s+not edit the graph/i);
  assert.match(text, /at most three questions/i);
  assert.match(text, /Do not\s+provide recommended answers/i);
  assert.match(text, /discrimination, application, transfer, case, or\s+scenario/i);
  assert.match(text, /conversation-local report/i);
});

test('exploration follows the accepted personal learning loop', async () => {
  const text = await skill('derivon-exploration');
  for (const step of ['Analyze the question', 'Explain from evidence', 'Verify usable understanding', 'Update after evidence', 'Offer valuable next questions', 'Continue']) {
    assert.match(text, new RegExp(step));
  }
  assert.match(text, /personal learning graph/i);
  assert.match(text, /Do not create a session file/);
  assert.match(text, /Do not create candidate\s+points or edges during recommendation/);
  assert.match(text, /empty tail.*query start set/is);
});

test('creation writes only after expert-frontier confirmation', async () => {
  const text = await skill('derivon-creation');
  assert.match(text, /user is the domain\s+semantic authority/i);
  assert.match(text, /recommended answer/i);
  assert.match(text, /Do not write/);
  assert.match(text, /confirm shared understanding and authorize this batch/i);
  assert.match(text, /chapter order, chronology, similarity, or citation disguised as derivation/i);
});

test('mindmap owns only the three accepted complex tools and reports documents', async () => {
  const scripts = (await readdir(path.join(root, 'derivon-mindmap/scripts'))).sort();
  assert.deepEqual(scripts, ['export-route-textbook.mjs', 'render-documents.mjs', 'validate-workspace.mjs']);
  const text = await skill('derivon-mindmap');
  assert.match(text, /direct `jq \| derivon \| jq` recipes/i);
  assert.match(text, /report graph changes and every updated document/i);
  assert.match(text, /interactive example/i);
  assert.match(text, /--allow-approximate/);
});

test('the CLI skill retains whole-step costs and B-hypergraph invariants', async () => {
  const text = await skill('derivon-cli');
  assert.match(text, /Tails are AND/);
  assert.match(text, /Parallel hyperedges are legal/);
  assert.match(text, /empty tail[\s\S]*not a\s+query start set/i);
  assert.match(text, /weight belongs to the whole hyperedge/i);
  assert.match(text, /Chinese `与`, `和`, `、`, English[\s\S]*`and`/);
});
