import { createHash } from 'node:crypto';

export const SOLVER_API_SCHEMA_VERSION = 1;
export const SOLVER_API_ID = 'kishpoker-postflop-solver-api-v1';
export const SOLVER_TREE_POLICY_ID =
  'flop25-75-turn75-150-river33-75-150-raise75-ai50-floor-v1';

export const SOLVER_TREE_POLICY = Object.freeze({
  id: SOLVER_TREE_POLICY_ID,
  initialStreet: 'flop',
  betsPotFraction: Object.freeze({
    flop: Object.freeze([0.25, 0.75]),
    turn: Object.freeze([0.75, 1.5]),
    river: Object.freeze([0.33, 0.75, 1.5])
  }),
  raisePotAfterCallFraction: 0.75,
  rounding: 'floor-to-chip',
  allInConversion: Object.freeze({
    remainingStackFraction: 0.5,
    comparison: 'inclusive',
    replaceActionsWithSoleAllIn: true
  })
});

export const DEFAULT_SOLVER_JOB_INPUT = Object.freeze({
  schemaVersion: SOLVER_API_SCHEMA_VERSION,
  board: 'AsKh9c',
  potBb: 17.5,
  effectiveStackBb: 92,
  ranges: Object.freeze({
    oop: Object.freeze({ format: 'text', value: 'AA,KK,QQ,AKs' }),
    ip: Object.freeze({ format: 'text', value: 'JJ,TT,AKo,AQs' })
  }),
  economics: Object.freeze({
    model: 'gg-rnc-rb40',
    rakeRate: 0.03,
    rakeCapBb: 1.8,
    flatDropThresholdBb: 30,
    flatDropAmountBb: 1.5
  }),
  treePolicyId: SOLVER_TREE_POLICY_ID,
  solve: Object.freeze({
    maxIterations: 64,
    targetExploitabilityPotFraction: 0
  }),
  export: Object.freeze({
    streets: 'flop-turn-river',
    nodeLimit: 512,
    turnCardLimit: 1,
    riverCardLimit: 1,
    turnCard: null,
    riverCard: null
  })
});

function fail(message, field) {
  const error = new Error(message);
  error.code = 'INVALID_SOLVER_INPUT';
  error.field = field;
  throw error;
}

function finiteNumber(value, field, { minimum = -Infinity, maximum = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail(`${field} 必须是 ${minimum} 到 ${maximum} 之间的有限数字`, field);
  }
  return number;
}

function chipNumber(value, field, options) {
  const number = finiteNumber(value, field, options);
  if (Math.abs(number * 100 - Math.round(number * 100)) > 1e-8) {
    fail(`${field} 最多支持 0.01bb 精度`, field);
  }
  return number;
}

function integer(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${field} 必须是 ${minimum} 到 ${maximum} 之间的整数`, field);
  }
  return number;
}

export function normalizeBoard(value) {
  const compact = String(value ?? '').replace(/[\s,/-]+/g, '');
  if (compact.length !== 6) fail('翻牌必须正好包含三张牌，例如 AsKh9c', 'board');
  const cards = compact.match(/.{2}/g) ?? [];
  const normalized = cards.map((card) => {
    const rank = card[0]?.toUpperCase();
    const suit = card[1]?.toLowerCase();
    if (!'23456789TJQKA'.includes(rank) || !'hsdc'.includes(suit)) {
      fail(`无效的翻牌：${card}`, 'board');
    }
    return `${rank}${suit}`;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail('翻牌不能包含重复牌', 'board');
  }
  return normalized.join('');
}

function normalizeOptionalCard(value, field) {
  if (value == null || value === '') return null;
  const card = String(value).trim();
  if (card.length !== 2) fail(`${field} 必须是一张牌，例如 7d`, field);
  const rank = card[0]?.toUpperCase();
  const suit = card[1]?.toLowerCase();
  if (!'23456789TJQKA'.includes(rank) || !'hsdc'.includes(suit)) {
    fail(`${field} 不是有效扑克牌`, field);
  }
  return `${rank}${suit}`;
}

function normalizeRange(value, field) {
  if (!value || typeof value !== 'object') fail(`${field} 范围缺失`, field);
  if (value.format === 'text') {
    const text = String(value.value ?? '').trim();
    if (!text || text.length > 100_000) {
      fail(`${field} 文本范围不能为空且不能超过 100,000 字符`, field);
    }
    return { format: 'text', value: text };
  }
  if (value.format === 'f32le-base64') {
    const data = String(value.data ?? '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      fail(`${field} 的 f32le 数据不是有效 base64`, field);
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength !== 1326 * 4) {
      fail(`${field} 的 f32le 数据必须正好是 1326 个 float32`, field);
    }
    return { format: 'f32le-base64', data };
  }
  fail(`${field} 只支持 text 或 f32le-base64`, field);
}

export function normalizeSolverJobInput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('求解请求必须是 JSON 对象');
  }
  const economicsRaw = raw.economics ?? {};
  const solveRaw = raw.solve ?? {};
  const exportRaw = raw.export ?? {};
  const model = String(economicsRaw.model ?? 'gg-rnc-rb40');
  if (!['gg-rnc-rb40', 'gg-rnc-full-rake', 'zero-rake', 'custom'].includes(model)) {
    fail('未知抽水模型', 'economics.model');
  }
  const zeroRake = model === 'zero-rake';
  const board = normalizeBoard(raw.board);
  const turnCard = normalizeOptionalCard(exportRaw.turnCard, 'export.turnCard');
  const riverCard = normalizeOptionalCard(exportRaw.riverCard, 'export.riverCard');
  const input = {
    schemaVersion: SOLVER_API_SCHEMA_VERSION,
    board,
    potBb: chipNumber(raw.potBb, 'potBb', { minimum: 0.01, maximum: 100_000 }),
    effectiveStackBb: chipNumber(raw.effectiveStackBb, 'effectiveStackBb', {
      minimum: 0.01,
      maximum: 100_000
    }),
    ranges: {
      oop: normalizeRange(raw.ranges?.oop, 'ranges.oop'),
      ip: normalizeRange(raw.ranges?.ip, 'ranges.ip')
    },
    economics: {
      model,
      rakeRate: zeroRake
        ? 0
        : finiteNumber(economicsRaw.rakeRate, 'economics.rakeRate', {
            minimum: 0,
            maximum: 1
          }),
      rakeCapBb: zeroRake
        ? 0
        : chipNumber(economicsRaw.rakeCapBb, 'economics.rakeCapBb', {
            minimum: 0,
            maximum: 100_000
          }),
      flatDropThresholdBb: zeroRake
        ? 0
        : chipNumber(
            economicsRaw.flatDropThresholdBb,
            'economics.flatDropThresholdBb',
            { minimum: 0, maximum: 100_000 }
          ),
      flatDropAmountBb: zeroRake
        ? 0
        : chipNumber(economicsRaw.flatDropAmountBb, 'economics.flatDropAmountBb', {
            minimum: 0,
            maximum: 100_000
          })
    },
    treePolicyId: String(raw.treePolicyId ?? SOLVER_TREE_POLICY_ID),
    solve: {
      maxIterations: integer(solveRaw.maxIterations, 'solve.maxIterations', 1, 100_000),
      targetExploitabilityPotFraction: finiteNumber(
        solveRaw.targetExploitabilityPotFraction ?? 0,
        'solve.targetExploitabilityPotFraction',
        { minimum: 0, maximum: 1 }
      )
    },
    export: {
      streets: String(exportRaw.streets ?? 'flop-turn-river'),
      nodeLimit: integer(exportRaw.nodeLimit ?? 512, 'export.nodeLimit', 1, 20_000),
      turnCardLimit: integer(
        exportRaw.turnCardLimit ?? 1,
        'export.turnCardLimit',
        1,
        49
      ),
      riverCardLimit: integer(
        exportRaw.riverCardLimit ?? 1,
        'export.riverCardLimit',
        1,
        48
      ),
      turnCard,
      riverCard
    }
  };
  if (input.treePolicyId !== SOLVER_TREE_POLICY_ID) {
    fail('首版只允许已确认的 KishPoker UI 动作树', 'treePolicyId');
  }
  if (!['flop', 'flop-turn', 'flop-turn-river'].includes(input.export.streets)) {
    fail('export.streets 只支持 flop、flop-turn 或 flop-turn-river', 'export.streets');
  }
  const boardCards = board.match(/.{2}/g) ?? [];
  if (turnCard && boardCards.includes(turnCard)) {
    fail('Turn 不能与翻牌重复', 'export.turnCard');
  }
  if (riverCard && !turnCard) {
    fail('选择 River 前必须先选择 Turn', 'export.riverCard');
  }
  if (riverCard && [...boardCards, turnCard].includes(riverCard)) {
    fail('River 不能与已有公共牌重复', 'export.riverCard');
  }
  return input;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function solverInputSha256(input) {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export function publicSolverJob(job) {
  return {
    schemaVersion: SOLVER_API_SCHEMA_VERSION,
    id: job.id,
    inputSha256: job.inputSha256,
    status: job.status,
    phase: job.phase,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    progress: job.progress,
    resources: job.resources,
    error: job.error ?? null,
    result: job.result ?? null,
    reproducibility: job.reproducibility,
    links: job.links
  };
}
