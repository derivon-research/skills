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

test('central document contract requires first-mention concept navigation without graph semantics', async () => {
  const text = await normalized('derivon-mindmap/references/rich-documents.md');
  assert.match(text, /first meaningful prose mention/i);
  assert.match(text, /standard relative link/i);
  assert.match(text, /reading navigation only, not a prerequisite, derivation/i);
  assert.match(text, /derivon-workspace\.mjs crosslink/i);
  assert.match(text, /Whole-workspace `--all` use requires a `--check` report and confirmation/i);
});

test('the learner-record boundary is stated where a reader will hit it', async () => {
  const skill = await normalized('derivon-mindmap/SKILL.md');
  assert.match(skill, /learner record is everything the application remembers/i);
  assert.match(skill, /never in the workspace/i);
  assert.match(skill, /route carries no completion marker/i);
  assert.match(skill, /input snapshot of\s+that solve/i);
  assert.match(skill, /absent file is `present: false` and not an error/i);
  assert.match(skill, /conflict-precondition/);
  assert.match(skill, /`--capabilities` is the single command list/i);

  const recipes = await normalized('derivon-mindmap/references/unix-recipes.md');
  assert.match(recipes, /a learner record is not workspace content/i);
  assert.match(recipes, /how far along a route the\s+learner is comes from `state\.json`/i);
  assert.match(recipes, /read-learner-record/);
  assert.match(recipes, /write-learner-record/);
});

test('Book Import treats meaning-bearing and requested figures as source fidelity', async () => {
  const text = await normalized('derivon-book-import/SKILL.md');
  assert.match(text, /Meaning-bearing source figures are source fidelity/i);
  assert.match(text, /user-requested figure is required/i);
  assert.match(text, /prefer exact extraction or faithful cropping/i);
  assert.match(text, /HTML comment, TODO, empty element.*is not a figure/i);
  assert.match(text, /report that object as blocked/i);
  assert.match(text, /Do not create a persistent figure inventory/i);
  assert.match(text, /Commit through the `derivon-mindmap` command surface/i);
});
