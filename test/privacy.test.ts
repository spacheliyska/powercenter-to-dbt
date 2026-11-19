/**
 * The repository is public. No email address and no path from the author's machine may end up
 * in it, for example through an exported agent conversation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const SKIPPED = new Set(['node_modules', '.git']);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** GitHub's no-reply addresses exist to be published. */
const PUBLISHABLE_EMAIL = /@users\.noreply\.github\.com$|^noreply@anthropic\.com$/;
/** A "Users" or "home" directory in any notation: Windows, Git Bash, file URLs or Unix. */
const HOME_DIRECTORY = /[\\/](?:Users|home)[\\/]/i;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

it('contains no email addresses or home-directory paths', () => {
  const leaks = files('.').flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    const emails = [...text.matchAll(EMAIL)].map((match) => match[0]).filter((email) => !PUBLISHABLE_EMAIL.test(email));
    const paths = HOME_DIRECTORY.test(text) ? ['a home-directory path'] : [];
    return [...emails, ...paths].map((leak) => `${path}: ${leak}`);
  });
  expect(leaks).toEqual([]);
});
