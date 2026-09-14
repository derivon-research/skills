/**
 * The single result envelope every command of the script command surface returns, plus the
 * stable diagnostic codes they may carry. The envelope is the whole stdout of a command: the
 * caller gets machine-readable status, the capability that was exercised, what changed, a
 * command-specific result, and every diagnostic with a code a client can branch on.
 *
 * Exit codes are part of the contract, not of the text: 0 is a clean run, 1 is a run that
 * produced diagnostics, 2 is a usage error. A diagnostic run is not a crash — the process
 * printed an envelope and said why.
 */

import process from 'node:process';

export const RESULT_SCHEMA = 'derivon.workspace-result/v1';
export const CAPABILITIES_SCHEMA = 'derivon.command-capabilities/v1';

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
};

/** One diagnostic. `path` is a workspace-relative path or JSON pointer; `.` means the workspace. */
export function issue(code, path, message) {
  return { code, path: path || '.', message: String(message) };
}

/** Build the one result envelope. */
export function envelope({ command, capability, status, changed, result = null, issues = [] }) {
  return {
    schema: RESULT_SCHEMA,
    command,
    status: status ?? (issues.length ? 'diagnostics' : 'ok'),
    capability,
    changed: { manifest: false, objects: [], documents: [], ...changed },
    result,
    issues,
  };
}

/** Print an envelope to stdout. `--pretty` only changes indentation. The write is synchronous
 * so an immediately following exit cannot truncate the envelope. */
export function emit(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}
