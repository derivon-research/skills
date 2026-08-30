import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(new URL('..', import.meta.url).pathname);

async function normalized(relativePath) {
  return (await readFile(path.join(repo, relativePath), 'utf8')).replace(/\s+/g, ' ').trim();
}

test('central document contract is presentation-aware and chooses the least powerful representation', async () => {
  const text = await normalized('derivon-mindmap/references/rich-documents.md');
  assert.match(text, /learner-visible publication/i);
  assert.match(text, /least powerful representation/i);
  assert.match(text, /local static image through Markdown/i);
  assert.match(text, /HTML comment.*invisible/i);
  assert.match(text, /metadata.*does not insert a figure/i);
  assert.match(text, /Renderer success is the publication gate/i);
  assert.match(text, /Browser screenshots.*not mandatory/i);
});

test('Book Import treats meaning-bearing and requested figures as source fidelity', async () => {
  const text = await normalized('derivon-book-import/SKILL.md');
  assert.match(text, /Meaning-bearing source figures are source fidelity/i);
  assert.match(text, /user-requested figure is required/i);
  assert.match(text, /prefer exact extraction or faithful cropping/i);
  assert.match(text, /HTML comment, TODO, empty element.*is not a figure/i);
  assert.match(text, /report that object as blocked/i);
  assert.match(text, /Do not create a persistent figure inventory/i);
});
