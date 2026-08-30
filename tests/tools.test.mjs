import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const validator = path.join(repo, 'derivon-mindmap/scripts/validate-workspace.mjs');
const renderer = path.join(repo, 'derivon-mindmap/scripts/render-documents.mjs');
const exporter = path.join(repo, 'derivon-mindmap/scripts/export-route-textbook.mjs');
const crosslink = path.join(repo, 'derivon-mindmap/scripts/crosslink-documents.mjs');

const IMAGES = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  webp: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  gif: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  avif: 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANRtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+AABAAAAAAAAACEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVGlwcnAAAAA2aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAIAAAADAAAADnBpeGkAAAAAAQwAAAAWaXBtYQAAAAAAAAABAAEDgQIDAAAAKW1kYXQSAAoIWABzWgIaDcIyExlHh4YhiaaaZoAAAJA/mwxgimY=',
};

async function writeImage(filename, type = 'png') {
  await writeFile(filename, Buffer.from(IMAGES[type], 'base64'));
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-skills-'));
  const objects = [
    ['docs/a', '# A\n\nStarting concept $a^2$.\n', '<button id="demo">Try A</button><script>document.querySelector("#demo").dataset.ready="yes"</script>'],
    ['docs/b', '# B\n\nSecond starting concept.\n', ''],
    ['docs/c', '# C\n\nThe combined conclusion.\n', ''],
    ['docs/d', '# D\n\nAn unreachable concept.\n', ''],
    ['docs/h-main', '# A and B imply C\n\nUse both premises.\n\n![Joint support diagram](./diagram.png)\n', ''],
    ['docs/h-alt', '# Alternative\n\nA more expensive route.\n', ''],
  ];
  for (const [directory, markdown, raw] of objects) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'document.md'), `${markdown}\n${raw}\n`);
    await writeFile(path.join(root, directory, 'index.html'), '<!doctype html><html><body>stale</body></html>\n');
  }
  await writeFile(path.join(root, 'docs/h-main/example.txt'), 'relative asset\n');
  await writeImage(path.join(root, 'docs/h-main/diagram.png'));
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

test('generated tool bundles start without repository dependencies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'derivon-tool-bundles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const script of [renderer, crosslink, exporter]) {
    const standalone = path.join(root, path.basename(script));
    await copyFile(script, standalone);
    const result = run(standalone, ['--help'], { cwd: root });
    assert.equal(result.status, 0, `${path.basename(script)}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
});

test('renderer audits HTML-only publications without rewriting them', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, '.derivon/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.graph.points[0].data.format = 'html';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeImage(path.join(root, 'docs/a/circuit.png'));
  const publication = '<!doctype html><html><body><img src="./circuit.png" alt="Closed circuit"></body></html>\n';
  await writeFile(path.join(root, 'docs/a/index.html'), publication);

  const accepted = run(renderer, ['--write', root, 'A']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Media \[A\] 1 local image/);
  assert.equal(await readFile(path.join(root, 'docs/a/index.html'), 'utf8'), publication);

  const remote = '<!doctype html><html><body><img src="https://example.com/circuit.png" alt="Closed circuit"></body></html>\n';
  await writeFile(path.join(root, 'docs/a/index.html'), remote);
  const rejected = run(renderer, ['--write', root, 'A']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /docs\/a\/index\.html:1/);
  assert.equal(await readFile(path.join(root, 'docs/a/index.html'), 'utf8'), remote);
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
  assert.deepEqual(
    await readFile(path.join(output, 'objects/h-main/diagram.png')),
    await readFile(path.join(root, 'docs/h-main/diagram.png')),
  );
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

test('exporter rewrites object links and copies recursive reference closure without changing route chapters', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'docs/h-main/document.md'), '# Main\n\nUse [D](../d/index.html#details) for comparison.\n');
  await writeFile(path.join(root, 'docs/d/document.md'), '# D\n\nSee [Alternative](../h-alt/index.html).\n');
  await writeFile(path.join(root, 'docs/h-alt/document.md'), '# Alternative\n\nReturn to [D](../d/index.html).\n');
  assert.equal(run(renderer, ['--write', root]).status, 0);

  const output = path.join(root, 'linked-textbook');
  const exported = run(exporter, [root, '--output', output, '--start', 'A', '--start', 'B', '--target', 'C']);
  assert.equal(exported.status, 0, exported.stderr);
  const route = JSON.parse(await readFile(path.join(output, 'route.json'), 'utf8'));
  assert.deepEqual(route.chapters.map((entry) => entry.id), ['A', 'B', 'h-main', 'C']);
  assert.deepEqual(route.references.map((entry) => entry.id), ['D', 'h-alt']);
  assert.deepEqual(route.references[0].referrerIds, ['h-main', 'h-alt']);
  assert.match(await readFile(path.join(output, 'objects/h-main/index.html'), 'utf8'), /href="\.\.\/D\/index\.html#details"/);
  assert.match(await readFile(path.join(output, 'objects/D/index.html'), 'utf8'), /Referenced from/);
  assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /<h2>References<\/h2>/);

  const bounded = run(exporter, [root, '--output', path.join(root, 'bounded'), '--start', 'A', '--start', 'B', '--target', 'C', '--max-references', '0']);
  assert.equal(bounded.status, 1);
  assert.match(bounded.stderr, /exceeds --max-references 0/);
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

test('renderer accepts local static formats, responsive HTML, CSS assets, and visible provenance', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'docs/a');
  for (const type of Object.keys(IMAGES)) await writeImage(path.join(directory, `figure.${type}`), type);
  await writeFile(path.join(directory, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><title>Parallel paths</title><a href="https://example.com/source"><path d="M0 5h20"/></a></svg>\n');
  await writeImage(path.join(directory, 'figure one.png'));
  await writeFile(path.join(directory, 'base.css'), '.figure { background-image: url(./figure.webp); }\n');
  await writeFile(path.join(directory, 'media.css'), '@import "./base.css";\n');
  await writeFile(path.join(directory, 'document.md'), `# Media\n\n<!-- source-figure: book-page 147 -->\n\n![PNG circuit](./figure.png)\n\n![Encoded path](./figure%20one.png?edition=1#detail)\n\n![JPEG circuit](./figure.jpg)\n\n![GIF circuit](./figure.gif)\n\n![AVIF circuit](./figure.avif)\n\n![SVG circuit](./figure.svg)\n\n<picture><source srcset="./figure.webp 1x, ./figure.png 2x"><img src="./figure.webp" alt="Responsive circuit"></picture>\n<link rel="stylesheet" href="./media.css">\n\n[External source citation](https://example.com/source)\n`);

  const rendered = run(renderer, ['--write', root, 'A']);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Media \[A\] 7 local image\(s\)/);
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  assert.match(html, /<img src="\.\/figure\.png" alt="PNG circuit">/);
  assert.match(html, /source-figure: book-page 147/);
});

test('renderer rejects unsafe, broken, unsupported, and invisible media', async (t) => {
  const cases = [
    ['missing file', '![Circuit](./missing.png)', /does not resolve to an existing local file/],
    ['empty file', '![Circuit](./empty.png)', /resolves to an empty file/],
    ['directory target', '![Circuit](./folder.png)', /must resolve to a regular file/],
    ['corrupt image', '![Circuit](./corrupt.png)', /corrupt or do not match/],
    ['mismatched image', '![Circuit](./mismatch.png)', /corrupt or do not match/],
    ['object escape', '![Circuit](../outside.png)', /escapes the owning object directory/],
    ['absolute path', '![Circuit](/tmp/circuit.png)', /must not use a remote, absolute/],
    ['file URL', '![Circuit](file:///tmp/circuit.png)', /must not use a remote, absolute/],
    ['remote URL', '![Circuit](https://example.com/circuit.png)', /must not use a remote, absolute/],
    ['data URL', '![Circuit](data:image/png;base64,AAAA)', /must not use a remote, absolute/],
    ['blob URL', '![Circuit](blob:https://example.com/id)', /must not use a remote, absolute/],
    ['PDF image', '![Circuit](./figure.pdf)', /Unsupported image format/],
    ['empty alt', '![](./figure.png)', /require meaningful nonempty alt text/],
    ['comment only', '<!-- source-figure: book-page 147 -->', /has no visible image or media element/],
    ['remote CSS URL', '<style>.x { background: url(https://example.com/x.png) }</style>', /must not use a remote, absolute/],
    ['remote stylesheet', '<link rel="stylesheet" href="//example.com/x.css">', /must not use a remote, absolute/],
    ['remote script', '<script src="https://example.com/x.js"></script>', /must not use a remote, absolute/],
    ['remote srcset', '<img alt="Circuit" srcset="https://example.com/a.png 1x">', /must not use a remote, absolute/],
    ['base URL override', '<base href="https://example.com/"><img alt="Circuit" src="./figure.png">', /must not change the publication base URL/],
  ];

  for (const [name, markdown, expected] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'docs/a');
    await writeFile(path.join(directory, 'document.md'), `# ${name}\n\n${markdown}\n`);
    await writeFile(path.join(directory, 'empty.png'), '');
    await mkdir(path.join(directory, 'folder.png'));
    await writeFile(path.join(directory, 'corrupt.png'), 'not a png');
    await writeImage(path.join(directory, 'mismatch.png'), 'gif');
    await writeImage(path.join(directory, 'figure.png'));
    await writeFile(path.join(directory, 'figure.pdf'), '%PDF-1.7\n');
    await writeImage(path.join(root, 'docs/outside.png'));
    const result = run(renderer, ['--write', root, 'A']);
    assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, expected, name);
    assert.match(result.stderr, /Media error \[A\] docs\/a\/document\.md:/, name);
  }
});

test('renderer rejects media symlinks that escape the object directory', async (t) => {
  const root = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), 'derivon-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeImage(path.join(external, 'outside.png'));
  await symlink(path.join(external, 'outside.png'), path.join(root, 'docs/a/escape.png'));
  await writeFile(path.join(root, 'docs/a/document.md'), '# A\n\n![Escaping circuit](./escape.png)\n');
  const result = run(renderer, ['--write', root, 'A']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolves outside the owning object directory|must resolve to a regular file/);
});

test('renderer audits nested CSS and SVG dependencies without partial publication writes', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const aIndex = path.join(root, 'docs/a/index.html');
  const stale = await readFile(aIndex, 'utf8');
  await writeFile(path.join(root, 'docs/a/document.md'), '# A changed\n');
  await writeFile(path.join(root, 'docs/b/nested.css'), '.x { background: url(https://example.com/remote.png); }\n');
  await writeFile(path.join(root, 'docs/b/media.css'), '@import url("./nested.css");\n');
  await writeFile(path.join(root, 'docs/b/document.md'), '# B\n\n<link rel="stylesheet" href="./media.css">\n');

  const cssFailure = run(renderer, ['--write', root, 'A', 'B']);
  assert.equal(cssFailure.status, 1);
  assert.match(cssFailure.stderr, /CSS url\(\).*must not use a remote, absolute/);
  assert.equal(await readFile(aIndex, 'utf8'), stale, 'preflight failure must prevent every selected write');

  await writeFile(path.join(root, 'docs/b/remote.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/x.png"/></svg>\n');
  await writeFile(path.join(root, 'docs/b/document.md'), '# B\n\n![Remote SVG dependency](./remote.svg)\n');
  const svgFailure = run(renderer, ['--write', root, 'B']);
  assert.equal(svgFailure.status, 1);
  assert.match(svgFailure.stderr, /SVG href.*must not use a remote, absolute/);
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
