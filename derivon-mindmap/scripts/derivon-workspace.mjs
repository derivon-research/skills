#!/usr/bin/env node

/**
 * `derivon-workspace.mjs` — the one entry point for changing and auditing a Mindmap workspace.
 *
 * Usage: derivon-workspace.mjs <command> <workspace> [flags]
 *        derivon-workspace.mjs --capabilities
 *
 * Every call returns one `derivon.workspace-result/v1` envelope on stdout. Exit code 0 means a
 * clean run, 1 means the run produced diagnostics (never an uncaught crash), and 2 means the
 * caller used the surface wrongly. `--capabilities` is generated from the same table the
 * dispatcher uses, so it cannot drift from what the surface actually runs.
 *
 * The process never calls `process.exit` after writing the envelope: stdout is a stream, and an
 * immediate exit can truncate it. It sets `process.exitCode` and lets the process drain.
 */

import process from 'node:process';
import { COMMANDS, UsageError, findCommand, loadContext, readStdin } from './lib/commands.mjs';
import { CAPABILITIES_SCHEMA, CODE, EXIT, emit, envelope, issue } from './lib/envelope.mjs';

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
    emit(envelope({ command: name, capability: command.capability, issues: [issue(CODE.IO_ERROR, '.derivon/workspace.json', error.message)] }), pretty);
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
      issues: [issue(CODE.IO_ERROR, '.', error?.message ?? String(error))],
    }), pretty);
    process.exitCode = EXIT.DIAGNOSTICS;
  }
}

function usage(name, message) {
  emit(envelope({
    command: name ?? null,
    capability: name ? findCommand(name)?.capability ?? null : null,
    status: 'diagnostics',
    issues: [issue(CODE.USAGE, '.', message)],
  }), pretty);
  process.exitCode = EXIT.USAGE;
}

function capabilities() {
  return {
    schema: CAPABILITIES_SCHEMA,
    commands: [...COMMANDS]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, capability, summary, argv, stdin, result }) => ({ name, capability, summary, argv, stdin, result })),
  };
}

function printHelp() {
  console.log('Usage: derivon-workspace.mjs <command> <workspace> [flags]');
  console.log('       derivon-workspace.mjs --capabilities');
  console.log('');
  for (const { name, capability, summary } of COMMANDS) {
    console.log(`  ${name.padEnd(18)} ${capability.padEnd(16)} ${summary}`);
  }
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}
