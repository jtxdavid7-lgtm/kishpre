import { cloudbaseClient, getCloudbaseDatabase } from './cloudbaseClient';
import { parseGgHand, summarizeHeroResults } from './handHistoryAnalyzer';

const PLATFORM = 'ggpoker';
const PARSER_VERSION = 'kish2note-browser-v1';
const METRIC_VERSION = 'kish2note-hero-v1';
const CONSENT_PURPOSE = 'cloud_hand_history_storage';
const CONSENT_POLICY_VERSION = '2026-07-15-v2-auto-library';
const LOOKUP_BATCH_SIZE = 50;
const LOOKUP_CONCURRENCY = 4;
const READ_PAGE_SIZE = 500;
const READ_PAGE_CONCURRENCY = 4;
const HASH_BATCH_SIZE = 32;
const HASH_PROGRESS_INTERVAL = 256;
const HAND_WRITE_BATCH_SIZE = 200;
const RELATION_WRITE_BATCH_SIZE = 500;
const WRITE_CONCURRENCY = 3;
const WRITE_BATCH_BYTES = 750_000;
const MAX_RAW_TEXT_BYTES = 262_144;

const PREFLOP_FACT_KEYS = [
  'heroFacingRaise',
  'heroThreeBetOpportunity',
  'heroVoluntary',
  'heroRaise',
  'heroThreeBet',
  'heroSqueezeOpportunity',
  'heroSqueeze',
  'heroFourBetOpportunity',
  'heroFourBet',
  'heroFoldToThreeBetOpportunity',
  'heroFoldToThreeBet',
  'heroFoldToFourBetOpportunity',
  'heroFoldToFourBet',
  'heroStealOpportunity',
  'heroSteal',
  'heroStealBtnOpportunity',
  'heroStealBtn',
  'heroStealSbOpportunity',
  'heroStealSb'
];

export class CloudLibraryError extends Error {
  constructor(message, { code = 'cloud-library/error', operation = '', cause, partialSuccess = false } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CloudLibraryError';
    this.code = code;
    this.operation = operation;
    this.partialSuccess = partialSuccess;
  }
}

function localizedDatabaseMessage(error, operation) {
  const code = String(error?.code ?? error?.name ?? '');
  const message = String(error?.message ?? '');

  if (code === '42501' || /permission|policy|row-level security|jwt/i.test(message)) {
    return '当前登录没有云牌谱权限，请重新登录后再试。';
  }
  if (code === '23505') return '云端已有相同记录，请刷新牌谱库后再试。';
  if (code === '23503') return '云端关联数据不完整，请刷新后重新保存。';
  if (code === '23514' || code === '22P02') return '牌谱数据未通过云端校验，请重新导入原始牌谱。';
  if (code === 'PGRST116') return '没有找到对应的云端记录。';
  if (/failed to fetch|network|timeout|load failed/i.test(message)) {
    return '网络连接失败，请检查网络后重试。';
  }
  return `${operation}失败，请稍后重试。`;
}

function toCloudError(error, operation) {
  if (error instanceof CloudLibraryError) return error;
  return new CloudLibraryError(localizedDatabaseMessage(error, operation), {
    code: String(error?.code ?? error?.name ?? 'cloud-library/request-failed'),
    operation,
    cause: error
  });
}

async function runQuery(query, operation) {
  try {
    const response = await query;
    if (response?.error) throw response.error;
    return response?.data ?? null;
  } catch (error) {
    throw toCloudError(error, operation);
  }
}

function notify(onProgress, phase, completed, total, message) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ phase, completed, total, message });
  } catch {
    // Progress UI must never interrupt a cloud save.
  }
}

function createClientUuid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new CloudLibraryError('当前浏览器不支持安全随机数，无法保存云牌谱。', {
      code: 'cloud-library/crypto-unavailable'
    });
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function normalizeRawText(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').trim();
}

async function sha256(value) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new CloudLibraryError('当前浏览器不支持 SHA-256，无法安全去重。', {
      code: 'cloud-library/crypto-unavailable'
    });
  }
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(values, concurrency, operation) {
  if (!values.length) return [];
  const results = new Array(values.length);
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  let nextIndex = 0;
  let firstError = null;

  const worker = async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function chunkRowsByPayload(rows) {
  const result = [];
  let current = [];
  let currentBytes = 2;

  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (current.length && (current.length >= HAND_WRITE_BATCH_SIZE || currentBytes + rowBytes > WRITE_BATCH_BYTES)) {
      result.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length) result.push(current);
  return result;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseStakes(stakes, fallbackBigBlind) {
  const values = String(stakes ?? '').match(/\$([\d,.]+)\/\$([\d,.]+)/);
  return {
    smallBlind: values ? Number(values[1].replaceAll(',', '')) : null,
    bigBlind: values ? Number(values[2].replaceAll(',', '')) : Number(fallbackBigBlind)
  };
}

function handDateToIso(value) {
  const match = String(value ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function startingHandKey(cards = []) {
  if (cards.length !== 2) return null;
  const ranks = '23456789TJQKA';
  const [first, second] = cards;
  if (!ranks.includes(first?.[0]) || !ranks.includes(second?.[0])) return null;
  if (first[0] === second[0]) return `${first[0]}${second[0]}`;
  const ordered = [first[0], second[0]].sort((left, right) => ranks.indexOf(right) - ranks.indexOf(left));
  return `${ordered.join('')}${first[1] === second[1] ? 's' : 'o'}`;
}

function pickFacts(result, keys) {
  return Object.fromEntries(keys.map((key) => [key, Boolean(result?.[key])]));
}

function serializeDetail(hand) {
  return {
    players: [...(hand.players?.entries?.() ?? [])].map(([name, player]) => ({ name, ...player })),
    holeCards: Object.fromEntries(hand.holeCards?.entries?.() ?? []),
    board: [...(hand.board ?? [])],
    winners: [...(hand.winners ?? [])],
    actions: [...(hand.actions ?? [])],
    heroCandidates: [...(hand.heroCandidates ?? [])]
  };
}

function compactSummary(results) {
  const { curve: _curve, ...summary } = summarizeHeroResults(results);
  return summary;
}

function normalizeSessionRow(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    libraryId: row.library_id,
    pokerAccountId: row.poker_account_id,
    name: row.name,
    hero: metadata.hero ?? '',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    timezone: row.timezone,
    handCount: Number(row.hand_count ?? 0),
    startTp: parseNumber(row.tp_start),
    endTp: parseNumber(row.tp_end),
    summary: metadata.heroSummary ?? null,
    createdAt: row.created_at,
    metadata
  };
}

function normalizeLibraryRow(row) {
  return {
    id: row.id,
    name: row.name || '我的牌谱',
    isDefault: Boolean(row.is_default),
    autoSaveEnabled: row.auto_save_enabled !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function requireSignedIn() {
  let authState;
  try {
    authState = await cloudbaseClient.getSession();
  } catch (error) {
    throw toCloudError(error, '读取登录状态');
  }
  if (!authState?.user) {
    throw new CloudLibraryError('请先登录，再保存或读取云牌谱。', {
      code: 'cloud-library/login-required'
    });
  }
  return authState.user;
}

async function fetchAll(buildQuery, operation) {
  const rows = [];
  const firstPage = await runQuery(
    buildQuery().range(0, READ_PAGE_SIZE - 1),
    operation
  );
  const firstRows = Array.isArray(firstPage) ? firstPage : [];
  rows.push(...firstRows);
  if (firstRows.length < READ_PAGE_SIZE) return rows;

  for (let offset = READ_PAGE_SIZE; ;) {
    const offsets = Array.from(
      { length: READ_PAGE_CONCURRENCY },
      (_, index) => offset + index * READ_PAGE_SIZE
    );
    const pages = await Promise.all(offsets.map((pageOffset) => runQuery(
      buildQuery().range(pageOffset, pageOffset + READ_PAGE_SIZE - 1),
      operation
    )));
    let complete = false;
    for (const page of pages) {
      const pageRows = Array.isArray(page) ? page : [];
      rows.push(...pageRows);
      if (pageRows.length < READ_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (complete) return rows;
    offset += READ_PAGE_SIZE * READ_PAGE_CONCURRENCY;
  }
}

async function findRowsInBatches(database, table, column, values, select, operation, equals = {}) {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  const batches = chunk(uniqueValues, LOOKUP_BATCH_SIZE);
  const pages = await runWithConcurrency(batches, LOOKUP_CONCURRENCY, async (valuesBatch) => {
    let query = database.from(table).select(select).in(column, valuesBatch);
    for (const [filterColumn, filterValue] of Object.entries(equals)) {
      query = query.eq(filterColumn, filterValue);
    }
    return runQuery(query, operation);
  });
  return pages.flatMap((rows) => Array.isArray(rows) ? rows : []);
}

async function resolveDefaultLibrary(database) {
  const select = 'id,name,is_default,auto_save_enabled,created_at,updated_at';
  const existing = await runQuery(
    database.from('hand_libraries')
      .select(select)
      .eq('is_default', true)
      .maybeSingle(),
    '读取默认牌谱库'
  );
  if (existing) return existing;

  const id = createClientUuid();
  try {
    return await runQuery(
      database.from('hand_libraries')
        .insert({ id, name: '我的牌谱', is_default: true, auto_save_enabled: true }, { defaultToNull: false })
        .select(select)
        .single(),
      '创建默认牌谱库'
    );
  } catch (error) {
    if (String(error.code) !== '23505') throw error;
    return runQuery(
      database.from('hand_libraries')
        .select(select)
        .eq('is_default', true)
        .single(),
      '读取默认牌谱库'
    );
  }
}

async function resolveLibrary(database, libraryId) {
  const id = String(libraryId ?? '').trim();
  if (!id) return resolveDefaultLibrary(database);
  const row = await runQuery(
    database.from('hand_libraries')
      .select('id,name,is_default,auto_save_enabled,created_at,updated_at')
      .eq('id', id)
      .maybeSingle(),
    '读取牌谱库'
  );
  if (!row) {
    throw new CloudLibraryError('没有找到这个牌谱库，或你没有访问权限。', {
      code: 'cloud-library/library-not-found'
    });
  }
  return row;
}

async function resolvePokerAccount(database, hero) {
  const select = 'id,platform,screen_name';
  const existing = await runQuery(
    database.from('poker_accounts')
      .select(select)
      .eq('platform', PLATFORM)
      .eq('screen_name', hero)
      .maybeSingle(),
    '查找牌手账号'
  );
  if (existing) return { row: existing, created: false };

  const id = createClientUuid();
  try {
    const inserted = await runQuery(
      database.from('poker_accounts')
        .insert(
          { id, platform: PLATFORM, screen_name: hero, timezone: 'Asia/Shanghai' },
          { defaultToNull: false }
        )
        .select(select)
        .single(),
      '创建牌手账号'
    );
    return { row: inserted, created: true };
  } catch (error) {
    if (String(error.code) !== '23505') throw error;
    const raced = await runQuery(
      database.from('poker_accounts')
        .select(select)
        .eq('platform', PLATFORM)
        .eq('screen_name', hero)
        .single(),
      '读取牌手账号'
    );
    return { row: raced, created: false };
  }
}

async function resolvePrivacyConsent(database, action = 'manual_cloud_save') {
  const select = 'id,purpose,policy_version,granted';
  const existing = await runQuery(
    database.from('privacy_consents')
      .select(select)
      .eq('purpose', CONSENT_PURPOSE)
      .eq('policy_version', CONSENT_POLICY_VERSION)
      .maybeSingle(),
    '读取隐私同意记录'
  );
  if (existing?.granted) return existing;

  const id = createClientUuid();
  try {
    return await runQuery(
      database.from('privacy_consents')
        .insert(
          {
            id,
            purpose: CONSENT_PURPOSE,
            policy_version: CONSENT_POLICY_VERSION,
            granted: true,
            source: 'web',
            evidence: { action, explicit: true, autoSavePolicy: true }
          },
          { defaultToNull: false }
        )
        .select(select)
        .single(),
      '记录隐私同意'
    );
  } catch (error) {
    if (String(error.code) !== '23505') throw error;
    return runQuery(
      database.from('privacy_consents')
        .select(select)
        .eq('purpose', CONSENT_PURPOSE)
        .eq('policy_version', CONSENT_POLICY_VERSION)
        .single(),
      '读取隐私同意记录'
    );
  }
}

export async function ensureDefaultCloudLibrary() {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  return normalizeLibraryRow(await resolveDefaultLibrary(database));
}

export async function listCloudLibraries() {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  let rows = await fetchAll(
    () => database.from('hand_libraries')
      .select('id,name,is_default,auto_save_enabled,created_at,updated_at')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true }),
    '读取牌谱库列表'
  );
  if (!rows.length) rows = [await resolveDefaultLibrary(database)];
  return rows.map(normalizeLibraryRow);
}

export async function hasCloudStorageConsent() {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  const row = await runQuery(
    database.from('privacy_consents')
      .select('id,granted')
      .eq('purpose', CONSENT_PURPOSE)
      .eq('policy_version', CONSENT_POLICY_VERSION)
      .maybeSingle(),
    '读取自动保存授权'
  );
  return Boolean(row?.granted);
}

export async function updateCloudLibrarySettings(libraryId, { autoSaveEnabled } = {}) {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  const library = await resolveLibrary(database, libraryId);
  const updated = await runQuery(
    database.from('hand_libraries')
      .update({ auto_save_enabled: Boolean(autoSaveEnabled) })
      .eq('id', library.id)
      .select('id,name,is_default,auto_save_enabled,created_at,updated_at')
      .single(),
    '更新牌谱库设置'
  );
  return normalizeLibraryRow(updated);
}

async function prepareHands(hands, hero, onProgress) {
  const encoder = new TextEncoder();
  const uniqueByExternalId = new Map();
  const uniqueByHash = new Map();
  const prepared = [];
  let duplicateCount = 0;
  let conflictCount = 0;

  for (let batchStart = 0; batchStart < hands.length; batchStart += HASH_BATCH_SIZE) {
    const candidates = [];
    const batchEnd = Math.min(hands.length, batchStart + HASH_BATCH_SIZE);

    for (let index = batchStart; index < batchEnd; index += 1) {
      const hand = hands[index];
      const rawText = normalizeRawText(hand?.raw);
      const rawBuffer = encoder.encode(rawText);
      const rawBytes = rawBuffer.byteLength;
      if (!rawText || rawBytes > MAX_RAW_TEXT_BYTES) {
        throw new CloudLibraryError(`第 ${index + 1} 手牌的原文为空或超过云端大小限制。`, {
          code: 'cloud-library/invalid-raw-text'
        });
      }
      const externalHandId = String(hand?.id ?? '').trim();
      if (!externalHandId) {
        throw new CloudLibraryError(`第 ${index + 1} 手牌缺少 GG 牌局号码。`, {
          code: 'cloud-library/invalid-hand-id'
        });
      }
      const heroResult = hand.getHeroResult?.(hero);
      if (!heroResult) {
        throw new CloudLibraryError(`牌手 ${hero} 不在牌局 ${externalHandId} 中。`, {
          code: 'cloud-library/hero-not-found'
        });
      }
      candidates.push({
        hand,
        heroResult,
        rawText,
        rawBuffer,
        rawBytes,
        externalHandId,
        sourceOrdinal: index,
        playedAt: handDateToIso(hand.date)
      });
    }

    const hashes = await Promise.all(candidates.map((item) => sha256(item.rawBuffer)));
    candidates.forEach((candidate, index) => {
      const item = {
        hand: candidate.hand,
        heroResult: candidate.heroResult,
        rawText: candidate.rawText,
        rawBytes: candidate.rawBytes,
        externalHandId: candidate.externalHandId,
        sourceOrdinal: candidate.sourceOrdinal,
        playedAt: candidate.playedAt
      };
      const contentSha256 = hashes[index];
      const duplicateId = uniqueByExternalId.get(item.externalHandId);
      if (duplicateId) {
        if (duplicateId.contentSha256 === contentSha256) duplicateCount += 1;
        else conflictCount += 1;
        return;
      }
      if (uniqueByHash.has(contentSha256)) {
        duplicateCount += 1;
        return;
      }

      const preparedItem = { ...item, contentSha256 };
      uniqueByExternalId.set(item.externalHandId, preparedItem);
      uniqueByHash.set(contentSha256, preparedItem);
      prepared.push(preparedItem);
    });

    if (batchEnd === hands.length || batchEnd % HASH_PROGRESS_INTERVAL === 0) {
      notify(onProgress, 'hashing', batchEnd, hands.length, '正在校验牌谱…');
    }
  }
  return { prepared, duplicateCount, conflictCount };
}

async function removeCreatedRecords(database, state) {
  const errors = [];
  const tryDelete = async (query, operation) => {
    try {
      await runQuery(query, operation);
    } catch (error) {
      errors.push(error.message);
    }
  };

  if (state.batchCreated && state.batchId) {
    await tryDelete(
      database.from('import_batch_hands').delete().eq('import_batch_id', state.batchId),
      '清理导入关联'
    );
  }
  if (state.sessionCreated && state.sessionId) {
    await tryDelete(database.from('hands').delete().eq('session_id', state.sessionId), '清理未完成的牌谱');
    await tryDelete(database.from('sessions').delete().eq('id', state.sessionId), '清理未完成的场次');
  }
  if (state.batchCreated && state.batchId) {
    await tryDelete(database.from('import_batches').delete().eq('id', state.batchId), '清理未完成的导入');
  }
  if (state.accountCreated && state.accountId) {
    await tryDelete(database.from('poker_accounts').delete().eq('id', state.accountId), '清理空牌手账号');
  }
  return errors;
}

/**
 * Persist a local analysis to one of the signed-in user's logical hand libraries.
 * Callers must obtain the user's current cloud-storage consent before automatic saves.
 */
export async function saveHandsToCloud({
  hands,
  hero,
  libraryId,
  sessionName,
  startTp,
  endTp,
  consentAction = 'manual_cloud_save',
  onProgress
} = {}) {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  const library = await resolveLibrary(database, libraryId);
  const inputHands = Array.isArray(hands) ? hands : [];
  const normalizedHero = String(hero ?? '').trim();
  const normalizedSessionName = String(sessionName ?? '').trim();
  if (!inputHands.length) {
    throw new CloudLibraryError('没有可保存的牌谱。', { code: 'cloud-library/no-hands' });
  }
  const unsupported = inputHands.find((hand) => hand?.analysisSupported === false);
  if (unsupported) {
    throw new CloudLibraryError('这批牌谱包含当前尚未支持分析的游戏类型。为避免生成错误统计，本次没有上传。', {
      code: 'cloud-library/unsupported-game'
    });
  }
  if (!normalizedHero || normalizedHero.length > 80) {
    throw new CloudLibraryError('请选择正确的 Hero 后再保存。', { code: 'cloud-library/invalid-hero' });
  }
  if (normalizedSessionName.length > 120) {
    throw new CloudLibraryError('场次名称不能超过 120 个字符。', {
      code: 'cloud-library/invalid-session-name'
    });
  }

  notify(onProgress, 'hashing', 0, inputHands.length, '正在校验牌谱…');
  const locallyPrepared = await prepareHands(inputHands, normalizedHero, onProgress);
  const existingById = await findRowsInBatches(
    database,
    'hands',
    'external_hand_id',
    locallyPrepared.prepared.map((item) => item.externalHandId),
    'id,library_id,poker_account_id,external_hand_id,content_sha256',
    '检查云端牌局号码',
    { library_id: library.id, platform: PLATFORM }
  );
  const byExternalId = new Map(existingById.map((row) => [row.external_hand_id, row]));
  const hashCandidates = locallyPrepared.prepared.filter((item) => !byExternalId.has(item.externalHandId));
  const existingByHash = await findRowsInBatches(
    database,
    'hands',
    'content_sha256',
    hashCandidates.map((item) => item.contentSha256),
    'id,library_id,poker_account_id,external_hand_id,content_sha256',
    '检查云端牌谱指纹',
    { library_id: library.id }
  );
  const byHash = new Map(existingByHash.map((row) => [row.content_sha256, row]));
  const newItems = [];
  const duplicateRows = [];
  let duplicateCount = locallyPrepared.duplicateCount;
  let conflictCount = locallyPrepared.conflictCount;

  for (const item of locallyPrepared.prepared) {
    const idMatch = byExternalId.get(item.externalHandId);
    if (idMatch) {
      if (idMatch.content_sha256 === item.contentSha256) {
        duplicateCount += 1;
        duplicateRows.push({ existing: idMatch, outcome: 'duplicate' });
      } else {
        conflictCount += 1;
        duplicateRows.push({ existing: idMatch, outcome: 'conflict' });
      }
      continue;
    }
    const hashMatch = byHash.get(item.contentSha256);
    if (hashMatch) {
      duplicateCount += 1;
      duplicateRows.push({ existing: hashMatch, outcome: 'duplicate' });
      continue;
    }
    newItems.push(item);
  }

  if (!newItems.length) {
    notify(onProgress, 'complete', inputHands.length, inputHands.length, '这些牌谱已经保存在云端。');
    return {
      sessionId: null,
      insertedCount: 0,
      duplicateCount,
      conflictCount,
      totalCount: inputHands.length,
      alreadySaved: true
    };
  }

  const state = {
    libraryId: library.id,
    accountId: null,
    accountCreated: false,
    batchId: createClientUuid(),
    batchCreated: false,
    sessionId: createClientUuid(),
    sessionCreated: false
  };

  try {
    notify(onProgress, 'preparing', 0, newItems.length, '正在准备云端场次…');
    const account = await resolvePokerAccount(database, normalizedHero);
    state.accountId = account.row.id;
    state.accountCreated = account.created;
    const consent = await resolvePrivacyConsent(database, consentAction);

    const acceptedDuplicateRows = duplicateRows.filter(({ existing }) => (
      existing.poker_account_id === state.accountId
    ));
    const heroResults = newItems.map((item) => item.heroResult);
    const heroSummary = compactSummary(heroResults);
    const playedTimes = newItems.map((item) => item.playedAt).filter(Boolean).sort();
    const startedAt = playedTimes[0] ?? null;
    const endedAt = playedTimes.at(-1) ?? null;
    const now = new Date().toISOString();

    await runQuery(
      database.from('import_batches').insert(
        {
          id: state.batchId,
          library_id: state.libraryId,
          poker_account_id: state.accountId,
          privacy_consent_id: consent.id,
          idempotency_key: state.batchId,
          status: 'completed',
          parser_version: PARSER_VERSION,
          source_manifest: {
            source: 'kish2note-browser',
            schemaVersion: 1,
            hero: normalizedHero,
            handCount: inputHands.length,
            containsFileNames: false
          },
          total_count: inputHands.length,
          inserted_count: newItems.length,
          duplicate_count: duplicateCount,
          conflict_count: conflictCount,
          error_count: 0,
          started_at: now,
          completed_at: now
        },
        { defaultToNull: false }
      ),
      '创建云端导入记录'
    );
    state.batchCreated = true;

    await runQuery(
      database.from('sessions').insert(
        {
          id: state.sessionId,
          library_id: state.libraryId,
          poker_account_id: state.accountId,
          source_import_batch_id: state.batchId,
          name: normalizedSessionName || (
            startedAt ? `${startedAt.slice(0, 10)} · ${normalizedHero}` : `GG Session · ${normalizedHero}`
          ),
          started_at: startedAt,
          ended_at: endedAt,
          timezone: 'Asia/Shanghai',
          hand_count: newItems.length,
          tp_start: parseNumber(startTp),
          tp_end: parseNumber(endTp),
          metadata: {
            schemaVersion: 1,
            hero: normalizedHero,
            heroSummary,
            importedAt: now,
            duplicateCount,
            conflictCount
          }
        },
        { defaultToNull: false }
      ),
      '创建云端场次'
    );
    state.sessionCreated = true;

    const handRows = newItems.map((item) => {
      const { hand, heroResult } = item;
      const stakes = parseStakes(hand.stakes, hand.bb);
      return {
        id: createClientUuid(),
        library_id: state.libraryId,
        poker_account_id: state.accountId,
        session_id: state.sessionId,
        platform: PLATFORM,
        external_hand_id: item.externalHandId,
        content_sha256: item.contentSha256,
        raw_text: item.rawText,
        source_ordinal: item.sourceOrdinal,
        source_date_text: hand.date || null,
        played_at: item.playedAt,
        currency: 'USD',
        small_blind: stakes.smallBlind,
        big_blind: stakes.bigBlind,
        stakes_label: hand.stakes || null,
        game_variant: hand.gameVariant || 'unknown',
        betting_structure: hand.bettingStructure || 'unknown',
        table_type: hand.tableType || 'unknown',
        max_players: Number.isInteger(hand.maxPlayers) ? hand.maxPlayers : null,
        game_descriptor_raw: hand.gameDescriptorRaw || null,
        table_name_raw: hand.tableNameRaw || null,
        analysis_supported: hand.analysisSupported !== false,
        hero_position: heroResult.position || null,
        hero_cards: [...(heroResult.cards ?? [])],
        starting_hand_key: startingHandKey(heroResult.cards),
        board_cards: [...(hand.board ?? [])],
        hand_value: heroResult.handValue || null,
        total_pot: Number(hand.totalPot ?? 0),
        hero_profit: Number(heroResult.profit ?? 0),
        hero_profit_bb: Number(heroResult.profitBB ?? 0),
        hand_rake: Number(hand.rake ?? 0),
        hand_jackpot: Number(hand.jackpot ?? 0),
        hero_rake_share: Number(heroResult.rake ?? 0),
        hero_jackpot_share: Number(heroResult.jackpot ?? 0),
        saw_flop: Boolean(heroResult.sawFlop),
        went_to_showdown: Boolean(heroResult.wentToShowdown),
        won_at_showdown: Boolean(heroResult.wonAtShowdown),
        won_when_saw_flop: Boolean(heroResult.wonWhenSawFlop),
        preflop_facts: pickFacts(heroResult, PREFLOP_FACT_KEYS),
        postflop_facts: heroResult.postflop ?? {},
        detail: serializeDetail(hand),
        parser_version: PARSER_VERSION,
        metric_version: METRIC_VERSION
      };
    });

    const handBatches = chunkRowsByPayload(handRows);
    let inserted = 0;
    await runWithConcurrency(handBatches, WRITE_CONCURRENCY, async (rows) => {
      const savedRows = await runQuery(
        database.from('hands')
          .insert(rows, { defaultToNull: false })
          .select('id,poker_account_id,external_hand_id'),
        '上传云端牌谱'
      );
      const returnedRows = Array.isArray(savedRows) ? savedRows : [];
      if (returnedRows.length !== rows.length) {
        throw new CloudLibraryError('云端返回的牌谱数量不完整，已停止本次保存。', {
          code: 'cloud-library/incomplete-insert',
          operation: '上传云端牌谱'
        });
      }
      const returnedByExternalId = new Map(returnedRows.map((row) => [row.external_hand_id, row]));
      for (const row of rows) {
        const saved = returnedByExternalId.get(row.external_hand_id);
        if (!saved?.id) {
          throw new CloudLibraryError(`云端没有返回牌局 ${row.external_hand_id} 的保存结果。`, {
            code: 'cloud-library/incomplete-insert',
            operation: '上传云端牌谱'
          });
        }
        row.savedId = saved.id;
      }
      inserted += rows.length;
      notify(onProgress, 'uploading', inserted, handRows.length, `正在保存牌谱 ${inserted}/${handRows.length}…`);
    });

    const relationRows = [
      ...handRows.map((row) => ({
        library_id: state.libraryId,
        poker_account_id: state.accountId,
        import_batch_id: state.batchId,
        hand_id: row.savedId,
        outcome: 'inserted'
      })),
      ...acceptedDuplicateRows.map(({ existing, outcome }) => ({
        library_id: state.libraryId,
        poker_account_id: state.accountId,
        import_batch_id: state.batchId,
        hand_id: existing.id,
        outcome
      }))
    ];
    const relationBatches = chunk(relationRows, RELATION_WRITE_BATCH_SIZE);
    await runWithConcurrency(relationBatches, WRITE_CONCURRENCY, (rows) => (
      runQuery(
        database.from('import_batch_hands').insert(rows, { defaultToNull: false }),
        '记录导入去重结果'
      )
    ));

    notify(onProgress, 'complete', handRows.length, handRows.length, '云牌谱保存完成。');
    return {
      sessionId: state.sessionId,
      importBatchId: state.batchId,
      insertedCount: handRows.length,
      duplicateCount,
      conflictCount,
      totalCount: inputHands.length,
      alreadySaved: false,
      summary: heroSummary
    };
  } catch (error) {
    const cleanupErrors = await removeCreatedRecords(database, state);
    const cloudError = toCloudError(error, '保存云牌谱');
    if (cleanupErrors.length) {
      cloudError.partialSuccess = true;
      cloudError.cleanupErrors = cleanupErrors;
      cloudError.message = `${cloudError.message} 部分临时数据可能尚未清理，请稍后在牌谱库检查。`;
    }
    throw cloudError;
  }
}

async function fetchSessionRows(database, libraryId) {
  return fetchAll(
    () => database.from('sessions')
      .select('id,library_id,poker_account_id,name,started_at,ended_at,timezone,hand_count,tp_start,tp_end,metadata,created_at')
      .eq('library_id', libraryId)
      .order('started_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }),
    '读取云牌谱场次'
  );
}

export async function loadCloudLibraryIndex({ libraryId } = {}) {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  const library = await resolveLibrary(database, libraryId);
  const rows = await fetchSessionRows(database, library.id);
  return {
    library: normalizeLibraryRow(library),
    sessions: rows.map(normalizeSessionRow)
  };
}

export async function listCloudSessions({ libraryId } = {}) {
  const result = await loadCloudLibraryIndex({ libraryId });
  return result.sessions;
}

export async function getCloudLibraryOverview({ libraryId } = {}) {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  const library = await resolveLibrary(database, libraryId);
  const rows = await fetchAll(
    () => database.from('hands')
      .select('played_at,stakes_label,game_variant,betting_structure,table_type,max_players,analysis_supported')
      .eq('library_id', library.id)
      .eq('analysis_supported', true)
      .order('played_at', { ascending: true, nullsFirst: false }),
    '读取牌谱库概览'
  );
  const stakes = new Map();
  const gameTypes = new Map();
  for (const row of rows) {
    if (row.stakes_label) stakes.set(row.stakes_label, (stakes.get(row.stakes_label) ?? 0) + 1);
    const key = `${row.game_variant ?? 'unknown'}:${row.betting_structure ?? 'unknown'}:${row.table_type ?? 'unknown'}:${row.max_players ?? 'unknown'}`;
    const existing = gameTypes.get(key);
    if (existing) existing.count += 1;
    else gameTypes.set(key, {
      key,
      gameVariant: row.game_variant ?? 'unknown',
      bettingStructure: row.betting_structure ?? 'unknown',
      tableType: row.table_type ?? 'unknown',
      maxPlayers: row.max_players ?? null,
      analysisSupported: row.analysis_supported !== false,
      count: 1
    });
  }
  const playedTimes = rows.map((row) => row.played_at).filter(Boolean);
  return {
    library: normalizeLibraryRow(library),
    totalHands: rows.length,
    startedAt: playedTimes[0] ?? null,
    endedAt: playedTimes.at(-1) ?? null,
    stakes: [...stakes.entries()].map(([value, count]) => ({ value, count })),
    gameTypes: [...gameTypes.values()]
  };
}

export async function loadCloudSession(sessionId) {
  await requireSignedIn();
  const id = String(sessionId ?? '').trim();
  if (!id) throw new CloudLibraryError('缺少要读取的场次编号。', { code: 'cloud-library/invalid-session-id' });
  const database = getCloudbaseDatabase();
  const sessionRow = await runQuery(
    database.from('sessions')
      .select('id,library_id,poker_account_id,name,started_at,ended_at,timezone,hand_count,tp_start,tp_end,metadata,created_at')
      .eq('id', id)
      .maybeSingle(),
    '读取云牌谱场次'
  );
  if (!sessionRow) {
    throw new CloudLibraryError('没有找到这个云牌谱场次，或它已被删除。', {
      code: 'cloud-library/session-not-found'
    });
  }

  const rows = await fetchAll(
    () => database.from('hands')
      .select('id,external_hand_id,content_sha256,raw_text,played_at,source_ordinal')
      .eq('session_id', id)
      .order('played_at', { ascending: true, nullsFirst: false })
      .order('source_ordinal', { ascending: true })
      .order('external_hand_id', { ascending: true }),
    '读取云端牌谱'
  );
  const hands = rows.map((row) => {
    try {
      const parsed = parseGgHand(row.raw_text);
      if (!parsed?.id) throw new Error('missing hand id');
      return parsed;
    } catch (error) {
      throw new CloudLibraryError(`牌局 ${row.external_hand_id} 的云端原文无法解析。`, {
        code: 'cloud-library/invalid-cloud-hand',
        operation: '重建云端牌谱',
        cause: error
      });
    }
  });
  const session = normalizeSessionRow(sessionRow);
  return {
    session,
    hands,
    hero: session.hero,
    startTp: session.startTp,
    endTp: session.endTp
  };
}

function parseCloudHandRows(rows) {
  return rows.map((row) => {
    try {
      const parsed = parseGgHand(row.raw_text);
      if (!parsed?.id) throw new Error('missing hand id');
      return parsed;
    } catch (error) {
      throw new CloudLibraryError(`牌局 ${row.external_hand_id} 的云端原文无法解析。`, {
        code: 'cloud-library/invalid-cloud-hand',
        operation: '重建云端牌谱',
        cause: error
      });
    }
  });
}

function gameTypeKey(hand) {
  return `${hand?.gameVariant ?? 'unknown'}:${hand?.bettingStructure ?? 'unknown'}:${hand?.tableType ?? 'unknown'}:${hand?.maxPlayers ?? 'unknown'}`;
}

export async function loadCloudLibraryHands({ libraryId, filters = {} } = {}) {
  await requireSignedIn();
  const database = getCloudbaseDatabase();
  const library = await resolveLibrary(database, libraryId);
  const stakes = [...new Set((filters.stakes ?? []).map(String).filter(Boolean))];
  const gameTypes = [...new Set((filters.gameTypes ?? []).map(String).filter(Boolean))];
  const gameParts = gameTypes.map((key) => key.split(':'));
  const variants = [...new Set(gameParts.map((parts) => parts[0]).filter(Boolean))];
  const structures = [...new Set(gameParts.map((parts) => parts[1]).filter(Boolean))];
  const tableTypes = [...new Set(gameParts.map((parts) => parts[2]).filter(Boolean))];
  const hasUnknownMaxPlayers = gameParts.some((parts) => {
    const value = parts[3];
    return value === undefined || value === '' || value === 'unknown' || !Number.isInteger(Number(value));
  });
  const maxPlayers = [...new Set(gameParts
    .map((parts) => Number(parts[3]))
    .filter(Number.isInteger))];
  const from = String(filters.from ?? '').trim();
  const to = String(filters.to ?? '').trim();

  const rows = await fetchAll(
    () => {
      let query = database.from('hands')
        .select('id,external_hand_id,raw_text,played_at,source_ordinal,stakes_label,game_variant,betting_structure,table_type,max_players')
        .eq('library_id', library.id)
        .eq('analysis_supported', true)
        .order('played_at', { ascending: true, nullsFirst: false })
        .order('source_ordinal', { ascending: true })
        .order('external_hand_id', { ascending: true });
      if (from) query = query.gte('played_at', from);
      if (to) query = query.lt('played_at', to);
      if (stakes.length) query = query.in('stakes_label', stakes);
      if (variants.length) query = query.in('game_variant', variants);
      if (structures.length) query = query.in('betting_structure', structures);
      if (tableTypes.length) query = query.in('table_type', tableTypes);
      if (maxPlayers.length && !hasUnknownMaxPlayers) query = query.in('max_players', maxPlayers);
      return query;
    },
    '读取牌谱库筛选结果'
  );

  const hands = parseCloudHandRows(rows).filter((hand) => (
    !gameTypes.length || gameTypes.includes(gameTypeKey(hand))
  ));
  return { library: normalizeLibraryRow(library), hands, filters };
}

export async function deleteCloudSession(sessionId) {
  await requireSignedIn();
  const id = String(sessionId ?? '').trim();
  if (!id) throw new CloudLibraryError('缺少要删除的场次编号。', { code: 'cloud-library/invalid-session-id' });
  const database = getCloudbaseDatabase();
  const session = await runQuery(
    database.from('sessions')
      .select('id,source_import_batch_id')
      .eq('id', id)
      .maybeSingle(),
    '查找要删除的场次'
  );
  if (!session) {
    throw new CloudLibraryError('没有找到这个云牌谱场次，或它已被删除。', {
      code: 'cloud-library/session-not-found'
    });
  }

  const deleted = await runQuery(
    database.from('sessions').delete().eq('id', id).select('id').maybeSingle(),
    '删除云牌谱场次'
  );
  if (!deleted) {
    throw new CloudLibraryError('云牌谱场次没有删除成功，请刷新后重试。', {
      code: 'cloud-library/delete-not-confirmed'
    });
  }

  const cleanupWarnings = [];
  if (session.source_import_batch_id) {
    try {
      await runQuery(
        database.from('import_batches').delete().eq('id', session.source_import_batch_id),
        '清理场次导入记录'
      );
    } catch (error) {
      cleanupWarnings.push(error.message);
    }
  }
  return { sessionId: id, deleted: true, cleanupWarnings };
}
