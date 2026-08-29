import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const validator = path.join(repo, 'derivon-mindmap/scripts/validate-workspace.mjs');
const renderer = path.join(repo, 'derivon-mindmap/scripts/render-documents.mjs');
const exporter = path.join(repo, 'derivon-mindmap/scripts/export-route-textbook.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-skills-'));
  const objects = [
    ['docs/a', '# A\n\nStarting concept $a^2$.\n', '<button id="demo">Try A</button><script>document.querySelector("#demo").dataset.ready="yes"</script>'],
    ['docs/b', '# B\n\nSecond starting concept.\n', ''],
    ['docs/c', '# C\n\nThe combined conclusion.\n', ''],
    ['docs/d', '# D\n\nAn unreachable concept.\n', ''],
    ['docs/h-main', '# A and B imply C\n\nUse both premises.\n', ''],
    ['docs/h-alt', '# Alternative\n\nA more expensive route.\n', ''],
  ];
  for (const [directory, markdown, raw] of objects) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'document.md'), `${markdown}\n${raw}\n`);
    await writeFile(path.join(root, directory, 'index.html'), '<!doctype html><html><body>stale</body></html>\n');
  }
  await writeFile(path.join(root, 'docs/h-main/example.txt'), 'relative asset\n');
  await mkdir(path.join(root, '.derivon'), { recursive: true });
  await writeFile(path.join(root, '.derivon/workspace.json'), `${JSON.stringify({
    schema: 'derivon.authoring/v0.3.0',
    document: { title: 'Fixture', description: 'Route export fixture' },
    graph: {
      points: [
        { id: 'A', data: { label: 'A', document: 'docs/a', format: 'markdown' } },
        { id: 'B', data: { label: 'B', document: 'docs/b', format: 'markdown' } },
        { id: 'C', data: { label: 'C', document: 'docs/c', format: 'markdown' } },
        { id: 'D', data: { label: 'D', document: 'docs/d', format: 'markdown' } },
      ],
      hyperedges: [
        { id: 'h-main', weight: 1.5, tails: ['A', 'B'], head: 'C', data: { document: 'docs/h-main', format: 'markdown' } },
        { id: 'h-alt', weight: 3, tails: ['A', 'B'], head: 'C', data: { document: 'docs/h-alt', format: 'markdown' } },
      ],
    },
    view: { replacements: [{ points: ['A', 'B'], replaceWith: 'C', show: 'points' }] },
  }, null, 2)}\n`);
  return root;
}

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...options });
}

test('validator accepts a complete workspace and reports authoring errors', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = run(validator, ['--json', root]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);

  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.graph.points[1].data.document = 'docs/a';
  manifest.view.replacements.push({ points: ['C'], replaceWith: 'A', show: 'points' });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const invalid = run(validator, ['--json', root]);
  assert.equal(invalid.status, 1);
  const result = JSON.parse(invalid.stdout);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.message.includes('also owned')));
  assert.ok(result.issues.some((entry) => entry.message.includes('cycle')));
});

test('workspace tools reject document symlinks outside the workspace', async (t) => {
  const root = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), 'derivon-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(external, { recursive: true, force: true }));
  await rm(path.join(root, 'docs/a'), { recursive: true });
  await writeFile(path.join(external, 'document.md'), '# Outside\n');
  await writeFile(path.join(external, 'index.html'), '<!doctype html><html><body>outside</body></html>\n');
  await symlink(external, path.join(root, 'docs/a'), 'dir');

  const validated = run(validator, ['--json', root]);
  assert.equal(validated.status, 1);
  assert.ok(JSON.parse(validated.stdout).issues.some((entry) => entry.message.includes('outside the workspace')));
  const rendered = run(renderer, ['--write', root, 'A']);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /outside the workspace/);
  const exported = run(exporter, [root, '--output', path.join(root, 'textbook'), '--start', 'A', '--start', 'B', '--target', 'C']);
  assert.equal(exported.status, 1);
  assert.match(exported.stderr, /outside the workspace/);
});

test('self-contained renderer preserves raw HTML and renders offline KaTeX', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const drift = run(renderer, [root, 'A']);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /Drift:/);
  const rendered = run(renderer, ['--write', root, 'A']);
  assert.equal(rendered.status, 0, rendered.stderr);
  const html = await readFile(path.join(root, 'docs/a/index.html'), 'utf8');
  assert.match(html, /class="katex"/);
  assert.match(html, /<button id="demo">/);
  assert.match(html, /<script>document\.querySelector/);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /cdn\.jsdelivr/);
  const synchronized = run(renderer, [root, 'A']);
  assert.equal(synchronized.status, 0, synchronized.stderr);
});

test('exporter follows executable order, preserves assets, and protects output', async (t) => {
  const root = await fixture();
  const output = path.join(root, 'textbook');
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(run(renderer, ['--write', root]).status, 0);
  const exported = run(exporter, [root, '--output', output, '--start', 'A', '--start', 'B', '--target', 'C']);
  assert.equal(exported.status, 0, exported.stderr);
  const route = JSON.parse(await readFile(path.join(output, 'route.json'), 'utf8'));
  assert.deepEqual(route.result.executableOrder, ['h-main']);
  assert.deepEqual(route.chapters.map((entry) => entry.id), ['A', 'B', 'h-main', 'C']);
  assert.equal(await readFile(path.join(output, 'objects/h-main/example.txt'), 'utf8'), 'relative asset\n');
  assert.match(await readFile(path.join(output, 'objects/h-main/index.html'), 'utf8'), /Textbook navigation/);
  await assert.rejects(readFile(path.join(output, 'objects/h-alt/index.html'), 'utf8'));

  const refused = run(exporter, [root, '--output', output, '--start', 'A', '--start', 'B', '--target', 'C']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  const forced = run(exporter, [root, '--output', output, '--start', 'A', '--start', 'B', '--target', 'C', '--force']);
  assert.equal(forced.status, 0, forced.stderr);

  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'keep.txt'), 'keep');
  const unsafe = run(exporter, [root, '--output', foreign, '--start', 'A', '--start', 'B', '--target', 'C', '--force']);
  assert.equal(unsafe.status, 1);
  assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');

  const unreachable = run(exporter, [root, '--output', path.join(root, 'no-route'), '--start', 'A', '--target', 'D']);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /unreachable/i);
});

test('exporter requires explicit opt-in for a budget-limited route', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const graph = {
    points: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => ({ id, data: { label: id, document: `docs/${id.toLowerCase()}`, format: 'markdown' } })),
    hyperedges: [
      ['h0', 1, ['D'], 'C'], ['h1', 4, ['B', 'E'], 'D'], ['h2', 3, ['A', 'E'], 'G'],
      ['h3', 5, ['D'], 'E'], ['h4', 3, ['F'], 'E'], ['h5', 1, ['D'], 'F'],
      ['h6', 5, ['A'], 'D'], ['h7', 1, ['C', 'B'], 'G'], ['h8', 3, ['A'], 'B'],
      ['h9', 2, ['B', 'D'], 'G'], ['h10', 5, ['F'], 'D'], ['h11', 2, ['G'], 'E'],
    ].map(([id, weight, tails, head]) => ({ id, weight, tails, head, data: { document: `docs/${id}`, format: 'markdown' } })),
  };
  manifest.graph = graph;
  manifest.view.replacements = [];
  for (const object of [...graph.points, ...graph.hyperedges]) {
    const directory = path.join(root, object.data.document);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'document.md'), `# ${object.id}\n\nRoute object.\n`);
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><body>stale</body></html>\n');
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(run(renderer, ['--write', root]).status, 0);

  const output = path.join(root, 'approximate');
  const refused = run(exporter, [root, '--output', output, '--start', 'A', '--target', 'G', '--max-nodes', '0', '--max-millis', '0']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not proven optimal/i);
  const allowed = run(exporter, [root, '--output', output, '--start', 'A', '--target', 'G', '--max-nodes', '0', '--max-millis', '0', '--allow-approximate']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /not proven optimal/i);
});

test('preview server binds loopback and serves the generated textbook', async (t) => {
  const root = await fixture();
  const output = path.join(root, 'served');
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(run(renderer, ['--write', root]).status, 0);
  const child = spawn(process.execPath, [exporter, root, '--output', output, '--start', 'A', '--start', 'B', '--target', 'C', '--serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`preview timeout: ${stdout}\n${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/Preview: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('exit', (code) => reject(new Error(`preview exited ${code}: ${stderr}`)));
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Learning sequence/);
});

test('canonical jq and derivon pipeline atomically reinserts a graph mutation', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = `set -eu
manifest="$1/.derivon/workspace.json"
graph_tmp="$(mktemp "$1/.derivon/graph.XXXXXX")"
manifest_tmp="$(mktemp "$1/.derivon/workspace.XXXXXX")"
trap 'rm -f "$graph_tmp" "$manifest_tmp"' EXIT
jq '.graph' "$manifest" | derivon hyperedge set weight h-main 2.5 > "$graph_tmp"
jq --slurpfile graph "$graph_tmp" '.graph = $graph[0]' "$manifest" > "$manifest_tmp"
node "$2" --manifest "$manifest_tmp" "$1" >/dev/null
mv "$manifest_tmp" "$manifest"
`;
  const result = spawnSync('/bin/sh', ['-c', shell, 'pipeline', root, validator], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(path.join(root, '.derivon/workspace.json'), 'utf8'));
  assert.equal(manifest.graph.hyperedges[0].weight, 2.5);
  assert.equal(manifest.view.replacements[0].replaceWith, 'C');
});
