const DATABASE_NAME = 'k2note-oauth-analysis-drafts';
const DATABASE_VERSION = 1;
const STORE_NAME = 'drafts';
const GOOGLE_LOGIN_DRAFT_ID = 'pending-google-login';
const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_DRAFT_BYTES = 96 * 1024 * 1024;
const encoder = new TextEncoder();

let databasePromise = null;

function draftError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? draftError('本机临时存储请求失败。', 'oauth-draft/request-failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? draftError('本机临时存储事务失败。', 'oauth-draft/transaction-failed'));
    transaction.onabort = () => reject(transaction.error ?? draftError('本机临时存储事务已取消。', 'oauth-draft/transaction-aborted'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) {
    throw draftError('当前浏览器不支持临时保留分析结果，请改用手机号登录或稍后重试。', 'oauth-draft/indexeddb-unavailable');
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? draftError('无法打开本机临时存储。', 'oauth-draft/open-failed'));
      request.onblocked = () => reject(draftError('另一个页面正在更新临时存储，请关闭其他 K2note 页面后重试。', 'oauth-draft/open-blocked'));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function normalizeRawHands(hands) {
  const rawHands = [];
  let totalBytes = 0;
  for (const hand of Array.isArray(hands) ? hands : []) {
    const raw = String(hand?.raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (!raw.startsWith('Poker Hand #')) continue;
    totalBytes += encoder.encode(raw).byteLength;
    if (totalBytes > MAX_DRAFT_BYTES) {
      throw draftError('当前牌谱超过本机 OAuth 临时保留上限，请先保存原文件或改用手机号登录。', 'oauth-draft/too-large');
    }
    rawHands.push(raw);
  }
  if (!rawHands.length) {
    throw draftError('当前没有可临时保留的 GGPoker 牌谱。', 'oauth-draft/no-hands');
  }
  return { rawHands, totalBytes };
}

export async function saveGoogleLoginAnalysisDraft({
  hands,
  hero = '',
  fileMeta = null,
  startTp = '0',
  endTp = '0',
  datasetFilters = null,
  positionFilter = 'all',
  holeCardFilter = null,
  historyTab = 'overview',
  postLoginAction = ''
} = {}) {
  const { rawHands, totalBytes } = normalizeRawHands(hands);
  const now = Date.now();
  const record = {
    id: GOOGLE_LOGIN_DRAFT_ID,
    version: 1,
    createdAt: now,
    expiresAt: now + DRAFT_TTL_MS,
    handCount: rawHands.length,
    totalBytes,
    rawHands,
    hero: String(hero ?? '').slice(0, 256),
    fileMeta: fileMeta && typeof fileMeta === 'object' ? fileMeta : null,
    startTp: String(startTp ?? '0').slice(0, 64),
    endTp: String(endTp ?? '0').slice(0, 64),
    datasetFilters: datasetFilters && typeof datasetFilters === 'object' ? datasetFilters : null,
    positionFilter: String(positionFilter ?? 'all').slice(0, 32),
    holeCardFilter: holeCardFilter && typeof holeCardFilter === 'object' ? holeCardFilter : null,
    historyTab: String(historyTab ?? 'overview').slice(0, 32),
    postLoginAction: postLoginAction === 'open-cloud-save' ? postLoginAction : ''
  };
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(record);
  await transactionDone(transaction);
  return { handCount: record.handCount, totalBytes: record.totalBytes };
}

export async function takeGoogleLoginAnalysisDraft() {
  if (!globalThis.indexedDB) return null;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const record = await requestResult(store.get(GOOGLE_LOGIN_DRAFT_ID));
  if (record) store.delete(GOOGLE_LOGIN_DRAFT_ID);
  await transactionDone(transaction);
  if (
    !record
    || record.version !== 1
    || !Array.isArray(record.rawHands)
    || !record.rawHands.length
    || !Number.isFinite(record.expiresAt)
    || record.expiresAt < Date.now()
  ) return null;
  return record;
}

export async function clearGoogleLoginAnalysisDraft() {
  if (!globalThis.indexedDB) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).delete(GOOGLE_LOGIN_DRAFT_ID);
  await transactionDone(transaction);
}

export async function closeGoogleLoginAnalysisDraftDatabase() {
  if (!databasePromise) return;
  const database = await databasePromise.catch(() => null);
  database?.close();
  databasePromise = null;
}
