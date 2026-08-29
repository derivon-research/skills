#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const names = [
  'derivon-cli',
  'derivon-mindmap',
  'derivon-book-import',
  'derivon-teaching',
  'derivon-exploration',
  'derivon-creation',
];
const issues = [];

for (const name of names) {
  const file = path.join(root, name, 'SKILL.md');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    issues.push(`${name}: missing SKILL.md`);
    continue;
  }
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) {
    issues.push(`${name}: missing YAML frontmatter`);
    continue;
  }
  if (!frontmatter[1].includes(`name: ${name}`)) issues.push(`${name}: frontmatter name mismatch`);
  if (!/^description:\s*\S+/m.test(frontmatter[1])) issues.push(`${name}: missing description`);

  for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target) continue;
    try {
      await access(path.resolve(path.dirname(file), target));
    } catch {
      issues.push(`${name}: broken relative link ${match[1]}`);
    }
  }
}

if (issues.length) {
  console.error(issues.join('\n'));
  process.exit(1);
}
console.log(`Validated ${names.length} Derivon skills.`);
