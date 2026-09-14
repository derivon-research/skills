import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(repo, 'derivon-mindmap/scripts/derivon-workspace.mjs');

const BASE_MANIFEST = {
  schema: 'derivon.workspace/v1',
  id: 'command-fixture',
  document: { title: 'Fixture', description: '' },
  graph: {
    points: [
      { id: 'A', data: { label: 'Alpha', document: 'docs/a' } },
      { id: 'B', data: { label: 'Beta', document: 'docs/b' } },
    ],
    hyperedges: [
      { id: 'h-ab', weight: 1.5, tails: ['A'], head: 'B', data: { document: 'docs/h-ab' } },
    ],
  },
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-command-'));
  for (const [directory, markdown] of [
    ['docs/a', '# Alpha\n\nGrounded alpha.\n'],
    ['docs/b', '# Beta\n\nGrounded beta.\n'],
    ['docs/h-ab', '# Alpha to Beta\n\nAlpha establishes beta.\n'],
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'document.md'), markdown);
  }
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`);
  return root;
}

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input });
}

async function manifest(root) {
  return readFile(path.join(root, '.derivon/workspace.json'), 'utf8');
}

async function entries(directory) {
  return readdir(directory);
}

function assertNoTemporaries(listing, where) {
  assert.equal(listing.filter((name) => name.includes('.derivon-part-')).length, 0, `temporary files left in ${where}: ${listing.join(', ')}`);
}

test('capabilities is the single command manifest and every declared command runs', async (t) => {
  const capabilities = JSON.parse(run(['--capabilities']).stdout);
  assert.equal(capabilities.schema, 'derivon.command-capabilities/v1');
  const names = capabilities.commands.map((command) => command.name);
  assert.deepEqual([...names].sort(), names, 'commands are sorted');
  assert.ok(names.includes('add-concept') && names.includes('write-document') && names.includes('import'));
  for (const command of capabilities.commands) {
    assert.equal(typeof command.capability, 'string', command.name);
    assert.equal(typeof command.summary, 'string', command.name);
    assert.ok(Array.isArray(command.argv) && command.argv.length > 0, command.name);
    assert.ok(command.argv.some((argument) => argument.name === 'workspace' && argument.required), command.name);
    assert.ok(command.result && Array.isArray(command.result.changed), command.name);
  }

  for (const command of capabilities.commands) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const invocations = {
      validate: [[root], undefined],
      render: [[root], undefined],
      crosslink: [[root, '--all'], undefined],
      'new-object-id': [[root], undefined],
      'export-textbook': [[root, '--output', path.join(root, 'textbook'), '--start', 'A', '--target', 'B'], undefined],
      'add-concept': [[root], JSON.stringify({ id: 'C1', data: { label: 'Gamma', document: 'docs/c1' }, markdown: '# Gamma\n\nNew.\n' })],
      'add-derivation': [[root], JSON.stringify({ id: 'h-extra', tails: ['A'], head: 'B', weight: 2, data: { document: 'docs/h-extra' }, markdown: '# Extra\n\nAlternative.\n' })],
      'set-metadata': [[root], JSON.stringify({ document: { title: 'Renamed' } })],
      'write-document': [[root], JSON.stringify({ object: 'A', markdown: '# Alpha\n\nRewritten.\n' })],
      'delete-object': [[root, 'h-ab'], undefined],
      import: [[root], JSON.stringify(BASE_MANIFEST)],
    };
    const [args, input] = invocations[command.name];
    const result = run([command.name, ...args], input);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schema, 'derivon.workspace-result/v1', command.name);
    assert.equal(output.command, command.name, command.name);
    assert.equal(output.capability, command.capability, command.name);
    assert.equal(output.status, 'ok', `${command.name}: ${output.issues.map((issue) => issue.code).join(', ')}`);
    assert.equal(result.status, 0, command.name);
  }
});

test('usage errors and unknown objects use their own exit codes and codes', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const unknown = run(['frobnicate', root]);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).issues[0].code, 'usage');

  const missingWorkspace = run(['validate']);
  assert.equal(missingWorkspace.status, 2);
  assert.equal(JSON.parse(missingWorkspace.stdout).issues[0].code, 'usage');

  const diagnostics = run(['write-document', root], JSON.stringify({ object: 'NOPE', markdown: '# x\n' }));
  assert.equal(diagnostics.status, 1);
  const output = JSON.parse(diagnostics.stdout);
  assert.equal(output.status, 'diagnostics');
  assert.equal(output.issues[0].code, 'unknown-object');
  assert.equal(output.changed.manifest, false);
});

test('add-concept writes the document first and replaces the manifest last', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await manifest(root);

  const result = run(['add-concept', root], JSON.stringify({
    id: 'C',
    data: { label: 'Gamma', document: 'docs/c', tags: ['topic'] },
    markdown: '# Gamma\n\nA new concept.\n',
  }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.changed, { manifest: true, objects: ['C'], documents: ['docs/c'] });
  assert.equal(await readFile(path.join(root, 'docs/c/document.md'), 'utf8'), '# Gamma\n\nA new concept.\n');
  const written = JSON.parse(await manifest(root));
  assert.ok(written.graph.points.some((point) => point.id === 'C'));
  assert.notEqual(await manifest(root), before);
  assertNoTemporaries(await entries(root), root);
  assertNoTemporaries(await entries(path.join(root, '.derivon')), '.derivon');
});

test('a refused structural commit leaves the manifest byte-identical and the new document rolled back', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await manifest(root);

  // The head of the new derivation does not exist, so the candidate graph is invalid.
  const invalid = run(['add-derivation', root], JSON.stringify({
    id: 'h-ghost',
    tails: ['A'],
    head: 'GHOST',
    weight: 1,
    data: { document: 'docs/h-ghost' },
    markdown: '# Ghost\n\nInvalid.\n',
  }));
  assert.equal(invalid.status, 1);
  assert.equal(await manifest(root), before, 'manifest must not change on a refused commit');
  await assert.rejects(readdir(path.join(root, 'docs/h-ghost')), { code: 'ENOENT' }, 'a document this command created is rolled back');
  assertNoTemporaries(await entries(root), root);

  // A document directory already owned by another object is a duplicate, not a second add.
  const duplicate = run(['add-concept', root], JSON.stringify({
    id: 'C2',
    data: { label: 'Gamma', document: 'docs/a' },
    markdown: '# Gamma\n\nDuplicate.\n',
  }));
  assert.equal(duplicate.status, 1);
  assert.equal(JSON.parse(duplicate.stdout).issues[0].code, 'duplicate-document');
  assert.equal(await manifest(root), before);
  assert.equal(await readFile(path.join(root, 'docs/a/document.md'), 'utf8'), '# Alpha\n\nGrounded alpha.\n');

  // A nested document directory this command created is removed whole, not just its leaf.
  const nested = run(['add-derivation', root], JSON.stringify({
    id: 'h-nested',
    tails: ['A'],
    head: 'GHOST',
    weight: 1,
    data: { document: 'docs/nested/deeper' },
    markdown: '# Nested\n\nInvalid.\n',
  }));
  assert.equal(nested.status, 1);
  assert.equal(await manifest(root), before);
  await assert.rejects(readdir(path.join(root, 'docs/nested')), { code: 'ENOENT' }, 'the whole created chain is rolled back');
});

test('a concurrent manifest change refuses the whole commit by manifest hash', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const manifestPath = path.join(root, '.derivon/workspace.json');
  let stopped = false;
  let counter = 0;
  const writer = (async () => {
    while (!stopped) {
      counter += 1;
      const candidate = structuredClone(BASE_MANIFEST);
      candidate.document.description = `writer ${counter}`;
      const temporary = path.join(root, `.write-${counter}.tmp`);
      await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`);
      await rename(temporary, manifestPath);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();

  const child = spawn(process.execPath, [cli, 'add-concept', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify({ id: 'RACE', data: { label: 'Race', document: 'docs/race' }, markdown: '# Race\n\nConcurrent.\n' }));
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  stopped = true;
  await writer;

  assert.equal(code, 1);
  const output = JSON.parse(stdout);
  assert.equal(output.status, 'diagnostics');
  assert.equal(output.issues[0].code, 'conflict-precondition');
  assert.equal(output.changed.manifest, false);
  const final = JSON.parse(await manifest(root));
  assert.ok(!final.graph.points.some((point) => point.id === 'RACE'), 'the refused candidate never reached the manifest');
  await assert.rejects(readdir(path.join(root, 'docs/race')), { code: 'ENOENT' });
  assertNoTemporaries(await entries(root), root);
});

test('document paths are contained entry by entry after realpath', async (t) => {
  const root = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), 'derivon-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(external, { recursive: true, force: true }));
  const before = await manifest(root);

  for (const [name, document] of [
    ['parent traversal', '../escape'],
    ['interior traversal', 'docs/../escape'],
    ['absolute path', path.join(external, 'docs')],
    ['backslash', 'docs\\escape'],
  ]) {
    const result = run(['add-concept', root], JSON.stringify({ id: `X${document.length}`, data: { label: name, document }, markdown: '# x\n' }));
    assert.equal(result.status, 1, name);
    assert.equal(JSON.parse(result.stdout).issues[0].code, 'document-unsafe', name);
  }

  // A document directory that is a symlink out of the workspace resolves outside it.
  await writeFile(path.join(external, 'document.md'), '# Outside\n');
  await symlink(external, path.join(root, 'docs/escape'));
  const escaped = run(['add-concept', root], JSON.stringify({ id: 'ESC', data: { label: 'Escape', document: 'docs/escape' }, markdown: '# Escape\n' }));
  assert.equal(escaped.status, 1);
  assert.equal(JSON.parse(escaped.stdout).issues[0].code, 'document-unsafe');

  // A symlinked parent directory must not carry a created document outside the workspace.
  const outsideParent = path.join(external, 'parent-target');
  await mkdir(outsideParent, { recursive: true });
  await symlink(outsideParent, path.join(root, 'linkdocs'));
  const viaSymlink = run(['add-concept', root], JSON.stringify({ id: 'VIA', data: { label: 'Via', document: 'linkdocs/nested' }, markdown: '# Via\n' }));
  assert.equal(viaSymlink.status, 1);
  assert.equal(JSON.parse(viaSymlink.stdout).issues[0].code, 'document-unsafe');
  await assert.rejects(readdir(path.join(outsideParent, 'nested')), { code: 'ENOENT' }, 'nothing may be created outside the workspace');

  // The same check guards a document write against a hand-edited manifest.
  const linked = await mkdtemp(path.join(os.tmpdir(), 'derivon-linked-'));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await mkdir(path.join(linked, '.derivon'), { recursive: true });
  await copyFile(path.join(root, '.derivon/workspace.json'), path.join(linked, '.derivon/workspace.json'));
  await mkdir(path.join(linked, 'docs'), { recursive: true });
  await symlink(external, path.join(linked, 'docs/a'));
  const guarded = run(['write-document', linked], JSON.stringify({ object: 'A', markdown: '# Escaped\n' }));
  assert.equal(guarded.status, 1);
  assert.equal(JSON.parse(guarded.stdout).issues[0].code, 'document-unsafe');
  assert.equal(await readFile(path.join(external, 'document.md'), 'utf8'), '# Outside\n', 'the outside document must stay untouched');

  assert.equal(await manifest(root), before);
});

test('import validates a complete manifest, creates a missing one, and refuses an invalid one', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const imported = structuredClone(BASE_MANIFEST);
  imported.document.title = 'Imported';
  imported.graph.points.push({ id: 'C', data: { label: 'Gamma', document: 'docs/b' } });
  const duplicate = run(['import', root], JSON.stringify(imported));
  assert.equal(duplicate.status, 1);
  assert.ok(JSON.parse(duplicate.stdout).issues.some((issue) => issue.code === 'duplicate-document'));

  const missingField = run(['import', root], JSON.stringify({ ...structuredClone(BASE_MANIFEST), view: {} }));
  assert.equal(missingField.status, 1);
  assert.ok(JSON.parse(missingField.stdout).issues.some((issue) => issue.code === 'schema-invalid'));

  const clean = structuredClone(BASE_MANIFEST);
  clean.document.title = 'Imported';
  const accepted = run(['import', root], JSON.stringify(clean));
  assert.equal(accepted.status, 0, accepted.stdout);
  assert.equal(JSON.parse(await manifest(root)).document.title, 'Imported');

  const fresh = await mkdtemp(path.join(os.tmpdir(), 'derivon-fresh-'));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  await mkdir(path.join(fresh, '.derivon'), { recursive: true });
  for (const [directory, markdown] of [['docs/a', '# Alpha\n'], ['docs/b', '# Beta\n'], ['docs/h-ab', '# Edge\n']]) {
    await mkdir(path.join(fresh, directory), { recursive: true });
    await writeFile(path.join(fresh, directory, 'document.md'), markdown);
  }
  const created = run(['import', fresh], JSON.stringify(BASE_MANIFEST));
  assert.equal(created.status, 0, created.stdout);
  assert.equal(JSON.parse(await manifest(fresh)).id, 'command-fixture');
});

test('set-metadata delivers the object ids it changed', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(['set-metadata', root], JSON.stringify({
    objects: { A: { data: { label: 'Alpha renamed', document: 'docs/a' } } },
  }));
  assert.equal(result.status, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.changed.objects, ['A']);
  assert.deepEqual(output.result, { objects: ['A'] });
  assert.equal(JSON.parse(await manifest(root)).graph.points[0].data.label, 'Alpha renamed');
});

test('delete-object removes the graph object and never its document directory', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const removed = run(['delete-object', root, 'h-ab']);
  assert.equal(removed.status, 0, removed.stdout);
  const output = JSON.parse(removed.stdout);
  assert.deepEqual(output.changed, { manifest: true, objects: ['h-ab'], documents: [] });
  assert.deepEqual(output.result.documents, ['docs/h-ab']);
  assert.equal(await readFile(path.join(root, 'docs/h-ab/document.md'), 'utf8'), '# Alpha to Beta\n\nAlpha establishes beta.\n');
  assert.equal(JSON.parse(await manifest(root)).graph.hyperedges.length, 0);

  const unknown = run(['delete-object', root, 'NOPE']);
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).issues[0].code, 'unknown-object');
});

test('write-document replaces one document and crosslink stays behind the command surface', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const written = run(['write-document', root], JSON.stringify({ object: 'A', markdown: '# Alpha\n\nRewritten alpha.\n' }));
  assert.equal(written.status, 0, written.stdout);
  assert.deepEqual(JSON.parse(written.stdout).changed, { manifest: false, objects: [], documents: ['docs/a'] });
  assert.equal(await readFile(path.join(root, 'docs/a/document.md'), 'utf8'), '# Alpha\n\nRewritten alpha.\n');
  assertNoTemporaries(await entries(path.join(root, 'docs/a')), 'docs/a');

  const checked = run(['crosslink', root, '--all', '--check']);
  assert.equal(checked.status, 1);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.command, 'crosslink');
  assert.ok(report.result.insertionCount >= 1);
  assert.ok(report.issues.every((issue) => typeof issue.code === 'string'));

  const published = run(['crosslink', root, '--all']);
  assert.equal(published.status, 0, published.stdout);
  assert.deepEqual(JSON.parse(published.stdout).changed.documents.length > 0, true);
  assert.ok((await readFile(path.join(root, 'docs/h-ab/document.md'), 'utf8')).includes('[Alpha]'));
});

test('render and export-textbook return the envelope and coded diagnostics', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const rendered = run(['render', root]);
  assert.equal(rendered.status, 0, rendered.stdout);
  assert.equal(JSON.parse(rendered.stdout).result.documents.length, 3);

  const unknown = run(['render', root, 'NOPE']);
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).issues[0].code, 'unknown-object');

  await rm(path.join(root, 'docs/a'), { recursive: true });
  const missing = run(['render', root, 'A']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).issues[0].code, 'document-missing', 'a missing document directory is a named diagnostic, not an errno');
  await mkdir(path.join(root, 'docs/a'), { recursive: true });
  await writeFile(path.join(root, 'docs/a/document.md'), '# Alpha\n\nGrounded alpha.\n');

  const exported = run(['export-textbook', root, '--output', path.join(root, 'textbook'), '--start', 'A', '--target', 'B']);
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).result.chapters.map((chapter) => chapter.id), ['A', 'h-ab', 'B']);

  const refused = run(['export-textbook', root, '--output', path.join(root, 'textbook'), '--start', 'A', '--target', 'B']);
  assert.equal(refused.status, 1);
  assert.ok(JSON.parse(refused.stdout).issues.some((issue) => issue.code === 'output-exists'));

  const unreachable = run(['export-textbook', root, '--output', path.join(root, 'no-route'), '--start', 'A', '--target', 'MISSING']);
  assert.equal(unreachable.status, 1);
  assert.ok(JSON.parse(unreachable.stdout).issues.some((issue) => ['route-unreachable', 'graph-invalid'].includes(issue.code)));

  const preview = run(['export-textbook', root, '--output', path.join(root, 'served'), '--start', 'A', '--target', 'B', '--serve']);
  assert.equal(preview.status, 2, 'the preview server is not part of the command surface');
  assert.equal(JSON.parse(preview.stdout).issues[0].code, 'usage');
});

test('the generated bundles stay self-contained after the command surface rebuild', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-standalone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['render-documents.mjs', 'crosslink-documents.mjs', 'export-route-textbook.mjs']) {
    const standalone = path.join(root, name);
    await copyFile(path.join(repo, 'derivon-mindmap/scripts', name), standalone);
    const result = spawnSync(process.execPath, [standalone, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
});
