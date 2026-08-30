import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { parse } from 'parse5';
import path from 'node:path';
import process from 'node:process';

const MARKER_SCHEMA = 'derivon.textbook-output/v1';
const ROUTE_SCHEMA = 'derivon.textbook-route/v1';
const args = process.argv.slice(2);
if (takeFlag('--help') || takeFlag('-h')) {
  console.log(`Usage:
  node export-route-textbook.mjs <workspace> --output <directory>
    [--start <point>]... --target <point> [--target <point>]...
    [--max-nodes <n>] [--max-millis <n>] [--max-references <n>]
    [--allow-approximate] [--force] [--serve] [--port <n>]`);
  process.exit(0);
}
const workspaceRoot = path.resolve(args.shift() ?? '.');
const outputArg = takeValue('--output', true);
const starts = takeValues('--start');
const targets = takeValues('--target');
const maxNodes = takeValue('--max-nodes') ?? '200000';
const maxMillis = takeValue('--max-millis') ?? '10000';
const maxReferences = takeValue('--max-references') ?? '500';
const allowApproximate = takeFlag('--allow-approximate');
const force = takeFlag('--force');
const serve = takeFlag('--serve');
const port = Number(takeValue('--port') ?? 0);
if (args.length) fail(`Unexpected argument: ${args[0]}`, 2);
if (!targets.length) fail('At least one --target is required.', 2);
if (!/^\d+$/.test(maxNodes) || !/^\d+$/.test(maxMillis)) fail('Route budgets must be non-negative integers.', 2);
if (!/^\d+$/.test(maxReferences)) fail('--max-references must be a non-negative integer.', 2);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('Invalid --port.', 2);
const outputRoot = path.resolve(outputArg);
if (outputRoot === workspaceRoot || outputRoot.startsWith(`${workspaceRoot}${path.sep}.derivon${path.sep}`)) {
  fail('Output cannot replace the workspace or live under .derivon.', 2);
}

const manifest = JSON.parse(await readFile(path.join(workspaceRoot, '.derivon', 'workspace.json'), 'utf8'));
const graph = manifest.graph;
const routeArgs = ['query', 'route'];
for (const id of starts) routeArgs.push('--start', id);
for (const id of targets) routeArgs.push('--target', id);
routeArgs.push('--max-nodes', maxNodes, '--max-millis', maxMillis);
const solved = spawnSync('derivon', routeArgs, {
  input: JSON.stringify(graph), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (solved.error?.code === 'ENOENT') fail('derivon CLI is not installed or not on PATH.');
if (solved.status !== 0) fail((solved.stderr || solved.stdout).trim());
const route = JSON.parse(solved.stdout);
if (!route.reachable) {
  const diagnoses = (route.targetDiagnoses ?? []).map((entry) => `${entry.targetPointId}: blocking=${entry.blockingPointIds.join(',') || 'none'} cycles=${entry.cycles.length}`).join('\n');
  fail(`Route is unreachable.\n${diagnoses}`);
}
if (!route.provenOptimal && !allowApproximate) fail('Route is not proven optimal. Increase the budget or pass --allow-approximate.');

const pointById = new Map(graph.points.map((point) => [point.id, { ...point, kind: 'concept' }]));
const edgeById = new Map(graph.hyperedges.map((edge) => [edge.id, { ...edge, kind: 'derivation' }]));
const objectById = new Map([...pointById, ...edgeById]);
const objectByPublication = new Map([...objectById.values()].map((object) => [normalizeWorkspacePath(`${object.data.document}/index.html`), object]));
const sequence = [];
const seenPoints = new Set();
for (const id of route.startPointIds) addPoint(id, 'prerequisite');
for (const edgeId of route.executableOrder) {
  const edge = edgeById.get(edgeId);
  if (!edge) fail(`Route references unknown hyperedge ${edgeId}.`);
  sequence.push(entryFor(edge, 'derivation'));
  if (!seenPoints.has(edge.head)) addPoint(edge.head, 'conclusion');
}
for (const id of route.pointIds) if (!seenPoints.has(id)) addPoint(id, 'route-concept');

const routeIds = new Set(sequence.map((entry) => entry.id));
const references = [];
const referrers = new Map();
const sourceById = new Map();
const htmlById = new Map();
const linksById = new Map();
const queue = sequence.map((entry) => objectById.get(entry.id));
const discovered = new Set(routeIds);
for (let cursor = 0; cursor < queue.length; cursor += 1) {
  const object = queue[cursor];
  const source = await safeWorkspaceDirectory(workspaceRoot, object.data?.document);
  await rejectSymbolicLinks(source);
  const sourceIndex = path.join(source, 'index.html');
  let html;
  try { html = await readFile(sourceIndex, 'utf8'); } catch { fail(`Missing document for ${object.kind} ${object.id}: ${path.relative(workspaceRoot, sourceIndex)}`); }
  sourceById.set(object.id, source);
  htmlById.set(object.id, html);
  const links = knownObjectLinks(html, object, objectByPublication);
  linksById.set(object.id, links);
  for (const link of links) {
    const direct = referrers.get(link.target.id) ?? new Set();
    direct.add(object.id);
    referrers.set(link.target.id, direct);
    if (discovered.has(link.target.id)) continue;
    if (references.length >= Number(maxReferences)) fail(`Reference closure exceeds --max-references ${maxReferences}. Increase the bound explicitly.`);
    discovered.add(link.target.id);
    const entry = entryFor(link.target, 'reference');
    references.push(entry);
    queue.push(link.target);
  }
}

const stageRoot = await prepareStage(outputRoot, force);
try {
  const exportedEntries = [...sequence, ...references];
  for (const entry of exportedEntries) {
    const destination = path.join(stageRoot, 'objects', entry.id);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceById.get(entry.id), destination, { recursive: true, errorOnExist: true });
  }
  for (let index = 0; index < sequence.length; index += 1) {
    const entry = sequence[index];
    const file = path.join(stageRoot, entry.href);
    const rewritten = rewriteObjectLinks(htmlById.get(entry.id), linksById.get(entry.id));
    const previous = sequence[index - 1];
    const next = sequence[index + 1];
    await writeFile(file, injectNavigation(rewritten, previous, next), 'utf8');
  }
  for (const entry of references) {
    const file = path.join(stageRoot, entry.href);
    const rewritten = rewriteObjectLinks(htmlById.get(entry.id), linksById.get(entry.id));
    const firstReferrerId = [...(referrers.get(entry.id) ?? [])][0];
    const firstReferrer = firstReferrerId ? entryFor(objectById.get(firstReferrerId), 'referrer') : null;
    await writeFile(file, injectReferenceNavigation(rewritten, firstReferrer), 'utf8');
  }

  const routeDocument = {
    schema: ROUTE_SCHEMA,
    workspace: { title: manifest.document.title, description: manifest.document.description },
    query: { startPointIds: route.startPointIds, targetPointIds: route.targetPointIds },
    result: route,
    chapters: sequence,
    references: references.map((entry) => ({
      ...entry,
      referrerIds: [...(referrers.get(entry.id) ?? [])],
    })),
  };
  await writeFile(path.join(stageRoot, 'route.json'), `${JSON.stringify(routeDocument, null, 2)}\n`, 'utf8');
  await writeFile(path.join(stageRoot, '.derivon-textbook.json'), `${JSON.stringify({ schema: MARKER_SCHEMA }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(stageRoot, 'index.html'), textbookIndex(manifest, route, sequence, references), 'utf8');
  await finalizeStage(stageRoot, outputRoot);
} catch (error) {
  await rm(stageRoot, { recursive: true, force: true });
  throw error;
}
console.log(`Exported textbook: ${outputRoot}`);

if (serve) await serveDirectory(outputRoot, port);

function addPoint(id, role) {
  const point = pointById.get(id);
  if (!point) fail(`Route references unknown point ${id}.`);
  seenPoints.add(id);
  sequence.push(entryFor(point, role));
}
function entryFor(object, role) {
  return {
    id: object.id,
    kind: object.kind,
    role,
    title: object.kind === 'concept' ? object.data.label : `${object.tails.join(' + ') || 'empty'} -> ${object.head}`,
    href: `objects/${object.id}/index.html`,
  };
}
async function prepareStage(output, overwrite) {
  try {
    await stat(output);
    if (!overwrite) fail(`Output already exists: ${output}. Pass --force to replace a recognized textbook output.`);
    let marker;
    try { marker = JSON.parse(await readFile(path.join(output, '.derivon-textbook.json'), 'utf8')); } catch { fail(`Refusing to replace unrecognized output directory: ${output}`); }
    if (marker.schema !== MARKER_SCHEMA) fail(`Refusing to replace unrecognized output directory: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(output), { recursive: true });
  return mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.tmp-`));
}
async function finalizeStage(stage, output) {
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
}
async function safeWorkspaceDirectory(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) fail(`Unsafe document path: ${String(relative)}`);
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) fail(`Unsafe document path: ${relative}`);
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(resolved)]);
  if (realDirectory === realRoot || !realDirectory.startsWith(`${realRoot}${path.sep}`)) fail(`Document path resolves outside the workspace: ${relative}`);
  return realDirectory;
}
async function rejectSymbolicLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`Refusing symbolic link in document directory: ${current}`);
    if (info.isDirectory()) await rejectSymbolicLinks(current);
  }
}
function knownObjectLinks(html, sourceObject, targets) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const links = [];
  visitHtml(document, (node) => {
    if (node.tagName?.toLowerCase() !== 'a') return;
    const attribute = (node.attrs ?? []).find((entry) => entry.name.toLowerCase() === 'href');
    const location = node.sourceCodeLocation?.attrs?.href;
    if (!attribute || !location) return;
    const target = resolveObjectHref(`${sourceObject.data.document}/index.html`, attribute.value, targets);
    if (!target) return;
    const suffix = attribute.value.slice(attribute.value.split(/[?#]/, 1)[0].length);
    links.push({ target, suffix, start: location.startOffset, end: location.endOffset });
  });
  return links;
}
function rewriteObjectLinks(html, links) {
  let output = html;
  for (const link of [...links].sort((left, right) => right.start - left.start)) {
    const href = `../${encodeURIComponent(link.target.id)}/index.html${link.suffix}`;
    output = `${output.slice(0, link.start)}href="${escapeHtml(href)}"${output.slice(link.end)}`;
  }
  return output;
}
function resolveObjectHref(sourceDocument, href, targets) {
  const value = String(href ?? '').trim();
  if (!value || value.startsWith('#') || value.startsWith('/') || value.startsWith('\\') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const pathOnly = value.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = pathOnly.split('/').map((segment) => decodeURIComponent(segment)).join('/'); } catch { return null; }
  const resolved = normalizeWorkspacePath(path.posix.join(path.posix.dirname(normalizeWorkspacePath(sourceDocument)), decoded));
  return targets.get(resolved) ?? null;
}
function normalizeWorkspacePath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return '';
  return normalized;
}
function visitHtml(node, visitor) {
  visitor(node);
  for (const child of node.childNodes ?? []) visitHtml(child, visitor);
}
function injectNavigation(html, previous, next) {
  if (!/<body(?:\s[^>]*)?>/i.test(html)) fail('Object publication is not a complete HTML document with a body element.');
  const nav = `<nav class="derivon-textbook-nav" aria-label="Textbook navigation"><a href="../../index.html">Contents</a>${previous ? `<a rel="prev" href="../${encodeURIComponent(previous.id)}/index.html">Previous</a>` : ''}${next ? `<a rel="next" href="../${encodeURIComponent(next.id)}/index.html">Next</a>` : ''}</nav><style>.derivon-textbook-nav{position:relative;display:flex;gap:12px;flex-wrap:wrap;max-width:820px;margin:0 auto 20px;padding:12px 0;border-bottom:1px solid #d5d8d3;font:14px/1.4 system-ui,sans-serif}.derivon-textbook-nav a{color:#245f72}.derivon-textbook-nav a[rel=next]{margin-left:auto}</style>`;
  return html.replace(/<body(\s[^>]*)?>/i, (match) => `${match}\n${nav}`);
}
function injectReferenceNavigation(html, referrer) {
  if (!/<body(?:\s[^>]*)?>/i.test(html)) fail('Reference publication is not a complete HTML document with a body element.');
  const back = referrer ? `<a href="../${encodeURIComponent(referrer.id)}/index.html">Referenced from ${escapeHtml(referrer.title)}</a>` : '';
  const nav = `<nav class="derivon-textbook-nav" aria-label="Reference navigation"><a href="../../index.html">Contents</a>${back}</nav><style>.derivon-textbook-nav{position:relative;display:flex;gap:12px;flex-wrap:wrap;max-width:820px;margin:0 auto 20px;padding:12px 0;border-bottom:1px solid #d5d8d3;font:14px/1.4 system-ui,sans-serif}.derivon-textbook-nav a{color:#245f72}</style>`;
  return html.replace(/<body(\s[^>]*)?>/i, (match) => `${match}\n${nav}`);
}
function textbookIndex(manifestValue, routeValue, chapters, references) {
  const warning = routeValue.provenOptimal ? '' : '<p class="warning"><strong>Warning:</strong> this route was not proven optimal.</p>';
  const items = chapters.map((chapter, index) => `<li><span>${index + 1}</span><a href="${escapeHtml(chapter.href)}">${escapeHtml(chapter.title)}</a><small>${escapeHtml(chapter.kind)} / ${escapeHtml(chapter.role)}</small></li>`).join('\n');
  const referenceItems = references.map((reference) => `<li><span>R</span><a href="${escapeHtml(reference.href)}">${escapeHtml(reference.title)}</a><small>${escapeHtml(reference.kind)}</small></li>`).join('\n');
  const referenceSection = references.length ? `<h2>References</h2><ol>${referenceItems}</ol>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifestValue.document.title)} - Route Textbook</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#202422;background:#fff}body{max-width:900px;margin:auto;padding:32px;line-height:1.6}h1{line-height:1.2}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}dt{font-weight:700}dd{margin:0}.warning{padding:12px;border-left:4px solid #a44f3f;background:#fff4f1}ol{padding:0;list-style:none;border-top:1px solid #d5d8d3}li{display:grid;grid-template-columns:32px 1fr auto;gap:12px;padding:12px 0;border-bottom:1px solid #d5d8d3}a{color:#245f72}small{color:#68716c}@media(max-width:560px){body{padding:18px}dl{grid-template-columns:1fr}li{grid-template-columns:28px 1fr}small{grid-column:2}}</style></head><body><h1>${escapeHtml(manifestValue.document.title)}</h1><p>${escapeHtml(manifestValue.document.description)}</p>${warning}<dl><dt>Starts</dt><dd>${escapeHtml(routeValue.startPointIds.join(', ') || 'none')}</dd><dt>Targets</dt><dd>${escapeHtml(routeValue.targetPointIds.join(', '))}</dd><dt>Cost</dt><dd>${escapeHtml(routeValue.cost)}</dd><dt>Optimal</dt><dd>${routeValue.provenOptimal ? 'proven' : 'not proven'}</dd></dl><h2>Learning sequence</h2><ol>${items}</ol>${referenceSection}</body></html>\n`;
}
async function serveDirectory(root, requestedPort) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relative || relative.endsWith('/')) relative += 'index.html';
      const file = path.resolve(root, relative);
      if (!file.startsWith(`${root}${path.sep}`)) throw new Error('outside root');
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime(file), 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
  const address = server.address();
  console.log(`Preview: http://127.0.0.1:${address.port}/`);
  console.log(`PID: ${process.pid} (stop with: kill ${process.pid})`);
  await new Promise((resolve) => {
    const stop = () => server.close(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
function mime(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.woff2': 'font/woff2' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function takeFlag(flag) { const index = args.indexOf(flag); if (index < 0) return false; args.splice(index, 1); return true; }
function takeValue(flag, required = false) { const index = args.indexOf(flag); if (index < 0) { if (required) fail(`Missing ${flag}.`, 2); return null; } const value = args[index + 1]; if (!value || value.startsWith('--')) fail(`Missing value for ${flag}.`, 2); args.splice(index, 2); return value; }
function takeValues(flag) { const values = []; for (;;) { const value = takeValue(flag); if (value === null) return values; values.push(value); } }
function fail(message, code = 1) { console.error(message); process.exit(code); }
