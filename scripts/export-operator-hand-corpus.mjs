import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';

const DEFAULT_OUTPUT_ROOT = resolve(
  'D:/K2note玩家池牌谱库',
);
const PAGE_SIZE = 500;
const HANDS_PER_FILE = 2_000;
const MAX_CLI_OUTPUT_BYTES = 64 * 1024 * 1024;

function readEnvFile(path) {
  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function formatSnapshotName(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}_${part('hour')}-${part('minute')}-${part('second')}`;
}

function parseArgs(argv) {
  const options = { outputRoot: DEFAULT_OUTPUT_ROOT, sync: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--sync') {
      options.sync = true;
      continue;
    }
    if (argv[index] === '--output') {
      const next = argv[index + 1];
      if (!next) throw new Error('--output requires a directory path.');
      options.outputRoot = resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function readSnapshots(outputRoot) {
  if (!existsSync(outputRoot)) return [];
  return readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^导出-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => {
      const directory = resolve(outputRoot, entry.name);
      const manifestPath = resolve(directory, 'manifest.json');
      if (!existsSync(manifestPath)) return null;
      try {
        return {
          directory,
          manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.manifest.exportedAt.localeCompare(left.manifest.exportedAt));
}

function summaryMatchesManifest(summary, manifest) {
  if (
    Number(summary.unique_hands) !== Number(manifest.uniqueHands)
    || Number(summary.raw_bytes) !== Number(manifest.rawHandBytes)
  ) return false;
  if (manifest.corpusSha256) return manifest.corpusSha256 === summary.corpus_sha256;
  return (manifest.firstSavedAt || null) === (summary.first_saved_at || null)
    && (manifest.lastSavedAt || null) === (summary.last_saved_at || null);
}

function removeSupersededSnapshot(outputRoot, snapshotDirectory) {
  const resolvedRoot = resolve(outputRoot);
  const resolvedSnapshot = resolve(snapshotDirectory);
  if (
    dirname(resolvedSnapshot) !== resolvedRoot
    || !/^导出-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(basename(resolvedSnapshot))
  ) {
    throw new Error(`Refusing to remove unexpected snapshot path: ${resolvedSnapshot}`);
  }
  rmSync(resolvedSnapshot, { recursive: true, force: false });
}

function parseCloudBaseJson(output) {
  const match = output.match(/\{[\s\S]*\}\s*$/);
  if (!match) throw new Error(`CloudBase CLI did not return JSON: ${output.slice(-500)}`);
  const response = JSON.parse(match[0]);
  if (!response?.data?.Rows || !response?.data?.Columns) {
    throw new Error(`Unexpected CloudBase SQL response: ${match[0].slice(0, 500)}`);
  }
  return response.data;
}

function createSqlRunner({ envId, region }) {
  const npxCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
  return (sql) => {
    const sqlPath = resolve(tmpdir(), `k2note-corpus-export-${randomUUID()}.sql`);
    writeFileSync(sqlPath, sql, 'utf8');
    try {
      const result = spawnSync(process.execPath, [
        npxCli,
        '--yes',
        '--package', '@cloudbase/cli@3.6.2',
        '--call', 'node scripts/run-cloudbase-sql.mjs',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
        env: {
          ...process.env,
          K2NOTE_CLOUDBASE_SQL_FILE: sqlPath,
          K2NOTE_CLOUDBASE_ENV_ID: envId,
          K2NOTE_CLOUDBASE_REGION: region,
        },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`CloudBase SQL export failed: ${result.stderr || result.stdout}`);
      }
      return parseCloudBaseJson(result.stdout);
    } finally {
      unlinkSync(sqlPath);
    }
  };
}

function parseRows(data) {
  return data.Rows.map((row) => {
    const values = JSON.parse(row);
    return Object.fromEntries(data.Columns.map((column, index) => [column, values[index]]));
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function main() {
  const { outputRoot, sync } = parseArgs(process.argv.slice(2));
  const env = readEnvFile(resolve('.env.local'));
  const envId = env.get('VITE_CLOUDBASE_ENV_ID');
  const region = env.get('VITE_CLOUDBASE_REGION');
  if (!envId || !region) throw new Error('CloudBase environment id or region is missing.');

  const runSql = createSqlRunner({ envId, region });
  const summaryRows = parseRows(runSql(`
    SELECT
      count(*)::bigint AS unique_hands,
      COALESCE(sum(raw_bytes), 0)::bigint AS raw_bytes,
      min(created_at) AS first_saved_at,
      max(created_at) AS last_saved_at,
      encode(
        sha256(convert_to(COALESCE(string_agg(content_sha256, '' ORDER BY content_sha256), ''), 'UTF8')),
        'hex'
      ) AS corpus_sha256
    FROM public.operator_hand_corpus
  `));
  const summary = summaryRows[0];
  const expectedHands = Number(summary.unique_hands);
  const expectedBytes = Number(summary.raw_bytes);

  mkdirSync(outputRoot, { recursive: true });
  const previousSnapshots = readSnapshots(outputRoot);
  if (sync && previousSnapshots.some(({ manifest }) => summaryMatchesManifest(summary, manifest))) {
    console.log(JSON.stringify({
      status: 'unchanged',
      snapshotDirectory: previousSnapshots[0]?.directory || null,
      uniqueHands: expectedHands,
      rawHandBytes: expectedBytes,
      checkedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }

  const snapshotName = formatSnapshotName(new Date());
  const snapshotDirectory = resolve(outputRoot, `导出-${snapshotName}`);
  if (existsSync(snapshotDirectory)) {
    throw new Error(`Export directory already exists: ${snapshotDirectory}`);
  }
  mkdirSync(snapshotDirectory, { recursive: false });

  const seenHashes = new Set();
  const files = [];
  let cursor = '';
  let rawBytes = 0;
  let fileHands = [];
  let fileFirstIndex = 1;

  const flushFile = () => {
    if (!fileHands.length) return;
    const lastIndex = seenHashes.size;
    const fileName = `player-pool-${String(fileFirstIndex).padStart(6, '0')}-${String(lastIndex).padStart(6, '0')}.txt`;
    const contents = `${fileHands.join('\r\n\r\n')}\r\n`;
    writeFileSync(resolve(snapshotDirectory, fileName), contents, 'utf8');
    files.push({
      file: fileName,
      hands: fileHands.length,
      bytes: Buffer.byteLength(contents, 'utf8'),
      sha256: sha256(contents),
    });
    fileHands = [];
    fileFirstIndex = lastIndex + 1;
  };

  try {
    while (true) {
      const cursorWhere = cursor ? `WHERE content_sha256 > '${cursor}'` : '';
      const data = runSql(`
        SELECT
          content_sha256,
          external_hand_id,
          raw_bytes::bigint AS raw_bytes,
          encode(convert_to(raw_text, 'UTF8'), 'base64') AS raw_text_base64
        FROM public.operator_hand_corpus
        ${cursorWhere}
        ORDER BY content_sha256
        LIMIT ${PAGE_SIZE}
      `);
      const rows = parseRows(data);
      if (!rows.length) break;

      for (const row of rows) {
        const rawText = Buffer.from(row.raw_text_base64.replace(/\s/g, ''), 'base64').toString('utf8');
        const computedHash = sha256(rawText);
        if (computedHash !== row.content_sha256) {
          throw new Error(`SHA-256 mismatch for hand ${row.external_hand_id}.`);
        }
        const bytes = Buffer.byteLength(rawText, 'utf8');
        if (bytes !== Number(row.raw_bytes)) {
          throw new Error(`Byte count mismatch for hand ${row.external_hand_id}.`);
        }
        if (seenHashes.has(computedHash)) {
          throw new Error(`Duplicate corpus hand encountered: ${computedHash}.`);
        }
        seenHashes.add(computedHash);
        rawBytes += bytes;
        fileHands.push(rawText);
        if (fileHands.length >= HANDS_PER_FILE) flushFile();
      }
      cursor = rows.at(-1).content_sha256;
      process.stdout.write(`\rDownloaded and verified ${seenHashes.size}/${expectedHands} unique hands`);
      if (rows.length < PAGE_SIZE) break;
    }
    flushFile();
    process.stdout.write('\n');

    if (seenHashes.size !== expectedHands || rawBytes !== expectedBytes) {
      throw new Error(
        `Cloud snapshot changed during export (expected ${expectedHands}/${expectedBytes}, got ${seenHashes.size}/${rawBytes}). Run the export again.`,
      );
    }

    const manifest = {
      formatVersion: 1,
      source: 'CloudBase SQL public.operator_hand_corpus',
      exportedAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
      uniqueHands: seenHashes.size,
      rawHandBytes: rawBytes,
      deduplication: 'SHA-256 of the exact UTF-8 raw hand text',
      includesUserIdentity: false,
      includesUploadMetadata: false,
      firstSavedAt: summary.first_saved_at || null,
      lastSavedAt: summary.last_saved_at || null,
      corpusSha256: summary.corpus_sha256,
      files,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const readmeText = [
      '# K2note 玩家池牌谱库',
      '',
      `- 导出时间：${manifest.exportedAt}`,
      `- 全局去重牌谱：${manifest.uniqueHands.toLocaleString('zh-CN')} 手`,
      `- 原始文本字节：${manifest.rawHandBytes.toLocaleString('zh-CN')}`,
      '- 去重方式：对每手 UTF-8 原始牌谱计算 SHA-256。',
      '- 隐私范围：不包含贡献者身份、手机号、Google 账号、设备标识或上传批次。',
      '',
      '## 使用',
      '',
      '将 `player-pool-*.txt` 文件作为 GG 原始牌谱导入分析工具即可。',
      '',
      '## 数据治理提醒',
      '',
      '这是一份时点快照。若用户之后撤回贡献或申请删除，需重新导出并废弃旧快照，以保持本地牌谱库与云端当前合法数据集一致。请勿向无关第三方分发。',
      '',
    ].join('\r\n');
    writeFileSync(resolve(snapshotDirectory, 'manifest.json'), manifestText, 'utf8');
    writeFileSync(resolve(snapshotDirectory, 'README.md'), readmeText, 'utf8');

    const zip = new JSZip();
    for (const { file } of files) {
      zip.file(file, readFileSync(resolve(snapshotDirectory, file)));
    }
    zip.file('manifest.json', manifestText);
    zip.file('README.md', readmeText);
    const zipBytes = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const zipPath = resolve(snapshotDirectory, `K2note-玩家池牌谱库-${snapshotName}.zip`);
    writeFileSync(zipPath, zipBytes);

    if (sync) {
      for (const previous of previousSnapshots) {
        if (previous.directory !== snapshotDirectory) {
          removeSupersededSnapshot(outputRoot, previous.directory);
        }
      }
    }

    console.log(JSON.stringify({
      status: sync ? 'updated' : 'exported',
      snapshotDirectory,
      zipPath,
      uniqueHands: seenHashes.size,
      rawHandBytes: rawBytes,
      archiveBytes: zipBytes.length,
      files: files.length,
    }, null, 2));
  } catch (error) {
    rmSync(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
}

await main();
