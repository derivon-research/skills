import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { parse } from 'parse5';
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SCHEMA = 'derivon.crosslink-report/v1';
const args = process.argv.slice(2);
const write = takeFlag('--write');
const json = takeFlag('--json');
const all = takeFlag('--all');
const auditLinks = takeFlag('--audit-links');
const manifestArg = takeValue('--manifest');
const applyIds = new Set(takeValues('--apply').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean));
if (takeFlag('--help') || takeFlag('-h')) {
  console.log(`Usage:
  node crosslink-documents.mjs [--write [--apply <suggestion-id>...]] [--json] [--manifest <candidate.json>] <workspace> <selector>...
  node crosslink-documents.mjs [--write [--apply <suggestion-id>...]] [--json] [--manifest <candidate.json>] <workspace> --all
  node crosslink-documents.mjs --audit-links [--json] [--manifest <candidate.json>] <workspace>

A suggestion is the first exact-label mention of a concept in one document, with id <document-object-id>:<concept-id>.
--write writes the suggestions named by --apply and nothing else.
--audit-links reports links to files that do not exist in the workspace.`);
  process.exit(0);
}
const workspaceRoot = path.resolve(args.shift() ?? '.');
const selectors = args;
if (!auditLinks && all === Boolean(selectors.length)) fail('Choose exactly one of --all or one or more object selectors.', 2);
if (auditLinks && selectors.length) fail('--audit-links always reads every document; drop the selectors.', 2);
if (applyIds.size && !write) fail('--apply only makes sense with --write.', 2);
const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(workspaceRoot, '.derivon', 'workspace.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const objects = [
  ...(manifest.graph?.points ?? []).map((object) => ({ ...object, kind: 'concept' })),
  ...(manifest.graph?.hyperedges ?? []).map((object) => ({ ...object, kind: 'derivation' })),
];
const points = (manifest.graph?.points ?? []).map((point) => ({ ...point, kind: 'concept' }));
const selected = all || auditLinks ? objects : selectObjects(objects, selectors);
const pointGroups = new Map();
for (const point of points) {
  const group = pointGroups.get(point.data.label) ?? [];
  group.push(point);
  pointGroups.set(point.data.label, group);
}
const labels = [...pointGroups.keys()].filter(Boolean).sort((left, right) => right.length - left.length || left.localeCompare(right));
const targetByDocument = new Map(objects.map((object) => [normalizeWorkspacePath(`${object.data.document}/document.md`), object]));
const reports = [];
const blockers = [];
const notices = [];
if (auditLinks) {
  const issues = await auditDocumentLinks();
  // Wait for the write to flush: process.exit below would otherwise cut a large report off a pipe.
  if (json) await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ schema: 'derivon.link-audit/v1', issues }, null, 2)}\n`, resolve));
  else for (const entry of issues) console.error(`${entry.code} [${entry.objectId}] ${entry.source}:${entry.line} ${entry.message}`);
  process.exit(issues.length ? 1 : 0);
}

for (const object of selected) {
  const relativeSource = `${object.data.document}/document.md`;
  let filename;
  let source;
  try {
    filename = await safeWorkspaceSource(workspaceRoot, relativeSource);
    source = await readFile(filename, 'utf8');
  } catch (error) {
    blockers.push(issue(object, relativeSource, 1, 'missing-source', error.message));
    continue;
  }
  let analysis;
  try {
    analysis = analyzeMarkdown(source, object, relativeSource);
  } catch (error) {
    blockers.push(issue(object, relativeSource, 1, 'parse-error', error.message));
    continue;
  }
  const result = resolveInsertions({
    source,
    object,
    relativeSource,
    analysis,
    labels,
    pointGroups,
    targetByDocument,
  });
  reports.push({ ...result, filename, content: source });
  blockers.push(...result.issues);
  notices.push(...result.notices);
}

const suggestions = reports.flatMap((report) => report.insertions);
const suggestionIds = new Set(suggestions.map((entry) => entry.id));
for (const id of applyIds) {
  if (!suggestionIds.has(id)) blockers.push({ objectId: id.split(':')[0], source: '.', line: 1, code: 'unknown-suggestion', message: `${id} is not a pending suggestion in the selected documents` });
}
const chosen = (entry) => applyIds.has(entry.id);
if (blockers.length) {
  emitReport({ blockers, suggestions, written: [] });
  process.exitCode = 1;
} else if (!write) {
  emitReport({ blockers: [], suggestions, written: [] });
} else {
  const prepared = reports.filter((entry) => entry.insertions.some(chosen)).map((report) => {
    const patches = report.insertions.filter(chosen);
    const output = applyPatches(report.content, patches);
    const analysis = analyzeMarkdown(output);
    const object = objects.find((entry) => entry.id === report.objectId);
    const verification = resolveInsertions({
      source: output,
      object,
      relativeSource: report.source,
      analysis,
      labels,
      pointGroups,
      targetByDocument,
    });
    const writtenIds = new Set(patches.map((entry) => entry.id));
    if (verification.issues.length || verification.insertions.some((entry) => writtenIds.has(entry.id))) {
      throw new Error(`Crosslink verification failed for ${report.source}`);
    }
    return { ...report, output };
  });
  const staged = [];
  const applied = [];
  try {
    for (const report of prepared) {
      const temporary = `${report.filename}.crosslink-${process.pid}-${staged.length}.tmp`;
      await mkdir(path.dirname(temporary), { recursive: true });
      await writeFile(temporary, report.output, 'utf8');
      staged.push({ temporary, filename: report.filename });
    }
    for (const entry of staged) {
      await rename(entry.temporary, entry.filename);
      applied.push(entry.filename);
    }
  } catch (error) {
    await Promise.all(staged.map((entry) => rm(entry.temporary, { force: true })));
    await Promise.all(applied.map((filename) => {
      const original = prepared.find((entry) => entry.filename === filename);
      return writeFile(filename, original.content, 'utf8');
    }));
    throw error;
  }
  emitReport({ blockers: [], suggestions, written: suggestions.filter(chosen) });
}

function selectObjects(values, requested) {
  const normalized = new Set(requested.map((value) => value.replace(/\/$/, '')));
  const matches = values.filter((object) => {
    const source = 'document.md';
    return normalized.has(object.id)
      || normalized.has(object.data.document)
      || normalized.has(`${object.data.document}/${source}`);
  });
  const matched = new Set(matches.flatMap((object) => {
    const source = 'document.md';
    return [object.id, object.data.document, `${object.data.document}/${source}`];
  }));
  const unknown = requested.filter((value) => !matched.has(value.replace(/\/$/, '')));
  if (unknown.length) fail(`Unknown object selector(s): ${unknown.join(', ')}`, 2);
  return matches;
}

function analyzeMarkdown(source, object, relativeSource) {
  const tree = fromMarkdown(source, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const blocks = [];
  const links = [];
  walk(tree, [], (node) => {
    if (node.type !== 'link') return true;
    links.push({
      start: node.position.start.offset,
      end: node.position.end.offset,
      text: visibleMdText(node),
      href: node.url,
      line: node.position.start.line,
    });
    return false;
  });
  walk(tree, [], (node) => {
    if (node.type === 'paragraph' || node.type === 'tableCell') {
      blocks.push(markdownBlock(source, node));
      return false;
    }
    return true;
  });
  return { blocks, links };
}

function markdownBlock(source, node) {
  const groups = [];
  let group = newGroup();
  const flush = () => {
    if (group.text) groups.push(group);
    group = newGroup();
  };
  const collect = (current, formats = []) => {
    if (current.type === 'text') {
      const start = current.position.start.offset;
      const end = current.position.end.offset;
      if (source.slice(start, end) !== current.value || current.value.includes('\n')) {
        flush();
        return;
      }
      group.leaves.push({ start, end, textStart: group.text.length, textEnd: group.text.length + current.value.length });
      group.text += current.value;
      return;
    }
    if (['emphasis', 'strong', 'delete'].includes(current.type)) {
      const visibleStart = group.text.length;
      for (const child of current.children ?? []) collect(child, [...formats, current]);
      const visibleEnd = group.text.length;
      if (visibleEnd > visibleStart) group.formats.push({
        visibleStart,
        visibleEnd,
        start: current.position.start.offset,
        end: current.position.end.offset,
      });
      return;
    }
    flush();
  };
  for (const child of node.children ?? []) collect(child);
  flush();
  return { groups, start: node.position.start.offset, line: node.position.start.line };
}

function analyzeHtml(source) {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const links = [];
  visitHtml(document, (node) => {
    if (node.tagName?.toLowerCase() !== 'a') return;
    const location = node.sourceCodeLocation;
    const href = (node.attrs ?? []).find((attribute) => attribute.name.toLowerCase() === 'href')?.value ?? '';
    links.push({ start: location?.startOffset ?? 0, end: location?.endOffset ?? 0, text: visibleHtmlText(node), href, line: location?.startLine ?? 1 });
  });
  const blocks = [];
  const eligible = new Set(['p', 'li', 'blockquote', 'td', 'th']);
  const collectBlocks = (node, insideBlock = false) => {
    const isBlock = eligible.has(node.tagName?.toLowerCase());
    if (isBlock && !insideBlock) {
      blocks.push(htmlBlock(source, node));
      return;
    }
    for (const child of node.childNodes ?? []) collectBlocks(child, insideBlock || isBlock);
  };
  collectBlocks(document);
  return { blocks, links };
}

function htmlBlock(source, node) {
  const groups = [];
  const excluded = new Set(['a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'script', 'style', 'svg', 'button', 'input', 'select', 'textarea', 'option', 'br', 'hr']);
  const formats = new Set(['em', 'strong', 's', 'del', 'span', 'mark', 'small', 'sub', 'sup']);
  let group = newGroup();
  const flush = () => {
    if (group.text) groups.push(group);
    group = newGroup();
  };
  const collect = (current) => {
    if (current.nodeName === '#text') {
      const location = current.sourceCodeLocation;
      if (!location || current.value.includes('\n') || source.slice(location.startOffset, location.endOffset) !== current.value) {
        flush();
        return;
      }
      group.leaves.push({ start: location.startOffset, end: location.endOffset, textStart: group.text.length, textEnd: group.text.length + current.value.length });
      group.text += current.value;
      return;
    }
    const tag = current.tagName?.toLowerCase();
    if (tag && excluded.has(tag)) {
      flush();
      return;
    }
    const visibleStart = group.text.length;
    for (const child of current.childNodes ?? []) collect(child);
    const visibleEnd = group.text.length;
    const location = current.sourceCodeLocation;
    if (tag && formats.has(tag) && visibleEnd > visibleStart && location?.startTag && location?.endTag) {
      group.formats.push({ visibleStart, visibleEnd, start: location.startTag.startOffset, end: location.endTag.endOffset });
    }
  };
  for (const child of node.childNodes ?? []) collect(child);
  flush();
  return { groups };
}

// A link the author wrote whose visible text is a label but whose target is another object is kept
// as written, and that label is not suggested again in the document. The object's own label
// occupies its span and is never linked, so no shorter label is cut out of it.
function resolveInsertions({ source, object, relativeSource, analysis, labels, pointGroups, targetByDocument }) {
  const issues = [];
  const notices = [];
  const candidates = [];
  const validLinks = new Map();
  const keptTargets = new Set();
  for (const link of analysis.links) {
    const target = resolveObjectHref(`${object.data.document}/${'document.md'}`, link.href, targetByDocument);
    if (target?.kind === 'concept') {
      const existing = validLinks.get(target.id);
      if (existing === undefined || link.start < existing) validLinks.set(target.id, link.start);
    }
    const matchedRanges = [];
    for (const label of labels) {
      const index = findLabel(link.text, label, 0);
      if (index < 0 || matchedRanges.some((range) => index < range.end && index + label.length > range.start)) continue;
      matchedRanges.push({ start: index, end: index + label.length });
      const targets = pointGroups.get(label);
      if (targets.length === 1 && target?.id !== targets[0].id && !keptTargets.has(targets[0].id)) {
        keptTargets.add(targets[0].id);
        notices.push(issue(object, relativeSource, link.line, 'kept-author-link', `${label} stays linked to ${link.href}; ${targets[0].id} is not linked in this document`));
      }
    }
  }
  const terms = labels.map((label) => ({ label, targets: pointGroups.get(label) }));
  for (const block of analysis.blocks) {
    for (const group of block.groups) {
      for (const { label, targets } of terms) {
        const occupyOnly = targets.length === 1 && targets[0].id === object.id;
        let from = 0;
        for (;;) {
          const index = findLabel(group.text, label, from);
          if (index < 0) break;
          const sourceRange = groupRange(group, index, index + label.length);
          if (sourceRange) candidates.push({ label, targets, occupyOnly, ...sourceRange, line: lineAt(source, sourceRange.start) });
          from = index + Math.max(1, label.length);
        }
      }
    }
  }
  candidates.sort((left, right) => left.start - right.start
    || right.label.length - left.label.length
    || Number(right.occupyOnly) - Number(left.occupyOnly));
  const firstByLabel = new Map();
  let occupiedEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < occupiedEnd) continue;
    occupiedEnd = candidate.end;
    if (candidate.occupyOnly) continue;
    if (!firstByLabel.has(candidate.label)) firstByLabel.set(candidate.label, candidate);
  }
  const insertions = [];
  for (const [label, candidate] of firstByLabel) {
    if (candidate.targets.length > 1) {
      issues.push(issue(object, relativeSource, candidate.line, 'ambiguous-label', `${label} matches ${candidate.targets.map((target) => target.id).join(', ')}`));
      continue;
    }
    const point = candidate.targets[0];
    if (keptTargets.has(point.id)) continue;
    const existing = validLinks.get(point.id);
    if (existing !== undefined && existing <= candidate.start) continue;
    const href = relativeObjectHref(`${object.data.document}/${'document.md'}`, point.data.document);
    insertions.push({
      id: `${object.id}:${point.id}`,
      objectId: object.id,
      source: relativeSource,
      line: candidate.line,
      start: candidate.start,
      end: candidate.end,
      display: source.slice(candidate.start, candidate.end),
      context: contextAround(source, candidate.start, candidate.end),
      targetId: point.id,
      href,
    });
  }
  return { objectId: object.id, source: relativeSource, insertions: insertions.sort((a, b) => a.start - b.start), issues, notices };
}

// The visible neighbourhood of an insertion, so a reviewer can see whether the label was cut out
// of a longer word (for example 对角矩阵 inside 三对角矩阵) without opening the document.
function contextAround(source, start, end, width = 8) {
  const clean = (value) => value.replace(/\s+/g, ' ');
  return `${clean(source.slice(Math.max(0, start - width), start))}[${source.slice(start, end)}]${clean(source.slice(end, end + width))}`;
}

function groupRange(group, visibleStart, visibleEnd) {
  const first = group.leaves.find((leaf) => visibleStart >= leaf.textStart && visibleStart < leaf.textEnd);
  const last = [...group.leaves].reverse().find((leaf) => visibleEnd > leaf.textStart && visibleEnd <= leaf.textEnd);
  if (!first || !last) return null;
  let start = first.start + (visibleStart - first.textStart);
  let end = last.start + (visibleEnd - last.textStart);
  for (const format of group.formats) {
    if (format.visibleStart === visibleStart) start = Math.min(start, format.start);
    if (format.visibleEnd === visibleEnd) end = Math.max(end, format.end);
  }
  return { start, end };
}

function findLabel(text, label, from) {
  for (let index = text.indexOf(label, from); index >= 0; index = text.indexOf(label, index + 1)) {
    if (hasCjk(label) || hasBoundaries(text, index, index + label.length)) return index;
  }
  return -1;
}

function hasBoundaries(text, start, end) {
  const word = /[\p{L}\p{N}_]/u;
  return !(start > 0 && word.test(text[start - 1])) && !(end < text.length && word.test(text[end]));
}

function hasCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function applyPatches(source, insertions) {
  let output = source;
  for (const patch of [...insertions].sort((a, b) => b.start - a.start)) {
    const raw = output.slice(patch.start, patch.end);
    const replacement = `[${raw}](${patch.href})`;
    output = `${output.slice(0, patch.start)}${replacement}${output.slice(patch.end)}`;
  }
  return output;
}

function relativeObjectHref(sourceDocument, targetDirectory) {
  const sourceDirectory = path.posix.dirname(normalizeWorkspacePath(sourceDocument));
  const target = `${normalizeWorkspacePath(targetDirectory)}/document.md`;
  const relative = path.posix.relative(sourceDirectory, target);
  return relative.split('/').map((segment) => segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)).join('/');
}

function resolveObjectHref(sourceDocument, href, targetByDocument) {
  const value = String(href ?? '').trim();
  if (!value || value.startsWith('#') || value.startsWith('/') || value.startsWith('\\') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
  const pathOnly = value.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = pathOnly.split('/').map((segment) => decodeURIComponent(segment)).join('/'); } catch { return null; }
  const resolved = normalizeWorkspacePath(path.posix.join(path.posix.dirname(normalizeWorkspacePath(sourceDocument)), decoded));
  return targetByDocument.get(resolved) ?? null;
}

function normalizeWorkspacePath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) throw new Error(`Unsafe workspace path: ${value}`);
  return normalized;
}

async function safeWorkspaceSource(root, relative) {
  const normalized = normalizeWorkspacePath(relative);
  const resolved = path.resolve(root, ...normalized.split('/'));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe workspace path: ${relative}`);
  const [realRoot, realFile, information] = await Promise.all([realpath(root), realpath(resolved), lstat(resolved)]);
  if (information.isSymbolicLink()) throw new Error(`Refusing symbolic-link document source: ${relative}`);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Document source resolves outside the workspace: ${relative}`);
  return realFile;
}

function newGroup() {
  return { text: '', leaves: [], formats: [] };
}

function visibleMdText(node) {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') return node.value ?? '';
  return (node.children ?? []).map(visibleMdText).join('');
}

function visibleHtmlText(node) {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(visibleHtmlText).join('');
}

function visitHtml(node, visitor) {
  visitor(node);
  for (const child of node.childNodes ?? []) visitHtml(child, visitor);
}

function walk(node, ancestors, visitor) {
  const descend = visitor(node, ancestors);
  if (descend === false) return;
  for (const child of node.children ?? []) walk(child, [...ancestors, node], visitor);
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function issue(object, source, line, code, message) {
  return { objectId: object.id, source, line, code, message };
}

function emitReport({ blockers: issues, suggestions, written }) {
  const writtenIds = new Set(written.map((entry) => entry.id));
  const report = {
    schema: SCHEMA,
    mode: write ? 'write' : 'check',
    selectedDocuments: selected.length,
    changedDocuments: new Set(written.map((entry) => entry.source)).size,
    writtenCount: written.length,
    suggestions: suggestions.map(({ start, end, href, display, objectId, ...entry }) => ({ ...entry, written: writtenIds.has(entry.id) })),
    issues,
    notices,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const entry of report.suggestions) {
    console.log(`${entry.written ? 'Linked' : 'Suggested'} ${entry.id} ${entry.source}:${entry.line} ${entry.context}`);
  }
  for (const entry of issues) console.error(`Crosslink error [${entry.objectId}] ${entry.source}:${entry.line} ${entry.code}: ${entry.message}`);
  for (const entry of notices) console.log(`Kept [${entry.objectId}] ${entry.source}:${entry.line} ${entry.message}`);
  console.log(`${write ? 'Wrote' : 'Checked'} ${report.selectedDocuments} document(s): ${report.suggestions.length} suggestion(s), ${report.writtenCount} written, ${issues.length} issue(s).`);
}

// Links whose workspace target does not exist. `validate` runs this over every document. A
// derivation's tails and head need no link in its document: readers of a derivation are shown them
// from the graph.
async function auditDocumentLinks() {
  const issues = [];
  const realRoot = await realpath(workspaceRoot);
  for (const object of objects) {
    const relativeSource = `${object.data.document}/document.md`;
    let source;
    try {
      source = await readFile(await safeWorkspaceSource(workspaceRoot, relativeSource), 'utf8');
    } catch {
      continue;
    }
    let analysis;
    try {
      analysis = analyzeMarkdown(source);
    } catch {
      continue;
    }
    for (const link of analysis.links) {
      const value = String(link.href ?? '').trim();
      if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) continue;
      if (resolveObjectHref(relativeSource, value, targetByDocument)) continue;
      if (!(await workspaceFileExists(realRoot, relativeSource, value))) {
        issues.push(issue(object, relativeSource, link.line, 'dangling-link', `${JSON.stringify(link.text)} links to ${value}, which is not a file in the workspace`));
      }
    }
  }
  return issues;
}

async function workspaceFileExists(realRoot, sourceDocument, href) {
  if (href.startsWith('/') || href.startsWith('\\')) return false;
  let decoded;
  try { decoded = href.split(/[?#]/, 1)[0].split('/').map((segment) => decodeURIComponent(segment)).join('/'); } catch { return false; }
  let relative;
  try { relative = normalizeWorkspacePath(path.posix.join(path.posix.dirname(normalizeWorkspacePath(sourceDocument)), decoded)); } catch { return false; }
  const resolved = path.resolve(realRoot, ...relative.split('/'));
  if (!resolved.startsWith(`${realRoot}${path.sep}`)) return false;
  try { await access(resolved); return true; } catch { return false; }
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function takeFlag(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeValues(flag) {
  const values = [];
  for (let index = args.indexOf(flag); index >= 0; index = args.indexOf(flag)) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`, 2);
    args.splice(index, 2);
    values.push(value);
  }
  return values;
}

function takeValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`, 2);
  args.splice(index, 2);
  return value;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
