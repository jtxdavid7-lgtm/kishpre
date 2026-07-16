import {
  cloudbaseClient,
  getCloudbaseDatabase,
  isAnonymousCloudbaseUser
} from './cloudbaseClient';
import { withAuthMutationLock, withStableAuthSession } from './authMutationLock.js';
import {
  cancelAllArchiveJobs,
  cleanupArchiveQueue,
  createArchiveJob,
  finalizeArchiveJob,
  getArchiveJob,
  listArchiveJobsBySubject,
  removeArchiveJob,
  requestArchiveQueuePersistence,
  resumeArchiveJob,
  runArchiveQueue,
  stageArchiveBatches
} from './operatorArchiveQueue.js';

export const OPERATOR_ARCHIVE_POLICY_VERSION = '2026-07-16-v1';

export const OPERATOR_ARCHIVE_PREFERENCE_KEY = 'k2note:operator-archive-preference';
const DELETE_SECRET_KEY = 'k2note:operator-archive-delete-secret';
const COPY_MARKER_KEY = 'k2note:operator-archive-has-copies';
const MAX_HAND_BYTES = 262_144;
const MAX_BATCH_HANDS = 500;
const MAX_BATCH_BYTES = 700_000;
const HASH_CONCURRENCY = 32;
const encoder = new TextEncoder();

export class OperatorArchiveError extends Error {
  constructor(message, { code = 'operator-archive/request-failed', cause = null } = {}) {
    super(message);
    this.name = 'OperatorArchiveError';
    this.code = code;
    this.cause = cause;
  }
}

function readOperatorArchivePreference() {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(OPERATOR_ARCHIVE_PREFERENCE_KEY) || 'null');
    if (
      value?.choice === 'local-only'
      && value?.policyVersion === OPERATOR_ARCHIVE_POLICY_VERSION
    ) return value;
    if (
      value?.choice === 'accepted'
      && value?.policyVersion === OPERATOR_ARCHIVE_POLICY_VERSION
      && typeof value?.subjectId === 'string'
      && value.subjectId.trim().length > 0
      && typeof value?.consentToken === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.consentToken)
      && typeof value?.acceptedAt === 'string'
      && !Number.isNaN(Date.parse(value.acceptedAt))
    ) return value;
  } catch {
    // A corrupt preference must never be interpreted as consent.
  }
  return null;
}

export function getOperatorArchivePreference() {
  return readOperatorArchivePreference()?.choice ?? null;
}

export function setOperatorArchivePreference(choice, consent = null) {
  if (typeof window === 'undefined') return;
  if (choice !== 'accepted' && choice !== 'local-only') {
    window.localStorage.removeItem(OPERATOR_ARCHIVE_PREFERENCE_KEY);
    return;
  }
  const subjectId = String(consent?.subjectId ?? '').trim();
  const consentToken = String(consent?.consentToken ?? '').trim();
  const acceptedAt = String(consent?.acceptedAt ?? '').trim();
  const validConsent = Boolean(
    subjectId
    && subjectId.length <= 256
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(consentToken)
    && !Number.isNaN(Date.parse(acceptedAt))
  );
  if (choice === 'accepted' && (
    !validConsent
  )) {
    throw new OperatorArchiveError('无法把牌谱保存选择绑定到当前身份。', {
      code: 'operator-archive/invalid-consent-subject'
    });
  }
  window.localStorage.setItem(OPERATOR_ARCHIVE_PREFERENCE_KEY, JSON.stringify({
    choice,
    policyVersion: OPERATOR_ARCHIVE_POLICY_VERSION,
    ...(choice === 'accepted' ? { subjectId, consentToken, acceptedAt } : {}),
    ...(choice === 'local-only' && validConsent ? {
      pendingRevocation: { subjectId, consentToken, acceptedAt }
    } : {}),
    updatedAt: new Date().toISOString()
  }));
}

export function hasOperatorArchiveCopies() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(COPY_MARKER_KEY) === '1';
}

function createClientUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function createDeleteSecret() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function getOrCreateDeleteSecret() {
  const existing = window.localStorage.getItem(DELETE_SECRET_KEY) || '';
  if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  const secret = createDeleteSecret();
  window.localStorage.setItem(DELETE_SECRET_KEY, secret);
  return secret;
}

function cloudbaseUserId(user) {
  return String(user?.id ?? user?.uid ?? user?.sub ?? '').trim();
}

function consentFromPreference(record, decision = 'stored_default') {
  if (record?.choice !== 'accepted') return null;
  return {
    subjectId: record.subjectId,
    consentToken: record.consentToken,
    acceptedAt: record.acceptedAt,
    decision
  };
}

function pendingRevocationFromPreference(record) {
  if (record?.choice === 'accepted') return consentFromPreference(record);
  const pending = record?.pendingRevocation;
  if (!pending || typeof pending !== 'object') return null;
  return {
    subjectId: String(pending.subjectId ?? '').trim(),
    consentToken: String(pending.consentToken ?? '').trim(),
    acceptedAt: String(pending.acceptedAt ?? '').trim(),
    decision: 'stored_default'
  };
}

function consentStillCurrent(consent) {
  const current = readOperatorArchivePreference();
  return current?.choice === 'accepted'
    && current.subjectId === consent?.subjectId
    && current.consentToken === consent?.consentToken
    && current.acceptedAt === consent?.acceptedAt;
}

export async function acceptOperatorArchivePreference() {
  const clientAcceptedAt = new Date().toISOString();
  const consent = await withAuthMutationLock(async () => {
    const authState = await cloudbaseClient.ensureArchiveSession();
    const subjectId = cloudbaseUserId(authState?.user);
    if (!subjectId) {
      throw new OperatorArchiveError('无法确认牌谱副本保存身份。', {
        code: 'operator-archive/missing-user-id'
      });
    }
    const response = await getCloudbaseDatabase().rpc('create_operator_archive_consent', {
      p_delete_secret: getOrCreateDeleteSecret(),
      p_consent_version: OPERATOR_ARCHIVE_POLICY_VERSION,
      p_consent_evidence: {
        granted: true,
        choice: 'explicit_accept',
        notice: 'operator_hand_archive',
        clientAcceptedAt,
        language: document.documentElement.lang || 'zh-CN'
      }
    });
    if (response?.error) throw response.error;
    const result = normalizeRpcData(response?.data);
    const consentToken = String(result.consent_token ?? '').trim();
    const acceptedAt = String(result.accepted_at ?? '').trim();
    return { subjectId, consentToken, acceptedAt, decision: 'explicit_accept' };
  });
  // A newly issued server token invalidates every older generation. Remove
  // their pending device payloads before making the new generation current.
  try {
    await cancelAllArchiveJobs('A new archive consent generation was created.');
  } catch {
    // The server token still prevents stale jobs from being accepted. Queue
    // cleanup will be retried when the runner starts again.
  }
  setOperatorArchivePreference('accepted', consent);
  return consent;
}

export async function resolveOperatorArchiveConsent() {
  const preference = readOperatorArchivePreference();
  if (preference?.choice !== 'accepted') return null;

  const authState = await withStableAuthSession(() => cloudbaseClient.getSession());
  if (cloudbaseUserId(authState?.user) !== preference.subjectId) return null;

  // Re-read after the asynchronous session lookup so another tab can revoke
  // consent without this tab continuing from a stale in-memory choice.
  if (!consentStillCurrent(preference)) return null;
  return consentFromPreference(preference);
}

export async function disableOperatorArchivePreference() {
  const existing = readOperatorArchivePreference();
  const pending = pendingRevocationFromPreference(existing);
  // Stop every tab before waiting for network or an in-flight shared auth lock.
  setOperatorArchivePreference('local-only', pending);
  try {
    await cancelAllArchiveJobs('Operator archive saving was disabled.');
  } catch {
    // Revoking the server token below remains the authoritative stop. The
    // runner also re-checks local consent before every queued request.
  }
  if (!pending?.consentToken) return { revoked: false, localOnly: true };

  try {
    const result = await withAuthMutationLock(async () => {
      await cloudbaseClient.ensureArchiveSession();
      const response = await getCloudbaseDatabase().rpc('revoke_operator_archive_consent', {
        p_consent_token: pending.consentToken,
        p_delete_secret: getOrCreateDeleteSecret()
      });
      if (response?.error) throw response.error;
      return normalizeRpcData(response?.data);
    });
    setOperatorArchivePreference('local-only');
    return { ...result, localOnly: true };
  } catch (error) {
    throw archiveError(error, '已停止本地自动保存，但云端撤回确认失败，请稍后重试。');
  }
}

function normalizeRawText(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').trim();
}

async function sha256(bytes) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new OperatorArchiveError('当前浏览器不支持安全去重，副本未上传。', {
      code: 'operator-archive/crypto-unavailable'
    });
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeRpcData(data) {
  if (Array.isArray(data)) return data[0] ?? {};
  return data && typeof data === 'object' ? data : {};
}

function archiveError(error, fallback = '牌谱副本保存失败。') {
  if (error instanceof OperatorArchiveError) return error;
  const message = String(error?.message ?? '').trim();
  return new OperatorArchiveError(message || fallback, {
    code: String(error?.code ?? error?.name ?? 'operator-archive/request-failed'),
    cause: error
  });
}

function notify(onProgress, completed, total, message) {
  try {
    onProgress?.({ completed, total, message });
  } catch {
    // Progress UI must never interrupt the archive operation.
  }
}

async function buildRows(hands, start, end) {
  const rows = [];
  for (let offset = start; offset < end; offset += HASH_CONCURRENCY) {
    const candidates = hands.slice(offset, Math.min(end, offset + HASH_CONCURRENCY)).map((hand, index) => {
      const rawText = normalizeRawText(hand?.raw);
      const rawBytes = encoder.encode(rawText);
      if (!rawText.startsWith('Poker Hand #')) {
        throw new OperatorArchiveError(`第 ${offset + index + 1} 手牌不是可识别的 GGPoker 原始牌谱。`, {
          code: 'operator-archive/invalid-hand'
        });
      }
      if (rawBytes.byteLength > MAX_HAND_BYTES) {
        throw new OperatorArchiveError(`第 ${offset + index + 1} 手牌超过云端单手大小限制。`, {
          code: 'operator-archive/hand-too-large'
        });
      }
      const externalHandId = String(hand?.id ?? '').trim();
      if (!externalHandId || externalHandId.length > 128) {
        throw new OperatorArchiveError(`第 ${offset + index + 1} 手牌缺少有效牌局号码。`, {
          code: 'operator-archive/invalid-hand-id'
        });
      }
      return { rawText, rawBytes, externalHandId };
    });
    const hashes = await Promise.all(candidates.map((candidate) => sha256(candidate.rawBytes)));
    candidates.forEach((candidate, index) => rows.push({
      external_hand_id: candidate.externalHandId,
      content_sha256: hashes[index],
      raw_text: candidate.rawText
    }));
  }
  return rows;
}

function splitRowsByPayload(rows) {
  const result = [];
  let current = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (current.length && (
      current.length >= MAX_BATCH_HANDS
      || currentBytes + rowBytes > MAX_BATCH_BYTES
    )) {
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

export async function archiveImportedHands({ hands, consent, onProgress } = {}) {
  const inputHands = Array.isArray(hands) ? hands.filter(Boolean) : [];
  if (!inputHands.length) {
    return {
      status: 'completed',
      completedCount: 0,
      queuedCount: 0,
      totalCount: 0,
      durable: true
    };
  }

  notify(onProgress, 0, inputHands.length, '正在准备牌谱副本…');
  let activeStagingJobId = null;
  try {
    const authState = await withAuthMutationLock(() => cloudbaseClient.ensureArchiveSession());
    const archiveUserId = cloudbaseUserId(authState.user);
    if (!archiveUserId) {
      throw new OperatorArchiveError('无法确认牌谱副本保存身份。', {
        code: 'operator-archive/missing-user-id'
      });
    }
    if (
      !consent
      || archiveUserId !== consent.subjectId
      || !consentStillCurrent(consent)
      || !['explicit_accept', 'stored_default'].includes(consent.decision)
    ) {
      throw new OperatorArchiveError('当前牌谱保存同意与登录身份不匹配，副本未上传。', {
        code: 'operator-archive/consent-mismatch'
      });
    }
    const importId = createClientUuid();
    const deleteSecret = getOrCreateDeleteSecret();
    const consentEvidence = {
      granted: true,
      source: 'k2note-browser-import',
      choice: consent.decision,
      notice: 'operator_hand_archive',
      importId,
      authenticated: !isAnonymousCloudbaseUser(authState.user),
      acceptedAt: consent.acceptedAt,
      language: globalThis.document?.documentElement?.lang || 'zh-CN'
    };
    await Promise.allSettled([
      cleanupArchiveQueue(),
      requestArchiveQueuePersistence()
    ]);

    const jobIds = [];
    let stagedHands = 0;

    // Finalize each payload as its own runnable job. If the page or computer
    // closes during a very large import, every already-finalized payload can
    // still resume instead of the whole import remaining trapped in staging.
    for (let start = 0; start < inputHands.length; start += MAX_BATCH_HANDS) {
      if (!consentStillCurrent(consent)) {
        throw new OperatorArchiveError('牌谱保存已在本设备关闭，未完成的本地待传副本已停止。', {
          code: 'operator-archive/consent-revoked'
        });
      }
      const rows = await buildRows(
        inputHands,
        start,
        Math.min(inputHands.length, start + MAX_BATCH_HANDS)
      );
      for (const payload of splitRowsByPayload(rows)) {
        if (!consentStillCurrent(consent)) {
          throw new OperatorArchiveError('牌谱保存已在本设备关闭，未完成的本地待传副本已停止。', {
            code: 'operator-archive/consent-revoked'
          });
        }
        const job = await createArchiveJob({
          importId,
          subjectId: archiveUserId,
          policyVersion: OPERATOR_ARCHIVE_POLICY_VERSION,
          consentToken: consent.consentToken,
          acceptedAt: consent.acceptedAt,
          consentEvidence,
          deleteSecret,
          totalHands: payload.length
        });
        activeStagingJobId = job.id;
        if (!consentStillCurrent(consent)) {
          throw new OperatorArchiveError('牌谱保存已在本设备关闭，未完成的本地待传副本已停止。', {
            code: 'operator-archive/consent-revoked'
          });
        }
        await stageArchiveBatches(job.id, [{
          batchIndex: 0,
          clientBatchId: createClientUuid(),
          payload
        }]);
        await finalizeArchiveJob(job.id, {
          expectedBatchCount: 1,
          expectedHandCount: payload.length
        });
        if (!consentStillCurrent(consent)) {
          throw new OperatorArchiveError('牌谱保存已在本设备关闭，未完成的本地待传副本已停止。', {
            code: 'operator-archive/consent-revoked'
          });
        }
        activeStagingJobId = null;
        jobIds.push(job.id);
        stagedHands += payload.length;
        notify(
          onProgress,
          stagedHands,
          inputHands.length,
          `已建立续传任务 ${stagedHands.toLocaleString()} / ${inputHands.length.toLocaleString()}`
        );
      }
    }

    const runner = await runOperatorArchiveQueueForConsent(consent, {
      onProgress,
      focusImportId: importId,
      focusTotal: inputHands.length
    });
    const storedJobs = (await Promise.all(jobIds.map((jobId) => getArchiveJob(jobId)))).filter(Boolean);
    const completedCount = storedJobs.reduce(
      (sum, storedJob) => sum + Number(storedJob.completedHands ?? 0),
      0
    );
    const discardedCount = storedJobs.reduce(
      (sum, storedJob) => sum + (
        storedJob.status === 'cancelled'
          ? Math.max(0, Number(storedJob.totalHands ?? 0) - Number(storedJob.completedHands ?? 0))
          : 0
      ),
      0
    );
    let status = 'ready';
    if (storedJobs.length && storedJobs.every((storedJob) => storedJob.status === 'completed')) {
      status = 'completed';
    } else if (storedJobs.some((storedJob) => storedJob.status === 'paused')) {
      status = 'paused';
    } else if (storedJobs.some((storedJob) => storedJob.status === 'cancelled')) {
      status = 'cancelled';
    } else if (storedJobs.some((storedJob) => storedJob.status === 'retry')) {
      status = 'retry';
    }
    return {
      importId,
      jobId: jobIds[0] ?? null,
      jobIds,
      status,
      completedCount,
      queuedCount: Math.max(0, inputHands.length - completedCount - discardedCount),
      discardedCount,
      totalCount: inputHands.length,
      durable: true,
      runnerAcquired: runner?.acquired === true
    };
  } catch (error) {
    if (activeStagingJobId) {
      try {
        await removeArchiveJob(activeStagingJobId, { force: true });
      } catch {
        // Stale staging jobs are ignored by the runner and removed by cleanup.
      }
    }
    throw archiveError(error);
  }
}

function queueJobMatchesConsent(job, consent) {
  const preference = readOperatorArchivePreference();
  return preference?.choice === 'accepted'
    && preference.policyVersion === OPERATOR_ARCHIVE_POLICY_VERSION
    && preference.subjectId === consent?.subjectId
    && preference.consentToken === consent?.consentToken
    && preference.acceptedAt === consent?.acceptedAt
    && job?.subjectId === consent?.subjectId
    && job?.policyVersion === OPERATOR_ARCHIVE_POLICY_VERSION
    && job?.consentToken === consent?.consentToken
    && job?.acceptedAt === consent?.acceptedAt;
}

async function runOperatorArchiveQueueForConsent(
  consent,
  { onProgress, focusImportId = null, focusTotal = 0 } = {}
) {
  if (!consent?.subjectId || !consentStillCurrent(consent)) {
    return { acquired: false, reason: 'consent-mismatch' };
  }
  const database = getCloudbaseDatabase();
  let focusedCompleted = 0;
  return runArchiveQueue({
    subjectId: consent.subjectId,
    waitForRetries: false,
    canUploadJob: (job) => (
      queueJobMatchesConsent(job, consent)
        ? { allowed: true }
        : {
            allowed: false,
            action: 'cancel',
            reason: 'Archive consent or identity no longer matches this durable job.'
          }
    ),
    uploadBatch: async ({ job, batch }) => {
      const response = await withStableAuthSession(async () => {
        const current = await cloudbaseClient.getSession();
        if (cloudbaseUserId(current?.user) !== job.subjectId) {
          throw new OperatorArchiveError('登录状态已变化，牌谱副本已保留在本机等待恢复。', {
            code: 'operator-archive/auth-changed'
          });
        }
        if (!queueJobMatchesConsent(job, consent)) {
          throw new OperatorArchiveError('牌谱保存已在本设备关闭，已停止继续上传副本。', {
            code: 'operator-archive/consent-revoked'
          });
        }
        return database.rpc('ingest_operator_hand_archive', {
          p_client_batch_id: batch.clientBatchId,
          p_consent_token: job.consentToken,
          p_consent_version: job.policyVersion,
          p_consent_evidence: job.consentEvidence,
          p_delete_secret: job.deleteSecret,
          p_hands: batch.payload
        });
      });
      if (response?.error) throw response.error;
      window.localStorage.setItem(COPY_MARKER_KEY, '1');
      return normalizeRpcData(response?.data);
    },
    onProgress: (event) => {
      if (event?.type !== 'uploaded' || !event.job) return;
      if (focusImportId && event.job.importId !== focusImportId) return;
      if (focusImportId) focusedCompleted += Number(event.completedHands ?? 0);
      const completed = focusImportId
        ? focusedCompleted
        : Number(event.job.completedHands ?? 0);
      const total = focusImportId
        ? Number(focusTotal ?? 0)
        : Number(event.job.totalHands ?? 0);
      notify(
        onProgress,
        completed,
        total,
        `已保存 ${completed.toLocaleString()} / ${total.toLocaleString()} 手牌副本`
      );
    }
  });
}

export async function resumeOperatorArchiveQueue({ onProgress } = {}) {
  const consent = await resolveOperatorArchiveConsent();
  if (!consent) return { skipped: true, reason: 'no-current-consent' };

  await Promise.allSettled([
    cleanupArchiveQueue(),
    requestArchiveQueuePersistence()
  ]);
  const pausedJobs = await listArchiveJobsBySubject(consent.subjectId, {
    statuses: ['paused'],
    limit: 1000
  });
  const resumableCodes = new Set([
    'operator-archive/auth-changed',
    'operator-archive/missing-user-id',
    '54000',
    'job-paused'
  ]);
  await Promise.all(pausedJobs
    .filter((job) => (
      queueJobMatchesConsent(job, consent)
      && resumableCodes.has(String(job?.lastError?.code ?? ''))
    ))
    .map((job) => resumeArchiveJob(job.id)));

  return runOperatorArchiveQueueForConsent(consent, { onProgress });
}

export async function deleteMyOperatorArchive() {
  const pending = pendingRevocationFromPreference(readOperatorArchivePreference());
  setOperatorArchivePreference('local-only', pending);
  try {
    try {
      await cancelAllArchiveJobs('Operator archive copies were deleted.');
    } catch {
      // The server deletion is still authoritative; queued requests also fail
      // their local consent check and their server token validation.
    }
    await withAuthMutationLock(() => cloudbaseClient.ensureArchiveSession());
    const response = await getCloudbaseDatabase().rpc('delete_operator_hand_archive_by_secret', {
      p_delete_secret: getOrCreateDeleteSecret()
    });
    if (response?.error) throw response.error;
    const result = normalizeRpcData(response?.data);
    setOperatorArchivePreference('local-only');
    window.localStorage.removeItem(COPY_MARKER_KEY);
    return result;
  } catch (error) {
    throw archiveError(error, '删除牌谱副本失败。');
  }
}
