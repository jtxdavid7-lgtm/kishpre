import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { buildWebsiteExport, decodeCompactPackNode } from './compact-pack.mjs';
import {
  normalizeSolverJobInput,
  publicSolverJob,
  SOLVER_API_ID,
  SOLVER_API_SCHEMA_VERSION,
  SOLVER_TREE_POLICY,
  solverInputSha256
} from './protocol.mjs';

const HOST = process.env.SOLVER_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.SOLVER_UI_PORT || 8788);
const DATA_ROOT = path.resolve(
  process.env.SOLVER_UI_DATA_ROOT || 'F:/kish-gto/solver-ui-runs-v1'
);
const SOLVER_ROOT = path.resolve(
  process.env.POSTFLOP_SOLVER_ROOT || 'F:/kish-gto/solver-engines/postflop-solver-gg'
);
const SOLVER_BINARY = path.resolve(
  process.env.POSTFLOP_SOLVER_BINARY ||
    path.join(
      SOLVER_ROOT,
      'target',
      'release',
      'examples',
      process.platform === 'win32'
        ? 'gg_fulltree_direct_pack.exe'
        : 'gg_fulltree_direct_pack'
    )
);
const JOB_STATUSES = new Set([
  'queued',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'stopped',
  'interrupted'
]);
const jobs = new Map();
const pending = [];
let activeJobId = null;

function now() {
  return new Date().toISOString();
}

function slash(filePath) {
  return filePath.replaceAll('\\', '/');
}

function statusLinks(id) {
  return {
    self: `/api/v1/jobs/${id}`,
    stop: `/api/v1/jobs/${id}/stop`,
    retry: `/api/v1/jobs/${id}/retry`,
    result: `/api/v1/jobs/${id}/result`,
    export: `/api/v1/jobs/${id}/export`
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function serializedJob(job) {
  return {
    schemaVersion: SOLVER_API_SCHEMA_VERSION,
    id: job.id,
    inputSha256: job.inputSha256,
    input: job.input,
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
    links: job.links,
    stopRequested: job.stopRequested === true,
    processPid: Number.isInteger(job.processPid) ? job.processPid : null,
    logs: job.logs.slice(-200)
  };
}

function persistJob(job) {
  const operation = async () => {
    const temporary = path.join(job.directory, `job.${process.pid}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(serializedJob(job), null, 2)}\n`, 'utf8');
    await fs.rename(temporary, path.join(job.directory, 'job.json'));
  };
  job.persistPromise = (job.persistPromise ?? Promise.resolve()).then(operation, operation);
  return job.persistPromise;
}

function addLog(job, stream, text) {
  const clean = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (!clean) return;
  job.logs.push({ at: now(), stream, text: clean.slice(0, 4000) });
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

function parseProgress(job, text) {
  const pattern = /iteration:\s*(\d+)\s*\/\s*(\d+)\s*\(exploitability\s*=\s*([\d.eE+-]+)\)/g;
  for (const match of String(text).matchAll(pattern)) {
    const iteration = Number(match[1]);
    const totalIterations = Number(match[2]);
    const exploitabilityChips = Number(match[3]);
    const startingPotChips = job.input.potBb * 100;
    job.progress = {
      iteration,
      totalIterations,
      percent: totalIterations > 0 ? (iteration / totalIterations) * 100 : 0,
      exploitabilityChips: Number.isFinite(exploitabilityChips)
        ? exploitabilityChips
        : null,
      exploitabilityPotFraction:
        Number.isFinite(exploitabilityChips) && startingPotChips > 0
          ? exploitabilityChips / startingPotChips
          : null,
      updatedAt: now()
    };
  }
}

function commandArguments(job) {
  const input = job.input;
  const args = [
    '--mode',
    'smoke',
    '--output-format',
    'compact-binary-v1',
    '--emit-progress',
    '--tree-policy',
    input.treePolicyId,
    '--flop',
    input.board,
    '--pot-bb',
    String(input.potBb),
    '--stack-bb',
    String(input.effectiveStackBb),
    '--max-iterations',
    String(input.solve.maxIterations),
    '--target-exploitability-pot-fraction',
    String(input.solve.targetExploitabilityPotFraction),
    '--rake-rate',
    String(input.economics.rakeRate),
    '--rake-cap-bb',
    String(input.economics.rakeCapBb),
    '--flat-drop-threshold-bb',
    String(input.economics.flatDropThresholdBb),
    '--flat-drop-amount-bb',
    String(input.economics.flatDropAmountBb),
    '--export-streets',
    input.export.streets,
    '--node-limit',
    String(input.export.nodeLimit),
    '--output',
    job.packPath
  ];
  if (input.export.streets !== 'flop') {
    args.push('--turn-card-limit', String(input.export.turnCardLimit));
  }
  if (input.export.streets === 'flop-turn-river') {
    args.push('--river-card-limit', String(input.export.riverCardLimit));
  }
  if (input.export.turnCard) args.push('--turn-card', input.export.turnCard);
  if (input.export.riverCard) args.push('--river-card', input.export.riverCard);
  if (input.economics.model === 'zero-rake') args.push('--zero-rake');
  for (const position of ['oop', 'ip']) {
    const range = input.ranges[position];
    if (range.format === 'text') {
      args.push(`--${position}-range`, range.value);
    } else {
      args.push(`--${position}-range-f32le`, path.join(job.directory, `${position}.range.f32le`));
    }
  }
  return args;
}

async function writeRangeAssets(job) {
  for (const position of ['oop', 'ip']) {
    const range = job.input.ranges[position];
    if (range.format !== 'f32le-base64') continue;
    await fs.writeFile(
      path.join(job.directory, `${position}.range.f32le`),
      Buffer.from(range.data, 'base64'),
      { flag: 'wx' }
    );
  }
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.once('exit', (code) => resolve(code === 0 ? stdout.trim() : ''));
    child.once('error', () => resolve(''));
  });
}

async function processExecutable(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (process.platform === 'win32') {
    const output = await runPowerShell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.Path }`
    );
    return output ? path.resolve(output) : null;
  }
  if (process.platform === 'linux') {
    return fs.readlink(`/proc/${pid}/exe`).then(path.resolve).catch(() => null);
  }
  return null;
}

async function terminateSolverProcess(pid) {
  const executable = await processExecutable(pid);
  if (!executable || executable.toLowerCase() !== SOLVER_BINARY.toLowerCase()) return false;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    process.kill(pid, 'SIGTERM');
  }
  return true;
}

async function sampleResources(job) {
  if (!job.child || job.resourceSamplePending) return;
  job.resourceSamplePending = true;
  try {
    let sample = null;
    if (process.platform === 'win32') {
      const output = await runPowerShell(
        `$p = Get-Process -Id ${Number(job.child.pid)} -ErrorAction SilentlyContinue; ` +
          `if ($p) { [pscustomobject]@{ cpuSeconds=$p.CPU; workingSetBytes=$p.WorkingSet64; ` +
          `privateBytes=$p.PrivateMemorySize64 } | ConvertTo-Json -Compress }`
      );
      if (output) sample = JSON.parse(output);
    } else if (process.platform === 'linux') {
      const status = await fs.readFile(`/proc/${job.child.pid}/status`, 'utf8').catch(() => '');
      const workingSetKb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
      sample = { workingSetBytes: workingSetKb * 1024, privateBytes: null, cpuSeconds: null };
    }
    if (!sample) return;
    const sampledAt = Date.now();
    let cpuPercent = null;
    if (
      Number.isFinite(sample.cpuSeconds) &&
      Number.isFinite(job.lastCpuSeconds) &&
      Number.isFinite(job.lastResourceSampleAt)
    ) {
      const elapsedSeconds = (sampledAt - job.lastResourceSampleAt) / 1000;
      if (elapsedSeconds > 0) cpuPercent = ((sample.cpuSeconds - job.lastCpuSeconds) / elapsedSeconds) * 100;
    }
    job.lastCpuSeconds = Number.isFinite(sample.cpuSeconds) ? sample.cpuSeconds : job.lastCpuSeconds;
    job.lastResourceSampleAt = sampledAt;
    job.resources = {
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : null,
      cpuLogicalCount: os.cpus().length,
      workingSetBytes: Number(sample.workingSetBytes) || null,
      privateBytes: Number(sample.privateBytes) || null,
      peakWorkingSetBytes: Math.max(
        job.resources.peakWorkingSetBytes ?? 0,
        Number(sample.workingSetBytes) || 0
      ),
      sampledAt: now()
    };
    await persistJob(job);
  } catch (error) {
    addLog(job, 'monitor', error.message);
  } finally {
    job.resourceSamplePending = false;
  }
}

async function finishSuccessfulJob(job) {
  job.phase = 'packaging';
  await persistJob(job);
  const manifestPath = path.join(job.packPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const websiteExport = await buildWebsiteExport(job.packPath);
  const exportPath = path.join(job.directory, 'website-export-v1.json');
  await fs.writeFile(exportPath, `${JSON.stringify(websiteExport)}\n`, { flag: 'wx' });
  const resultSha256 = await fileSha256(exportPath);
  job.status = 'succeeded';
  job.phase = 'completed';
  job.finishedAt = now();
  job.progress = {
    iteration: manifest.solve?.maxIterations ?? job.progress.iteration,
    totalIterations: manifest.solve?.maxIterations ?? job.progress.totalIterations,
    percent: 100,
    exploitabilityChips: manifest.solve?.finalExploitabilityChips ?? null,
    exploitabilityPotFraction: manifest.solve?.finalExploitabilityPotFraction ?? null,
    updatedAt: now()
  };
  job.result = {
    format: websiteExport.format,
    sha256: resultSha256,
    bytes: (await fs.stat(exportPath)).size,
    nodeCount: manifest.nodes.length,
    groupCount: manifest.groups.length,
    releaseStatus: manifest.releaseStatus,
    releaseEligible: manifest.releaseEligible,
    treeHash: manifest.treeHash,
    rangeHash: manifest.rangeHash,
    modelHash: manifest.modelHash,
    finalExploitabilityPotFraction: manifest.solve?.finalExploitabilityPotFraction ?? null
  };
}

async function executeJob(job) {
  activeJobId = job.id;
  job.status = 'running';
  job.phase = 'initializing';
  job.startedAt = now();
  await persistJob(job);
  try {
    if (!await pathExists(SOLVER_BINARY)) {
      throw new Error(`找不到 solver 二进制：${SOLVER_BINARY}`);
    }
    await writeRangeAssets(job);
    const args = commandArguments(job);
    job.phase = 'solving';
    job.reproducibility.command = [slash(SOLVER_BINARY), ...args.map(slash)];
    await persistJob(job);
    await new Promise((resolve, reject) => {
      const child = spawn(SOLVER_BINARY, args, {
        cwd: SOLVER_ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      job.child = child;
      job.processPid = child.pid;
      void persistJob(job);
      let stdoutTail = '';
      let stderrTail = '';
      const consume = (stream) => (chunk) => {
        const text = chunk.toString('utf8');
        if (stream === 'stdout') {
          stdoutTail = `${stdoutTail}${text}`.slice(-16_000);
          parseProgress(job, stdoutTail);
        } else {
          stderrTail = `${stderrTail}${text}`.slice(-16_000);
        }
        for (const line of text.split(/[\r\n]+/)) addLog(job, stream, line);
        void persistJob(job);
      };
      child.stdout.on('data', consume('stdout'));
      child.stderr.on('data', consume('stderr'));
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        job.child = null;
        job.processPid = null;
        if (job.resourceTimer) clearInterval(job.resourceTimer);
        job.resourceTimer = null;
        if (job.stopRequested) return resolve({ stopped: true, code, signal });
        if (code === 0) return resolve({ stopped: false, code, signal });
        reject(new Error(`solver 退出：code=${code ?? '-'} signal=${signal ?? '-'}`));
      });
      job.resourceTimer = setInterval(() => void sampleResources(job), 2000);
      void sampleResources(job);
    }).then(async ({ stopped }) => {
      if (stopped) {
        job.status = 'stopped';
        job.phase = 'stopped';
        job.finishedAt = now();
      } else {
        await finishSuccessfulJob(job);
      }
    });
  } catch (error) {
    job.status = job.stopRequested ? 'stopped' : 'failed';
    job.phase = job.stopRequested ? 'stopped' : 'failed';
    job.finishedAt = now();
    job.error = {
      code: error.code || 'SOLVER_JOB_FAILED',
      message: error.message,
      at: now()
    };
    addLog(job, 'server', error.stack || error.message);
  } finally {
    if (job.resourceTimer) clearInterval(job.resourceTimer);
    job.resourceTimer = null;
    job.child = null;
    job.processPid = null;
    await persistJob(job);
    activeJobId = null;
    void runNextJob();
  }
}

function runNextJob() {
  if (activeJobId || pending.length === 0) return;
  const nextId = pending.shift();
  const job = jobs.get(nextId);
  if (!job || job.status !== 'queued') return void runNextJob();
  void executeJob(job);
}

async function createJob(input) {
  const normalized = normalizeSolverJobInput(input);
  const inputSha256 = solverInputSha256(normalized);
  const id = `${Date.now().toString(36)}-${inputSha256.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(DATA_ROOT, id);
  await fs.mkdir(directory, { recursive: false });
  const binarySha256 = await fileSha256(SOLVER_BINARY).catch(() => null);
  const job = {
    id,
    directory,
    packPath: path.join(directory, 'compact-pack'),
    input: normalized,
    inputSha256,
    status: 'queued',
    phase: 'queued',
    createdAt: now(),
    progress: {
      iteration: 0,
      totalIterations: normalized.solve.maxIterations,
      percent: 0,
      exploitabilityChips: null,
      exploitabilityPotFraction: null,
      updatedAt: now()
    },
    resources: {
      cpuPercent: null,
      cpuLogicalCount: os.cpus().length,
      workingSetBytes: null,
      privateBytes: null,
      peakWorkingSetBytes: 0,
      sampledAt: null
    },
    reproducibility: {
      apiId: SOLVER_API_ID,
      apiSchemaVersion: SOLVER_API_SCHEMA_VERSION,
      inputSha256,
      solverBinary: slash(SOLVER_BINARY),
      solverBinarySha256: binarySha256,
      dataDirectory: slash(directory),
      command: null
    },
    links: statusLinks(id),
    logs: [],
    stopRequested: false
  };
  jobs.set(id, job);
  await persistJob(job);
  pending.push(id);
  runNextJob();
  return job;
}

async function recoverJobs() {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(DATA_ROOT, entry.name);
    const persisted = await fs
      .readFile(path.join(directory, 'job.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!persisted || !JOB_STATUSES.has(persisted.status)) continue;
    const job = {
      ...persisted,
      directory,
      packPath: path.join(directory, 'compact-pack'),
      logs: Array.isArray(persisted.logs) ? persisted.logs : [],
      links: statusLinks(persisted.id),
      persistPromise: Promise.resolve(),
      stopRequested: false
    };
    if (['queued', 'running', 'stopping'].includes(job.status)) {
      const terminatedOrphan = Number.isInteger(job.processPid)
        ? await terminateSolverProcess(job.processPid)
        : false;
      job.processPid = null;
      job.status = 'interrupted';
      job.phase = 'interrupted';
      job.finishedAt = now();
      job.error = {
        code: 'SERVER_RESTARTED',
        message: terminatedOrphan
          ? '后台服务重启，已终止经二进制路径核验的遗留 solver 进程；可使用重试创建同输入任务。'
          : '后台服务重启，未发现可安全核验的遗留 solver 进程；可使用重试创建同输入任务。',
        at: now()
      };
      await persistJob(job);
    }
    jobs.set(job.id, job);
  }
}

function allowedOrigin(origin) {
  if (!origin) return null;
  const configured = process.env.SOLVER_UI_ALLOWED_ORIGINS;
  if (configured) {
    const allowed = configured.split(',').map((value) => value.trim()).filter(Boolean);
    return allowed.includes(origin) ? origin : null;
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin : null;
}

function rejectDisallowedBrowserOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin || allowedOrigin(origin)) return false;
  sendJson(request, response, 403, {
    error: 'ORIGIN_NOT_ALLOWED',
    message: '该网页无权调用本机 Solver'
  });
  return true;
}

function sendJson(request, response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  const origin = allowedOrigin(request.headers.origin);
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) {
      const error = new Error('请求体超过 2MiB');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('请求体不是有效 JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function stopJob(job) {
  if (job.status === 'queued') {
    job.stopRequested = true;
    job.status = 'stopped';
    job.phase = 'stopped';
    job.finishedAt = now();
    await persistJob(job);
    return;
  }
  if (job.status !== 'running' || !job.child) return;
  job.stopRequested = true;
  job.status = 'stopping';
  job.phase = 'stopping';
  await persistJob(job);
  await terminateSolverProcess(job.child.pid);
}

async function requestHandler(request, response) {
  const origin = allowedOrigin(request.headers.origin);
  if (rejectDisallowedBrowserOrigin(request, response)) return;
  if (request.method === 'OPTIONS') {
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.headers['access-control-request-private-network'] === 'true') {
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    });
    return response.end();
  }
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (request.method === 'GET' && url.pathname === '/api/v1/health') {
    const binaryAvailable = await pathExists(SOLVER_BINARY);
    return sendJson(request, response, binaryAvailable ? 200 : 503, {
      apiId: SOLVER_API_ID,
      schemaVersion: SOLVER_API_SCHEMA_VERSION,
      status: binaryAvailable ? 'ready' : 'solver-binary-missing',
      bind: `${HOST}:${PORT}`,
      queue: { activeJobId, pending: pending.length },
      solver: { binary: slash(SOLVER_BINARY), available: binaryAvailable },
      treePolicy: SOLVER_TREE_POLICY
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/jobs') {
    const list = [...jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 100)
      .map(publicSolverJob);
    return sendJson(request, response, 200, { jobs: list });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/jobs') {
    const job = await createJob(await readJsonBody(request));
    return sendJson(request, response, 202, publicSolverJob(job));
  }
  const match = url.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9-]+)(?:\/(stop|retry|result|export))?$/);
  if (!match) return sendJson(request, response, 404, { error: 'NOT_FOUND' });
  const job = jobs.get(match[1]);
  if (!job) return sendJson(request, response, 404, { error: 'JOB_NOT_FOUND' });
  const action = match[2] ?? 'status';
  if (request.method === 'GET' && action === 'status') {
    return sendJson(request, response, 200, publicSolverJob(job));
  }
  if (request.method === 'POST' && action === 'stop') {
    await stopJob(job);
    return sendJson(request, response, 202, publicSolverJob(job));
  }
  if (request.method === 'POST' && action === 'retry') {
    if (!['failed', 'stopped', 'interrupted'].includes(job.status)) {
      return sendJson(request, response, 409, { error: 'JOB_NOT_RETRYABLE' });
    }
    const retried = await createJob(job.input);
    return sendJson(request, response, 202, publicSolverJob(retried));
  }
  if (request.method === 'GET' && action === 'result') {
    if (job.status !== 'succeeded') {
      return sendJson(request, response, 409, { error: 'RESULT_NOT_READY', status: job.status });
    }
    const nodeId = Number(url.searchParams.get('node') ?? 0);
    const result = await decodeCompactPackNode(job.packPath, nodeId);
    result.job = publicSolverJob(job);
    return sendJson(request, response, 200, result);
  }
  if (request.method === 'GET' && action === 'export') {
    if (job.status !== 'succeeded') {
      return sendJson(request, response, 409, { error: 'RESULT_NOT_READY', status: job.status });
    }
    const exportPath = path.join(job.directory, 'website-export-v1.json');
    const stats = await fs.stat(exportPath);
    const originValue = allowedOrigin(request.headers.origin);
    if (originValue) response.setHeader('Access-Control-Allow-Origin', originValue);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="kishpoker-solver-${job.id}.json"`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"sha256-${job.result.sha256}"`,
      'X-Content-Type-Options': 'nosniff'
    });
    return createReadStream(exportPath).pipe(response);
  }
  return sendJson(request, response, 405, { error: 'METHOD_NOT_ALLOWED' });
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('SOLVER_UI_PORT 必须是有效端口');
}
if (!path.isAbsolute(DATA_ROOT) || path.parse(DATA_ROOT).root === DATA_ROOT) {
  throw new Error('SOLVER_UI_DATA_ROOT 必须是非磁盘根目录的绝对路径');
}

await recoverJobs();
const server = http.createServer((request, response) => {
  void requestHandler(request, response).catch((error) => {
    const status = error.statusCode || (error.code === 'INVALID_SOLVER_INPUT' ? 400 : 500);
    sendJson(request, response, status, {
      error: error.code || 'INTERNAL_ERROR',
      message: error.message,
      field: error.field ?? null
    });
  });
});
server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    event: 'kishpoker-solver-api-ready',
    apiId: SOLVER_API_ID,
    url: `http://${HOST}:${PORT}/api/v1`,
    dataRoot: slash(DATA_ROOT),
    solverBinary: slash(SOLVER_BINARY),
    recoveredJobs: jobs.size
  }));
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const activeJob = activeJobId ? jobs.get(activeJobId) : null;
  if (activeJob?.child) {
    activeJob.stopRequested = true;
    activeJob.status = 'interrupted';
    activeJob.phase = 'interrupted';
    activeJob.finishedAt = now();
    activeJob.error = {
      code: 'SERVER_SHUTDOWN',
      message: '后台服务关闭，solver 子进程已安全终止；可按相同输入重试。',
      at: now()
    };
    await terminateSolverProcess(activeJob.child.pid);
    await persistJob(activeJob);
  }
  server.close(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown());
