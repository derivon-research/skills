/**
 * Label review: advisories on concept labels, and the companion record that acknowledges them.
 *
 * The Mindmap canvas draws each concept in a fixed box with a one-line label, so a label is a
 * short handle and a proposition's statement belongs in `data.description` and the document. Two
 * checks flag labels an Agent must look at again:
 *
 * - `coordination`: the label contains a coordination signal (与, 和, 及, 、, 并且, `and`, `&`,
 *   list punctuation). It may bundle parts that should be separate points.
 * - `length`: the label is wider than the canvas shows.
 *
 * These are advisories, never errors: they do not make a workspace invalid and do not change a
 * command's status or exit code. An advisory is resolved by splitting the point, shortening the
 * label, or recording an acknowledgement with a reason in `.derivon/label-review.json`
 * (`derivon.label-review/v1`). The manifest gets no field for it, like `.derivon/orientation.json`.
 *
 * An acknowledgement silences an advisory only while its point exists and carries a label
 * byte-identical to the recorded one, so a rename puts the label up for review again. An entry
 * that silences nothing is stale: validate ignores it and reports the count, and the next
 * `review-label` write prunes it. A malformed record is a validate error.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CODE, issue } from './envelope.mjs';

export const LABEL_REVIEW_SCHEMA = 'derivon.label-review/v1';
export const LABEL_REVIEW_FILE = '.derivon/label-review.json';
export const LABEL_CHECKS = ['coordination', 'length'];

/**
 * The widest label the canvas shows without an ellipsis, in width units.
 *
 * The concept box's label is 13px system-ui at weight 650 with `labelMaxWidth: 112`,
 * `labelMaxLines: 1` and ellipsis overflow (derivon-mindmap `src/G6GraphSurface.tsx`). A CJK
 * glyph is one em, 13px, so 8 fit (104px) and a 9th (117px) is cut. Latin letters, digits and
 * most symbols average a little over half an em at that size, so they count half a unit; this
 * errs slightly permissive for Latin-heavy labels, which is the cheaper mistake for an advisory.
 */
export const LABEL_WIDTH_LIMIT = 8;

/* East Asian Wide and Fullwidth ranges (Unicode EastAsianWidth W/F), coarsened to blocks. */
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

const ZERO_WIDTH = /[\p{Mn}\p{Me}​-‏⁠︀-️﻿]/u;

function isWide(codePoint) {
  for (const [low, high] of WIDE_RANGES) {
    if (codePoint < low) return false;
    if (codePoint <= high) return true;
  }
  return false;
}

/** Display width of a label in canvas units: wide and fullwidth characters 1, combining and
 * zero-width characters 0, everything else 0.5. */
export function labelWidth(label) {
  let width = 0;
  for (const character of String(label)) {
    if (ZERO_WIDTH.test(character)) continue;
    width += isWide(character.codePointAt(0)) ? 1 : 0.5;
  }
  return width;
}

/* Compounds where the character is not a coordinating conjunction: a sum (之和, 直和, 和空间,
 * 的和), a harmonic or saturated object (调和, 饱和), a verb (参与, 涉及). Masked before
 * matching; a rare true coordination they hide is the cheaper mistake for an advisory. */
const NOT_COORDINATION = [
  '平方和', '部分和', '和空间', '之和', '直和', '的和', '和的', '求和', '总和', '幂和', '和式', '调和', '饱和', '中和', '缓和', '和谐',
  '柔和', '温和', '参与', '给与', '授与', '涉及', '普及', '及格', '危及', '波及', '顾及', '触及',
  '企及', '来不及', '不及',
];
const CJK_SIGNALS = ['并且', '与', '和', '及', '、'];
/* Commas and semicolons inside ASCII brackets or inline math separate arguments, as in
 * `(cos θ, sin θ)` or `ℒ(V, W)`, so bracketed text is dropped before looking for them. Fullwidth
 * brackets are prose and stay. */
const BRACKETED = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|⟨[^⟨⟩]*⟩|\$[^$]*\$/g;
const LIST_PUNCTUATION = [',', '，', ';', '；', '&'];

/** The coordination signals a label contains, in a stable order; empty when it has none. */
export function coordinationSignals(label) {
  let masked = String(label);
  for (const compound of NOT_COORDINATION) masked = masked.replaceAll(compound, '□');
  const found = CJK_SIGNALS.filter((signal) => masked.includes(signal));
  let outside = masked;
  for (let previous = null; previous !== outside;) {
    previous = outside;
    outside = outside.replace(BRACKETED, ' ');
  }
  if (/\band\b/i.test(outside)) found.push('and');
  for (const mark of LIST_PUNCTUATION) if (outside.includes(mark)) found.push(mark);
  return found;
}

function advisoriesFor(point) {
  const label = point.data.label;
  const found = [];
  const signals = coordinationSignals(label);
  if (signals.length) {
    found.push({
      id: point.id,
      label,
      check: 'coordination',
      message: `label contains coordination (${signals.join(' ')}). If its parts can be defined, derived or referenced on their own, split the point and give each part its own derivations. If it names one proposition or one relation, shorten the label to a noun-like handle and put the full statement in data.description and the document's first sentence. Only when one indivisible understanding really carries this name, acknowledge it with review-label and the reason.`,
    });
  }
  const width = labelWidth(label);
  if (width > LABEL_WIDTH_LIMIT) {
    found.push({
      id: point.id,
      label,
      check: 'length',
      width,
      message: `label is ${width} units wide and the canvas shows ${LABEL_WIDTH_LIMIT} (a CJK or fullwidth character is 1, any other character 0.5). If it bundles parts that can be defined, derived or referenced on their own, split the point. Otherwise shorten it to a noun-like handle: the conventional name when one exists, or a coined one that no other label uses and that does not read as a definition; put the full statement in data.description and the document's first sentence. Only when no shorter handle is recognizable, acknowledge it with review-label and the reason.`,
    });
  }
  return found;
}

/** Every label advisory the manifest's concepts raise, before acknowledgements. Points without
 * a string label are skipped; the workspace validator reports those. */
export function labelAdvisories(manifest) {
  const points = Array.isArray(manifest?.graph?.points) ? manifest.graph.points : [];
  return points
    .filter((point) => typeof point?.id === 'string' && typeof point?.data?.label === 'string')
    .flatMap(advisoriesFor);
}

/**
 * Parse a label-review record. Returns `{ entries }` or `{ issues }`; every issue carries the
 * `label-review-invalid` code and a path inside the record.
 */
export function parseLabelReview(text) {
  const issues = [];
  const add = (pointer, message) => issues.push(issue(CODE.LABEL_REVIEW_INVALID, `${LABEL_REVIEW_FILE}#${pointer}`, message));
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    add('', `not valid JSON: ${error.message}`);
    return { issues };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add('', 'expected an object');
    return { issues };
  }
  for (const key of Object.keys(value)) if (!['schema', 'entries'].includes(key)) add(`/${key}`, 'unknown field');
  if (value.schema !== LABEL_REVIEW_SCHEMA) add('/schema', `expected ${LABEL_REVIEW_SCHEMA}`);
  if (!Array.isArray(value.entries)) {
    add('/entries', 'expected an array');
    return { issues };
  }
  const seen = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const at = `/entries/${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      add(at, 'expected an object');
      continue;
    }
    for (const key of Object.keys(entry)) if (!['id', 'label', 'check', 'reason'].includes(key)) add(`${at}/${key}`, 'unknown field');
    if (typeof entry.id !== 'string' || !entry.id) add(`${at}/id`, 'expected a point id');
    if (typeof entry.label !== 'string') add(`${at}/label`, 'expected the label as it was reviewed');
    if (!LABEL_CHECKS.includes(entry.check)) add(`${at}/check`, `expected one of ${LABEL_CHECKS.join(', ')}`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) add(`${at}/reason`, 'expected a non-empty reason');
    const key = `${entry.id}\u0000${entry.check}`;
    if (seen.has(key)) add(at, `duplicate entry for ${entry.id} ${entry.check}`);
    seen.add(key);
  }
  return issues.length ? { issues } : { entries: value.entries };
}

/** Read the workspace's label-review record. An absent file is an empty record. */
export async function readLabelReview(root) {
  let text;
  try {
    text = await readFile(path.join(root, LABEL_REVIEW_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, text: null, entries: [] };
    return { present: true, text: null, issues: [issue(CODE.IO_ERROR, LABEL_REVIEW_FILE, error.message)] };
  }
  return { present: true, text, ...parseLabelReview(text) };
}

/** Does this entry acknowledge this advisory? Same point, same check, byte-identical label. */
function acknowledges(entry, advisory) {
  return entry.id === advisory.id && entry.check === advisory.check && entry.label === advisory.label;
}

/**
 * Split the manifest's advisories into open and acknowledged, and count the stale entries: the
 * ones that silence no current advisory because the point is gone or its label changed.
 */
export function applyLabelReview(manifest, entries) {
  const advisories = labelAdvisories(manifest);
  const open = advisories.filter((advisory) => !entries.some((entry) => acknowledges(entry, advisory)));
  const live = entries.filter((entry) => advisories.some((advisory) => acknowledges(entry, advisory)));
  return { advisories, open, acknowledged: advisories.length - open.length, live, stale: entries.length - live.length };
}

/**
 * The validate-side audit: read the record, apply it, and return the fields validate reports.
 * `issues` is non-empty only for a record that cannot be read or parsed; advisories never are
 * issues.
 */
export async function auditLabelReview({ root, manifest }) {
  const record = await readLabelReview(root);
  if (record.issues) {
    return { issues: record.issues, labelReviews: labelAdvisories(manifest), acknowledged: 0, stale: 0 };
  }
  const { open, acknowledged, stale } = applyLabelReview(manifest, record.entries);
  return { issues: [], labelReviews: open, acknowledged, stale };
}

/** Serialize a record the way `review-label` writes it. */
export function serializeLabelReview(entries) {
  const ordered = [...entries]
    .map(({ id, label, check, reason }) => ({ id, label, check, reason }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.check.localeCompare(right.check));
  return `${JSON.stringify({ schema: LABEL_REVIEW_SCHEMA, entries: ordered }, null, 2)}\n`;
}
