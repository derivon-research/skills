import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import katexCss from 'katex/dist/katex.min.css';
import { auditDocumentMedia, formatMediaIssue, MediaPreflightError } from './media-preflight.mjs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const usage = `Usage:
  node render-documents.mjs [--write] [--manifest <candidate.json>] <workspace> [object-id-or-document ...]

Without --write, reports source/publication drift and exits 1 when drift exists.
Both modes preflight local media and offline HTML/CSS dependencies before output.
The script is self-contained and needs no workspace npm dependencies.`;
const args = process.argv.slice(2);
const write = takeFlag(args, '--write');
const manifestArg = takeValue(args, '--manifest');
if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
  console.log(usage);
  process.exit(0);
}
const workspaceRoot = path.resolve(args.shift() ?? '.');
const selectors = new Set(args.map((value) => value.replace(/\/$/, '')));
const manifestPath = manifestArg ? path.resolve(manifestArg) : path.join(workspaceRoot, '.derivon', 'workspace.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const objects = [
  ...(manifest.graph?.points ?? []).map((object) => ({ ...object, kind: 'concept' })),
  ...(manifest.graph?.hyperedges ?? []).map((object) => ({ ...object, kind: 'derivation' })),
];
const selected = objects.filter((object) => !selectors.size
  || selectors.has(object.id)
  || selectors.has(object.data?.document)
  || selectors.has(`${object.data?.document}/document.md`));
if (selectors.size) {
  const matched = new Set(selected.flatMap((object) => [object.id, object.data?.document, `${object.data?.document}/document.md`]));
  const unknown = [...selectors].filter((selector) => !matched.has(selector));
  if (unknown.length) throw new Error(`Unknown object selector(s): ${unknown.join(', ')}`);
}

const markdownRenderer = new Marked(
  { gfm: true },
  markedKatex({ throwOnError: false, strict: false }),
);
const publications = [];
const mediaIssues = [];
for (const object of selected) {
  const directory = await safeWorkspacePath(workspaceRoot, object.data.document);
  const htmlOnly = object.data?.format === 'html';
  const sourceName = htmlOnly ? 'index.html' : 'document.md';
  const sourcePath = path.join(directory, sourceName);
  const outputPath = path.join(directory, 'index.html');
  const source = await readFile(sourcePath, 'utf8');
  try {
    const media = await auditDocumentMedia({
      markdown: source,
      objectId: object.id,
      sourcePath: `${object.data.document}/${sourceName}`,
      objectDirectory: directory,
    });
    publications.push({ object, markdown: source, outputPath, media, htmlOnly });
  } catch (error) {
    if (!(error instanceof MediaPreflightError)) throw error;
    mediaIssues.push(...error.issues);
  }
}

if (mediaIssues.length) {
  console.error(mediaIssues.map(formatMediaIssue).join('\n\n'));
  process.exitCode = 1;
} else {
  let drift = 0;
  for (const { object, markdown, outputPath, media, htmlOnly } of publications) {
    if (!htmlOnly) {
      const title = object.kind === 'concept' ? object.data.label : `Derivation ${object.id}`;
      const expected = renderDocument(markdown, title || object.id);
      let current = null;
      try {
        current = await readFile(outputPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current !== expected) {
        drift += 1;
        if (write) {
          await writeFile(outputPath, expected, 'utf8');
          console.log(`Rendered ${object.data.document}/index.html`);
        } else {
          console.error(`Drift: ${object.data.document}/index.html`);
        }
      }
    }
    if (media.assets.length) {
      console.log(`Media [${object.id}] ${media.assets.length} local image(s): ${media.assets.join(', ')}`);
    }
  }

  if (!drift) console.log(`Publication is synchronized for ${selected.length} selected object(s).`);
  else if (!write) process.exitCode = 1;
  else console.log(`Rendered ${drift} document(s).`);
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function takeValue(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  values.splice(index, 2);
  return value;
}

async function safeWorkspacePath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error(`Unsafe document path: ${String(relative)}`);
  }
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe document path: ${relative}`);
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(resolved)]);
  if (realDirectory === realRoot || !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Document path resolves outside the workspace: ${relative}`);
  }
  return realDirectory;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderDocument(markdown, title) {
  const body = markdownRenderer.parse(markdown, { async: false }).trim();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${baseStyle().split('\n').map((line) => `    ${line}`).join('\n')}
${katexCss.split('\n').map((line) => `    ${line}`).join('\n')}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function baseStyle() {
  return `:root { color: #202422; background: #fff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color-scheme: light; }
* { box-sizing: border-box; }
body { max-width: 820px; margin: 0 auto; padding: 32px; line-height: 1.7; }
h1, h2, h3 { line-height: 1.3; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow: auto; padding: 12px; background: #f4f5f2; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid #799084; color: #5d6761; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 7px 9px; border: 1px solid #d5d8d3; text-align: left; }
img, svg, canvas { max-width: 100%; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: 4px 0; }
button, input, select, textarea { font: inherit; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #2f7087; outline-offset: 2px; }
@media (max-width: 560px) { body { padding: 18px; } table { display: block; overflow-x: auto; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; } }`;
}
