/**
 * Durable browser queue for opted-in operator hand-history contributions.
 *
 * The queue deliberately knows nothing about local source files and never
 * stores a filename or filesystem path. Only the already-normalized RPC rows
 * (external_hand_id, content_sha256, raw_text) are persisted.
 *
 * Exactly-once effect is obtained with this order:
 *   1. Persist a batch and its stable clientBatchId in IndexedDB.
 *   2. Send that exact stored batch to the idempotent CloudBase RPC.
 *   3. In one IndexedDB transaction, delete the acknowledged raw batch and
 *      increment the parent job's completed counters.
 *
 * If the page exits after the server commit but before step 3, the same
 * clientBatchId and payload are sent again and the server returns its
 * idempotent result. Completed raw payloads are removed immediately.
 */

const DATABASE_NAME = 'k2note-operator-archive-queue';
const DATABASE_VERSION = 1;
const JOB_STORE = 'jobs';
const BATCH_STORE = 'batches';
const LEASE_STORE = 'leases';
const RUNNER_LOCK_NAME = 'k2note:operator-archive-queue-runner';
const RUNNER_LEASE_NAME = 'operator-archive-runner';
const DEFAULT_RUNNER_LEASE_MS = 30_000;
const DEFAULT_BATCH_CLAIM_MS = 5 * 60_000;
const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_TERMINAL_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_BATCH_HANDS = 500;
const MAX_BATCH_BYTES = 700_000;
const MAX_STAGE_BATCHES_PER_TRANSACTION = 8;
const encoder = new TextEncoder();

const RUNNABLE_JOB_STATUSES = new Set(['ready', 'retry']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'cancelled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DELETE_SECRET_PATTERN = /^[0-9a-f]{64}$/;

let databasePromise = null;

export class OperatorArchiveQueueError extends Error {
  constructor(message, { code = 'operator-archive-queue/error', cause = null } = {}) {
    super(message);
    this.name = 'OperatorArchiveQueueError';
    this.code = code;
    this.cause = cause;
  }
}

function queueError(message, code, cause = null) {
  return new OperatorArchiveQueueError(message, { code, cause });
}

function nowMs() {
  return Date.now();
}

function createUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw queueError('Secure random UUID generation is unavailable.', 'operator-archive-queue/crypto-unavailable');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function requiredString(value, field, maxLength = 256) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw queueError(`${field} is missing or invalid.`, `operator-archive-queue/invalid-${field}`);
  }
  return normalized;
}

function validTimestamp(value, field) {
  const normalized = requiredString(value, field, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw queueError(`${field} is not a valid timestamp.`, `operator-archive-queue/invalid-${field}`);
  }
  return normalized;
}

function positiveInteger(value, field, { allowZero = false } = {}) {
  const normalized = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw queueError(`${field} must be an integer of at least ${minimum}.`, `operator-archive-queue/invalid-${field}`);
  }
  return normalized;
}

function normalizeConsentEvidence(evidence, { importId, acceptedAt }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw queueError('Consent evidence is required.', 'operator-archive-queue/invalid-consent');
  }

  const normalized = {
    granted: evidence.granted === true,
    source: requiredString(evidence.source, 'consent-source', 128),
    choice: requiredString(evidence.choice, 'consent-choice', 64),
    notice: requiredString(evidence.notice, 'consent-notice', 128),
    importId: requiredString(evidence.importId ?? importId, 'consent-import-id', 128),
    authenticated: evidence.authenticated === true,
    acceptedAt: validTimestamp(evidence.acceptedAt ?? acceptedAt, 'consent-accepted-at'),
    language: requiredString(evidence.language ?? 'zh-CN', 'consent-language', 32)
  };

  if (!normalized.granted || normalized.importId !== importId || normalized.acceptedAt !== acceptedAt) {
    throw queueError('Consent evidence does not match the archive job.', 'operator-archive-queue/consent-mismatch');
  }
  return normalized;
}

function normalizePayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw queueError('A non-empty hand payload is required.', 'operator-archive-queue/invalid-payload');
  }
  return payload.map((row, index) => {
    const externalHandId = requiredString(row?.external_hand_id, `hand-${index}-id`, 128);
    const contentSha256 = String(row?.content_sha256 ?? '').trim();
    const rawText = String(row?.raw_text ?? '');
    if (!SHA256_PATTERN.test(contentSha256)) {
      throw queueError(`Hand ${index + 1} has an invalid SHA-256.`, 'operator-archive-queue/invalid-hand-sha');
    }
    if (!rawText.startsWith('Poker Hand #')) {
      throw queueError(`Hand ${index + 1} is not a recognized raw GG hand.`, 'operator-archive-queue/invalid-hand-text');
    }

    // Explicit field projection prevents accidental persistence of filenames,
    // parser objects, local paths, or other import metadata.
    return {
      external_hand_id: externalHandId,
      content_sha256: contentSha256,
      raw_text: rawText
    };
  });
}

function publicJob(job) {
  if (!job) return null;
  const { deleteSecret: _deleteSecret, ...safeJob } = job;
  return safeJob;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? queueError('IndexedDB request failed.', 'operator-archive-queue/indexeddb-request'));
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? queueError('IndexedDB transaction was aborted.', 'operator-archive-queue/indexeddb-abort'));
    transaction.onerror = () => {
      // onabort provides the final transaction error.
    };
  });
}

function walkCursor(request, visit) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? queueError('IndexedDB cursor failed.', 'operator-archive-queue/indexeddb-cursor'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        visit(cursor);
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

function findCursorValue(request, predicate) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? queueError('IndexedDB cursor failed.', 'operator-archive-queue/indexeddb-cursor'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(null);
        return;
      }
      try {
        if (predicate(cursor.value)) resolve(cursor.value);
        else cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) {
    return Promise.reject(queueError('IndexedDB is unavailable in this browser.', 'operator-archive-queue/indexeddb-unavailable'));
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(JOB_STORE)) {
        const jobs = database.createObjectStore(JOB_STORE, { keyPath: 'id' });
        jobs.createIndex('bySubject', 'subjectId', { unique: false });
        jobs.createIndex('byStatus', 'status', { unique: false });
        jobs.createIndex('bySubjectCreated', ['subjectId', 'createdAt'], { unique: false });
      }
      if (!database.objectStoreNames.contains(BATCH_STORE)) {
        const batches = database.createObjectStore(BATCH_STORE, { keyPath: 'id' });
        batches.createIndex('byJob', 'jobId', { unique: false });
        batches.createIndex('byJobIndex', ['jobId', 'batchIndex'], { unique: true });
        batches.createIndex('byJobClientBatch', ['jobId', 'clientBatchId'], { unique: true });
        batches.createIndex('byJobStatus', ['jobId', 'status'], { unique: false });
      }
      if (!database.objectStoreNames.contains(LEASE_STORE)) {
        database.createObjectStore(LEASE_STORE, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      databasePromise = null;
      reject(request.error ?? queueError('Unable to open the archive queue.', 'operator-archive-queue/indexeddb-open'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      databasePromise = null;
      reject(queueError('Archive queue upgrade is blocked by another tab.', 'operator-archive-queue/indexeddb-blocked'));
    };
  });
  return databasePromise;
}

async function withTransaction(storeNames, mode, operation) {
  const database = await openDatabase();
  const transaction = database.transaction(storeNames, mode);
  const completion = transactionCompletion(transaction);
  const stores = Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]));
  try {
    const result = await operation(stores, transaction);
    await completion;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted or completed.
    }
    await completion.catch(() => {});
    if (error instanceof OperatorArchiveQueueError) throw error;
    throw queueError(error?.message || 'Archive queue transaction failed.', 'operator-archive-queue/transaction-failed', error);
  }
}

function deleteBatchesForJob(batchStore, jobId) {
  const range = globalThis.IDBKeyRange.only(jobId);
  return walkCursor(batchStore.index('byJob').openCursor(range), (cursor) => cursor.delete());
}

function jobsForSubjectRequest(jobStore, subjectId) {
  if (!subjectId) return jobStore.getAll();
  return jobStore.index('bySubject').getAll(globalThis.IDBKeyRange.only(subjectId));
}

/**
 * Creates a durable job in `staging` state. No upload runner will see it until
 * `finalizeArchiveJob` verifies that every expected batch was persisted.
 * The delete secret is device-local queue state and is never returned by the
 * public query APIs. The server-issued consent token is stored with the job so
 * a reload never has to manufacture or silently rebind consent.
 */
export async function createArchiveJob({
  id = createUuid(),
  importId = createUuid(),
  subjectId,
  policyVersion,
  consentToken,
  acceptedAt,
  consentEvidence,
  deleteSecret,
  totalHands
} = {}) {
  const normalizedId = requiredString(id, 'job-id', 128);
  const normalizedImportId = requiredString(importId, 'import-id', 128);
  const normalizedSubjectId = requiredString(subjectId, 'subject-id', 256);
  const normalizedPolicyVersion = requiredString(policyVersion, 'policy-version', 64);
  const normalizedConsentToken = requiredString(consentToken, 'consent-token', 128);
  if (!UUID_PATTERN.test(normalizedConsentToken)) {
    throw queueError('consentToken must be a UUID.', 'operator-archive-queue/invalid-consent-token');
  }
  const normalizedAcceptedAt = validTimestamp(acceptedAt, 'accepted-at');
  const normalizedDeleteSecret = String(deleteSecret ?? '').trim();
  const normalizedTotalHands = positiveInteger(totalHands, 'total-hands');
  if (!DELETE_SECRET_PATTERN.test(normalizedDeleteSecret)) {
    throw queueError('The archive delete secret is invalid.', 'operator-archive-queue/invalid-delete-secret');
  }
  const normalizedEvidence = normalizeConsentEvidence(consentEvidence, {
    importId: normalizedImportId,
    acceptedAt: normalizedAcceptedAt
  });
  const timestamp = nowMs();
  const job = {
    id: normalizedId,
    importId: normalizedImportId,
    subjectId: normalizedSubjectId,
    policyVersion: normalizedPolicyVersion,
    consentToken: normalizedConsentToken,
    acceptedAt: normalizedAcceptedAt,
    consentEvidence: normalizedEvidence,
    deleteSecret: normalizedDeleteSecret,
    status: 'staging',
    totalHands: normalizedTotalHands,
    totalBatches: 0,
    stagedHands: 0,
    stagedBatches: 0,
    completedHands: 0,
    completedBatches: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    readyAt: null,
    completedAt: null,
    cancelledAt: null
  };

  return withTransaction([JOB_STORE], 'readwrite', async ({ jobs }) => {
    const existing = await requestResult(jobs.get(normalizedId));
    if (existing) {
      const sameJob = existing.importId === job.importId
        && existing.subjectId === job.subjectId
        && existing.policyVersion === job.policyVersion
        && existing.consentToken === job.consentToken
        && existing.acceptedAt === job.acceptedAt
        && existing.deleteSecret === job.deleteSecret
        && existing.totalHands === job.totalHands;
      if (!sameJob) {
        throw queueError('The archive job id is already used by a different job.', 'operator-archive-queue/job-conflict');
      }
      return publicJob(existing);
    }
    await requestResult(jobs.add(job));
    return publicJob(job);
  });
}

function normalizeStagedBatch(jobId, batch) {
  const batchIndex = positiveInteger(batch?.batchIndex, 'batch-index', { allowZero: true });
  const clientBatchId = requiredString(batch?.clientBatchId, 'client-batch-id', 128);
  if (!UUID_PATTERN.test(clientBatchId)) {
    throw queueError('clientBatchId must be a UUID.', 'operator-archive-queue/invalid-client-batch-id');
  }
  if (Array.isArray(batch?.payload) && batch.payload.length > MAX_BATCH_HANDS) {
    throw queueError(
      `A durable batch may contain at most ${MAX_BATCH_HANDS} hands.`,
      'operator-archive-queue/batch-too-large'
    );
  }
  const payload = normalizePayload(batch?.payload);
  const payloadBytes = encoder.encode(JSON.stringify(payload)).byteLength;
  if (payload.length > MAX_BATCH_HANDS || payloadBytes > MAX_BATCH_BYTES) {
    throw queueError(
      `A durable batch may contain at most ${MAX_BATCH_HANDS} hands and ${MAX_BATCH_BYTES} bytes.`,
      'operator-archive-queue/batch-too-large'
    );
  }
  return {
    id: `${jobId}:${batchIndex}`,
    jobId,
    batchIndex,
    clientBatchId,
    payload,
    handCount: payload.length,
    payloadBytes,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    claimOwner: null,
    claimToken: null,
    claimExpiresAt: 0,
    createdAt: nowMs(),
    updatedAt: nowMs()
  };
}

/**
 * Persists one or more immutable batches while the job is staging. Callers
 * should use modest chunks rather than one enormous IndexedDB transaction.
 * Repeating an identical batch index is idempotent; changing its batch id or
 * payload is rejected.
 */
export async function stageArchiveBatches(jobId, batchInputs) {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  if (!Array.isArray(batchInputs) || batchInputs.length === 0) {
    throw queueError('At least one batch is required.', 'operator-archive-queue/no-batches');
  }
  if (batchInputs.length > MAX_STAGE_BATCHES_PER_TRANSACTION) {
    throw queueError(
      `Stage at most ${MAX_STAGE_BATCHES_PER_TRANSACTION} batches per transaction to keep large imports memory-bounded.`,
      'operator-archive-queue/staging-chunk-too-large'
    );
  }
  const batchesToStage = batchInputs.map((batch) => normalizeStagedBatch(normalizedJobId, batch));
  const uniqueIds = new Set(batchesToStage.map((batch) => batch.id));
  const uniqueClientIds = new Set(batchesToStage.map((batch) => batch.clientBatchId));
  if (uniqueIds.size !== batchesToStage.length || uniqueClientIds.size !== batchesToStage.length) {
    throw queueError('A staging call contains duplicate batch indexes or client batch ids.', 'operator-archive-queue/duplicate-stage-batch');
  }

  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(normalizedJobId));
    if (!job) throw queueError('Archive job not found.', 'operator-archive-queue/job-not-found');
    if (job.status !== 'staging') {
      throw queueError('Only a staging job can accept batches.', 'operator-archive-queue/job-not-staging');
    }

    let addedHands = 0;
    let addedBatches = 0;
    for (const batch of batchesToStage) {
      const existing = await requestResult(batches.get(batch.id));
      if (existing) {
        const sameBatch = existing.clientBatchId === batch.clientBatchId
          && existing.handCount === batch.handCount
          && JSON.stringify(existing.payload) === JSON.stringify(batch.payload);
        if (!sameBatch) {
          throw queueError('A staged batch index is already used by different content.', 'operator-archive-queue/batch-conflict');
        }
        continue;
      }
      const existingClientBatch = await requestResult(
        batches.index('byJobClientBatch').get([normalizedJobId, batch.clientBatchId])
      );
      if (existingClientBatch) {
        throw queueError('A client batch id is already used elsewhere in this job.', 'operator-archive-queue/client-batch-id-conflict');
      }
      await requestResult(batches.add(batch));
      addedHands += batch.handCount;
      addedBatches += 1;
    }

    job.stagedHands += addedHands;
    job.stagedBatches += addedBatches;
    job.updatedAt = nowMs();
    if (job.stagedHands > job.totalHands) {
      throw queueError('Staged hands exceed the declared job total.', 'operator-archive-queue/staging-overflow');
    }
    await requestResult(jobs.put(job));
    return publicJob(job);
  });
}

export function stageArchiveBatch(jobId, batch) {
  return stageArchiveBatches(jobId, [batch]);
}

/**
 * Atomically verifies all staged rows and changes the job to `ready`. A job
 * cannot become runnable if a batch is missing or the hand count differs.
 */
export async function finalizeArchiveJob(jobId, { expectedBatchCount, expectedHandCount } = {}) {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  const normalizedBatchCount = positiveInteger(expectedBatchCount, 'expected-batch-count');
  const normalizedHandCount = positiveInteger(expectedHandCount, 'expected-hand-count');

  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(normalizedJobId));
    if (!job) throw queueError('Archive job not found.', 'operator-archive-queue/job-not-found');
    if (job.status !== 'staging') {
      if (job.totalBatches === normalizedBatchCount && job.totalHands === normalizedHandCount) return publicJob(job);
      throw queueError('Archive job has already left staging.', 'operator-archive-queue/job-not-staging');
    }

    let actualBatchCount = 0;
    let actualHands = 0;
    let stateIsValid = true;
    await walkCursor(
      batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(normalizedJobId)),
      (cursor) => {
        actualBatchCount += 1;
        actualHands += cursor.value.handCount;
        stateIsValid &&= cursor.value.status === 'pending';
      }
    );
    if (
      actualBatchCount !== normalizedBatchCount
      || job.stagedBatches !== normalizedBatchCount
      || actualHands !== normalizedHandCount
      || job.stagedHands !== normalizedHandCount
      || job.totalHands !== normalizedHandCount
    ) {
      throw queueError('The job is incomplete and cannot be made ready.', 'operator-archive-queue/staging-incomplete');
    }
    if (!stateIsValid) {
      throw queueError('A staged batch has an unexpected state.', 'operator-archive-queue/staging-state-invalid');
    }

    const timestamp = nowMs();
    job.totalBatches = normalizedBatchCount;
    job.status = 'ready';
    job.readyAt = timestamp;
    job.updatedAt = timestamp;
    await requestResult(jobs.put(job));
    return publicJob(job);
  });
}

/** Returns one job without exposing its device delete secret. */
export async function getArchiveJob(jobId) {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  return withTransaction([JOB_STORE], 'readonly', async ({ jobs }) => publicJob(await requestResult(jobs.get(normalizedJobId))));
}

/** Lists jobs belonging to one immutable CloudBase subject id. */
export async function listArchiveJobsBySubject(subjectId, { statuses = null, limit = 100 } = {}) {
  const normalizedSubjectId = requiredString(subjectId, 'subject-id', 256);
  const allowedStatuses = Array.isArray(statuses) && statuses.length ? new Set(statuses.map(String)) : null;
  const normalizedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  return withTransaction([JOB_STORE], 'readonly', async ({ jobs }) => {
    const result = await requestResult(jobs.index('bySubject').getAll(globalThis.IDBKeyRange.only(normalizedSubjectId)));
    return result
      .filter((job) => !allowedStatuses || allowedStatuses.has(job.status))
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, normalizedLimit)
      .map(publicJob);
  });
}

/**
 * Returns aggregate queue state without reading raw payloads into an array.
 * `storedHands` and `storedPayloadBytes` describe data still present locally.
 */
export async function getArchiveQueueSummary({ subjectId = null } = {}) {
  const normalizedSubjectId = subjectId ? requiredString(subjectId, 'subject-id', 256) : null;
  return withTransaction([JOB_STORE, BATCH_STORE], 'readonly', async ({ jobs, batches }) => {
    const jobRows = await requestResult(jobsForSubjectRequest(jobs, normalizedSubjectId));
    const jobIds = new Set(jobRows.map((job) => job.id));
    const byStatus = {};
    let totalHands = 0;
    let completedHands = 0;
    let storedHands = 0;
    let storedBatches = 0;
    let storedPayloadBytes = 0;
    let nextAttemptAt = 0;

    for (const job of jobRows) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      totalHands += job.totalHands;
      completedHands += job.completedHands;
      if (job.status === 'retry' && job.nextAttemptAt > 0) {
        nextAttemptAt = nextAttemptAt ? Math.min(nextAttemptAt, job.nextAttemptAt) : job.nextAttemptAt;
      }
    }

    await walkCursor(batches.openCursor(), (cursor) => {
      const batch = cursor.value;
      if (!jobIds.has(batch.jobId)) return;
      storedHands += batch.handCount;
      storedBatches += 1;
      storedPayloadBytes += batch.payloadBytes;
      if (batch.status === 'uploading' && batch.claimExpiresAt > 0) {
        nextAttemptAt = nextAttemptAt ? Math.min(nextAttemptAt, batch.claimExpiresAt) : batch.claimExpiresAt;
      }
    });

    return {
      jobCount: jobRows.length,
      byStatus,
      totalHands,
      completedHands,
      storedHands,
      storedBatches,
      storedPayloadBytes,
      nextAttemptAt,
      hasRunnableJobs: jobRows.some((job) => RUNNABLE_JOB_STATUSES.has(job.status))
    };
  });
}

/** Pauses a ready/retry job while retaining its raw pending batches. */
export function pauseArchiveJob(jobId, reason = 'paused') {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(normalizedJobId));
    if (!job) throw queueError('Archive job not found.', 'operator-archive-queue/job-not-found');
    if (TERMINAL_JOB_STATUSES.has(job.status) || job.status === 'staging') return publicJob(job);
    const timestamp = nowMs();
    await walkCursor(batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(normalizedJobId)), (cursor) => {
      const batch = cursor.value;
      if (batch.status !== 'uploading') return;
      batch.status = 'pending';
      batch.claimOwner = null;
      batch.claimToken = null;
      batch.claimExpiresAt = 0;
      batch.updatedAt = timestamp;
      cursor.update(batch);
    });
    job.status = 'paused';
    job.nextAttemptAt = 0;
    job.lastError = { code: 'paused', message: String(reason), at: timestamp };
    job.updatedAt = timestamp;
    await requestResult(jobs.put(job));
    return publicJob(job);
  });
}

/** Resumes a paused or retry job without changing its identity or consent. */
export function resumeArchiveJob(jobId) {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(normalizedJobId));
    if (!job) throw queueError('Archive job not found.', 'operator-archive-queue/job-not-found');
    if (job.status !== 'paused' && job.status !== 'retry') return publicJob(job);
    const timestamp = nowMs();
    let nextAttemptAt = 0;
    await walkCursor(batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(normalizedJobId)), (cursor) => {
      const batch = cursor.value;
      if (batch.status === 'uploading') {
        batch.status = 'retry';
        batch.claimOwner = null;
        batch.claimToken = null;
        batch.claimExpiresAt = 0;
        batch.nextAttemptAt = timestamp;
        batch.updatedAt = timestamp;
        cursor.update(batch);
      }
      if (batch.status === 'retry' && batch.nextAttemptAt > timestamp) {
        nextAttemptAt = nextAttemptAt ? Math.min(nextAttemptAt, batch.nextAttemptAt) : batch.nextAttemptAt;
      }
    });
    job.status = nextAttemptAt ? 'retry' : 'ready';
    job.nextAttemptAt = nextAttemptAt;
    job.lastError = null;
    job.updatedAt = timestamp;
    await requestResult(jobs.put(job));
    return publicJob(job);
  });
}

/**
 * Cancels a job and atomically removes every unacknowledged raw batch. This
 * stops future uploads; the caller must separately invoke the server deletion
 * RPC when previously acknowledged copies must also be withdrawn.
 */
export function cancelArchiveJob(jobId, reason = 'cancelled') {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(normalizedJobId));
    if (!job) throw queueError('Archive job not found.', 'operator-archive-queue/job-not-found');
    if (job.status === 'completed' || job.status === 'cancelled') return publicJob(job);
    const timestamp = nowMs();
    await deleteBatchesForJob(batches, normalizedJobId);
    job.status = 'cancelled';
    job.cancelledAt = timestamp;
    job.nextAttemptAt = 0;
    job.lastError = { code: 'cancelled', message: String(reason), at: timestamp };
    job.updatedAt = timestamp;
    await requestResult(jobs.put(job));
    return publicJob(job);
  });
}

/** Cancels all non-terminal jobs for one subject in one IndexedDB transaction. */
export async function cancelArchiveJobsBySubject(subjectId, reason = 'cancelled') {
  const normalizedSubjectId = requiredString(subjectId, 'subject-id', 256);
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const subjectJobs = await requestResult(jobs.index('bySubject').getAll(globalThis.IDBKeyRange.only(normalizedSubjectId)));
    const timestamp = nowMs();
    let cancelledJobs = 0;
    let discardedHands = 0;
    for (const job of subjectJobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
      await walkCursor(batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(job.id)), (cursor) => {
        discardedHands += cursor.value.handCount;
        cursor.delete();
      });
      job.status = 'cancelled';
      job.cancelledAt = timestamp;
      job.nextAttemptAt = 0;
      job.lastError = { code: 'cancelled', message: String(reason), at: timestamp };
      job.updatedAt = timestamp;
      await requestResult(jobs.put(job));
      cancelledJobs += 1;
    }
    return { cancelledJobs, discardedHands };
  });
}

/**
 * Cancels every non-terminal job on this browser device and atomically removes
 * all unacknowledged raw payloads. This is the queue-side companion to the
 * device-secret server deletion RPC, which can span several historical UIDs.
 */
export async function cancelAllArchiveJobs(reason = 'cancelled') {
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const allJobs = await requestResult(jobs.getAll());
    const timestamp = nowMs();
    let cancelledJobs = 0;
    let discardedHands = 0;
    for (const job of allJobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
      await walkCursor(batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(job.id)), (cursor) => {
        discardedHands += cursor.value.handCount;
        cursor.delete();
      });
      job.status = 'cancelled';
      job.cancelledAt = timestamp;
      job.nextAttemptAt = 0;
      job.lastError = { code: 'cancelled', message: String(reason), at: timestamp };
      job.updatedAt = timestamp;
      await requestResult(jobs.put(job));
      cancelledJobs += 1;
    }
    return { cancelledJobs, discardedHands };
  });
}

/**
 * Removes abandoned `staging` jobs and old terminal summaries atomically with
 * their remaining batches. It never removes ready, retry, or paused payloads.
 */
export async function cleanupArchiveQueue({
  stagingMaxAgeMs = DEFAULT_STAGING_MAX_AGE_MS,
  terminalMaxAgeMs = DEFAULT_TERMINAL_MAX_AGE_MS,
  now = nowMs()
} = {}) {
  const stagingCutoff = now - Math.max(0, Number(stagingMaxAgeMs) || 0);
  const terminalCutoff = now - Math.max(0, Number(terminalMaxAgeMs) || 0);
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const allJobs = await requestResult(jobs.getAll());
    const removedJobIds = [];
    for (const job of allJobs) {
      if (job.status === 'staging' && job.stagedHands === job.totalHands && job.stagedBatches > 0) {
        let actualBatchCount = 0;
        let actualHands = 0;
        let batchesArePending = true;
        await walkCursor(
          batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(job.id)),
          (cursor) => {
            actualBatchCount += 1;
            actualHands += Number(cursor.value.handCount ?? 0);
            batchesArePending &&= cursor.value.status === 'pending';
          }
        );
        if (
          batchesArePending
          && actualBatchCount === job.stagedBatches
          && actualHands === job.totalHands
        ) {
          const timestamp = nowMs();
          job.totalBatches = actualBatchCount;
          job.status = 'ready';
          job.readyAt = timestamp;
          job.updatedAt = timestamp;
          await requestResult(jobs.put(job));
          continue;
        }
      }
      const staleStaging = job.status === 'staging' && job.updatedAt < stagingCutoff;
      const oldTerminal = TERMINAL_JOB_STATUSES.has(job.status) && job.updatedAt < terminalCutoff;
      if (!staleStaging && !oldTerminal) continue;
      await deleteBatchesForJob(batches, job.id);
      await requestResult(jobs.delete(job.id));
      removedJobIds.push(job.id);
    }
    return { removedJobIds, removedCount: removedJobIds.length };
  });
}

/** Deletes a terminal summary. Active jobs require `force: true`. */
export async function removeArchiveJob(jobId, { force = false } = {}) {
  const normalizedJobId = requiredString(jobId, 'job-id', 128);
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(normalizedJobId));
    if (!job) return false;
    if (!force && !TERMINAL_JOB_STATUSES.has(job.status)) {
      throw queueError('An active archive job cannot be removed without force.', 'operator-archive-queue/job-active');
    }
    await deleteBatchesForJob(batches, normalizedJobId);
    await requestResult(jobs.delete(normalizedJobId));
    return true;
  });
}

async function recoverAbandonedClaims(subjectId) {
  const timestamp = nowMs();
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const subjectJobs = await requestResult(jobs.index('bySubject').getAll(globalThis.IDBKeyRange.only(subjectId)));
    let recovered = 0;
    for (const job of subjectJobs) {
      if (!RUNNABLE_JOB_STATUSES.has(job.status)) continue;
      let jobChanged = false;
      let futureRetryAt = 0;
      await walkCursor(batches.index('byJob').openCursor(globalThis.IDBKeyRange.only(job.id)), (cursor) => {
        const batch = cursor.value;
        if (batch.status === 'uploading' && batch.claimExpiresAt <= timestamp) {
          batch.status = 'retry';
          batch.nextAttemptAt = timestamp;
          batch.claimOwner = null;
          batch.claimToken = null;
          batch.claimExpiresAt = 0;
          batch.updatedAt = timestamp;
          cursor.update(batch);
          recovered += 1;
          jobChanged = true;
        }
        if (batch.status === 'retry' && batch.nextAttemptAt > timestamp) {
          futureRetryAt = futureRetryAt
            ? Math.min(futureRetryAt, batch.nextAttemptAt)
            : batch.nextAttemptAt;
        }
      });
      if (jobChanged) {
        job.status = futureRetryAt ? 'retry' : 'ready';
        job.nextAttemptAt = futureRetryAt;
        job.updatedAt = timestamp;
        await requestResult(jobs.put(job));
      }
    }
    return recovered;
  });
}

async function claimNextBatch(subjectId, ownerId, claimMs) {
  const timestamp = nowMs();
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const subjectJobs = await requestResult(jobs.index('bySubject').getAll(globalThis.IDBKeyRange.only(subjectId)));
    subjectJobs.sort((left, right) => left.createdAt - right.createdAt);
    for (const job of subjectJobs) {
      if (!RUNNABLE_JOB_STATUSES.has(job.status)) continue;
      if (job.status === 'retry' && job.nextAttemptAt > timestamp) continue;
      const range = globalThis.IDBKeyRange.bound(
        [job.id, 0],
        [job.id, Number.MAX_SAFE_INTEGER]
      );
      const batch = await findCursorValue(
        batches.index('byJobIndex').openCursor(range),
        (candidate) => (
          (candidate.status === 'pending' || candidate.status === 'retry')
          && candidate.nextAttemptAt <= timestamp
        ) || (
          candidate.status === 'uploading'
          && candidate.claimExpiresAt <= timestamp
        )
      );
      if (!batch) continue;

      batch.status = 'uploading';
      batch.attempts += 1;
      batch.claimOwner = ownerId;
      batch.claimToken = createUuid();
      batch.claimExpiresAt = timestamp + claimMs;
      batch.updatedAt = timestamp;
      await requestResult(batches.put(batch));
      job.updatedAt = timestamp;
      await requestResult(jobs.put(job));
      return { job, batch };
    }
    return null;
  });
}

function ownsClaim(batch, claimOwner, claimToken) {
  return batch?.status === 'uploading'
    && batch.claimOwner === claimOwner
    && batch.claimToken === claimToken;
}

async function completeClaimedBatch(jobId, batchId, claimOwner, claimToken) {
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(jobId));
    if (!job) return { acknowledged: false, job: null };
    const batch = await requestResult(batches.get(batchId));
    if (!batch) return { acknowledged: false, job: publicJob(job) };
    if (!ownsClaim(batch, claimOwner, claimToken)) {
      return { acknowledged: false, stale: true, job: publicJob(job) };
    }

    await requestResult(batches.delete(batchId));
    const timestamp = nowMs();
    job.completedHands += batch.handCount;
    job.completedBatches += 1;
    job.updatedAt = timestamp;

    if (job.completedBatches >= job.totalBatches) {
      job.status = 'completed';
      job.completedAt = timestamp;
      job.nextAttemptAt = 0;
      job.lastError = null;
    } else if (job.status === 'paused') {
      job.nextAttemptAt = 0;
    } else if (job.status === 'retry' && job.nextAttemptAt > timestamp) {
      // Another concurrent worker has already scheduled a later retry.
    } else {
      job.status = 'ready';
      job.nextAttemptAt = 0;
      job.lastError = null;
    }
    await requestResult(jobs.put(job));
    return { acknowledged: true, completedHands: batch.handCount, job: publicJob(job) };
  });
}

async function retryClaimedBatch(jobId, batchId, claimOwner, claimToken, errorRecord, nextAttemptAt) {
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(jobId));
    const batch = await requestResult(batches.get(batchId));
    if (!job || !batch || !ownsClaim(batch, claimOwner, claimToken)) {
      return { updated: false, stale: true, job: publicJob(job) };
    }
    const timestamp = nowMs();
    batch.status = 'retry';
    batch.nextAttemptAt = nextAttemptAt;
    batch.lastError = errorRecord;
    batch.claimOwner = null;
    batch.claimToken = null;
    batch.claimExpiresAt = 0;
    batch.updatedAt = timestamp;
    await requestResult(batches.put(batch));
    if (job.status !== 'paused') {
      job.status = 'retry';
      job.nextAttemptAt = job.nextAttemptAt
        ? Math.min(job.nextAttemptAt, nextAttemptAt)
        : nextAttemptAt;
      job.lastError = errorRecord;
    }
    job.updatedAt = timestamp;
    await requestResult(jobs.put(job));
    return { updated: true, stale: false, job: publicJob(job) };
  });
}

async function pauseClaimedBatch(jobId, batchId, claimOwner, claimToken, errorRecord) {
  return withTransaction([JOB_STORE, BATCH_STORE], 'readwrite', async ({ jobs, batches }) => {
    const job = await requestResult(jobs.get(jobId));
    const batch = await requestResult(batches.get(batchId));
    if (!job) return null;
    if (!batch || !ownsClaim(batch, claimOwner, claimToken)) {
      return { updated: false, stale: true, job: publicJob(job) };
    }
    const timestamp = nowMs();
    batch.status = 'pending';
    batch.nextAttemptAt = 0;
    batch.lastError = errorRecord;
    batch.claimOwner = null;
    batch.claimToken = null;
    batch.claimExpiresAt = 0;
    batch.updatedAt = timestamp;
    await requestResult(batches.put(batch));
    job.status = 'paused';
    job.nextAttemptAt = 0;
    job.lastError = errorRecord;
    job.updatedAt = timestamp;
    await requestResult(jobs.put(job));
    return { updated: true, stale: false, job: publicJob(job) };
  });
}

async function nextRetryAtForSubject(subjectId) {
  return withTransaction([JOB_STORE, BATCH_STORE], 'readonly', async ({ jobs, batches }) => {
    const subjectJobs = await requestResult(jobs.index('bySubject').getAll(globalThis.IDBKeyRange.only(subjectId)));
    let nextAttemptAt = subjectJobs
      .filter((job) => job.status === 'retry' && job.nextAttemptAt > 0)
      .reduce((minimum, job) => minimum ? Math.min(minimum, job.nextAttemptAt) : job.nextAttemptAt, 0);
    const jobIds = new Set(subjectJobs.map((job) => job.id));
    await walkCursor(batches.openCursor(), (cursor) => {
      const batch = cursor.value;
      if (!jobIds.has(batch.jobId)) return;
      // Retry batches are governed by the parent job's circuit-breaker time.
      // Uploading claims need their own wake-up because a crashed worker may
      // leave the parent job in `ready` state until the claim expires.
      const candidate = batch.status === 'uploading' ? batch.claimExpiresAt : 0;
      if (candidate > 0) nextAttemptAt = nextAttemptAt ? Math.min(nextAttemptAt, candidate) : candidate;
    });
    return nextAttemptAt;
  });
}

function normalizeErrorRecord(error, fallbackCode = 'upload-failed') {
  const message = String(error?.message ?? error ?? 'Archive upload failed.').slice(0, 1000);
  return {
    code: String(error?.code ?? error?.name ?? fallbackCode).slice(0, 128),
    message,
    at: nowMs()
  };
}

/**
 * Conservative retry whitelist. Unknown application, SQL, and validation
 * failures pause instead of repeatedly sending a potentially invalid batch.
 */
export function classifyArchiveQueueError(error) {
  const chain = [];
  const seen = new Set();
  let candidate = error;
  while (candidate && typeof candidate === 'object' && chain.length < 6 && !seen.has(candidate)) {
    chain.push(candidate);
    seen.add(candidate);
    candidate = candidate.cause ?? candidate.response ?? null;
  }
  const statuses = chain.flatMap((item) => [item?.status, item?.statusCode, item?.response?.status])
    .map(Number)
    .filter(Number.isFinite);
  const codes = chain.flatMap((item) => [item?.code, item?.name, item?.errorCode])
    .map((value) => String(value ?? '').toLowerCase())
    .filter(Boolean);
  const message = chain.map((item) => String(item?.message ?? item?.error ?? ''))
    .join(' ')
    .toLowerCase();
  const retryAfterSeconds = Math.max(0, ...chain
    .flatMap((item) => [item?.retryAfter, item?.retry_after])
    .map(Number)
    .filter(Number.isFinite));
  const retryableStatus = statuses.some((status) => status === 408 || status === 425 || status === 429 || status >= 500);
  const retryableSqlState = codes.some((code) => (
    code.startsWith('08')
    || code === '40001'
    || code === '40p01'
    || code.startsWith('53')
    || code === '57p01'
  ));
  const retryableNetworkError = codes.some((code) => (
    code.startsWith('econn')
    || code === 'etimedout'
    || code === 'eai_again'
    || code === 'networkerror'
    || code === 'network_error'
    || code === 'request:fail'
  )) || [
    'failed to fetch',
    'fetch failed',
    'load failed',
    'network error',
    'network request failed',
    'request:fail',
    'connection reset',
    'connection refused',
    'connection closed',
    'connection timed out',
    'timed out',
    'timeout',
    'offline'
  ].some((fragment) => message.includes(fragment));
  const explicitlyAborted = codes.some((code) => code === 'aborterror' || code.includes('aborted'));
  return {
    retryable: !explicitlyAborted && (retryableStatus || retryableSqlState || retryableNetworkError),
    retryAfterMs: retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0
  };
}

function retryDelayMs(attempts, retryAfterMs = 0) {
  if (retryAfterMs > 0) return Math.min(10 * 60_000, retryAfterMs);
  const cap = Math.min(60_000, 1000 * (2 ** Math.min(8, Math.max(0, attempts - 1))));
  return Math.max(500, Math.floor(Math.random() * cap));
}

function abortableDelay(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(queueError('Archive queue run was aborted.', 'operator-archive-queue/aborted'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function acquireLease(ownerId, leaseMs) {
  return withTransaction([LEASE_STORE], 'readwrite', async ({ leases }) => {
    const timestamp = nowMs();
    const existing = await requestResult(leases.get(RUNNER_LEASE_NAME));
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > timestamp) return false;
    await requestResult(leases.put({
      name: RUNNER_LEASE_NAME,
      ownerId,
      expiresAt: timestamp + leaseMs,
      updatedAt: timestamp
    }));
    return true;
  });
}

async function renewLease(ownerId, leaseMs) {
  return withTransaction([LEASE_STORE], 'readwrite', async ({ leases }) => {
    const existing = await requestResult(leases.get(RUNNER_LEASE_NAME));
    if (!existing || existing.ownerId !== ownerId) return false;
    const timestamp = nowMs();
    existing.expiresAt = timestamp + leaseMs;
    existing.updatedAt = timestamp;
    await requestResult(leases.put(existing));
    return true;
  });
}

async function releaseLease(ownerId) {
  return withTransaction([LEASE_STORE], 'readwrite', async ({ leases }) => {
    const existing = await requestResult(leases.get(RUNNER_LEASE_NAME));
    if (existing?.ownerId === ownerId) await requestResult(leases.delete(RUNNER_LEASE_NAME));
  });
}

async function withIndexedDbLease(ownerId, leaseMs, operation) {
  if (!await acquireLease(ownerId, leaseMs)) return { acquired: false, reason: 'locked' };
  let leaseLost = false;
  let heartbeatPromise = null;
  const heartbeat = globalThis.setInterval(() => {
    if (heartbeatPromise || leaseLost) return;
    heartbeatPromise = renewLease(ownerId, leaseMs)
      .then((renewed) => {
        leaseLost = !renewed;
      })
      .catch(() => {
        leaseLost = true;
      })
      .finally(() => {
        heartbeatPromise = null;
      });
  }, Math.max(1000, Math.floor(leaseMs / 3)));

  try {
    return await operation({
      ownerId,
      isValid: () => !leaseLost,
      renew: async () => {
        if (leaseLost) return false;
        leaseLost = !await renewLease(ownerId, leaseMs);
        return !leaseLost;
      }
    });
  } finally {
    globalThis.clearInterval(heartbeat);
    await heartbeatPromise?.catch(() => {});
    await releaseLease(ownerId).catch(() => {});
  }
}

/**
 * Runs with one cross-tab owner. Chromium uses navigator.locks. Browsers
 * without that API use an expiring IndexedDB lease with a heartbeat; stable
 * batch ids make a rare lease overlap harmless at the server.
 */
async function withRunnerLock(leaseMs, operation) {
  const ownerId = createUuid();
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request === 'function') {
    return locks.request(RUNNER_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false, reason: 'locked' };
      return operation({ ownerId, isValid: () => true, renew: async () => true });
    });
  }
  return withIndexedDbLease(ownerId, leaseMs, operation);
}

function notifyProgress(onProgress, event) {
  try {
    onProgress?.(event);
  } catch {
    // UI callbacks cannot interrupt durable queue transitions.
  }
}

/**
 * Drains ready batches for one exact subject id.
 *
 * `uploadBatch({ job, batch, signal })` must call the CloudBase RPC with the
 * stored `batch.clientBatchId`, `batch.payload`, `job.consentToken`,
 * `job.consentEvidence`, and `job.deleteSecret`; it must throw when the RPC
 * response contains an error.
 *
 * `canUploadJob(job)` is checked immediately before each request. It may
 * return true, false (pause), or `{ allowed: false, action: 'cancel', reason }`.
 * This lets the integration re-check policy version, subject, and current
 * consent without changing the immutable queued evidence.
 *
 * Transient failures are persisted as retries with full-jitter exponential
 * backoff. Permanent failures pause the job and retain its raw batch for an
 * explicit retry. The runner resumes abandoned `uploading` claims on startup.
 */
export async function runArchiveQueue({
  subjectId,
  uploadBatch,
  canUploadJob = null,
  classifyError = classifyArchiveQueueError,
  onProgress = null,
  concurrency = DEFAULT_CONCURRENCY,
  leaseMs = DEFAULT_RUNNER_LEASE_MS,
  batchClaimMs = DEFAULT_BATCH_CLAIM_MS,
  waitForRetries = true,
  maxRetryWaitMs = 60_000,
  signal = null
} = {}) {
  const normalizedSubjectId = requiredString(subjectId, 'subject-id', 256);
  if (typeof uploadBatch !== 'function') {
    throw queueError('runArchiveQueue requires an uploadBatch callback.', 'operator-archive-queue/upload-callback-required');
  }
  const workerCount = Math.max(1, Math.min(2, Number(concurrency) || DEFAULT_CONCURRENCY));
  const normalizedLeaseMs = Math.max(5000, Number(leaseMs) || DEFAULT_RUNNER_LEASE_MS);
  const normalizedClaimMs = Math.max(normalizedLeaseMs * 2, Number(batchClaimMs) || DEFAULT_BATCH_CLAIM_MS);

  return withRunnerLock(normalizedLeaseMs, async (lease) => {
    await recoverAbandonedClaims(normalizedSubjectId);
    let uploadedBatches = 0;
    let uploadedHands = 0;
    let retryCount = 0;
    let pausedJobs = 0;
    const runStartedAt = nowMs();

    const drainWorker = async () => {
      while (!signal?.aborted && lease.isValid()) {
        if (!await lease.renew()) return;
        const claimed = await claimNextBatch(normalizedSubjectId, lease.ownerId, normalizedClaimMs);
        if (!claimed) return;

        if (canUploadJob) {
          let decision;
          try {
            decision = await canUploadJob(publicJob(claimed.job));
          } catch (error) {
            decision = { allowed: false, action: 'pause', reason: error?.message || 'Consent validation failed.' };
          }
          const allowed = decision === true || decision?.allowed === true;
          if (!allowed) {
            const action = decision?.action ?? 'pause';
            const reason = decision?.reason ?? 'Archive consent or identity is no longer valid.';
            if (action === 'cancel') await cancelArchiveJob(claimed.job.id, reason);
            else {
              const pauseResult = await pauseClaimedBatch(
                claimed.job.id,
                claimed.batch.id,
                lease.ownerId,
                claimed.batch.claimToken,
                normalizeErrorRecord(reason, 'job-paused')
              );
              if (pauseResult?.stale) {
                notifyProgress(onProgress, { type: 'stale', jobId: claimed.job.id, batchIndex: claimed.batch.batchIndex });
                continue;
              }
            }
            pausedJobs += 1;
            notifyProgress(onProgress, { type: action === 'cancel' ? 'cancelled' : 'paused', jobId: claimed.job.id, reason });
            continue;
          }
        }

        try {
          await uploadBatch({ job: claimed.job, batch: claimed.batch, signal });
          const completion = await completeClaimedBatch(
            claimed.job.id,
            claimed.batch.id,
            lease.ownerId,
            claimed.batch.claimToken
          );
          if (completion.acknowledged) {
            uploadedBatches += 1;
            uploadedHands += completion.completedHands;
            notifyProgress(onProgress, {
              type: 'uploaded',
              jobId: claimed.job.id,
              batchIndex: claimed.batch.batchIndex,
              completedHands: completion.completedHands,
              job: completion.job
            });
          } else {
            notifyProgress(onProgress, {
              type: 'stale',
              jobId: claimed.job.id,
              batchIndex: claimed.batch.batchIndex
            });
          }
        } catch (error) {
          const errorRecord = normalizeErrorRecord(error);
          let classification;
          try {
            classification = await classifyError(error, claimed.batch);
          } catch (classificationError) {
            classification = { retryable: false };
            errorRecord.message = `${errorRecord.message} Error classification also failed: ${String(classificationError?.message ?? classificationError)}`.slice(0, 1000);
          }
          if (classification?.retryable !== false) {
            const delayMs = classification?.delayMs ?? retryDelayMs(
              claimed.batch.attempts,
              classification?.retryAfterMs ?? 0
            );
            const nextAttemptAt = nowMs() + Math.max(0, Number(delayMs) || 0);
            const retryResult = await retryClaimedBatch(
              claimed.job.id,
              claimed.batch.id,
              lease.ownerId,
              claimed.batch.claimToken,
              errorRecord,
              nextAttemptAt
            );
            if (retryResult?.stale) {
              notifyProgress(onProgress, { type: 'stale', jobId: claimed.job.id, batchIndex: claimed.batch.batchIndex });
              continue;
            }
            retryCount += 1;
            notifyProgress(onProgress, {
              type: 'retry',
              jobId: claimed.job.id,
              batchIndex: claimed.batch.batchIndex,
              attempt: claimed.batch.attempts,
              nextAttemptAt,
              error: errorRecord
            });
          } else {
            const pauseResult = await pauseClaimedBatch(
              claimed.job.id,
              claimed.batch.id,
              lease.ownerId,
              claimed.batch.claimToken,
              errorRecord
            );
            if (pauseResult?.stale) {
              notifyProgress(onProgress, { type: 'stale', jobId: claimed.job.id, batchIndex: claimed.batch.batchIndex });
              continue;
            }
            pausedJobs += 1;
            notifyProgress(onProgress, {
              type: 'paused',
              jobId: claimed.job.id,
              batchIndex: claimed.batch.batchIndex,
              error: errorRecord
            });
          }
        }
      }
    };

    while (!signal?.aborted && lease.isValid()) {
      await Promise.all(Array.from({ length: workerCount }, () => drainWorker()));
      const nextAttemptAt = await nextRetryAtForSubject(normalizedSubjectId);
      if (!waitForRetries || !nextAttemptAt) break;
      const delayMs = Math.max(0, nextAttemptAt - nowMs());
      if (nowMs() - runStartedAt + delayMs > Math.max(0, Number(maxRetryWaitMs) || 0)) break;
      await abortableDelay(delayMs, signal);
    }

    const summary = await getArchiveQueueSummary({ subjectId: normalizedSubjectId });
    return {
      acquired: true,
      uploadedBatches,
      uploadedHands,
      retryCount,
      pausedJobs,
      summary
    };
  });
}

/** Best-effort request for durable browser storage after explicit opt-in. */
export async function requestArchiveQueuePersistence() {
  if (typeof globalThis.navigator?.storage?.persist !== 'function') return false;
  try {
    return await globalThis.navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Closes the cached IndexedDB connection, primarily for tests/upgrades. */
export async function closeArchiveQueueDatabase() {
  if (!databasePromise) return;
  const database = await databasePromise.catch(() => null);
  database?.close();
  databasePromise = null;
}
