/**
 * The single result envelope every command of the script command surface returns, plus the
 * stable diagnostic codes they may carry. The envelope is the whole stdout of a command: the
 * caller gets machine-readable status, the capability that was exercised, which artifact it
 * touched, what changed, a command-specific result, and every diagnostic with a code a client
 * can branch on.
 *
 * The surface governs two artifact categories — workspace content and learner records — and one
 * envelope carries both. Naming it after either one would make the name false for the other, so
 * it is named after what the two share: a command call. `--capabilities` publishes the same
 * string, so a client reads the envelope's name from the surface rather than hard-coding it.
 *
 * Exit codes are part of the contract, not of the text: 0 is a clean run, 1 is a run that
 * produced diagnostics, 2 is a usage error. A diagnostic run is not a crash — the process
 * printed an envelope and said why.
 */

import process from 'node:process';

export const RESULT_SCHEMA = 'derivon.command-result/v1';
export const CAPABILITIES_SCHEMA = 'derivon.command-capabilities/v1';

/** The two artifact categories the surface writes and reads. A learner record is not workspace
 * content: it lives in the application data directory, keyed by the workspace id, and never
 * enters a manifest, a commit or its revision. */
export const ARTIFACTS = [
  { name: 'workspace', summary: "Workspace content: the manifest, its graph objects and the documents they own. Changed only through this surface, by derivon-mindmap's ADR-0011." },
  { name: 'learner-records', summary: 'Learner records: mastery and confirmed routes, stored outside the workspace in the application data directory, keyed by the workspace id.' },
];

export const EXIT = { OK: 0, DIAGNOSTICS: 1, USAGE: 2 };

/**
 * Stable diagnostic codes. A code names the kind of failure; the message keeps the detail.
 * Codes are shared vocabulary between the workspace validator, the bundled tools and the
 * command surface, so a client never has to parse prose.
 */
export const CODE = {
  USAGE: 'usage',
  IO_ERROR: 'io-error',
  INVALID_JSON: 'invalid-json',
  INVALID_PAYLOAD: 'invalid-payload',
  SCHEMA_UNKNOWN: 'schema-unknown',
  SCHEMA_INVALID: 'schema-invalid',
  INVALID_ID: 'invalid-id',
  DUPLICATE_ID: 'duplicate-id',
  DUPLICATE_TAG: 'duplicate-tag',
  DUPLICATE_DOCUMENT: 'duplicate-document',
  DOCUMENT_UNSAFE: 'document-unsafe',
  DOCUMENT_MISSING: 'document-missing',
  UNKNOWN_OBJECT: 'unknown-object',
  GRAPH_INVALID: 'graph-invalid',
  EXTERNAL_TOOL: 'external-tool',
  CONFLICT_PRECONDITION: 'conflict-precondition',
  OUTPUT_EXISTS: 'output-exists',
  ROUTE_UNREACHABLE: 'route-unreachable',
  ROUTE_NOT_OPTIMAL: 'route-not-optimal',
  CROSSLINK_CONFLICT: 'conflicting-link',
  CROSSLINK_AMBIGUOUS: 'ambiguous-label',
  CROSSLINK_MISSING_SOURCE: 'missing-source',
  CROSSLINK_PARSE_ERROR: 'parse-error',
  CROSSLINK_MISSING: 'crosslink-missing',
  MEDIA_INVALID: 'media-invalid',
  LEARNER_RECORD_UNREADABLE: 'learner-record-unreadable',
  LEARNER_RECORD_INVALID: 'learner-record-invalid',
  BASIS_UNCOMPUTABLE: 'basis-uncomputable',
};

/** One diagnostic. `path` is a workspace-relative path or JSON pointer; `.` means the workspace. */
export function issue(code, path, message) {
  return { code, path: path || '.', message: String(message) };
}

/** Build the one result envelope. `artifact` is the category the command belongs to, so a
 * client can gate a tool set on "may this session touch learner records" without parsing the
 * capability's name. */
export function envelope({ command, capability, artifact, status, changed, result = null, issues = [] }) {
  return {
    schema: RESULT_SCHEMA,
    command,
    status: status ?? (issues.length ? 'diagnostics' : 'ok'),
    capability,
    artifact,
    changed: { manifest: false, objects: [], documents: [], learnerRecord: null, ...changed },
    result,
    issues,
  };
}

/** Print an envelope to stdout. `--pretty` only changes indentation. The write is synchronous
 * so an immediately following exit cannot truncate the envelope. */
export function emit(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}
