const DEFAULT_SOLVER_API_BASE = 'http://127.0.0.1:8788/api/v1';

export const SOLVER_API_BASE = String(
  import.meta.env.VITE_SOLVER_API_BASE || DEFAULT_SOLVER_API_BASE
).replace(/\/$/, '');

async function request(path, options = {}) {
  const response = await fetch(`${SOLVER_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `请求失败：${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function getSolverHealth() {
  return request('/health');
}

export function listSolverJobs() {
  return request('/jobs');
}

export function createSolverJob(input) {
  return request('/jobs', { method: 'POST', body: JSON.stringify(input) });
}

export function getSolverJob(id) {
  return request(`/jobs/${encodeURIComponent(id)}`);
}

export function stopSolverJob(id) {
  return request(`/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}

export function retrySolverJob(id) {
  return request(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export function getSolverResult(id, nodeId = 0) {
  return request(`/jobs/${encodeURIComponent(id)}/result?node=${encodeURIComponent(nodeId)}`);
}

export function solverExportUrl(id) {
  return `${SOLVER_API_BASE}/jobs/${encodeURIComponent(id)}/export`;
}
