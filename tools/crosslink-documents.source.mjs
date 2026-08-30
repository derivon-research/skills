import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { parse } from 'parse5';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SCHEMA = 'derivon.crosslink-report/v1';
const args = process.argv.slice(2);
const write = takeFlag('--write');
const json = takeFlag('--json');
const all = takeFlag('--all');
const manifestArg = takeValue('--manifest');
if (takeFlag('--help') || takeFlag('-h')) {
  console.log(`Usage:
  node crosslink-documents.mjs [--write] [--json] [--manifest <candidate.json>] <workspace> <selector>...
  node crosslink-documents.mjs [--write] [--json] [--manifest <candidate.json>] <workspace> --all`);
  process.exit(0);
}
const workspaceRoot = path.resolve(args.shift() ?? '.');
const selectors = args;
if (all === Boolean(selectors.length)) fail('Choose exactly one of --all or one or more object selectors.', 2);
const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(workspaceRoot, '.derivon', 'workspace.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const objects = [
  ...(manifest.graph?.points ?? []).map((object) => ({ ...object, kind: 'concept' })),
  ...(manifest.graph?.hyperedges ?? []).map((object) => ({ ...object, kind: 'derivation' })),
];
const points = (manifest.graph?.points ?? []).map((point) => ({ ...point, kind: 'concept' }));
const selected = all ? objects : selectObjects(objects, selectors);
const pointGroups = new Map();
for (const point of points) {
  const group = pointGroups.get(point.data.label) ?? [];
  group.push(point);
  pointGroups.set(point.data.label, group);
}
const labels = [...pointGroups.keys()].filter(Boolean).sort((left, right) => right.length - left.length || left.localeCompare(right));
const targetByPublication = new Map(objects.map((object) => [normalizeWorkspacePath(`${object.data.document}/index.html`), object]));
const reports = [];
const blockers = [];

for (const object of selected) {
  if (!['markdown', 'html'].includes(object.data?.format)) {
    blockers.push(issue(object, '', 1, 'unsupported-format', `Unsupported document format: ${object.data?.format}`));
    continue;
  }
  const sourceName = object.data.format === 'html' ? 'index.html' : 'document.md';
  const relativeSource = `${object.data.document}/${sourceName}`;
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
    analysis = object.data.format === 'html'
      ? analyzeHtml(source, object, relativeSource)
      : analyzeMarkdown(source, object, relativeSource);
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
    targetByPublication,
  });
  reports.push({ ...result, filename, content: source, format: object.data.format });
  blockers.push(...result.issues);
}

const insertions = reports.flatMap((report) => report.insertions);
if (blockers.length) {
  emitReport({ blockers, reports, insertions, wrote: false });
  process.exitCode = 1;
} else if (!write) {
  emitReport({ blockers: [], reports, insertions, wrote: false });
  if (insertions.length) process.exitCode = 1;
} else {
  const prepared = reports.filter((entry) => entry.insertions.length).map((report) => {
    const output = applyPatches(report.content, report.insertions, report.format);
    const analysis = report.format === 'html'
      ? analyzeHtml(output)
      : analyzeMarkdown(output);
    const object = objects.find((entry) => entry.id === report.objectId);
    const verification = resolveInsertions({
      source: output,
      object,
      relativeSource: report.source,
      analysis,
      labels,
      pointGroups,
      targetByPublication,
    });
    if (verification.issues.length || verification.insertions.length) {
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
  emitReport({ blockers: [], reports, insertions, wrote: true });
}

function selectObjects(values, requested) {
  const normalized = new Set(requested.map((value) => value.replace(/\/$/, '')));
  const matches = values.filter((object) => {
    const source = object.data.format === 'html' ? 'index.html' : 'document.md';
    return normalized.has(object.id)
      || normalized.has(object.data.document)
      || normalized.has(`${object.data.document}/${source}`);
  });
  const matched = new Set(matches.flatMap((object) => {
    const source = object.data.format === 'html' ? 'index.html' : 'document.md';
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

function resolveInsertions({ source, object, relativeSource, analysis, labels, pointGroups, targetByPublication }) {
  const issues = [];
  const candidates = [];
  const validLinks = new Map();
  const conflicts = [];
  for (const link of analysis.links) {
    const target = resolveObjectHref(`${object.data.document}/${object.data.format === 'html' ? 'index.html' : 'document.md'}`, link.href, targetByPublication);
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
      if (targets.length === 1 && target?.id !== targets[0].id) conflicts.push({ label, point: targets[0], link });
    }
  }
  for (const block of analysis.blocks) {
    for (const group of block.groups) {
      for (const label of labels) {
        const targets = pointGroups.get(label);
        if (targets.length === 1 && targets[0].id === object.id) continue;
        let from = 0;
        for (;;) {
          const index = findLabel(group.text, label, from);
          if (index < 0) break;
          const sourceRange = groupRange(group, index, index + label.length);
          if (sourceRange) candidates.push({ label, targets, ...sourceRange, line: lineAt(source, sourceRange.start) });
          from = index + Math.max(1, label.length);
        }
      }
    }
  }
  candidates.sort((left, right) => left.start - right.start || right.label.length - left.label.length);
  const firstByLabel = new Map();
  let occupiedEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < occupiedEnd) continue;
    occupiedEnd = candidate.end;
    if (!firstByLabel.has(candidate.label)) firstByLabel.set(candidate.label, candidate);
  }
  const insertions = [];
  const conflictedTargets = new Set();
  for (const conflict of conflicts.sort((left, right) => left.link.start - right.link.start)) {
    const candidate = firstByLabel.get(conflict.label);
    const existing = validLinks.get(conflict.point.id);
    if ((candidate === undefined || conflict.link.start <= candidate.start)
      && (existing === undefined || existing > conflict.link.start)
      && !conflictedTargets.has(conflict.point.id)) {
      issues.push(issue(object, relativeSource, conflict.link.line, 'conflicting-link', `${conflict.label} is linked to ${conflict.link.href}`));
      conflictedTargets.add(conflict.point.id);
    }
  }
  for (const [label, candidate] of firstByLabel) {
    if (candidate.targets.length > 1) {
      issues.push(issue(object, relativeSource, candidate.line, 'ambiguous-label', `${label} matches ${candidate.targets.map((target) => target.id).join(', ')}`));
      continue;
    }
    const point = candidate.targets[0];
    if (conflictedTargets.has(point.id)) continue;
    const existing = validLinks.get(point.id);
    if (existing !== undefined && existing <= candidate.start) continue;
    const href = relativeObjectHref(`${object.data.document}/${object.data.format === 'html' ? 'index.html' : 'document.md'}`, point.data.document);
    insertions.push({
      objectId: object.id,
      source: relativeSource,
      line: candidate.line,
      start: candidate.start,
      end: candidate.end,
      display: source.slice(candidate.start, candidate.end),
      targetId: point.id,
      href,
    });
  }
  return { objectId: object.id, source: relativeSource, insertions: insertions.sort((a, b) => a.start - b.start), issues };
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

function applyPatches(source, insertions, format) {
  let output = source;
  for (const patch of [...insertions].sort((a, b) => b.start - a.start)) {
    const raw = output.slice(patch.start, patch.end);
    const replacement = format === 'html'
      ? `<a href="${escapeHtml(patch.href)}">${raw}</a>`
      : `[${raw}](${patch.href})`;
    output = `${output.slice(0, patch.start)}${replacement}${output.slice(patch.end)}`;
  }
  return output;
}

function relativeObjectHref(sourceDocument, targetDirectory) {
  const sourceDirectory = path.posix.dirname(normalizeWorkspacePath(sourceDocument));
  const target = `${normalizeWorkspacePath(targetDirectory)}/index.html`;
  const relative = path.posix.relative(sourceDirectory, target);
  return relative.split('/').map((segment) => segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)).join('/');
}

function resolveObjectHref(sourceDocument, href, targetByPublication) {
  const value = String(href ?? '').trim();
  if (!value || value.startsWith('#') || value.startsWith('/') || value.startsWith('\\') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
  const pathOnly = value.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = pathOnly.split('/').map((segment) => decodeURIComponent(segment)).join('/'); } catch { return null; }
  const resolved = normalizeWorkspacePath(path.posix.join(path.posix.dirname(normalizeWorkspacePath(sourceDocument)), decoded));
  return targetByPublication.get(resolved) ?? null;
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

function emitReport({ blockers: issues, reports: documents, insertions, wrote }) {
  const report = {
    schema: SCHEMA,
    mode: write ? 'write' : 'check',
    selectedDocuments: selected.length,
    changedDocuments: new Set(insertions.map((entry) => entry.source)).size,
    insertionCount: insertions.length,
    cleanDocuments: documents.filter((entry) => !entry.insertions.length && !entry.issues.length).map((entry) => entry.source),
    skippedDocuments: [],
    insertions: insertions.map(({ start, end, ...entry }) => entry),
    issues,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const entry of report.insertions) {
    console.log(`${wrote ? 'Linked' : 'Missing'} [${entry.objectId}] ${entry.source}:${entry.line} ${JSON.stringify(entry.display)} -> ${entry.targetId} (${entry.href})`);
  }
  for (const entry of issues) console.error(`Crosslink error [${entry.objectId}] ${entry.source}:${entry.line} ${entry.code}: ${entry.message}`);
  console.log(`${wrote ? 'Wrote' : 'Checked'} ${report.selectedDocuments} document(s): ${report.insertionCount} link(s), ${issues.length} issue(s).`);
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
