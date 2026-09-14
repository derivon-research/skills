#!/usr/bin/env node

/**
 * `derivon-workspace.mjs` — the one entry point for changing and auditing a Mindmap workspace.
 *
 * Usage: derivon-workspace.mjs <command> <workspace> [flags]
 *        derivon-workspace.mjs --capabilities
 *
 * Every call returns one `derivon.command-result/v1` envelope on stdout. Exit code 0 means a
 * clean run, 1 means the run produced diagnostics (never an uncaught crash), and 2 means the
 * caller used the surface wrongly. `--capabilities` is generated from the same table the
 * dispatcher uses, so it cannot drift from what the surface actually runs, and it is also where
 * the envelope's own schema and exit codes are published.
 *
 * The surface governs two artifact categories — workspace content and learner records — and
 * every command declares which one it belongs to. Learner records live outside the workspace in
 * the application data directory, keyed by the workspace id; their commands compute that path
 * themselves.
 *
 * The process never calls `process.exit` after writing the envelope: stdout is a stream, and an
 * immediate exit can truncate it. It sets `process.exitCode` and lets the process drain.
 */

import process from 'node:process';
import { COMMANDS, UsageError, findCommand, loadContext, readStdin } from './lib/commands.mjs';
import { ARTIFACTS, CAPABILITIES_SCHEMA, CODE, EXIT, RESULT_SCHEMA, emit, envelope, issue } from './lib/envelope.mjs';

const argv = process.argv.slice(2);
const pretty = takeFlag(argv, '--pretty');

if (takeFlag(argv, '--capabilities')) {
  emit(capabilities(), pretty);
} else if (takeFlag(argv, '--help') || takeFlag(argv, '-h')) {
  printHelp();
} else {
  const name = argv.shift();
  if (!name) usage(name, 'a command name is required; run --help for the list');
  else if (!findCommand(name)) usage(name, `unknown command: ${name}`);
  else if (!argv[0]) usage(name, `${name} requires a workspace root`);
  else await dispatch(name, argv.shift());
}

async function dispatch(name, workspaceArg) {
  const command = findCommand(name);
  let context;
  try {
    context = await loadContext(workspaceArg);
  } catch (error) {
    emit(envelope({ command: name, capability: command.capability, artifact: command.artifact, issues: [issue(CODE.IO_ERROR, '.derivon/workspace.json', error.message)] }), pretty);
    process.exitCode = EXIT.DIAGNOSTICS;
    return;
  }
  try {
    const stdin = command.stdin?.required ? await readStdin() : '';
    const result = await command.run({ argv, context, stdin });
    const issues = result.issues ?? [];
    emit(envelope({
      command: name,
      capability: command.capability,
      artifact: command.artifact,
      changed: result.changed,
      result: result.result ?? null,
      issues,
    }), pretty);
    process.exitCode = issues.length ? EXIT.DIAGNOSTICS : EXIT.OK;
  } catch (error) {
    if (error instanceof UsageError) {
      usage(name, error.message);
      return;
    }
    /* An unexpected failure still leaves through the envelope, never as a bare stack. */
    emit(envelope({
      command: name,
      capability: command.capability,
      artifact: command.artifact,
      issues: [issue(CODE.IO_ERROR, '.', error?.message ?? String(error))],
    }), pretty);
    process.exitCode = EXIT.DIAGNOSTICS;
  }
}

function usage(name, message) {
  const command = name ? findCommand(name) : null;
  emit(envelope({
    command: name ?? null,
    capability: command?.capability ?? null,
    artifact: command?.artifact ?? null,
    status: 'diagnostics',
    issues: [issue(CODE.USAGE, '.', message)],
  }), pretty);
  process.exitCode = EXIT.USAGE;
}

/**
 * The one capability document a client reads: what exists, which artifact each command belongs
 * to, what each command's argv, stdin and result are, and which envelope and exit codes every
 * call answers with. It is generated from the command table, so it cannot list a command the
 * surface does not run.
 */
function capabilities() {
  return {
    schema: CAPABILITIES_SCHEMA,
    result: {
      schema: RESULT_SCHEMA,
      exitCodes: { ok: EXIT.OK, diagnostics: EXIT.DIAGNOSTICS, usage: EXIT.USAGE },
      fields: [
        { name: 'schema', description: 'The envelope schema, equal to result.schema.' },
        { name: 'command', description: 'The command that ran, or null for a usage error before dispatch.' },
        { name: 'status', description: 'ok, or diagnostics when issues is non-empty.' },
        { name: 'capability', description: 'The capability the command exercised.' },
        { name: 'artifact', description: 'Which artifact category the command belongs to.' },
        { name: 'changed', description: 'What the call changed: manifest, objects, documents, learnerRecord.' },
        { name: 'result', description: 'The command-specific result, or null.' },
        { name: 'issues', description: 'Diagnostics with a stable code, a path and a message.' },
      ],
    },
    artifacts: ARTIFACTS,
    commands: [...COMMANDS]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, artifact, capability, summary, argv, stdin, result }) => ({ name, artifact, capability, summary, argv, stdin, result })),
  };
}

function printHelp() {
  console.log('Usage: derivon-workspace.mjs <command> <workspace> [flags]');
  console.log('       derivon-workspace.mjs --capabilities');
  console.log('');
  for (const { name, artifact, capability, summary } of COMMANDS) {
    console.log(`  ${name.padEnd(21)} ${artifact.padEnd(16)} ${capability.padEnd(22)} ${summary}`);
  }
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}
