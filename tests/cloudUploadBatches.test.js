import { describe, expect, it, vi } from 'vitest';
import {
  chunkRowsByPayload,
  cloudUploadBatchDefaults,
  extractCloudErrorDetails,
  insertRowsAdaptively,
  shouldSplitCloudWrite
} from '../src/lib/cloudUploadBatches';

describe('cloud upload batching', () => {
  it('keeps normal batches within the conservative row limit', () => {
    const rows = Array.from({ length: 95 }, (_, index) => ({
      id: index,
      raw_text: `hand-${index}`
    }));
    const batches = chunkRowsByPayload(rows);

    expect(cloudUploadBatchDefaults.maxRows).toBe(40);
    expect(batches.map((batch) => batch.length)).toEqual([40, 40, 15]);
  });

  it('measures UTF-8 payload bytes instead of JavaScript character count', () => {
    const rows = [
      { id: 1, raw_text: '中'.repeat(20) },
      { id: 2, raw_text: '中'.repeat(20) }
    ];
    const batches = chunkRowsByPayload(rows, { maxRows: 10, maxBytes: 100 });

    expect(batches).toHaveLength(2);
  });

  it('splits a rejected oversized request and preserves every returned row', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: index,
      external_hand_id: `RC${index}`
    }));
    const insert = vi.fn(async (batch) => {
      if (batch.length > 2) {
        const error = new Error('request body too large');
        error.status = 413;
        throw error;
      }
      return batch.map((row) => ({ ...row, saved: true }));
    });

    const saved = await insertRowsAdaptively(rows, insert);

    expect(saved).toHaveLength(rows.length);
    expect(saved.map((row) => row.external_hand_id)).toEqual(rows.map((row) => row.external_hand_id));
    expect(insert).toHaveBeenCalledTimes(7);
  });

  it('does not multiply permission failures into more requests', async () => {
    const permissionError = Object.assign(new Error('row-level security'), {
      code: '42501',
      status: 403
    });
    const insert = vi.fn().mockRejectedValue(permissionError);

    await expect(insertRowsAdaptively([{ id: 1 }, { id: 2 }], insert)).rejects.toBe(permissionError);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(shouldSplitCloudWrite(permissionError)).toBe(false);
  });

  it('extracts nested CloudBase error metadata for user-facing diagnostics', () => {
    const cloudError = new Error('Request failed');
    cloudError.response = {
      status: 429,
      data: {
        errorCode: 'RATE_LIMITED',
        message: 'Too many requests',
        requestId: 'request-1'
      }
    };
    const details = extractCloudErrorDetails(cloudError);

    expect(details).toEqual({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Request failed · Too many requests',
      requestId: 'request-1'
    });
  });
});
