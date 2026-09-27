import Fuse from 'fuse.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// Find the graph objects a piece of text may mean, ranked the way the Mindmap editor's
// "reference an object" picker ranks them (derivon-mindmap src/editorReferences.ts): exact id,
// exact label, id prefix, label prefix, then fuzzy. This adds each concept's description to the
// fuzzy terms, because a writer often knows what a concept says before knowing its label.
// With --from, every candidate carries a ready Markdown link relative to that object's document.
// Concepts may share a label (derivon-mindmap ADR-0014), so each concept candidate carries its
// qualifier, and the qualifier is searchable too.

const SCHEMA = 'derivon.object-search/v1';
const args = process.argv.slice(2);
const json = takeFlag('--json');
const from = takeValue('--from');
const kind = takeValue('--kind');
const limitValue = takeValue('--limit');
const manifestArg = takeValue('--manifest');
if (takeFlag('--help') || takeFlag('-h')) {
  console.log(`Usage:
  node find-objects.mjs [--json] [--from <object-id>] [--kind concept|derivation] [--limit <n>] [--manifest <candidate.json>] <workspace> <query...>`);
  process.exit(0);
}
if (kind && !['concept', 'derivation'].includes(kind)) fail('--kind must be concept or derivation', 2);
const limit = limitValue === null ? 10 : Number(limitValue);
if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer', 2);
const workspaceRoot = path.resolve(args.shift() ?? '.');
const query = args.join(' ').trim();
if (!query) fail('Give the text to look up.', 2);
const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(workspaceRoot, '.derivon', 'workspace.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const points = manifest.graph?.points ?? [];
const hyperedges = manifest.graph?.hyperedges ?? [];
const labelById = new Map(points.map((point) => [point.id, point.data?.label ?? point.id]));

const targets = [
  ...points.map((point) => ({
    kind: 'concept',
    id: point.id,
    label: point.data?.label ?? point.id,
    qualifier: typeof point.data?.qualifier === 'string' && point.data.qualifier.trim() ? point.data.qualifier : null,
    detail: point.data?.description ?? '',
    document: point.data?.document,
    searchTerms: [point.id, point.data?.label ?? '', point.data?.qualifier ?? '', point.data?.description ?? ''],
  })),
  ...hyperedges.map((edge) => {
    const tailLabels = (edge.tails ?? []).map((id) => labelById.get(id) ?? id);
    const headLabel = labelById.get(edge.head) ?? edge.head;
    return {
      kind: 'derivation',
      id: edge.id,
      label: `推导 ${edge.id}`,
      detail: `${tailLabels.length ? tailLabels.join(' + ') : '∅'} → ${headLabel}`,
      document: edge.data?.document,
      searchTerms: [edge.id, ...(edge.tails ?? []), ...tailLabels, edge.head, headLabel],
    };
  }),
].filter((target) => !kind || target.kind === kind);

let source = null;
if (from) {
  const owner = [...points, ...hyperedges].find((object) => object.id === from);
  if (!owner) fail(`Unknown object for --from: ${from}`, 2);
  source = `${owner.data.document}/document.md`;
}

const candidates = search(targets, query, limit).map((target) => ({
  kind: target.kind,
  id: target.id,
  label: target.label,
  ...(target.kind === 'concept' ? { qualifier: target.qualifier } : {}),
  detail: target.detail,
  document: target.document,
  ...(source ? { link: `[${linkText(target)}](${objectDocumentHref(source, target.document)})` } : {}),
}));

if (json) {
  process.stdout.write(`${JSON.stringify({ schema: SCHEMA, query, from: from ?? null, candidates }, null, 2)}\n`);
} else {
  for (const candidate of candidates) {
    console.log(`${candidate.id}\t${candidate.label}${candidate.qualifier ? `（${candidate.qualifier}）` : ''}\t${candidate.detail}${candidate.link ? `\t${candidate.link}` : ''}`);
  }
}

function search(values, text, max) {
  const value = text.toLocaleLowerCase();
  const fuse = new Fuse([...values], {
    keys: ['label', 'id', 'searchTerms'],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 1,
    includeScore: true,
  });
  const fuzzyScore = new Map(fuse.search(value).map(({ item, score }) => [item.id, score ?? 1]));
  return values
    .map((target, index) => {
      const id = target.id.toLocaleLowerCase();
      const label = target.label.toLocaleLowerCase();
      let rank;
      if (id === value) rank = 0;
      else if (label === value) rank = 1;
      else if (id.startsWith(value)) rank = 2;
      else if (label.startsWith(value)) rank = 3;
      else {
        const score = fuzzyScore.get(target.id);
        rank = score === undefined ? Number.POSITIVE_INFINITY : 4 + score;
      }
      return { target, index, rank };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, max)
    .map(({ target }) => target);
}

// A concept link shows its label; a derivation link shows its id, which the writer usually rewords.
function linkText(target) {
  return target.kind === 'concept' ? target.label : target.id;
}

// The same relative href the Mindmap editor writes (derivon-mindmap src/workspace/references.ts).
function objectDocumentHref(documentPath, targetDirectory) {
  const from = documentPath.split('/').filter(Boolean).slice(0, -1);
  const target = [...targetDirectory.split('/').filter(Boolean), 'document.md'];
  let shared = 0;
  while (shared < from.length && shared < target.length && from[shared] === target[shared]) shared += 1;
  return [
    ...Array.from({ length: from.length - shared }, () => '..'),
    ...target.slice(shared).map((segment) => encodeURIComponent(segment)),
  ].join('/') || 'document.md';
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
