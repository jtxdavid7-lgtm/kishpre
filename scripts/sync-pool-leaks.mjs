import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const DEFAULT_SOURCE_DIRECTORY = process.env.POOL_LEAK_SOURCE
  ? resolve(process.env.POOL_LEAK_SOURCE)
  : resolve(
      PROJECT_ROOT,
      '..',
      '..',
      'gg_bot_project',
      'reports',
      'real_pool_vulnerability_explorer_v2',
    );
const OUTPUT_DIRECTORY = resolve(
  PROJECT_ROOT,
  'public/data/pool-leaks/v1',
);

const SCHEMA_VERSION = 1;
const EXPLORER_FILE = 'explorer_data.js';
const BOARD_FILE = 'flop_board_data.js';
const ROW_FIELDS = Object.freeze([
  'b', 'l', 'p', 's', 'r', 'a', 'c', 'h', 'z', 'zl',
  'n', 'f', 'ca', 'ra', 'd', 'm', 'g', 'lo', 'hi',
  'avg', 'min', 'max', 'pot', 'risk', 'call',
]);
const STRING_FIELDS = new Set(ROW_FIELDS.slice(0, 10));
const RATE_FIELDS = new Set(['f', 'ca', 'ra', 'd', 'm', 'lo', 'hi']);

function parseArguments(argv) {
  let sourceDirectory = DEFAULT_SOURCE_DIRECTORY;
  let positionalSourceSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') {
      const value = argv[index + 1];
      if (!value) throw new Error('--source 后需要提供源目录。');
      sourceDirectory = resolve(value);
      positionalSourceSeen = true;
      index += 1;
      continue;
    }
    if (argument.startsWith('--source=')) {
      const value = argument.slice('--source='.length);
      if (!value) throw new Error('--source 后需要提供源目录。');
      sourceDirectory = resolve(value);
      positionalSourceSeen = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      console.log('用法: node scripts/sync-pool-leaks.mjs [--source <报告目录>]');
      console.log('也可通过 POOL_LEAK_SOURCE 环境变量指定报告目录。');
      process.exit(0);
    }
    if (argument.startsWith('-')) throw new Error(`未知参数: ${argument}`);
    if (positionalSourceSeen) throw new Error('只能提供一个源目录。');
    sourceDirectory = resolve(argument);
    positionalSourceSeen = true;
  }

  return { sourceDirectory };
}

function extractJsonAssignment(source, globalName) {
  const marker = `window.${globalName}=`;
  const assignmentStart = source.indexOf(marker);
  if (assignmentStart < 0) throw new Error(`缺少数据段 ${globalName}。`);
  if (source.indexOf(marker, assignmentStart + marker.length) >= 0) {
    throw new Error(`数据段 ${globalName} 重复。`);
  }

  let start = assignmentStart + marker.length;
  while (/\s/.test(source[start] || '')) start += 1;
  if (source[start] !== '[' && source[start] !== '{') {
    throw new Error(`数据段 ${globalName} 不是 JSON 数组或对象。`);
  }

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[' || character === '{') {
      stack.push(character);
      continue;
    }
    if (character === ']' || character === '}') {
      const expected = character === ']' ? '[' : '{';
      if (stack.pop() !== expected) throw new Error(`数据段 ${globalName} 结构损坏。`);
      if (stack.length === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          throw new Error(`数据段 ${globalName} 不是有效 JSON。`);
        }
      }
    }
  }
  throw new Error(`数据段 ${globalName} 不完整。`);
}

function requireFiniteNumber(value, field, rowIndex, datasetName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的 ${field} 不是有限数字。`);
  }
}

function validateAndSanitizeRows(rows, datasetName, expectedRows, boardClasses) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${datasetName} 没有可用数据。`);
  }
  if (!Number.isInteger(expectedRows) || rows.length !== expectedRows) {
    throw new Error(`${datasetName} 行数不符：读取 ${rows.length}，应为 ${expectedRows}。`);
  }

  return rows.map((row, rowIndex) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行不是对象。`);
    }
    const sanitized = {};
    for (const field of ROW_FIELDS) {
      if (!Object.hasOwn(row, field)) {
        throw new Error(`${datasetName} 第 ${rowIndex + 1} 行缺少 ${field}。`);
      }
      const value = row[field];
      if (STRING_FIELDS.has(field)) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的 ${field} 不是有效文本。`);
        }
      } else {
        requireFiniteNumber(value, field, rowIndex, datasetName);
      }
      sanitized[field] = value;
    }

    if (!Number.isInteger(sanitized.n) || sanitized.n <= 0) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行样本数无效。`);
    }
    for (const field of RATE_FIELDS) {
      if (sanitized[field] < 0 || sanitized[field] > 1) {
        throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的 ${field} 超出 0–1。`);
      }
    }
    if (sanitized.lo > sanitized.d || sanitized.d > sanitized.hi) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的置信区间无效。`);
    }
    if (Math.abs((sanitized.f + sanitized.ca + sanitized.ra) - 1) > 0.00002) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的行动频率不闭合。`);
    }
    if (Math.abs((sanitized.ca + sanitized.ra) - sanitized.d) > 0.00002) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的防守率不闭合。`);
    }
    if (Math.abs((sanitized.d - sanitized.m) - sanitized.g) > 0.00002) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的 MDF Gap 不闭合。`);
    }
    if (sanitized.min < 0 || sanitized.max < sanitized.min) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的尺寸范围无效。`);
    }
    if (sanitized.pot < 0 || sanitized.risk < 0 || sanitized.call < 0) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行的金额口径无效。`);
    }
    if (boardClasses && !boardClasses.has(sanitized.b)) {
      throw new Error(`${datasetName} 第 ${rowIndex + 1} 行使用了未知牌面类。`);
    }
    return sanitized;
  });
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`汇总字段 ${field} 无效。`);
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`汇总字段 ${field} 无效。`);
  return value;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function serializeCompact(value) {
  return `${JSON.stringify(value)}\n`;
}

function writeAtomically(path, contents) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, contents, 'utf8');
  rmSync(path, { force: true });
  renameSync(temporaryPath, path);
}

function sanitizeSizeBuckets(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error('下注尺寸定义缺失。');
  }
  return definitions.map((definition) => {
    if (
      !definition
      || typeof definition.key !== 'string'
      || typeof definition.label !== 'string'
    ) throw new Error('下注尺寸定义无效。');
    const bucket = { key: definition.key, label: definition.label };
    if (Object.hasOwn(definition, 'upper_inclusive')) {
      const upper = definition.upper_inclusive;
      if (upper !== null && (typeof upper !== 'number' || !Number.isFinite(upper))) {
        throw new Error('下注尺寸上限无效。');
      }
      bucket.upperInclusive = upper;
    }
    return bucket;
  });
}

function main() {
  const { sourceDirectory } = parseArguments(process.argv.slice(2));
  const explorerPath = resolve(sourceDirectory, EXPLORER_FILE);
  const boardPath = resolve(sourceDirectory, BOARD_FILE);
  if (!existsSync(explorerPath) || !existsSync(boardPath)) {
    throw new Error(`源目录必须同时包含 ${EXPLORER_FILE} 和 ${BOARD_FILE}。`);
  }

  const explorerSource = readFileSync(explorerPath, 'utf8');
  const boardSource = readFileSync(boardPath, 'utf8');
  const rawExplorerRows = extractJsonAssignment(explorerSource, 'REAL_POOL_ROWS');
  const rawMetadata = extractJsonAssignment(explorerSource, 'REAL_POOL_META');
  const rawBoardRows = extractJsonAssignment(boardSource, 'REAL_POOL_FLOP_BOARD_ROWS');
  const rawBoardNames = extractJsonAssignment(boardSource, 'REAL_POOL_BOARD_NAMES');
  const rawBoardClasses = extractJsonAssignment(boardSource, 'REAL_POOL_BOARD_CLASSES');

  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) {
    throw new Error('报告元数据无效。');
  }
  if (typeof rawMetadata.version !== 'string' || typeof rawMetadata.created_at !== 'string') {
    throw new Error('报告版本或生成时间缺失。');
  }
  if (!Array.isArray(rawBoardClasses) || rawBoardClasses.length !== 35) {
    throw new Error('Flop 牌面分类必须恰好包含 35 类。');
  }
  if (new Set(rawBoardClasses).size !== rawBoardClasses.length) {
    throw new Error('Flop 牌面分类存在重复。');
  }
  if (!rawBoardNames || typeof rawBoardNames !== 'object' || Array.isArray(rawBoardNames)) {
    throw new Error('Flop 牌面中文名无效。');
  }

  const observedBoardClasses = new Set(
    rawMetadata.flop_board_filter?.board_class_labels_observed || [],
  );
  const boardClassSet = new Set(rawBoardClasses);
  const boardClasses = rawBoardClasses.map((key) => {
    const label = rawBoardNames[key];
    if (typeof key !== 'string' || typeof label !== 'string' || !label) {
      throw new Error('Flop 牌面分类缺少中文名称。');
    }
    return { key, label, observed: observedBoardClasses.has(key) };
  });

  const explorerRows = validateAndSanitizeRows(
    rawExplorerRows,
    '主查询数据',
    rawMetadata.nodes_html,
    null,
  );
  if (explorerRows.some((row) => row.b !== 'ALL')) {
    throw new Error('主查询数据混入了牌面拆分行。');
  }
  const boardRows = validateAndSanitizeRows(
    rawBoardRows,
    'Flop 牌面数据',
    rawMetadata.flop_board_filter_nodes,
    boardClassSet,
  );

  const counters = rawMetadata.counters || {};
  const boardMetadata = rawMetadata.flop_board_filter || {};
  const verifiedExamples = rawMetadata.examples_verification?.examples_verified;
  const summary = {
    handsAnalyzed: requirePositiveInteger(counters.hands_seen, 'handsAnalyzed'),
    headsUpPressureResponses: requirePositiveInteger(
      counters.eligible_hu_pressure_responses,
      'headsUpPressureResponses',
    ),
    flopBoardOpportunities: requirePositiveInteger(
      boardMetadata.opportunities,
      'flopBoardOpportunities',
    ),
    minimumReliableSample: requirePositiveInteger(rawMetadata.min_sample, 'minimumReliableSample'),
    browserMinimumSample: requirePositiveInteger(rawMetadata.html_min_sample, 'browserMinimumSample'),
    explorerRows: explorerRows.length,
    flopBoardRows: boardRows.length,
    boardClassesDeclared: rawBoardClasses.length,
    boardClassesObserved: observedBoardClasses.size,
    boardClassificationCoverage: boardMetadata.classification_coverage,
    verifiedSpotExamples: requireNonNegativeInteger(verifiedExamples, 'verifiedSpotExamples'),
  };
  if (
    typeof summary.boardClassificationCoverage !== 'number'
    || !Number.isFinite(summary.boardClassificationCoverage)
    || summary.boardClassificationCoverage < 0
    || summary.boardClassificationCoverage > 1
  ) throw new Error('牌面分类覆盖率无效。');
  if (summary.boardClassesObserved > summary.boardClassesDeclared) {
    throw new Error('已观测牌面类数量超过声明数量。');
  }

  const datasetVersion = rawMetadata.version;
  const generatedAt = rawMetadata.created_at;
  const explorerDocument = {
    schemaVersion: SCHEMA_VERSION,
    datasetVersion,
    generatedAt,
    rowFields: ROW_FIELDS,
    sizeBuckets: sanitizeSizeBuckets(rawMetadata.fine_size_definitions),
    rows: explorerRows,
  };
  const boardDocument = {
    schemaVersion: SCHEMA_VERSION,
    datasetVersion,
    generatedAt,
    scope: '单挑底池、单一防守者，面对 PFA 在 Flop 的第一次持续下注',
    boardClasses,
    sizeBuckets: sanitizeSizeBuckets(boardMetadata.size_bins),
    rows: boardRows,
  };

  const explorerContents = serializeCompact(explorerDocument);
  const boardContents = serializeCompact(boardDocument);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    datasetVersion,
    generatedAt,
    privacy: '仅包含匿名汇总统计，不含原始手牌、玩家身份或本机路径',
    summary,
    boardClasses,
    files: {
      explorer: {
        path: 'explorer.json',
        bytes: Buffer.byteLength(explorerContents),
        sha256: sha256(explorerContents),
        rows: explorerRows.length,
      },
      flopBoards: {
        path: 'flop-boards.json',
        bytes: Buffer.byteLength(boardContents),
        sha256: sha256(boardContents),
        rows: boardRows.length,
      },
    },
  };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;

  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  writeAtomically(resolve(OUTPUT_DIRECTORY, 'explorer.json'), explorerContents);
  writeAtomically(resolve(OUTPUT_DIRECTORY, 'flop-boards.json'), boardContents);
  writeAtomically(resolve(OUTPUT_DIRECTORY, 'manifest.json'), manifestContents);

  console.log(JSON.stringify({
    status: 'ok',
    schemaVersion: SCHEMA_VERSION,
    datasetVersion,
    explorerRows: explorerRows.length,
    flopBoardRows: boardRows.length,
    boardClasses: boardClasses.length,
    outputBytes: {
      manifest: Buffer.byteLength(manifestContents),
      explorer: Buffer.byteLength(explorerContents),
      flopBoards: Buffer.byteLength(boardContents),
    },
  }, null, 2));
}

main();
