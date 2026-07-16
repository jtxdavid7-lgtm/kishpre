import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sqlPath = process.env.K2NOTE_CLOUDBASE_SQL_FILE;
const envId = process.env.K2NOTE_CLOUDBASE_ENV_ID;
const region = process.env.K2NOTE_CLOUDBASE_REGION;

if (!sqlPath || !envId || !region) {
  throw new Error('CloudBase SQL runner environment is incomplete.');
}

const cloudbaseBinDirectory = (process.env.PATH || '')
  .split(delimiter)
  .find((entry) => existsSync(resolve(entry, 'cloudbase.cmd')));

if (!cloudbaseBinDirectory) {
  throw new Error('The CloudBase CLI package was not exposed by npx.');
}

const packageDirectory = resolve(dirname(cloudbaseBinDirectory), '@cloudbase/cli');
const cliPath = resolve(packageDirectory, 'dist/standalone/cli.js');
if (!existsSync(cliPath)) {
  throw new Error('The CloudBase CLI entry point could not be located.');
}

const sql = readFileSync(sqlPath, 'utf8');
process.argv = [
  process.execPath,
  cliPath,
  'db',
  'execute',
  '-e', envId,
  '-r', region,
  '--json',
  '--sql', sql
];

await import(pathToFileURL(cliPath).href);
