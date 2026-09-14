import parseCss from 'css-tree/parser';
import walkCss from 'css-tree/walker';
import { imageDimensionsFromData } from 'image-dimensions';
import { marked } from 'marked';
import { parseFragment } from 'parse5';
import { parseSrcset } from 'srcset';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const RASTER_EXTENSIONS = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.webp', 'webp'],
  ['.gif', 'gif'],
  ['.avif', 'avif'],
]);
const IMAGE_EXTENSIONS = new Set([...RASTER_EXTENSIONS.keys(), '.svg']);
const PLACEHOLDER_COMMENT = /(?:source[-_ ]?figure|figure[-_ ]?placeholder|image\s*(?:todo|placeholder)|(?:插图|图片|图像)[^\n]*(?:待补|占位|来源))/i;
const REMOTE_SCHEME = /^(?:https?:)?\/\//i;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export class MediaPreflightError extends Error {
  constructor(issues) {
    super(`${issues.length} media preflight error(s)`);
    this.name = 'MediaPreflightError';
    this.issues = issues;
  }
}

export async function auditDocumentMedia({ markdown, objectId, sourcePath, objectDirectory }) {
  const context = {
    markdown,
    objectId,
    sourcePath,
    objectDirectory,
    realObjectDirectory: await realpath(objectDirectory),
    issues: [],
    assets: new Set(),
    visibleMedia: 0,
    placeholderComments: [],
    checkedDependencies: new Set(),
    imageChecks: new Map(),
  };

  const tokens = marked.lexer(markdown, { gfm: true });
  let searchOffset = 0;
  marked.walkTokens(tokens, (token) => {
    if (token.type !== 'image' && token.type !== 'html') return;
    const tokenOffset = locateToken(markdown, token.raw, searchOffset);
    if (tokenOffset >= 0) searchOffset = tokenOffset + token.raw.length;
    const offset = tokenOffset >= 0 ? tokenOffset : 0;
    if (token.type === 'image') {
      context.visibleMedia += 1;
      if (!String(token.text ?? '').trim()) {
        addIssue(context, offset, token.raw, 'Markdown images require meaningful nonempty alt text.', 'Describe the information the figure contributes inside ![...].', 'media-alt');
      }
      context.pending ??= [];
      context.pending.push(checkReference(context, token.href, offset, token.raw, { image: true, role: 'Markdown image' }));
    } else {
      context.pending ??= [];
      context.pending.push(auditHtml(context, token.raw, offset, objectDirectory));
    }
  });
  await Promise.all(context.pending ?? []);

  if (context.placeholderComments.length && context.visibleMedia === 0) {
    for (const comment of context.placeholderComments) {
      addIssue(
        context,
        comment.offset,
        comment.snippet,
        'Figure metadata has no visible image or media element.',
        'Add the real local figure with Markdown image syntax, or report the figure as blocked instead of inserting a placeholder.',
        'media-placeholder',
      );
    }
  }
  if (context.issues.length) throw new MediaPreflightError(context.issues.sort((a, b) => a.offset - b.offset));
  return { assets: [...context.assets].sort(), mediaCount: context.assets.size };
}

export function formatMediaIssue(issue) {
  return `Media error [${issue.objectId}] ${issue.sourcePath}:${issue.line}\n  ${issue.snippet}\n  ${issue.message}\n  Fix: ${issue.repair}`;
}

function locateToken(markdown, raw, after) {
  const offset = markdown.indexOf(raw, after);
  return offset >= 0 ? offset : markdown.indexOf(raw);
}

function addIssue(context, offset, snippet, message, repair, code = 'media-invalid') {
  const normalizedSnippet = String(snippet ?? '').trim().replace(/\s+/g, ' ').slice(0, 180) || '(empty reference)';
  context.issues.push({
    code,
    objectId: context.objectId,
    sourcePath: context.sourcePath,
    line: lineAt(context.markdown, offset),
    offset,
    snippet: normalizedSnippet,
    message,
    repair,
  });
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < Math.max(0, offset); index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

async function auditHtml(context, html, baseOffset, baseDirectory) {
  let fragment;
  try {
    fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  } catch (error) {
    addIssue(context, baseOffset, html, `Raw HTML could not be parsed: ${error.message}`, 'Repair the HTML before rendering.', 'media-html');
    return;
  }
  await visitHtmlNodes(context, fragment.childNodes ?? [], html, baseOffset, baseDirectory);
}

async function visitHtmlNodes(context, nodes, html, baseOffset, baseDirectory) {
  for (const node of nodes) {
    const location = node.sourceCodeLocation;
    const nodeOffset = baseOffset + (location?.startOffset ?? 0);
    if (node.nodeName === '#comment') {
      if (PLACEHOLDER_COMMENT.test(node.data ?? '')) {
        context.placeholderComments.push({ offset: nodeOffset, snippet: `<!--${node.data}-->` });
      }
      continue;
    }
    if (!node.tagName) {
      await visitHtmlNodes(context, node.childNodes ?? [], html, baseOffset, baseDirectory);
      continue;
    }

    const tag = node.tagName.toLowerCase();
    const attributes = new Map((node.attrs ?? []).map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
    const attributeOffset = (name) => baseOffset + (location?.attrs?.[name]?.startOffset ?? location?.startOffset ?? 0);
    const snippet = location ? html.slice(location.startOffset, location.endOffset).slice(0, 180) : `<${tag}>`;

    if (tag === 'base') {
      addIssue(context, nodeOffset, snippet, 'Raw HTML must not change the publication base URL.', 'Remove <base>; keep every dependency object-relative.', 'media-base-url');
    } else if (tag === 'img') {
      context.visibleMedia += 1;
      if (!String(attributes.get('alt') ?? '').trim()) {
        addIssue(context, nodeOffset, snippet, 'HTML images require meaningful nonempty alt text.', 'Add an alt attribute that describes the figure information.', 'media-alt');
      }
      if (!attributes.has('src') && !attributes.has('srcset')) {
        addIssue(context, nodeOffset, snippet, 'HTML images require a src or srcset reference.', 'Reference an object-owned local image.', 'media-img-source');
      }
      await auditAttribute(context, attributes, 'src', attributeOffset('src'), snippet, baseDirectory, { image: true, role: '<img src>' });
      await auditSrcset(context, attributes.get('srcset'), attributeOffset('srcset'), snippet, baseDirectory, '<img srcset>');
    } else if (tag === 'source') {
      await auditAttribute(context, attributes, 'src', attributeOffset('src'), snippet, baseDirectory, { role: '<source src>' });
      await auditSrcset(context, attributes.get('srcset'), attributeOffset('srcset'), snippet, baseDirectory, '<source srcset>');
    } else if (tag === 'video') {
      context.visibleMedia += 1;
      await auditAttribute(context, attributes, 'src', attributeOffset('src'), snippet, baseDirectory, { role: '<video src>' });
      await auditNamedReference(context, attributes.get('poster'), attributeOffset('poster'), snippet, baseDirectory, { image: true, role: '<video poster>' });
    } else if (tag === 'audio' || tag === 'track') {
      await auditAttribute(context, attributes, 'src', attributeOffset('src'), snippet, baseDirectory, { role: `<${tag} src>` });
    } else if (tag === 'script' || tag === 'iframe' || tag === 'embed') {
      await auditAttribute(context, attributes, 'src', attributeOffset('src'), snippet, baseDirectory, { role: `<${tag} src>` });
    } else if (tag === 'object') {
      await auditAttribute(context, attributes, 'data', attributeOffset('data'), snippet, baseDirectory, { role: '<object data>' });
    } else if (tag === 'link' && String(attributes.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) {
      await auditAttribute(context, attributes, 'href', attributeOffset('href'), snippet, baseDirectory, { css: true, role: '<link rel="stylesheet">' });
    } else if (tag === 'input' && String(attributes.get('type') ?? '').toLowerCase() === 'image') {
      context.visibleMedia += 1;
      if (!String(attributes.get('alt') ?? '').trim()) {
        addIssue(context, nodeOffset, snippet, 'Image inputs require meaningful nonempty alt text.', 'Add an alt attribute that names the image action.', 'media-alt');
      }
      await auditAttribute(context, attributes, 'src', attributeOffset('src'), snippet, baseDirectory, { image: true, role: '<input type="image">' });
    } else if (tag === 'svg') {
      context.visibleMedia += 1;
      const title = (node.childNodes ?? []).find((child) => child.tagName?.toLowerCase() === 'title');
      const titleText = (title?.childNodes ?? []).map((child) => child.value ?? '').join('').trim();
      if (!String(attributes.get('aria-label') ?? '').trim()
        && !String(attributes.get('aria-labelledby') ?? '').trim()
        && !titleText) {
        addIssue(context, nodeOffset, snippet, 'Inline SVG figures require an accessible title or ARIA label.', 'Add a nonempty <title>, aria-label, or aria-labelledby value.', 'media-svg-accessibility');
      }
    } else if (tag === 'canvas') {
      context.visibleMedia += 1;
    }

    if (tag === 'style') {
      const css = (node.childNodes ?? []).filter((child) => child.nodeName === '#text').map((child) => child.value ?? '').join('');
      const cssOffset = baseOffset + (node.childNodes?.find((child) => child.nodeName === '#text')?.sourceCodeLocation?.startOffset ?? location?.startTag?.endOffset ?? 0);
      await auditCss(context, css, cssOffset, baseDirectory, 'stylesheet');
    }
    if (attributes.has('style')) {
      await auditCss(context, attributes.get('style'), attributeOffset('style'), baseDirectory, 'declarationList');
    }
    if (node.namespaceURI === 'http://www.w3.org/2000/svg'
      && ['image', 'use', 'script', 'feimage', 'mpath', 'textpath'].includes(tag)) {
      for (const name of ['href', 'xlink:href']) {
        const value = attributes.get(name);
        if (value && !value.trim().startsWith('#')) {
          await checkReference(context, value, attributeOffset(name), snippet, { role: `SVG ${name}`, baseDirectory });
        }
      }
    }

    await visitHtmlNodes(context, node.childNodes ?? [], html, baseOffset, baseDirectory);
  }
}

async function auditAttribute(context, attributes, name, offset, snippet, baseDirectory, options) {
  if (!attributes.has(name)) return;
  await auditNamedReference(context, attributes.get(name), offset, snippet, baseDirectory, options);
}

async function auditNamedReference(context, value, offset, snippet, baseDirectory, options) {
  if (value == null) return;
  await checkReference(context, value, offset, snippet, { ...options, baseDirectory });
}

async function auditSrcset(context, value, offset, snippet, baseDirectory, role) {
  if (value == null) return;
  let candidates;
  try {
    candidates = parseSrcset(value, { strict: true });
  } catch (error) {
    addIssue(context, offset, snippet, `${role} is invalid: ${error.message}`, 'Use a valid srcset with local object-relative image paths.', 'media-srcset');
    return;
  }
  if (!candidates.length) {
    addIssue(context, offset, snippet, `${role} must not be empty.`, 'Add at least one local object-relative image candidate.', 'media-srcset');
    return;
  }
  await Promise.all(candidates.map((candidate) => checkReference(context, candidate.url, offset, snippet, {
    image: true,
    role,
    baseDirectory,
  })));
}

async function auditCss(context, css, baseOffset, baseDirectory, parseContext) {
  if (!String(css ?? '').trim()) return;
  let ast;
  try {
    ast = parseCss(css, { context: parseContext, positions: true });
  } catch (error) {
    const offset = baseOffset + (error.offset ?? 0);
    addIssue(context, offset, String(css).slice(error.offset ?? 0, (error.offset ?? 0) + 120), `CSS could not be parsed: ${error.message}`, 'Repair the CSS before rendering.', 'media-css');
    return;
  }
  const references = [];
  const importUrls = new WeakSet();
  walkCss(ast, (node) => {
    if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') {
      const first = node.prelude?.children?.head?.data;
      if (first?.type === 'String' || first?.type === 'Url') {
        if (first.type === 'Url') importUrls.add(first);
        references.push({ value: first.value, offset: baseOffset + (first.loc?.start.offset ?? 0), role: 'CSS @import' });
      }
      return;
    }
    if (node.type === 'Url' && !importUrls.has(node)) {
      references.push({ value: node.value, offset: baseOffset + (node.loc?.start.offset ?? 0), role: 'CSS url()' });
    }
  });
  await Promise.all(references.map(({ value, offset, role }) => checkReference(context, value, offset, String(css).slice(0, 180), {
    css: role === 'CSS @import',
    role,
    baseDirectory,
  })));
}

async function checkReference(context, rawReference, offset, snippet, options = {}) {
  const reference = String(rawReference ?? '').trim();
  const role = options.role ?? 'media reference';
  if (!reference) {
    addIssue(context, offset, snippet, `${role} must not be empty.`, 'Use an object-relative local asset path.', 'media-reference');
    return;
  }
  if (reference.startsWith('#')) return;
  if (REMOTE_SCHEME.test(reference) || URI_SCHEME.test(reference) || path.isAbsolute(reference) || reference.startsWith('\\') || reference.includes('\\')) {
    addIssue(
      context,
      offset,
      reference,
      `${role} must not use a remote, absolute, file, data, blob, or other URL scheme.`,
      'Copy the authorized asset into this object directory and reference it with a relative path.',
      'media-reference',
    );
    return;
  }

  const pathPart = reference.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    addIssue(context, offset, reference, `${role} contains invalid percent encoding.`, 'Use a valid object-relative asset path.', 'media-reference');
    return;
  }
  if (!decoded) {
    addIssue(context, offset, reference, `${role} does not identify a local file.`, 'Use an object-relative local asset path.', 'media-reference');
    return;
  }

  const baseDirectory = options.baseDirectory ?? context.objectDirectory;
  const resolved = path.resolve(baseDirectory, decoded);
  if (resolved === context.objectDirectory || !resolved.startsWith(`${context.objectDirectory}${path.sep}`)) {
    addIssue(context, offset, reference, `${role} escapes the owning object directory.`, 'Place the asset inside this object directory and use a relative path.', 'media-outside');
    return;
  }

  let stat;
  let realAsset;
  try {
    [stat, realAsset] = await Promise.all([lstat(resolved), realpath(resolved)]);
  } catch (error) {
    addIssue(context, offset, reference, `${role} does not resolve to an existing local file.`, `Add ${decoded} inside the object directory before rendering.`, 'media-missing');
    return;
  }
  if (!realAsset.startsWith(`${context.realObjectDirectory}${path.sep}`)) {
    addIssue(context, offset, reference, `${role} resolves outside the owning object directory.`, 'Replace the escaping symlink/path with an object-owned local asset.', 'media-outside');
    return;
  }
  if (!stat.isFile()) {
    addIssue(context, offset, reference, `${role} must resolve to a regular file.`, 'Reference a file rather than a directory or special entry.', 'media-not-file');
    return;
  }
  if (stat.size === 0) {
    addIssue(context, offset, reference, `${role} resolves to an empty file.`, 'Replace it with a valid nonempty asset.', 'media-empty');
    return;
  }

  const relativeAsset = `./${path.relative(context.objectDirectory, resolved).split(path.sep).join('/')}`;
  const isImage = options.image || IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase());
  if (isImage) {
    let imageCheck = context.imageChecks.get(realAsset);
    if (!imageCheck) {
      imageCheck = verifyImage(context, resolved, relativeAsset, offset, reference);
      context.imageChecks.set(realAsset, imageCheck);
    }
    await imageCheck;
    context.assets.add(relativeAsset);
  }
  if (options.css) await auditDependencyFile(context, resolved, 'css');
}

async function verifyImage(context, filename, relativeAsset, offset, reference) {
  const extension = path.extname(filename).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    addIssue(context, offset, reference, `Unsupported image format for ${relativeAsset}.`, 'Use PNG, JPEG, WebP, GIF, SVG, or AVIF. PDF files cannot be embedded as images.', 'media-format');
    return;
  }
  const bytes = await readFile(filename);
  if (extension === '.svg') {
    await verifySvg(context, bytes, filename, offset, reference);
    return;
  }
  let dimensions;
  try {
    dimensions = imageDimensionsFromData(bytes);
  } catch {
    dimensions = null;
  }
  const expectedType = RASTER_EXTENSIONS.get(extension);
  if (!dimensions || dimensions.type !== expectedType || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)
    || dimensions.width <= 0 || dimensions.height <= 0) {
    addIssue(context, offset, reference, `Image bytes are corrupt or do not match the ${extension} extension.`, 'Replace the file with a valid image whose format and extension agree.', 'media-corrupt');
  }
}

async function verifySvg(context, bytes, filename, offset, reference) {
  const source = bytes.toString('utf8');
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  const root = (fragment.childNodes ?? []).find((node) => node.tagName);
  if (root?.tagName !== 'svg') {
    addIssue(context, offset, reference, 'SVG asset does not contain an <svg> root element.', 'Replace it with a structurally valid SVG file.', 'media-corrupt');
    return;
  }
  const attributes = new Map((root.attrs ?? []).map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
  const width = positiveSvgLength(attributes.get('width'));
  const height = positiveSvgLength(attributes.get('height'));
  const viewBox = String(attributes.get('viewbox') ?? '').trim().split(/[\s,]+/).map(Number);
  const positiveViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  if (!(width && height) && !positiveViewBox) {
    addIssue(context, offset, reference, 'SVG asset has no positive width/height or viewBox dimensions.', 'Add positive SVG dimensions so publication layout is deterministic.', 'media-svg-dimensions');
  }
  await visitHtmlNodes(context, [root], source, 0, path.dirname(filename));
}

function positiveSvgLength(value) {
  if (value == null || /%\s*$/.test(value)) return false;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(?:px|pt|pc|cm|mm|in)?$/i);
  return Boolean(match && Number(match[1]) > 0);
}

async function auditDependencyFile(context, filename, type) {
  const key = `${type}:${filename}`;
  if (context.checkedDependencies.has(key)) return;
  context.checkedDependencies.add(key);
  const source = await readFile(filename, 'utf8');
  if (type === 'css') await auditCss(context, source, 0, path.dirname(filename), 'stylesheet');
}
