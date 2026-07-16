import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function readEnvFile(path) {
  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let dollarTag = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '$') {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        dollarTag = tag;
        current += tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quote || dollarTag) throw new Error('Migration contains an unterminated SQL quote.');
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function compactMigration(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');
const migrationPath = resolve('cloudbase/migrations/005_operator_hand_archive.sql');
const envPath = resolve('.env.local');
const env = readEnvFile(envPath);
const envId = env.get('VITE_CLOUDBASE_ENV_ID');
const region = env.get('VITE_CLOUDBASE_REGION');
if (!envId || !region) throw new Error('CloudBase environment id or region is missing.');

const compacted = compactMigration(readFileSync(migrationPath, 'utf8'));
const statements = splitSqlStatements(compacted)
  .filter((statement) => !/^(BEGIN|COMMIT)$/i.test(statement));
const stageTable = 'public.k2note_migration_stage_005';
const insertRows = statements.map((statement, index) => (
  `(${index},$statement_${index}$${statement}$statement_${index}$)`
));
const insertGroups = [];
let currentGroup = [];
for (const row of insertRows) {
  const candidate = [...currentGroup, row];
  const command = `INSERT INTO ${stageTable} (sequence, sql_text) VALUES ${candidate.join(',')}`;
  if (command.length > 24_000 && currentGroup.length) {
    insertGroups.push(currentGroup);
    currentGroup = [row];
  } else {
    currentGroup = candidate;
  }
}
if (currentGroup.length) insertGroups.push(currentGroup);
const largestCommandLength = Math.max(
  ...insertGroups.map((group) => (
    `INSERT INTO ${stageTable} (sequence, sql_text) VALUES ${group.join(',')}`
  ).length)
);

console.log(JSON.stringify({
  migration: migrationPath,
  statementCount: statements.length,
  stageInsertGroups: insertGroups.length,
  largestCommandLength,
  mode: shouldApply ? 'apply' : 'dry-run'
}, null, 2));

if (!shouldApply) process.exit(0);

function runSql(sql, label) {
  console.log(`\n[CloudBase migration] ${label}`);
  const npxCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
  const sqlPath = resolve(tmpdir(), `k2note-cloudbase-${randomUUID()}.sql`);
  writeFileSync(sqlPath, sql, 'utf8');
  let result;
  try {
    result = spawnSync(process.execPath, [
      npxCli,
      '--yes',
      '--package', '@cloudbase/cli@3.6.2',
      '--call', 'node scripts/run-cloudbase-sql.mjs'
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        K2NOTE_CLOUDBASE_SQL_FILE: sqlPath,
        K2NOTE_CLOUDBASE_ENV_ID: envId,
        K2NOTE_CLOUDBASE_REGION: region
      }
    });
  } finally {
    unlinkSync(sqlPath);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

runSql(`DROP TABLE IF EXISTS ${stageTable}`, 'clear old staging table');
runSql(
  `CREATE UNLOGGED TABLE ${stageTable} (sequence integer PRIMARY KEY, sql_text text NOT NULL)`,
  'create private migration staging table'
);
runSql(
  `REVOKE ALL ON TABLE ${stageTable} FROM PUBLIC, anon, authenticated`,
  'lock migration staging table'
);
insertGroups.forEach((group, index) => runSql(
  `INSERT INTO ${stageTable} (sequence, sql_text) VALUES ${group.join(',')}`,
  `stage migration SQL ${index + 1}/${insertGroups.length}`
));
runSql(
  `DO $migration$ DECLARE item record; BEGIN FOR item IN SELECT sql_text FROM ${stageTable} ORDER BY sequence LOOP EXECUTE item.sql_text; END LOOP; END $migration$`,
  'apply migration atomically'
);
runSql(`DROP TABLE ${stageTable}`, 'remove migration staging table');
