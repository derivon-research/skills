/**
 * The command surface: one entry point, one result envelope per call, one call per commit.
 *
 * Every command's first argument is the workspace root, then command-specific flags and
 * selectors. Each command declares the capability it changes in the artifact's meaning and
 * the shape of its argv and stdin; `--capabilities` is generated from this table, so the table
 * is the only place a client learns what exists — the client does not keep a second list.
 *
 * A structural command builds its candidate in memory, writes the documents it owns first,
 * validates the whole candidate against the graph protocol and the workspace reference rules,
 * re-reads the manifest and refuses if it changed, and only then replaces the manifest by
 * temporary sibling and rename. Correctness never depends on the caller running a check first;
 * the read-only commands exist as an audit surface, not as a required step.
 *
 * The surface governs two artifact categories, and every command declares which one it belongs
 * to (`artifact`) beside the capability it exercises. Learner records are the second: they are
 * not workspace content, they live in the application data directory keyed by the workspace id,
 * and their commands compute that path themselves rather than being told it. The write boundary
 * and the capability vocabulary are `derivon-mindmap`'s ADR-0011
 * (https://github.com/derivon-research/derivon-mindmap/blob/main/docs/adr/0011-change-workspace-content-through-the-script-command-surface.md).
 */

import { lstat, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CODE, issue } from './envelope.mjs';
import { classifyWorkspacePath, manifestPathFor, readManifest, realWorkspaceRoot, replaceFileAtomically, sha256 } from './fs.mjs';
import { BasisError } from './basis.mjs';
import {
  MISSING_VERSION, applicationDataRoot, isBasis, learnerRecordFile, learnerRecordPath, parseLearnerRecord,
  personalRoutePath, personalRoutesDirectory,
} from './learner-records.mjs';
import {
  ROUTES_DIRECTORY, asIssues, auditWorkspaceRoutes, decodeRoute, isRouteId, listRouteFiles, loadRouteFile,
  personalRouteBasis, routeFileName, routeSummary, serializeRoute, validateRoute,
} from './routes.mjs';
import {
  LABEL_CHECKS, LABEL_REVIEW_FILE, applyLabelReview, auditLabelReview, readLabelReview, serializeLabelReview,
} from './label-review.mjs';
import { OBJECT_ID_PATTERN, auditWorkspace, isUsableWorkspaceId, safeRelativeDirectory } from './workspace-validator.mjs';
import { runDerivon, runTool } from './derivon.mjs';

const MANIFEST_LABEL = '.derivon/workspace.json';

export const COMMANDS = [
  {
    name: 'validate',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Audit a workspace manifest, its graph and its referenced documents, including document links to files that do not exist in the workspace.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'manifest', flag: '--manifest', kind: 'path', required: false, description: 'Audit this manifest instead of <workspace>/.derivon/workspace.json.' },
    ],
    stdin: null,
    result: { changed: [], fields: [
      { name: 'concepts', description: 'Concept count.' },
      { name: 'derivations', description: 'Derivation count.' },
      { name: 'labelReviews', description: 'Open label advisories, each { id, label, check, message }: check coordination (the label contains 与, 和, 及, 、, 并且, and, & or list punctuation), length (wider than the 8 units the canvas shows; a CJK character is 1, others 0.5), shared-name (other concepts, listed in sharedWith, carry the same label, and this one\'s description is missing or equal to another\'s, or it has no qualifier of its own; shared names are allowed), or qualifier-length (data.qualifier, also in the entry, is wider than 8 units). Advisories are not issues and never change status or exit code. Resolve each one: split the point, shorten the label or qualifier, write the difference into data.description and data.qualifier, or acknowledge it with review-label.' },
      { name: 'acknowledgedLabelReviews', description: 'Advisories silenced by .derivon/label-review.json.' },
      { name: 'staleLabelReviews', description: 'Acknowledgements that silence nothing because the point is gone or its label (for qualifier-length, its qualifier) changed; the next review-label prunes them.' },
      { name: 'routes', description: 'Every workspace route in .derivon/routes/, as list-routes reports it; each route error is also an issue.' },
    ] },
    run: runValidate,
  },
  {
    name: 'review-label',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Acknowledge label advisories that validate reports, recording the current label (and for qualifier-length the qualifier) and a reason in .derivon/label-review.json; renaming the point re-opens the review.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.label-review-request/v1', description: '{ entries: [{ id, check, reason }] } — check is coordination, length, shared-name or qualifier-length; reason says why the concept stays as it is after considering the advisory\'s remedies. Every entry must name an existing concept whose advisory is open now, or nothing is written.' },
    result: { changed: [], fields: [
      { name: 'file', description: 'The record written, .derivon/label-review.json.' },
      { name: 'recorded', description: 'The acknowledgements this call wrote: id, label, check, and qualifier for qualifier-length.' },
      { name: 'pruned', description: 'Stale acknowledgements removed.' },
      { name: 'entries', description: 'Acknowledgements in the record after the write.' },
    ] },
    run: runReviewLabel,
  },
  {
    name: 'list-routes',
    artifact: 'workspace',
    capability: 'read',
    summary: 'List the workspace routes in .derivon/routes/, each read against the current graph; an invalid or unreadable route is listed with its errors, never dropped.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: null,
    result: { changed: [], fields: [
      { name: 'routes', description: 'Each route: id, file, version, label, status (ready or invalid), ordered, steps (count), cost, errors (issues), warnings. Codes follow derivon-mindmap docs/routes.md. An unreadable file (unreadable, wrong-schema, unknown-key, missing-field, invalid-field) yields no route. Errors, each also an issue: id-mismatch, empty-label, empty-targets, duplicate-step, forbidden-field, missing-basis, dangling-concept, dangling-derivation, target-unreached (with gaps: each concept nothing in the route concludes, wantedBy, and the candidates in the graph that conclude it), order-not-executable (ordered routes only: the step, its position, and per missing concept producedAt, the position that concludes it, or null). Warnings never refuse anything: never-fires (root causes only), idle (a step no target needs; not reported while a target is unreached), duplicate-head (an earlier step already concludes the same concept, e.g. a parallel derivation). Positions are 1-based in the display order.' },
    ] },
    run: runListRoutes,
  },
  {
    name: 'read-route',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Read one workspace route verbatim with the version a write or delete has to carry, and its reading against the current graph.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'route', positional: true, kind: 'id', required: true, description: 'The route id, r- plus six characters.' },
    ],
    stdin: null,
    result: { changed: [], fields: [
      { name: 'id', description: 'The route id.' },
      { name: 'file', description: 'The workspace-relative file, .derivon/routes/<id>.json.' },
      { name: 'present', description: 'Whether the file exists; an absent route is not an error.' },
      { name: 'version', description: 'The version write-route and delete-route have to carry, or null when there is no file.' },
      { name: 'text', description: 'The file verbatim.' },
      { name: 'reading', description: 'When the file is a well-formed route: reading: { status, order (the steps in the order the route is shown), orderSource (written when ordered, else computed), conceptIds, cost, blocked (steps held up only because another step cannot fire), errors, warnings }. Codes follow derivon-mindmap docs/routes.md. An unreadable file (unreadable, wrong-schema, unknown-key, missing-field, invalid-field) yields no route. Errors, each also an issue: id-mismatch, empty-label, empty-targets, duplicate-step, forbidden-field, missing-basis, dangling-concept, dangling-derivation, target-unreached (with gaps: each concept nothing in the route concludes, wantedBy, and the candidates in the graph that conclude it), order-not-executable (ordered routes only: the step, its position, and per missing concept producedAt, the position that concludes it, or null). Warnings never refuse anything: never-fires (root causes only), idle (a step no target needs; not reported while a target is unreached), duplicate-head (an earlier step already concludes the same concept, e.g. a parallel derivation). Positions are 1-based in the display order.' },
    ] },
    run: runReadRoute,
  },
  {
    name: 'write-route',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Validate one workspace route against the route protocol and the current graph, refuse it on any error, and replace .derivon/routes/<id>.json atomically if it is still the version you read.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'route', positional: true, kind: 'id', required: true, description: 'The route id; the file is .derivon/routes/<route>.json and the document\'s id must equal it.' },
      { name: 'expected-version', flag: '--expected-version', kind: 'string', required: true, description: 'The version read-route reported: a 64-character lowercase hex digest, or the word missing for a new route.' },
    ],
    stdin: { required: true, schema: 'derivon.route/v1', description: 'A complete derivon.route/v1 document: { schema, id (equal to the <route> argument), label (non-empty), description?, known: [concept ids, may be empty], targets: [concept ids, at least one], steps: [derivation ids, no repeats, may be empty], ordered (true: steps are the route order; false: steps are a set and the order is computed) }. Any error refuses the write; warnings do not. A workspace route carries no basis and no basedOn. A new route\'s id is r- plus six random characters of 23456789abcdefghjkmnpqrstvwxyz that no route in list-routes or list-personal-routes uses.' },
    result: { changed: ['routes'], fields: [
      { name: 'id', description: 'The route id.' },
      { name: 'file', description: 'The file replaced.' },
      { name: 'version', description: 'The new version, for the next write.' },
      { name: 'reading', description: 'The route read against the graph, with its warnings.' },
    ] },
    run: runWriteRoute,
  },
  {
    name: 'delete-route',
    artifact: 'workspace',
    capability: 'delete',
    summary: 'Delete one workspace route file if it is still the version you read.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'route', positional: true, kind: 'id', required: true, description: 'The route id.' },
      { name: 'expected-version', flag: '--expected-version', kind: 'string', required: true, description: 'The version read-route reported.' },
    ],
    stdin: null,
    result: { changed: ['routes'], fields: [{ name: 'id', description: 'The route id.' }, { name: 'file', description: 'The file removed.' }] },
    run: runDeleteRoute,
  },
  {
    name: 'render',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Validate Markdown and media without writing anything, optionally for selected objects.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'objects', positional: true, kind: 'id', required: false, repeatable: true, description: 'Object ids, document directories, or document.md paths.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'documents', description: 'Validated documents with their media counts.' }] },
    run: runRender,
  },
  {
    name: 'crosslink',
    artifact: 'workspace',
    capability: 'write-document',
    summary: 'Suggest links for the first exact-label mention of each concept in the selected documents, and write only the suggestions named by --apply. A label several concepts share yields one suggestion per concept; apply the one the text means. A link the author wrote to another target is kept.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'selectors', positional: true, kind: 'id', required: false, repeatable: true, description: 'Object ids, document directories, or document.md paths.' },
      { name: 'all', flag: '--all', kind: 'boolean', required: false, description: 'Select every object.' },
      { name: 'apply', flag: '--apply', kind: 'id', required: false, repeatable: true, description: 'A suggestion id <document-object-id>:<concept-id> to write because it means that concept.' },
      { name: 'check', flag: '--check', kind: 'boolean', required: false, description: 'Report suggestions without writing.' },
    ],
    stdin: null,
    result: { changed: ['documents'], fields: [
      { name: 'selectedDocuments', description: 'Documents examined.' },
      { name: 'written', description: 'Links written by this call.' },
      { name: 'suggestions', description: 'Each suggestion: id, source, line, context with the matched text in brackets, targetId, written. Apply one only when its context means that concept. When several concepts share the matched label, each of them is its own suggestion at the same place, with shared: true, qualifier, description and alternatives (the other suggestion ids there); apply at most one, the one whose description the context means.' },
      { name: 'kept', description: 'Author links left as written, each suppressing its label in that document.' },
    ] },
    run: runCrosslink,
  },
  {
    name: 'find-objects',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Find the objects a piece of text may mean, ranked like the editor\'s reference picker; with --from, each candidate carries a Markdown link relative to that object\'s document.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'query', positional: true, kind: 'string', required: true, repeatable: true, description: 'Text to look up: a label, an id, or words from a description.' },
      { name: 'from', flag: '--from', kind: 'id', required: false, description: 'The object whose document will hold the link.' },
      { name: 'kind', flag: '--kind', kind: 'string', values: ['concept', 'derivation'], required: false, description: 'Only concepts or only derivations.' },
      { name: 'limit', flag: '--limit', kind: 'number', required: false, description: 'Most candidates to return; default 10.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'candidates', description: 'kind, id, label, qualifier (a concept\'s, or null), detail, document, and link when --from is given. Concepts may share a label; tell them apart by qualifier and detail.' }] },
    run: runFindObjects,
  },
  {
    name: 'new-object-id',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Mint a new object\'s id and document directory by the application\'s rule; use both as given.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'kind', flag: '--kind', kind: 'string', required: false, values: ['concept', 'derivation'], description: 'Defaults to concept.' },
    ],
    stdin: null,
    result: { changed: [], fields: [
      { name: 'id', description: 'The minted id.' },
      { name: 'document', description: 'The document directory for this id, as the application would create it: docs/concept-… or docs/derivation-… plus the id without its prefix.' },
    ] },
    run: runNewObjectId,
  },
  {
    name: 'export-textbook',
    artifact: 'workspace',
    capability: 'read',
    summary: 'Export a solved route as a static textbook outside the workspace.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'output', flag: '--output', kind: 'path', required: true, description: 'Textbook output directory.' },
      { name: 'start', flag: '--start', kind: 'id', required: false, repeatable: true, description: 'Route start point.' },
      { name: 'target', flag: '--target', kind: 'id', required: true, repeatable: true, description: 'Route target point.' },
      { name: 'max-nodes', flag: '--max-nodes', kind: 'number', required: false, description: 'Search node budget.' },
      { name: 'max-millis', flag: '--max-millis', kind: 'number', required: false, description: 'Search time budget.' },
      { name: 'max-references', flag: '--max-references', kind: 'number', required: false, description: 'Reference-closure bound.' },
      { name: 'allow-approximate', flag: '--allow-approximate', kind: 'boolean', required: false, description: 'Accept a route not proven optimal.' },
      { name: 'force', flag: '--force', kind: 'boolean', required: false, description: 'Replace a recognized textbook output.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'output', description: 'Output directory.' }, { name: 'chapters', description: 'Exported chapters.' }, { name: 'references', description: 'Exported reference closure.' }] },
    run: runExportTextbook,
  },
  {
    name: 'add-concept',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Add one concept and write its document first, then replace the manifest.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-add-concept/v1', description: '{ id, data, markdown? } — data requires label and document.' },
    result: { changed: ['manifest', 'objects', 'documents'], fields: [{ name: 'id', description: 'The added object id.' }] },
    run: runAddConcept,
  },
  {
    name: 'add-derivation',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Add one derivation and write its document first, then replace the manifest.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-add-derivation/v1', description: '{ id, tails, head, weight, data, markdown? } — data requires document.' },
    result: { changed: ['manifest', 'objects', 'documents'], fields: [{ name: 'id', description: 'The added object id.' }] },
    run: runAddDerivation,
  },
  {
    name: 'set-metadata',
    artifact: 'workspace',
    capability: 'write-structure',
    summary: 'Replace workspace metadata, tag declarations, or object data.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-set-metadata/v1', description: '{ document?, tags?, objects? } — objects maps an id to { data }.' },
    result: { changed: ['manifest', 'objects'], fields: [{ name: 'objects', description: 'Ids whose data was replaced.' }] },
    run: runSetMetadata,
  },
  {
    name: 'write-document',
    artifact: 'workspace',
    capability: 'write-document',
    summary: 'Replace one object document.md with compare-and-swap on the file.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace-write-document/v1', description: '{ object, markdown }.' },
    result: { changed: ['documents'], fields: [{ name: 'object', description: 'The object id.' }, { name: 'document', description: 'The document directory.' }] },
    run: runWriteDocument,
  },
  {
    name: 'delete-object',
    artifact: 'workspace',
    capability: 'delete',
    summary: 'Remove graph objects without deleting their document directories.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' },
      { name: 'ids', positional: true, kind: 'id', required: true, repeatable: true, description: 'Object ids to remove.' },
      { name: 'cascade', flag: '--cascade', kind: 'boolean', required: false, description: 'Also remove dependents of a removed point.' },
    ],
    stdin: null,
    result: { changed: ['manifest', 'objects'], fields: [{ name: 'documents', description: 'Document directories left untouched.' }] },
    run: runDeleteObject,
  },
  {
    name: 'import',
    artifact: 'workspace',
    capability: 'import',
    summary: 'Validate a complete manifest on stdin and replace the current one atomically.',
    argv: [{ name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root.' }],
    stdin: { required: true, schema: 'derivon.workspace/v1', description: 'A complete workspace manifest.' },
    result: { changed: ['manifest'], fields: [{ name: 'id', description: 'Workspace id.' }, { name: 'concepts', description: 'Concept count.' }, { name: 'derivations', description: 'Derivation count.' }] },
    run: runImport,
  },
  {
    name: 'read-learner-record',
    artifact: 'learner-records',
    capability: 'read-learner-record',
    summary: 'Read the learner\'s mastery record (state.json) from the application data directory, keyed by the workspace id. Personal routes have their own commands.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the record.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: null,
    result: { changed: [], fields: [{ name: 'file', description: 'The record that was read.' }, { name: 'path', description: 'The absolute path the record was read from.' }, { name: 'present', description: 'Whether the file exists; an absent record is not an error.' }, { name: 'version', description: 'The version a later write has to carry, or null when there is no file.' }, { name: 'text', description: 'The file verbatim, so a caller can rewrite it without losing anything.' }] },
    run: runReadLearnerRecord,
  },
  {
    name: 'write-learner-record',
    artifact: 'learner-records',
    capability: 'write-learner-record',
    summary: 'Validate the learner\'s mastery record, fill in any basis it leaves out, and replace state.json atomically.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the record and supplies the basis.' },
      { name: 'expected-version', flag: '--expected-version', kind: 'string', required: true, description: 'The version you read: a 64-character lowercase hex digest, or the word missing when there was no file.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: { required: true, schema: 'derivon.learning/v1', description: 'A complete record document. A record that omits basis has it computed from the workspace; a basis you supply is kept as supplied.' },
    result: { changed: ['learnerRecord'], fields: [{ name: 'file', description: 'The record that was written.' }, { name: 'path', description: 'The absolute path replaced.' }, { name: 'version', description: 'The new version, for the next write.' }] },
    run: runWriteLearnerRecord,
  },
  {
    name: 'list-personal-routes',
    artifact: 'learner-records',
    capability: 'read-learner-record',
    summary: 'List the learner\'s personal routes for this workspace, each read against the current graph and checked against its basis.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the records.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: null,
    result: { changed: [], fields: [
      { name: 'directory', description: 'The absolute directory listed.' },
      { name: 'routes', description: 'Each route: id, file, version, label, status (ready or invalid), ordered, steps (count), cost, basedOn, stale (its basis no longer matches the graph: report it, never re-solve, rewrite or delete it on your own), errors, warnings. Codes follow derivon-mindmap docs/routes.md. An unreadable file (unreadable, wrong-schema, unknown-key, missing-field, invalid-field) yields no route. Errors, each also an issue: id-mismatch, empty-label, empty-targets, duplicate-step, forbidden-field, missing-basis, dangling-concept, dangling-derivation, target-unreached (with gaps: each concept nothing in the route concludes, wantedBy, and the candidates in the graph that conclude it), order-not-executable (ordered routes only: the step, its position, and per missing concept producedAt, the position that concludes it, or null). Warnings never refuse anything: never-fires (root causes only), idle (a step no target needs; not reported while a target is unreached), duplicate-head (an earlier step already concludes the same concept, e.g. a parallel derivation). Positions are 1-based in the display order.' },
    ] },
    run: runListPersonalRoutes,
  },
  {
    name: 'read-personal-route',
    artifact: 'learner-records',
    capability: 'read-learner-record',
    summary: 'Read one personal route verbatim with the version a write or delete has to carry, its reading against the current graph, and whether its basis is stale.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the records.' },
      { name: 'route', positional: true, kind: 'id', required: true, description: 'The route id.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: null,
    result: { changed: [], fields: [
      { name: 'id', description: 'The route id.' },
      { name: 'path', description: 'The absolute path read.' },
      { name: 'present', description: 'Whether the file exists; an absent route is not an error.' },
      { name: 'version', description: 'The version a later write or delete has to carry, or null when there is no file.' },
      { name: 'text', description: 'The file verbatim.' },
      { name: 'stale', description: 'True when the route\'s basis no longer matches the graph: report it, never re-solve, rewrite or delete it on your own. Null for an unreadable file.' },
      { name: 'reading', description: 'When the file is a well-formed route: reading: { status, order (the steps in the order the route is shown), orderSource (written when ordered, else computed), conceptIds, cost, blocked (steps held up only because another step cannot fire), errors, warnings }.' },
    ] },
    run: runReadPersonalRoute,
  },
  {
    name: 'write-personal-route',
    artifact: 'learner-records',
    capability: 'write-learner-record',
    summary: 'Validate one personal route against the route protocol and the current graph, refuse it on any error, compute its basis, and replace the file atomically if it is still the version you read.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the records and supplies the basis.' },
      { name: 'route', positional: true, kind: 'id', required: true, description: 'The route id; the document\'s id must equal it.' },
      { name: 'expected-version', flag: '--expected-version', kind: 'string', required: true, description: 'The version you read: a 64-character lowercase hex digest, or the word missing for a new route.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: { required: true, schema: 'derivon.route/v1', description: 'A complete derivon.route/v1 document: { schema, id (equal to the <route> argument), label (non-empty), description?, known: [concept ids, may be empty], targets: [concept ids, at least one], steps: [derivation ids, no repeats, may be empty], ordered (true: steps are the route order; false: steps are a set and the order is computed) }. Any error refuses the write; warnings do not. A personal route may carry basedOn, the workspace route it was copied from (a record of origin, not a link). Its basis is always computed from the graph as it is now; one you send is replaced.' },
    result: { changed: ['learnerRecord'], fields: [
      { name: 'id', description: 'The route id.' },
      { name: 'path', description: 'The absolute path replaced.' },
      { name: 'version', description: 'The new version, for the next write.' },
      { name: 'reading', description: 'The route read against the graph, with its warnings.' },
    ] },
    run: runWritePersonalRoute,
  },
  {
    name: 'delete-personal-route',
    artifact: 'learner-records',
    capability: 'write-learner-record',
    summary: 'Delete one personal route if it is still the version you read. Mastery records are not affected.',
    argv: [
      { name: 'workspace', positional: true, kind: 'path', required: true, description: 'Workspace root; its manifest id keys the records.' },
      { name: 'route', positional: true, kind: 'id', required: true, description: 'The route id.' },
      { name: 'expected-version', flag: '--expected-version', kind: 'string', required: true, description: 'The version read-personal-route reported.' },
      { name: 'data-dir', flag: '--data-dir', kind: 'path', required: false, description: 'Override the application data directory root; defaults to the platform application data directory.' },
    ],
    stdin: null,
    result: { changed: ['learnerRecord'], fields: [{ name: 'id', description: 'The route id.' }, { name: 'path', description: 'The absolute path removed.' }] },
    run: runDeletePersonalRoute,
  },
];

export function findCommand(name) {
  return COMMANDS.find((command) => command.name === name) ?? null;
}

/* --------------------------------------------------------------------------------------- */
/* Argument and payload helpers                                                              */
/* --------------------------------------------------------------------------------------- */

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
  if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
  values.splice(index, 2);
  return value;
}

export class UsageError extends Error {}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve the workspace root, its real path, and the manifest bytes it currently holds. A
 * missing manifest is not fatal here: `validate` can audit a candidate and `import` can create
 * the first one. Read and parse failures are captured so a command can report the right code. */
export async function loadContext(workspaceArg) {
  if (typeof workspaceArg !== 'string' || !workspaceArg) throw new UsageError('a workspace root is required');
  const root = path.resolve(workspaceArg);
  const manifestPath = manifestPathFor(root, null);
  const realRoot = await realWorkspaceRoot(root);
  let current = null;
  let manifestError = null;
  try {
    current = await readManifest(manifestPath);
  } catch (error) {
    manifestError = error.code === 'ENOENT'
      ? issue(CODE.IO_ERROR, MANIFEST_LABEL, 'workspace manifest not found')
      : issue(CODE.INVALID_JSON, MANIFEST_LABEL, error.message);
  }
  return { root, realRoot, manifestPath, current, manifest: current?.manifest ?? null, manifestError };
}

function requireManifest(context) {
  return context.current ? null : (context.manifestError ?? issue(CODE.IO_ERROR, MANIFEST_LABEL, 'workspace manifest not found'));
}

function parseObject(stdin, allowed) {
  if (!stdin.trim()) return { error: issue(CODE.INVALID_PAYLOAD, '.', 'a JSON payload on stdin is required') };
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return { error: issue(CODE.INVALID_JSON, '.', error.message) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: issue(CODE.INVALID_PAYLOAD, '.', 'expected a JSON object') };
  }
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length) return { error: issue(CODE.INVALID_PAYLOAD, '.', `unknown field(s): ${unknown.join(', ')}`) };
  return { payload };
}

/* --------------------------------------------------------------------------------------- */
/* Read-only commands                                                                        */
/* --------------------------------------------------------------------------------------- */

async function runValidate({ argv, context }) {
  const manifestArg = takeValue(argv, '--manifest');
  if (argv.length) throw new UsageError(`Unexpected argument: ${argv[0]}`);
  const manifestPath = manifestArg ? path.resolve(manifestArg) : context.manifestPath;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    const code = error.code === 'ENOENT' ? CODE.IO_ERROR : CODE.INVALID_JSON;
    return { issues: [issue(code, relativeLabel(context.root, manifestPath), error.message)] };
  }
  const { issues, concepts, derivations } = await auditWorkspace({ root: context.root, manifest });
  if (!issues.length) {
    const links = runJsonTool('crosslink-documents.mjs', ['--audit-links', '--json', '--manifest', manifestPath, context.root]);
    if (links.error) issues.push(links.error);
    else issues.push(...(links.value.issues ?? []).map((entry) => issue(entry.code, entry.source, entry.message)));
  }
  const labels = await auditLabelReview({ root: context.root, manifest });
  issues.push(...labels.issues);
  const routes = await auditWorkspaceRoutes({ root: context.root, realRoot: context.realRoot, manifest });
  issues.push(...routes.issues);
  return {
    result: {
      concepts,
      derivations,
      labelReviews: labels.labelReviews,
      acknowledgedLabelReviews: labels.acknowledged,
      staleLabelReviews: labels.stale,
      routes: routes.routes,
    },
    issues,
  };
}

async function runRender({ argv, context }) {
  const report = runJsonTool('render-documents.mjs', ['--json', context.root, ...argv]);
  if (report.error) return { issues: [report.error] };
  return { result: { documents: report.value.documents ?? [] }, issues: report.value.issues ?? [] };
}

async function runCrosslink({ argv, context }) {
  const all = takeFlag(argv, '--all');
  const check = takeFlag(argv, '--check');
  const apply = [];
  for (let value = takeValue(argv, '--apply'); value !== undefined && value !== null; value = takeValue(argv, '--apply')) apply.push(value);
  if (all && argv.length) throw new UsageError('Choose either --all or explicit selectors, not both');
  if (!all && !argv.length) throw new UsageError('crosslink requires --all or at least one selector');
  if (check && apply.length) throw new UsageError('--apply writes; drop --check');
  const toolArgs = ['--json'];
  if (!check) toolArgs.push('--write');
  for (const id of apply) toolArgs.push('--apply', id);
  toolArgs.push(context.root);
  if (all) toolArgs.push('--all');
  else toolArgs.push(...argv);
  const report = runJsonTool('crosslink-documents.mjs', toolArgs);
  if (report.error) return { issues: [report.error] };
  const value = report.value;
  const suggestions = value.suggestions ?? [];
  const issues = (value.issues ?? []).map((entry) => issue(entry.code ?? CODE.CROSSLINK_PARSE_ERROR, entry.source, entry.message));
  const sources = [...new Set(suggestions.filter((entry) => entry.written).map((entry) => entry.source.replace(/\/document\.md$/, '')))];
  return {
    changed: { documents: sources },
    result: {
      selectedDocuments: value.selectedDocuments ?? 0,
      written: value.writtenCount ?? 0,
      suggestions: suggestions.map(({ id, source, line, context, targetId, written, shared, qualifier, description, alternatives }) => ({
        id, source, line, context, targetId, written, ...(shared ? { shared, qualifier, description, alternatives } : {}),
      })),
      kept: (value.notices ?? []).map(({ source, line, message }) => ({ source, line, message })),
    },
    issues,
  };
}

async function runFindObjects({ argv, context }) {
  const toolArgs = ['--json', '--manifest', context.manifestPath];
  for (const flag of ['--from', '--kind', '--limit']) {
    const value = takeValue(argv, flag);
    if (value !== undefined && value !== null) toolArgs.push(flag, value);
  }
  if (!argv.length) throw new UsageError('find-objects needs the text to look up');
  const report = runJsonTool('find-objects.mjs', [...toolArgs, context.root, ...argv]);
  if (report.error) return { issues: [report.error] };
  return { result: { query: report.value.query, candidates: report.value.candidates ?? [] }, issues: [] };
}

async function runNewObjectId({ argv, context }) {
  const kind = takeValue(argv, '--kind') ?? 'concept';
  if (!['concept', 'derivation'].includes(kind)) throw new UsageError('--kind must be concept or derivation');
  if (argv.length) throw new UsageError(`Unexpected argument: ${argv[0]}`);
  const result = runTool('new-object-id.mjs', ['--manifest', context.manifestPath, '--kind', kind]);
  if (result.status !== 0) {
    return { issues: [issue(CODE.IO_ERROR, MANIFEST_LABEL, (result.stderr || result.stdout).trim())] };
  }
  const { id, document } = JSON.parse(result.stdout);
  return { result: { id, document } };
}

async function runExportTextbook({ argv, context }) {
  if (argv.includes('--serve') || argv.includes('--port')) {
    throw new UsageError('the preview server is not part of the command surface; run scripts/export-route-textbook.mjs directly with --serve');
  }
  const report = runJsonTool('export-route-textbook.mjs', ['--json', context.root, ...argv]);
  if (report.error) return { issues: [report.error] };
  const value = report.value;
  return {
    result: { output: value.output ?? null, chapters: value.chapters ?? [], references: value.references ?? [] },
    issues: value.issues ?? [],
  };
}

/* --------------------------------------------------------------------------------------- */
/* Structural commands                                                                       */
/* --------------------------------------------------------------------------------------- */

async function runAddConcept({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'id', 'data', 'markdown']);
  if (parsed.error) return { issues: [parsed.error] };
  const { id, data, markdown } = parsed.payload;
  const issues = [];
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) issues.push(issue(CODE.INVALID_ID, '.', 'expected a workspace object id'));
  else if (findObject(context.manifest, id)) issues.push(issue(CODE.DUPLICATE_ID, '.', `object ${id} already exists`));
  if (!data || typeof data !== 'object' || Array.isArray(data)) issues.push(issue(CODE.INVALID_PAYLOAD, '/data', 'expected an object'));
  if (markdown !== undefined && typeof markdown !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, '/markdown', 'expected a string'));
  if (issues.length) return { issues };
  return addObject(context, { id, markdown, data, object: { id, data }, kind: 'concept' });
}

async function runAddDerivation({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'id', 'tails', 'head', 'weight', 'data', 'markdown']);
  if (parsed.error) return { issues: [parsed.error] };
  const { id, tails, head, weight, data, markdown } = parsed.payload;
  const issues = [];
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) issues.push(issue(CODE.INVALID_ID, '.', 'expected a workspace object id'));
  else if (findObject(context.manifest, id)) issues.push(issue(CODE.DUPLICATE_ID, '.', `object ${id} already exists`));
  if (!data || typeof data !== 'object' || Array.isArray(data)) issues.push(issue(CODE.INVALID_PAYLOAD, '/data', 'expected an object'));
  if (!Array.isArray(tails) || tails.some((tail) => typeof tail !== 'string')) issues.push(issue(CODE.INVALID_PAYLOAD, '/tails', 'expected an array of point ids'));
  if (typeof head !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, '/head', 'expected a point id'));
  if (typeof weight !== 'number' || !Number.isFinite(weight)) issues.push(issue(CODE.INVALID_PAYLOAD, '/weight', 'expected a finite number'));
  if (markdown !== undefined && typeof markdown !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, '/markdown', 'expected a string'));
  if (issues.length) return { issues };
  return addObject(context, { id, markdown, data, object: { id, weight, tails, head, data }, kind: 'derivation' });
}

async function runSetMetadata({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'document', 'tags', 'objects']);
  if (parsed.error) return { issues: [parsed.error] };
  const { document, tags, objects } = parsed.payload;
  const issues = [];
  const candidate = structuredClone(context.manifest);
  const changedObjects = [];
  if (document !== undefined) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      issues.push(issue(CODE.INVALID_PAYLOAD, '/document', 'expected an object'));
    } else {
      for (const key of Object.keys(document)) {
        if (!['title', 'description'].includes(key)) issues.push(issue(CODE.INVALID_PAYLOAD, `/document/${key}`, 'unknown field'));
        else if (typeof document[key] !== 'string') issues.push(issue(CODE.INVALID_PAYLOAD, `/document/${key}`, 'expected a string'));
        else candidate.document[key] = document[key];
      }
    }
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) issues.push(issue(CODE.INVALID_PAYLOAD, '/tags', 'expected an array'));
    else candidate.tags = tags;
  }
  if (objects !== undefined) {
    if (!objects || typeof objects !== 'object' || Array.isArray(objects)) {
      issues.push(issue(CODE.INVALID_PAYLOAD, '/objects', 'expected an object'));
    } else {
      for (const [id, value] of Object.entries(objects)) {
        const target = findObject(candidate, id);
        if (!target) { issues.push(issue(CODE.UNKNOWN_OBJECT, '/objects', `unknown object ${id}`)); continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('data' in value)) {
          issues.push(issue(CODE.INVALID_PAYLOAD, `/objects/${id}`, 'expected { data }'));
          continue;
        }
        target.data = value.data;
        changedObjects.push(id);
      }
    }
  }
  if (issues.length) return { issues };
  const committed = await commitManifest(context, candidate, { objects: changedObjects, documents: [] });
  if (committed.issues?.length) return committed;
  return { ...committed, result: { objects: changedObjects } };
}

async function runWriteDocument({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'object', 'markdown']);
  if (parsed.error) return { issues: [parsed.error] };
  const { object: objectId, markdown } = parsed.payload;
  if (typeof objectId !== 'string' || !objectId) return { issues: [issue(CODE.INVALID_PAYLOAD, '/object', 'expected an object id')] };
  if (typeof markdown !== 'string') return { issues: [issue(CODE.INVALID_PAYLOAD, '/markdown', 'expected a string')] };
  const target = findObject(context.manifest, objectId);
  if (!target) return { issues: [issue(CODE.UNKNOWN_OBJECT, '.', `unknown object ${objectId}`)] };
  const document = target.data?.document;
  if (!safeRelativeDirectory(document)) return { issues: [issue(CODE.DOCUMENT_UNSAFE, '.', `object ${objectId} has no safe document directory`)] };
  const placement = await classifyWorkspacePath(context.realRoot, context.root, document);
  if (placement.status === 'unsafe' || placement.status === 'outside') {
    return { issues: [issue(CODE.DOCUMENT_UNSAFE, '.', `document path for ${objectId} does not stay inside the workspace on its real path`)] };
  }
  if (placement.missing.length) {
    return { issues: [issue(CODE.DOCUMENT_MISSING, `${document}/document.md`, `document directory ${document} does not exist`)] };
  }
  const documentPath = path.join(placement.real, 'document.md');
  let before;
  try {
    before = await readFile(documentPath, 'utf8');
  } catch (error) {
    return { issues: [issue(CODE.DOCUMENT_MISSING, `${document}/document.md`, error.message)] };
  }
  const beforeHash = sha256(before);
  try {
    await replaceFileAtomically(documentPath, markdown, {
      beforeReplace: async () => {
        const latest = await readFile(documentPath, 'utf8');
        if (sha256(latest) !== beforeHash) throw conflictError('the document changed while the command ran; re-read and retry');
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, `${document}/document.md`, error.message)] };
  }
  return { changed: { documents: [document] }, result: { object: objectId, document } };
}

async function runDeleteObject({ argv, context }) {
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const cascade = takeFlag(argv, '--cascade');
  const ids = argv;
  if (!ids.length) throw new UsageError('delete-object requires at least one object id');
  for (const id of ids) {
    if (!findObject(context.manifest, id)) return { issues: [issue(CODE.UNKNOWN_OBJECT, '.', `unknown object ${id}`)] };
  }
  const documents = ids.map((id) => findObject(context.manifest, id).data?.document).filter(Boolean);
  let graph = graphOf(context.manifest);
  for (const id of ids) {
    const isPoint = graph.points.some((point) => point.id === id);
    let args;
    if (isPoint) {
      args = ['point', 'remove', id];
      if (cascade) args.push('--cascade');
    } else {
      args = ['hyperedge', 'remove', id];
    }
    const result = runDerivon(args, { input: JSON.stringify(graph) });
    if (result.error?.code === 'ENOENT') return { issues: [issue(CODE.EXTERNAL_TOOL, '.', 'derivon CLI is not installed or not on PATH')] };
    if (result.status !== 0) return { issues: [issue(CODE.GRAPH_INVALID, '.', (result.stderr || result.stdout).trim())] };
    try {
      graph = JSON.parse(result.stdout);
    } catch (error) {
      return { issues: [issue(CODE.GRAPH_INVALID, '.', `derivon returned no usable graph: ${error.message}`)] };
    }
  }
  const committed = await commitManifest(context, { ...context.manifest, graph: inManifestOrder(context.manifest, graph) }, { objects: ids, documents: [] });
  if (committed.issues?.length) return committed;
  return { ...committed, result: { documents, note: 'document directories are never deleted' } };
}

async function runImport({ argv, context, stdin }) {
  assertNoArguments(argv);
  if (!stdin.trim()) return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'a workspace manifest on stdin is required')] };
  let manifest;
  try {
    manifest = JSON.parse(stdin);
  } catch (error) {
    return { issues: [issue(CODE.INVALID_JSON, '.', error.message)] };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'expected a JSON object')] };
  }
  const committed = await commitManifest(context, manifest, { objects: [], documents: [] });
  if (committed.issues?.length) return committed;
  return {
    ...committed,
    result: {
      id: manifest.id,
      concepts: Array.isArray(manifest.graph?.points) ? manifest.graph.points.length : 0,
      derivations: Array.isArray(manifest.graph?.hyperedges) ? manifest.graph.hyperedges.length : 0,
    },
  };
}

/**
 * Acknowledge label advisories. The whole batch is checked before anything is written: every
 * entry must name an existing concept, a known check, a reason, and an advisory that is open for
 * the concept's current label. The record keeps that label, so a later rename re-opens the
 * review; stale entries are pruned on the way through. A malformed record is refused rather than
 * overwritten, because it may hold reasons nobody else has.
 */
async function runReviewLabel({ argv, context, stdin }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const parsed = parseObject(stdin, ['schema', 'entries']);
  if (parsed.error) return { issues: [parsed.error] };
  const { entries: requested } = parsed.payload;
  if (!Array.isArray(requested) || !requested.length) {
    return { issues: [issue(CODE.INVALID_PAYLOAD, '/entries', 'expected a non-empty array of { id, check, reason }')] };
  }

  const recordPath = path.join(context.root, LABEL_REVIEW_FILE);
  const record = await readLabelReview(context.root);
  if (record.issues) return { issues: record.issues.map((entry) => ({ ...entry, message: `${entry.message}; repair or remove the record before acknowledging more labels` })) };

  const points = new Map(graphOf(context.manifest).points.map((point) => [point.id, point]));
  const { advisories, live, stale } = applyLabelReview(context.manifest, record.entries);
  const issues = [];
  const recorded = [];
  const seen = new Set();
  for (const [index, entry] of requested.entries()) {
    const at = `/entries/${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { issues.push(issue(CODE.INVALID_PAYLOAD, at, 'expected { id, check, reason }')); continue; }
    const unknown = Object.keys(entry).filter((key) => !['id', 'check', 'reason'].includes(key));
    if (unknown.length) { issues.push(issue(CODE.INVALID_PAYLOAD, at, `unknown field(s): ${unknown.join(', ')}`)); continue; }
    const { id, check, reason } = entry;
    if (!LABEL_CHECKS.includes(check)) { issues.push(issue(CODE.INVALID_PAYLOAD, `${at}/check`, `expected one of ${LABEL_CHECKS.join(', ')}`)); continue; }
    if (typeof reason !== 'string' || !reason.trim()) { issues.push(issue(CODE.INVALID_PAYLOAD, `${at}/reason`, 'expected a non-empty reason why this label stays')); continue; }
    const point = typeof id === 'string' ? points.get(id) : undefined;
    if (!point) { issues.push(issue(CODE.UNKNOWN_OBJECT, `${at}/id`, `no concept ${JSON.stringify(id ?? null)}`)); continue; }
    const advisory = advisories.find((candidate) => candidate.id === id && candidate.check === check);
    if (!advisory) {
      issues.push(issue(CODE.LABEL_REVIEW_NOT_APPLICABLE, at, `concept ${id} (${JSON.stringify(point.data?.label ?? null)}) raises no ${check} advisory; there is nothing to acknowledge`));
      continue;
    }
    if (seen.has(`${id}\u0000${check}`)) { issues.push(issue(CODE.INVALID_PAYLOAD, at, `duplicate entry for ${id} ${check}`)); continue; }
    seen.add(`${id}\u0000${check}`);
    recorded.push({ id, label: point.data.label, ...(advisory.qualifier === undefined ? {} : { qualifier: advisory.qualifier }), check, reason: reason.trim() });
  }
  if (issues.length) return { issues };

  const kept = live.filter((entry) => !seen.has(`${entry.id}\u0000${entry.check}`));
  const entries = [...kept, ...recorded];
  const beforeText = record.text;
  try {
    await replaceFileAtomically(recordPath, serializeLabelReview(entries), {
      temporaryDirectory: context.root,
      beforeReplace: async () => {
        const latest = await readFile(recordPath, 'utf8').catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
        if (latest !== beforeText) throw conflictError('the label-review record changed while the command ran; re-read and retry');
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, LABEL_REVIEW_FILE, error.message)] };
  }
  return {
    result: {
      file: LABEL_REVIEW_FILE,
      recorded: recorded.map(({ reason, ...entry }) => entry),
      pruned: stale,
      entries: entries.length,
    },
  };
}

/* --------------------------------------------------------------------------------------- */
/* Routes                                                                                    */
/*                                                                                           */
/* One protocol, derivon.route/v1, in two places: workspace routes are workspace content in   */
/* .derivon/routes/<id>.json; personal routes are learner records. A write validates the     */
/* route's shape and reads it against the current graph, and any error refuses it: a route  */
/* that is invalid the moment it is stored is never stored. The version is the SHA-256 of   */
/* the file's bytes, and a write or delete carries the version it read.                     */
/* --------------------------------------------------------------------------------------- */

function takeRouteId(argv) {
  const id = argv.shift();
  if (id === undefined || id.startsWith('--')) throw new UsageError('a route id is required');
  return id;
}

function routeIdIssue(id) {
  return isRouteId(id) ? null : issue(CODE.INVALID_ID, '.', `\`${id}\` is not a route id: expected r- plus six characters of 23456789abcdefghjkmnpqrstvwxyz`);
}

function takeExpectedVersion(argv, { allowMissing }) {
  const expected = takeValue(argv, '--expected-version');
  const words = allowMissing ? `a 64-character lowercase hex digest or the word ${MISSING_VERSION}` : 'a 64-character lowercase hex digest';
  if (expected === null) throw new UsageError(`--expected-version is required: the version you read${allowMissing ? `, or the word ${MISSING_VERSION}` : ''}`);
  if (expected === MISSING_VERSION && allowMissing) return null;
  if (!isBasis(expected)) throw new UsageError(`--expected-version must be ${words}`);
  return expected;
}

/**
 * Decode, validate and serialize one route arriving on stdin, as the file `<id>.json`. A personal
 * route's basis is computed here, from the graph as it is now, before it is validated: a basis is
 * never carried over from an earlier version or written by hand.
 */
function prepareRoute(stdin, { location, id, manifest, label }) {
  if (!stdin.trim()) return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'a derivon.route/v1 document on stdin is required')] };
  let route;
  try {
    route = JSON.parse(stdin);
  } catch (error) {
    return { issues: [issue(CODE.ROUTE_UNREADABLE, `${label}#`, `not valid JSON: ${error.message}`)] };
  }
  const unreadable = decodeRoute(route, { prefix: label });
  if (unreadable.length) return { issues: unreadable };
  if (location === 'personal') route.basis = personalRouteBasis(manifest, route);
  const reading = validateRoute(manifest, route, { location, fileName: routeFileName(id), prefix: label });
  if (reading.errors.length) return { issues: asIssues(reading.errors) };
  return { route, reading, text: serializeRoute(route, { location }) };
}

/** The version of a file: the SHA-256 of its bytes, or null when it is not there. A symbolic
 * link is refused rather than followed. */
async function fileVersion(target) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw Object.assign(new Error('a symbolic link is refused rather than followed'), { code: CODE.DOCUMENT_UNSAFE });
  return sha256(await readFile(target));
}

/** Replace `target` with `text` if it is still at `expected` (null: still absent). */
async function replaceRouteFile(target, text, expected, { temporaryDirectory, label }) {
  let current;
  try {
    current = await fileVersion(target);
  } catch (error) {
    return [issue(error.code === CODE.DOCUMENT_UNSAFE ? CODE.DOCUMENT_UNSAFE : CODE.IO_ERROR, label, error.message)];
  }
  if (current !== expected) return [issue(CODE.CONFLICT_PRECONDITION, label, 'the route changed since it was read; re-read it and retry')];
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await replaceFileAtomically(target, text, {
      temporaryDirectory,
      beforeReplace: async () => {
        if (await fileVersion(target) !== expected) throw conflictError('the route changed while the command ran; re-read it and retry');
      },
    });
  } catch (error) {
    return [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, label, error.message)];
  }
  return [];
}

/** Remove `target` if it is still at `expected`. */
async function removeRouteFile(target, expected, label) {
  let current;
  try {
    current = await fileVersion(target);
  } catch (error) {
    return [issue(error.code === CODE.DOCUMENT_UNSAFE ? CODE.DOCUMENT_UNSAFE : CODE.IO_ERROR, label, error.message)];
  }
  if (current === null) return [issue(CODE.CONFLICT_PRECONDITION, label, 'the route is not there; re-read and retry')];
  if (current !== expected) return [issue(CODE.CONFLICT_PRECONDITION, label, 'the route changed since it was read; re-read it and retry')];
  try {
    await unlink(target);
  } catch (error) {
    return [issue(CODE.IO_ERROR, label, error.message)];
  }
  return [];
}

/**
 * Where a workspace route lives on its real path. `.derivon/routes` must stay inside the
 * workspace; a missing directory is created by the write.
 */
async function workspaceRouteTarget(context, id) {
  const placement = await classifyWorkspacePath(context.realRoot, context.root, ROUTES_DIRECTORY);
  if (placement.status !== 'inside') {
    return { issue: issue(CODE.DOCUMENT_UNSAFE, ROUTES_DIRECTORY, 'the route directory does not stay inside the workspace on its real path') };
  }
  const directory = path.join(placement.real, ...placement.missing);
  return { target: path.join(directory, routeFileName(id)), label: `${ROUTES_DIRECTORY}/${routeFileName(id)}` };
}

async function runListRoutes({ argv, context }) {
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const listed = await listRouteFiles(path.join(context.root, ROUTES_DIRECTORY), { realRoot: context.realRoot, label: ROUTES_DIRECTORY });
  const routes = [];
  for (const file of listed.files) {
    const loaded = await loadRouteFile(file.path, { location: 'workspace', fileName: file.name, manifest: context.manifest, label: file.label });
    routes.push(routeSummary(file, loaded));
  }
  /* An invalid route is a listed route with errors, not a failed listing. */
  return { result: { routes }, issues: listed.issues };
}

async function runReadRoute({ argv, context }) {
  const id = takeRouteId(argv);
  assertNoArguments(argv);
  const bad = routeIdIssue(id);
  if (bad) return { issues: [bad] };
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const placed = await workspaceRouteTarget(context, id);
  if (placed.issue) return { issues: [placed.issue] };
  const loaded = await loadRouteFile(placed.target, { location: 'workspace', manifest: context.manifest, label: placed.label });
  return {
    result: { id, file: placed.label, present: loaded.present, version: loaded.version, text: loaded.text, reading: loaded.reading },
    issues: loaded.errors,
  };
}

async function runWriteRoute({ argv, context, stdin }) {
  const expected = takeExpectedVersion(argv, { allowMissing: true });
  const id = takeRouteId(argv);
  assertNoArguments(argv);
  const bad = routeIdIssue(id);
  if (bad) return { issues: [bad] };
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const placed = await workspaceRouteTarget(context, id);
  if (placed.issue) return { issues: [placed.issue] };
  const prepared = prepareRoute(stdin, { location: 'workspace', id, manifest: context.manifest, label: placed.label });
  if (prepared.issues) return { issues: prepared.issues };
  /* The temporary sibling goes in the workspace root, as the manifest's does: the application
   * watches `.derivon`, and the root is the nearest point outside it on the same filesystem. */
  const issues = await replaceRouteFile(placed.target, prepared.text, expected, { temporaryDirectory: context.root, label: placed.label });
  if (issues.length) return { issues };
  return {
    changed: { routes: [id] },
    result: { id, file: placed.label, version: sha256(prepared.text), reading: prepared.reading },
  };
}

async function runDeleteRoute({ argv, context }) {
  const expected = takeExpectedVersion(argv, { allowMissing: false });
  const id = takeRouteId(argv);
  assertNoArguments(argv);
  const bad = routeIdIssue(id);
  if (bad) return { issues: [bad] };
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const placed = await workspaceRouteTarget(context, id);
  if (placed.issue) return { issues: [placed.issue] };
  const issues = await removeRouteFile(placed.target, expected, placed.label);
  if (issues.length) return { issues };
  return { changed: { routes: [id] }, result: { id, file: placed.label } };
}

/* --------------------------------------------------------------------------------------- */
/* Learner-record commands                                                                   */
/*                                                                                           */
/* Learner records are not workspace content. The two questions they answer — what has this   */
/* learner reached, and which routes are their own — live beside each other in the             */
/* application data directory, keyed by the workspace id, and are read and replaced            */
/* independently. The command computes that path itself: the workspace root supplies the id,   */
/* and the platform supplies the data directory.                                              */
/* --------------------------------------------------------------------------------------- */

/** The workspace id is the record's whole key on disk, and it becomes a directory name. */
function learnerRecordKey(context) {
  const id = context.manifest?.id;
  if (typeof id !== 'string' || !isUsableWorkspaceId(id)) {
    return { issue: issue(CODE.INVALID_ID, '/id', 'the manifest has no usable workspace id; learner records are keyed by it, and a workspace without one is a broken workspace') };
  }
  return { id };
}

/** The mastery record, the one fixed-name learner record file. */
const STATE_FILE = learnerRecordFile('state');

function takeDataRoot(argv) {
  const explicit = takeValue(argv, '--data-dir');
  if (explicit !== null) return { root: path.resolve(explicit) };
  const root = applicationDataRoot();
  return root === null
    ? { issue: issue(CODE.IO_ERROR, '.', 'no application data directory on this platform; pass --data-dir') }
    : { root };
}

/** The version of a record file: the SHA-256 of its bytes, or `null` when it is not there. A
 * record an unreadable-file error hides is not a missing record, so only `ENOENT` is `null`. */
async function recordVersion(target) {
  try {
    return sha256(await readFile(target));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runReadLearnerRecord({ argv, context }) {
  const file = STATE_FILE;
  const dataRoot = takeDataRoot(argv);
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const key = learnerRecordKey(context);
  if (key.issue) return { issues: [key.issue] };
  if (dataRoot.issue) return { issues: [dataRoot.issue] };
  const target = learnerRecordPath(dataRoot.root, key.id, file.name);

  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') return { issues: [issue(CODE.IO_ERROR, target, error.message)] };
    /* An absent record is an absent record: this learner has assessed nothing here, which is
     * not the same as a record that says so, and not an error. */
    return { result: { file: file.name, path: target, present: false, version: null, text: null } };
  }
  const version = sha256(bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return {
      result: { file: file.name, path: target, present: true, version, text: null },
      issues: [issue(CODE.LEARNER_RECORD_UNREADABLE, target, `not valid UTF-8: ${error.message}`)],
    };
  }
  /* The record is returned either way: a broken file is reported, never silently replaced or
   * hidden behind an empty record. */
  const parsed = parseLearnerRecord(text, file);
  return {
    result: { file: file.name, path: target, present: true, version, text },
    issues: parsed.unreadable ? [parsed.unreadable] : parsed.issues,
  };
}

async function runWriteLearnerRecord({ argv, context, stdin }) {
  const file = STATE_FILE;
  const expectedVersion = takeExpectedVersion(argv, { allowMissing: true });
  const dataRoot = takeDataRoot(argv);
  assertNoArguments(argv);
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const key = learnerRecordKey(context);
  if (key.issue) return { issues: [key.issue] };
  if (dataRoot.issue) return { issues: [dataRoot.issue] };

  if (!stdin.trim()) return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'a record document on stdin is required')] };
  let document;
  try {
    document = JSON.parse(stdin);
  } catch (error) {
    return { issues: [issue(CODE.INVALID_JSON, '.', error.message)] };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { issues: [issue(CODE.INVALID_PAYLOAD, '.', 'expected a JSON object')] };
  }
  if (document.schema !== file.schema) {
    return { issues: [issue(CODE.LEARNER_RECORD_UNREADABLE, '/schema', `expected ${file.schema}, found ${JSON.stringify(document.schema ?? null)}`)] };
  }
  /* Basis is checked in both passes: a supplied one has to be a hash to start with, and every
   * record has to have one to finish. Only a missing one is filled. */
  const shape = file.validate(document, { requireBasis: false });
  if (shape.length) return { issues: shape };
  try {
    await file.fill(document, { realRoot: context.realRoot, manifest: context.manifest });
  } catch (error) {
    if (error instanceof BasisError) return { issues: [issue(error.code, error.subject, error.message)] };
    return { issues: [issue(CODE.IO_ERROR, '.', error?.message ?? String(error))] };
  }
  const complete = file.validate(document, { requireBasis: true });
  if (complete.length) return { issues: complete };
  const text = file.serialize(document);
  const target = learnerRecordPath(dataRoot.root, key.id, file.name);

  let current;
  try {
    current = await recordVersion(target);
  } catch (error) {
    return { issues: [issue(CODE.IO_ERROR, target, error.message)] };
  }
  if (current !== expectedVersion) {
    return { issues: [issue(CODE.CONFLICT_PRECONDITION, target, 'the learner record changed since it was read; re-read it and retry')] };
  }
  try {
    await replaceFileAtomically(target, text, {
      beforeReplace: async () => {
        if (await recordVersion(target) !== expectedVersion) {
          throw conflictError('the learner record changed while the command ran; re-read it and retry');
        }
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, target, error.message)] };
  }
  return {
    changed: { learnerRecord: file.file },
    result: { file: file.name, path: target, version: sha256(text) },
  };
}

/**
 * A personal route read against the graph, plus whether its basis still matches: a stale route
 * is reported, never re-solved, rewritten or deleted here.
 */
function personalExtra(loaded, manifest) {
  const route = loaded.route;
  return { basedOn: route?.basedOn ?? null, stale: route ? route.basis !== personalRouteBasis(manifest, route) : null };
}

function personalContext(dataRoot, context) {
  const guard = requireManifest(context);
  if (guard) return { issues: [guard] };
  const key = learnerRecordKey(context);
  if (key.issue) return { issues: [key.issue] };
  if (dataRoot.issue) return { issues: [dataRoot.issue] };
  return { dataRoot: dataRoot.root, workspaceId: key.id };
}

async function runListPersonalRoutes({ argv, context }) {
  const place = personalContext(takeDataRoot(argv), context);
  assertNoArguments(argv);
  if (place.issues) return { issues: place.issues };
  const directory = personalRoutesDirectory(place.dataRoot, place.workspaceId);
  const listed = await listRouteFiles(directory);
  const routes = [];
  for (const file of listed.files) {
    const loaded = await loadRouteFile(file.path, { location: 'personal', fileName: file.name, manifest: context.manifest, label: file.label });
    routes.push(routeSummary(file, loaded, personalExtra(loaded, context.manifest)));
  }
  return { result: { directory, routes }, issues: listed.issues };
}

async function runReadPersonalRoute({ argv, context }) {
  const dataRoot = takeDataRoot(argv);
  const id = takeRouteId(argv);
  assertNoArguments(argv);
  const place = personalContext(dataRoot, context);
  const bad = routeIdIssue(id);
  if (bad) return { issues: [bad] };
  if (place.issues) return { issues: place.issues };
  const target = personalRoutePath(place.dataRoot, place.workspaceId, id);
  const loaded = await loadRouteFile(target, { location: 'personal', manifest: context.manifest, label: target });
  return {
    result: { id, path: target, present: loaded.present, version: loaded.version, text: loaded.text, stale: personalExtra(loaded, context.manifest).stale, reading: loaded.reading },
    issues: loaded.errors,
  };
}

async function runWritePersonalRoute({ argv, context, stdin }) {
  const expected = takeExpectedVersion(argv, { allowMissing: true });
  const dataRoot = takeDataRoot(argv);
  const id = takeRouteId(argv);
  assertNoArguments(argv);
  const place = personalContext(dataRoot, context);
  const bad = routeIdIssue(id);
  if (bad) return { issues: [bad] };
  if (place.issues) return { issues: place.issues };
  const target = personalRoutePath(place.dataRoot, place.workspaceId, id);
  const prepared = prepareRoute(stdin, { location: 'personal', id, manifest: context.manifest, label: target });
  if (prepared.issues) return { issues: prepared.issues };
  const issues = await replaceRouteFile(target, prepared.text, expected, { temporaryDirectory: path.dirname(target), label: target });
  if (issues.length) return { issues };
  return {
    changed: { learnerRecord: `routes/${routeFileName(id)}` },
    result: { id, path: target, version: sha256(prepared.text), reading: prepared.reading },
  };
}

async function runDeletePersonalRoute({ argv, context }) {
  const expected = takeExpectedVersion(argv, { allowMissing: false });
  const dataRoot = takeDataRoot(argv);
  const id = takeRouteId(argv);
  assertNoArguments(argv);
  const place = personalContext(dataRoot, context);
  const bad = routeIdIssue(id);
  if (bad) return { issues: [bad] };
  if (place.issues) return { issues: place.issues };
  const target = personalRoutePath(place.dataRoot, place.workspaceId, id);
  const issues = await removeRouteFile(target, expected, target);
  if (issues.length) return { issues };
  return { changed: { learnerRecord: `routes/${routeFileName(id)}` }, result: { id, path: target } };
}

/* --------------------------------------------------------------------------------------- */
/* Shared structural-command machinery                                                       */
/* --------------------------------------------------------------------------------------- */

/**
 * Add one graph object and its document. The document is written before the manifest, so a
 * failure never leaves a manifest naming a document that does not exist — the reverse (an
 * unreferenced document) is inert. A document or directory this command created is removed
 * again when the commit is refused, so a refusal is not a partial add.
 */
async function addObject(context, { id, markdown, data, object, kind }) {
  const document = data?.document;
  if (!safeRelativeDirectory(document)) {
    return { issues: [issue(CODE.DOCUMENT_UNSAFE, '/data/document', 'expected a safe workspace-relative directory')] };
  }
  const placement = await classifyWorkspacePath(context.realRoot, context.root, document);
  if (placement.status === 'unsafe' || placement.status === 'outside') {
    return { issues: [issue(CODE.DOCUMENT_UNSAFE, '/data/document', 'document path does not stay inside the workspace on its real path')] };
  }
  const directoryExists = placement.missing.length === 0;
  const documentDirectory = directoryExists ? placement.real : path.join(placement.real, ...placement.missing);
  const documentPath = path.join(documentDirectory, 'document.md');
  let documentExists = false;
  if (directoryExists) {
    try {
      const info = await lstat(documentPath);
      documentExists = info.isFile() && !info.isSymbolicLink();
    } catch {
      documentExists = false;
    }
  }
  if (documentExists && markdown !== undefined) {
    return { issues: [issue(CODE.DUPLICATE_DOCUMENT, '/data/document', `${document}/document.md already exists; use write-document to change it`)] };
  }
  if (!documentExists && markdown === undefined) {
    return { issues: [issue(CODE.DOCUMENT_MISSING, '/data/document', `${document}/document.md does not exist and no markdown was supplied`)] };
  }

  let createdDirectory = false;
  let createdDocument = false;
  if (markdown !== undefined) {
    await mkdir(documentDirectory, { recursive: true });
    createdDirectory = !directoryExists;
    await replaceFileAtomically(documentPath, markdown);
    createdDocument = true;
  }
  /* `missing[0]` is the first path segment this command created, so removing it removes the
   * whole chain the command made, not just the leaf. */
  const createdRoot = createdDirectory ? path.join(placement.real, placement.missing[0]) : null;

  const rollbackIssues = [];
  const rollback = async () => {
    try {
      if (createdRoot) await rm(createdRoot, { recursive: true, force: true });
      else if (createdDocument) await rm(documentPath, { force: true });
    } catch (error) {
      rollbackIssues.push(issue(CODE.IO_ERROR, document, `could not roll back the new document: ${error.message}`));
    }
  };

  const graph = graphOf(context.manifest);
  const candidate = {
    ...context.manifest,
    graph: kind === 'concept'
      ? { ...graph, points: [...graph.points, object] }
      : { ...graph, hyperedges: [...graph.hyperedges, object] },
  };

  const committed = await commitManifest(context, candidate, { objects: [id], documents: [document] });
  if (committed.issues?.length) {
    await rollback();
    return { ...committed, issues: [...committed.issues, ...rollbackIssues] };
  }
  return { ...committed, result: { id, document } };
}

/**
 * Validate, re-read, compare-and-swap, replace. The candidate is built in memory; the only
 * file written before the manifest is the replacement's own temporary sibling, and the
 * manifest temporary lives in the workspace root rather than in `.derivon`.
 */
async function commitManifest(context, candidate, changed) {
  const audit = await auditWorkspace({ root: context.root, manifest: candidate });
  if (audit.issues.length) return { issues: audit.issues };
  const expectedHash = context.current?.hash ?? null;
  const readLatest = async () => {
    try {
      const latest = await readManifest(context.manifestPath);
      return latest.hash;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  let latest;
  try {
    latest = await readLatest();
  } catch (error) {
    return { issues: [issue(CODE.IO_ERROR, MANIFEST_LABEL, error.message)] };
  }
  if (latest !== expectedHash) {
    return { issues: [issue(CODE.CONFLICT_PRECONDITION, MANIFEST_LABEL, 'the manifest changed while the command ran; re-read it and retry')] };
  }
  try {
    await replaceFileAtomically(context.manifestPath, `${JSON.stringify(candidate, null, 2)}\n`, {
      temporaryDirectory: context.root,
      beforeReplace: async () => {
        if (await readLatest() !== expectedHash) throw conflictError('the manifest changed while the command ran; re-read and retry');
      },
    });
  } catch (error) {
    return { issues: [issue(error.code === CODE.CONFLICT_PRECONDITION ? CODE.CONFLICT_PRECONDITION : CODE.IO_ERROR, MANIFEST_LABEL, error.message)] };
  }
  return { changed: { manifest: true, objects: [], documents: [], ...changed } };
}

/* --------------------------------------------------------------------------------------- */
/* Small helpers                                                                             */
/* --------------------------------------------------------------------------------------- */

function conflictError(message) {
  const error = new Error(message);
  error.code = CODE.CONFLICT_PRECONDITION;
  return error;
}

function assertNoArguments(argv) {
  if (argv.length) throw new UsageError(`Unexpected argument: ${argv[0]}`);
}

// derivon writes hyperedges before points. Keep whichever order the manifest already has,
// so adding one object does not rewrite the whole file.
function graphOf(manifest) {
  const graph = manifest?.graph ?? {};
  return inManifestOrder(manifest, {
    points: Array.isArray(graph.points) ? graph.points : [],
    hyperedges: Array.isArray(graph.hyperedges) ? graph.hyperedges : [],
  });
}

function inManifestOrder(manifest, { points, hyperedges }) {
  const keys = Object.keys(manifest?.graph ?? {});
  const pointsFirst = keys.includes('points') && keys.includes('hyperedges') && keys.indexOf('points') < keys.indexOf('hyperedges');
  return pointsFirst ? { points, hyperedges } : { hyperedges, points };
}

function findObject(manifest, id) {
  return [
    ...(manifest?.graph?.points ?? []),
    ...(manifest?.graph?.hyperedges ?? []),
  ].find((object) => object?.id === id) ?? null;
}

function relativeLabel(root, target) {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? target : relative;
}

/**
 * Run one bundled tool with `--json` and parse its report. A tool that crashes without a
 * report becomes one diagnostic instead of a bare stack; that is what retires the
 * `render-documents` stack trace from the surface.
 */
function runJsonTool(name, args) {
  const result = runTool(name, args);
  const text = (result.stdout ?? '').trim();
  if (text) {
    try {
      return { value: JSON.parse(text) };
    } catch {
      /* Fall through to the stderr diagnostic. */
    }
  }
  const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
  return { error: issue(CODE.IO_ERROR, '.', `${name}: ${detail}`) };
}
