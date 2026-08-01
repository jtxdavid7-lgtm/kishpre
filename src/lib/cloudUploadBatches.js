const DEFAULT_MAX_ROWS = 40;
const DEFAULT_MAX_BYTES = 220_000;

function stringifyErrorValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function extractCloudErrorDetails(error) {
  const candidates = [
    error,
    error?.error,
    error?.data,
    error?.response,
    error?.response?.data,
    error?.cause,
    error?.cause?.data,
    error?.cause?.response,
    error?.cause?.response?.data
  ].filter(Boolean);
  const explicitCode = candidates
    .map((candidate) => (
      candidate?.errorCode
      ?? candidate?.code
      ?? candidate?.error_code
    ))
    .map(stringifyErrorValue)
    .find(Boolean) ?? '';
  const code = explicitCode || (
    candidates
      .map((candidate) => candidate?.name)
      .map(stringifyErrorValue)
      .find((value) => value && value !== 'Error') ?? ''
  );
  const status = candidates
    .map((candidate) => candidate?.statusCode ?? candidate?.status)
    .map((value) => Number(value))
    .find(Number.isFinite) ?? null;
  const messages = candidates
    .flatMap((candidate) => [
      candidate?.message,
      candidate?.error_description,
      candidate?.details,
      candidate?.hint
    ])
    .map(stringifyErrorValue)
    .filter(Boolean);
  const message = [...new Set(messages)].join(' · ');
  const requestId = candidates
    .map((candidate) => (
      candidate?.requestId
      ?? candidate?.request_id
      ?? candidate?.traceId
      ?? candidate?.trace_id
    ))
    .map(stringifyErrorValue)
    .find(Boolean) ?? '';

  return { code, status, message, requestId };
}

export function chunkRowsByPayload(rows, {
  maxRows = DEFAULT_MAX_ROWS,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  const result = [];
  let current = [];
  let currentBytes = 2;
  const encoder = new TextEncoder();

  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (current.length && (
      current.length >= maxRows
      || currentBytes + rowBytes > maxBytes
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

export function shouldSplitCloudWrite(error) {
  const { code, status, message } = extractCloudErrorDetails(error);
  if (status === 413 || Number(code) === 413) return true;
  if (/PAYLOAD|REQUEST_TOO_LARGE|ENTITY_TOO_LARGE/i.test(code)) return true;
  if (code === 'INVALID_REQUEST' && /size|payload|body|large|limit/i.test(message)) return true;
  return /payload too large|request (?:body )?too large|entity too large|body size|request size|请求体?过大|超过.+(?:请求|写入).+限制/i.test(message);
}

export async function insertRowsAdaptively(rows, insertRows) {
  try {
    return await insertRows(rows);
  } catch (error) {
    if (rows.length <= 1 || !shouldSplitCloudWrite(error)) throw error;
    const midpoint = Math.ceil(rows.length / 2);
    const leftRows = await insertRowsAdaptively(rows.slice(0, midpoint), insertRows);
    const rightRows = await insertRowsAdaptively(rows.slice(midpoint), insertRows);
    return [...leftRows, ...rightRows];
  }
}

export const cloudUploadBatchDefaults = Object.freeze({
  maxRows: DEFAULT_MAX_ROWS,
  maxBytes: DEFAULT_MAX_BYTES
});
