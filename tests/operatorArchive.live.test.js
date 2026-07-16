// @vitest-environment happy-dom

import 'fake-indexeddb/auto';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';
import { parseGgHands } from '../src/lib/handHistoryAnalyzer.js';
import { cloudbaseClient, isAnonymousCloudbaseUser } from '../src/lib/cloudbaseClient.js';
import {
  acceptOperatorArchivePreference,
  archiveImportedHands,
  deleteMyOperatorArchive
} from '../src/lib/operatorArchive.js';
import { closeArchiveQueueDatabase } from '../src/lib/operatorArchiveQueue.js';

const runLiveTests = process.env.RUN_CLOUDBASE_LIVE_TESTS === '1';
const testArchivePath = process.env.K2NOTE_TEST_ARCHIVE
  || 'C:/Users/Administrator/Desktop/test.zip';

async function readTestHands() {
  const zip = await JSZip.loadAsync(await fs.readFile(testArchivePath));
  const textEntries = Object.values(zip.files)
    .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.txt'));
  const chunks = await Promise.all(textEntries.map((entry) => entry.async('string')));
  const uniqueHands = new Map();
  for (const chunk of chunks) {
    for (const hand of parseGgHands(chunk)) uniqueHands.set(hand.id, hand);
  }
  return [...uniqueHands.values()];
}

describe.skipIf(!runLiveTests)('CloudBase anonymous operator archive', () => {
  afterAll(async () => {
    await deleteMyOperatorArchive().catch(() => {});
    await cloudbaseClient.signOut().catch(() => {});
    await closeArchiveQueueDatabase();
  });

  it('archives all 6,309 hands without login and deletes the smoke-test copy', async () => {
    window.localStorage.clear();
    document.documentElement.lang = 'zh-CN';

    const hands = await readTestHands();
    expect(hands).toHaveLength(6309);

    const authState = await cloudbaseClient.ensureArchiveSession();
    expect(authState.user).toBeTruthy();
    expect(isAnonymousCloudbaseUser(authState.user)).toBe(true);

    let deletion;
    try {
      const consent = await acceptOperatorArchivePreference();
      expect(consent.subjectId).toBeTruthy();
      expect(consent.consentToken).toMatch(/^[0-9a-f-]{36}$/i);

      const result = await archiveImportedHands({ hands, consent });
      expect(result.status).toBe('completed');
      expect(result.completedCount).toBe(6309);
      expect(result.queuedCount).toBe(0);
    } finally {
      deletion = await deleteMyOperatorArchive();
    }
    expect(Number(deletion.deleted_hand_links ?? 0)).toBeGreaterThanOrEqual(6309);
    expect(deletion.canonical_cleanup_completed).toBe(true);
  }, 180_000);
});
