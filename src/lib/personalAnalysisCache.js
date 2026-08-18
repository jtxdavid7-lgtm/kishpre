const DATABASE_NAME = 'k2note-personal-analysis-cache';
const DATABASE_VERSION = 1;
const META_STORE = 'session_meta';
const CHUNK_STORE = 'session_chunks';
const CACHE_FORMAT = 'hero-results-v1';
const RESULT_CHUNK_SIZE = 1000;

let databasePromise = null;

const PREFLOP_BOOLEAN_KEYS = [
  'heroVoluntary',
  'heroRaise',
  'heroThreeBetOpportunity',
  'heroFacingRaise',
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

const POSTFLOP_BOOLEAN_KEYS = [
  'cbetOpportunity',
  'cbet',
  'cbetIpOpportunity',
  'cbetIp',
  'cbetOopOpportunity',
  'cbetOop',
  'foldToCbetOpportunity',
  'foldToCbet',
  'foldToCbetIpOpportunity',
  'foldToCbetIp',
  'foldToCbetOopOpportunity',
  'foldToCbetOop',
  'donkOpportunity',
  'donk',
  'checkResponseOpportunity',
  'checkCall',
  'checkRaise'
];

function cacheError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedIdentity(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw cacheError(`缺少${field}，无法使用本机分析缓存。`, 'personal-analysis-cache/invalid-scope');
  return normalized;
}

function cacheOwner(subjectId, libraryId) {
  return JSON.stringify([
    normalizedIdentity(subjectId, '用户身份'),
    normalizedIdentity(libraryId, '牌谱库编号')
  ]);
}

function cacheScope(subjectId, libraryId, consentToken) {
  return JSON.stringify([
    CACHE_FORMAT,
    normalizedIdentity(subjectId, '用户身份'),
    normalizedIdentity(libraryId, '牌谱库编号'),
    normalizedIdentity(consentToken, '贡献授权')
  ]);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? cacheError('本机分析缓存请求失败。', 'personal-analysis-cache/request-failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? cacheError('本机分析缓存事务失败。', 'personal-analysis-cache/transaction-failed'));
    transaction.onabort = () => reject(transaction.error ?? cacheError('本机分析缓存事务已取消。', 'personal-analysis-cache/transaction-aborted'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) {
    throw cacheError('当前浏览器不支持本机分析缓存。', 'personal-analysis-cache/indexeddb-unavailable');
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(META_STORE)) {
          const meta = database.createObjectStore(META_STORE, { keyPath: 'key' });
          meta.createIndex('scope', 'scope', { unique: false });
          meta.createIndex('owner', 'owner', { unique: false });
        }
        if (!database.objectStoreNames.contains(CHUNK_STORE)) {
          const chunks = database.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
          chunks.createIndex('scope', 'scope', { unique: false });
          chunks.createIndex('owner', 'owner', { unique: false });
          chunks.createIndex('sessionKey', 'sessionKey', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? cacheError('无法打开本机分析缓存。', 'personal-analysis-cache/open-failed'));
      request.onblocked = () => reject(cacheError('另一个 K2note 页面正在升级分析缓存，请关闭其他页面后重试。', 'personal-analysis-cache/open-blocked'));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compactPostflop(postflop) {
  const compact = {};
  for (const street of ['flop', 'turn', 'river']) {
    const source = postflop?.[street];
    if (!source || typeof source !== 'object') continue;
    compact[street] = Object.fromEntries(POSTFLOP_BOOLEAN_KEYS.map((key) => [key, Boolean(source[key])]));
  }
  return compact;
}

/**
 * Keeps only fields needed by the long-term report and its local filters.
 * Raw text, filenames, hole cards, boards, winners and action logs are never cached here.
 */
export function compactPersonalAnalysisResult(result) {
  if (!result || typeof result !== 'object') return null;
  const compact = {
    date: String(result.date ?? ''),
    stakes: String(result.stakes ?? ''),
    bb: finiteNumber(result.bb, 1) || 1,
    gameVariant: String(result.gameVariant ?? 'unknown'),
    bettingStructure: String(result.bettingStructure ?? 'unknown'),
    tableType: String(result.tableType ?? 'unknown'),
    maxPlayers: Number.isInteger(Number(result.maxPlayers)) ? Number(result.maxPlayers) : null,
    analysisSupported: result.analysisSupported !== false,
    position: String(result.position ?? ''),
    profit: finiteNumber(result.profit),
    profitBB: finiteNumber(result.profitBB),
    rake: finiteNumber(result.rake),
    jackpot: finiteNumber(result.jackpot),
    allInEvBeforeRakeBB: Number.isFinite(Number(result.allInEvBeforeRakeBB))
      ? Number(result.allInEvBeforeRakeBB)
      : null,
    allInEvOpportunity: Boolean(result.allInEvOpportunity),
    allInEvCovered: Boolean(result.allInEvCovered),
    allInEvMethod: String(result.allInEvMethod ?? ''),
    sawFlop: Boolean(result.sawFlop),
    wentToShowdown: Boolean(result.wentToShowdown),
    wonAtShowdown: Boolean(result.wonAtShowdown),
    wonWhenSawFlop: Boolean(result.wonWhenSawFlop),
    postflop: compactPostflop(result.postflop)
  };
  for (const key of PREFLOP_BOOLEAN_KEYS) compact[key] = Boolean(result[key]);
  return compact;
}

export function personalAnalysisSessionSignature(session) {
  return JSON.stringify([
    CACHE_FORMAT,
    String(session?.id ?? ''),
    Number(session?.handCount ?? 0),
    String(session?.hero ?? ''),
    String(session?.startedAt ?? ''),
    String(session?.endedAt ?? ''),
    String(session?.createdAt ?? '')
  ]);
}

function sessionKeyFor(scope, sessionId) {
  return JSON.stringify([scope, normalizedIdentity(sessionId, 'Session 编号')]);
}

async function recordsByIndex(storeName, indexName, value) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const request = transaction.objectStore(storeName).index(indexName).getAll(value);
  const records = await requestResult(request);
  await transactionDone(transaction);
  return Array.isArray(records) ? records : [];
}

export async function loadPersonalAnalysisCache({ subjectId, libraryId, consentToken, sessions = [] } = {}) {
  const scope = cacheScope(subjectId, libraryId, consentToken);
  const expected = new Map((Array.isArray(sessions) ? sessions : []).map((session) => [
    String(session?.id ?? ''),
    personalAnalysisSessionSignature(session)
  ]));
  const metaRecords = await recordsByIndex(META_STORE, 'scope', scope);
  const validMeta = metaRecords.filter((record) => (
    expected.get(String(record.sessionId ?? '')) === record.signature
  ));
  const validSessionKeys = new Set(validMeta.map((record) => record.sessionKey));
  const chunks = (await recordsByIndex(CHUNK_STORE, 'scope', scope))
    .filter((record) => validSessionKeys.has(record.sessionKey))
    .sort((first, second) => (
      String(first.sessionId).localeCompare(String(second.sessionId))
      || Number(first.chunkIndex) - Number(second.chunkIndex)
    ));
  return {
    results: chunks.flatMap((record) => Array.isArray(record.results) ? record.results : []),
    cachedSessionIds: validMeta.map((record) => String(record.sessionId)),
    cachedSourceHandCount: validMeta.reduce((sum, record) => sum + Number(record.sourceHandCount ?? 0), 0),
    cachedResultCount: validMeta.reduce((sum, record) => sum + Number(record.resultCount ?? 0), 0)
  };
}

async function deleteRecordsBySessionKeys(transaction, storeName, sessionKeys) {
  const store = transaction.objectStore(storeName);
  const keys = await Promise.all([...sessionKeys].map((sessionKey) => (
    requestResult(store.index('sessionKey').getAllKeys(sessionKey))
  )));
  for (const key of keys.flat()) store.delete(key);
}

export async function savePersonalAnalysisSessions({
  subjectId,
  libraryId,
  consentToken,
  entries = []
} = {}) {
  const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => {
    const sessionId = normalizedIdentity(entry?.session?.id, 'Session 编号');
    const results = (Array.isArray(entry?.results) ? entry.results : [])
      .map(compactPersonalAnalysisResult)
      .filter(Boolean);
    return {
      sessionId,
      session: entry.session,
      sourceHandCount: Math.max(0, Number(entry?.sourceHandCount ?? entry?.session?.handCount ?? results.length) || 0),
      results
    };
  });
  if (!normalizedEntries.length) return { sessions: 0, results: 0 };

  const owner = cacheOwner(subjectId, libraryId);
  const scope = cacheScope(subjectId, libraryId, consentToken);
  const sessionKeys = new Set(normalizedEntries.map((entry) => sessionKeyFor(scope, entry.sessionId)));
  const database = await openDatabase();
  const transaction = database.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  const metaStore = transaction.objectStore(META_STORE);
  const chunkStore = transaction.objectStore(CHUNK_STORE);

  for (const sessionKey of sessionKeys) metaStore.delete(sessionKey);
  await deleteRecordsBySessionKeys(transaction, CHUNK_STORE, sessionKeys);

  for (const entry of normalizedEntries) {
    const sessionKey = sessionKeyFor(scope, entry.sessionId);
    const chunks = [];
    for (let offset = 0; offset < entry.results.length; offset += RESULT_CHUNK_SIZE) {
      chunks.push(entry.results.slice(offset, offset + RESULT_CHUNK_SIZE));
    }
    metaStore.put({
      key: sessionKey,
      sessionKey,
      owner,
      scope,
      sessionId: entry.sessionId,
      signature: personalAnalysisSessionSignature(entry.session),
      sourceHandCount: entry.sourceHandCount,
      resultCount: entry.results.length,
      chunkCount: chunks.length,
      updatedAt: Date.now()
    });
    chunks.forEach((results, chunkIndex) => chunkStore.put({
      key: JSON.stringify([sessionKey, chunkIndex]),
      sessionKey,
      owner,
      scope,
      sessionId: entry.sessionId,
      chunkIndex,
      results
    }));
  }
  await transactionDone(transaction);
  return {
    sessions: normalizedEntries.length,
    results: normalizedEntries.reduce((sum, entry) => sum + entry.results.length, 0)
  };
}

export async function prunePersonalAnalysisCache({ subjectId, libraryId, consentToken, activeSessionIds = [] } = {}) {
  const scope = cacheScope(subjectId, libraryId, consentToken);
  const active = new Set((Array.isArray(activeSessionIds) ? activeSessionIds : []).map(String));
  const metas = await recordsByIndex(META_STORE, 'scope', scope);
  const staleKeys = new Set(metas
    .filter((record) => !active.has(String(record.sessionId)))
    .map((record) => record.sessionKey));
  if (!staleKeys.size) return 0;
  const database = await openDatabase();
  const transaction = database.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  for (const sessionKey of staleKeys) transaction.objectStore(META_STORE).delete(sessionKey);
  await deleteRecordsBySessionKeys(transaction, CHUNK_STORE, staleKeys);
  await transactionDone(transaction);
  return staleKeys.size;
}

export async function clearPersonalAnalysisCache({ subjectId, libraryId } = {}) {
  const owner = cacheOwner(subjectId, libraryId);
  const [metas, chunks] = await Promise.all([
    recordsByIndex(META_STORE, 'owner', owner),
    recordsByIndex(CHUNK_STORE, 'owner', owner)
  ]);
  if (!metas.length && !chunks.length) return 0;
  const database = await openDatabase();
  const transaction = database.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  const metaStore = transaction.objectStore(META_STORE);
  const chunkStore = transaction.objectStore(CHUNK_STORE);
  metas.forEach((record) => metaStore.delete(record.key));
  chunks.forEach((record) => chunkStore.delete(record.key));
  await transactionDone(transaction);
  return metas.length;
}

export async function closePersonalAnalysisCacheDatabase() {
  if (!databasePromise) return;
  const database = await databasePromise.catch(() => null);
  database?.close();
  databasePromise = null;
}
