import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rocketExecutable = path.resolve(
  process.env.ROCKETSOLVER_EXE ??
    'C:/Users/Administrator/AppData/Local/Programs/rocket_solver/RocketSolver.exe'
);
const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const outputDirectory = path.resolve(
  process.env.ROCKETSOLVER_TURN_BATCH_OUTPUT ?? 'F:/kish-gto/turn-batch-v1'
);
const idleTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_SUPERVISOR_IDLE_TIMEOUT_MS ?? String(6 * 60 * 1000),
  10
);
const restartDelayMs = Number.parseInt(
  process.env.ROCKETSOLVER_SUPERVISOR_RESTART_DELAY_MS ?? '10000',
  10
);
const maxConsecutiveRestarts = Number.parseInt(
  process.env.ROCKETSOLVER_SUPERVISOR_MAX_RESTARTS ?? '8',
  10
);
const checkpointPath = path.join(outputDirectory, 'checkpoint.json');
const heartbeatPath = path.join(outputDirectory, 'heartbeat.json');
const supervisorLogPath = path.join(outputDirectory, 'supervisor.log');
const stdoutLogPath = path.join(outputDirectory, 'batch.log');
const stderrLogPath = path.join(outputDirectory, 'batch-error.log');
const debugPort = new URL(endpoint).port || '9229';

let activeBatch = null;
let activeRocket = null;
let stopping = false;

function log(event, details = {}) {
  const record = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  fs.appendFileSync(supervisorLogPath, `${record}\n`, 'utf8');
  console.log(record);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function killProcessTree(child, label) {
  if (!child?.pid) return;
  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8'
  });
  log('process-tree-stopped', {
    label,
    processId: child.pid,
    exitCode: result.status,
    stderr: result.stderr?.trim() || null
  });
}

function readCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch {
    return null;
  }
}

function activityModifiedAt() {
  let latest = 0;
  for (const filePath of [heartbeatPath, checkpointPath]) {
    try {
      latest = Math.max(latest, fs.statSync(filePath).mtimeMs);
    } catch {
      // The first batch process creates these files.
    }
  }
  return latest;
}

async function waitForRocket() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (activeRocket?.exitCode !== null) {
      throw new Error(`RocketSolver exited during startup with code ${activeRocket.exitCode}`);
    }
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const targets = await response.json();
        if (targets.some((target) => target.type === 'page' && target.webSocketDebuggerUrl)) {
          await delay(5000);
          return;
        }
      }
    } catch {
      // RocketSolver can take several seconds to expose the page target.
    }
    await delay(1000);
  }
  throw new Error('RocketSolver CDP endpoint did not become ready within 90 seconds');
}

async function startRun() {
  activeRocket = spawn(rocketExecutable, [`--remote-debugging-port=${debugPort}`], {
    cwd: path.dirname(rocketExecutable),
    stdio: 'ignore',
    windowsHide: true
  });
  log('rocketsolver-started', { processId: activeRocket.pid, debugPort });
  await waitForRocket();

  const stdoutFd = fs.openSync(stdoutLogPath, 'a');
  const stderrFd = fs.openSync(stderrLogPath, 'a');
  try {
    activeBatch = spawn(process.execPath, ['scripts/gto/run-rocketsolver-turn-batch.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ROCKETSOLVER_CDP: endpoint,
        ROCKETSOLVER_TURN_BATCH_OUTPUT: outputDirectory
      },
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  log('batch-started', { processId: activeBatch.pid });
}

function waitForBatch(startingCompleted) {
  return new Promise((resolve) => {
    let settled = false;
    let latestCompleted = startingCompleted;
    let lastActivityAt = Math.max(Date.now(), activityModifiedAt());
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve({ ...result, madeProgress: latestCompleted > startingCompleted });
    };

    activeBatch.once('exit', (code, signal) => finish({ reason: 'exit', code, signal }));
    timer = setInterval(() => {
      if (settled) return;
      const checkpoint = readCheckpoint();
      const completed = checkpoint?.completed?.length ?? latestCompleted;
      if (completed > latestCompleted) {
        latestCompleted = completed;
        log('progress', {
          completed,
          total: checkpoint?.requestedFlops ?? null,
          failures: checkpoint?.failures?.length ?? null
        });
      }
      const modifiedAt = activityModifiedAt();
      if (modifiedAt > lastActivityAt) lastActivityAt = modifiedAt;
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        log('batch-stalled', {
          completed: latestCompleted,
          idleSeconds: Math.round((Date.now() - lastActivityAt) / 1000)
        });
        killProcessTree(activeBatch, 'batch');
        finish({ reason: 'stalled', code: null, signal: null });
      }
    }, 15_000);
  });
}

function cleanup() {
  if (stopping) return;
  stopping = true;
  killProcessTree(activeBatch, 'batch');
  killProcessTree(activeRocket, 'rocketsolver');
}

process.once('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.once('exit', cleanup);

fs.mkdirSync(outputDirectory, { recursive: true });
log('supervisor-started', {
  processId: process.pid,
  outputDirectory,
  idleTimeoutMs,
  maxConsecutiveRestarts
});

let consecutiveRestarts = 0;
while (!stopping) {
  const before = readCheckpoint();
  const startingCompleted = before?.completed?.length ?? 0;
  try {
    await startRun();
    const result = await waitForBatch(startingCompleted);
    const checkpoint = readCheckpoint();
    const completed = checkpoint?.completed?.length ?? startingCompleted;
    const total = checkpoint?.requestedFlops ?? 0;
    const failures = checkpoint?.failures?.length ?? 0;
    log('batch-ended', { ...result, completed, total, failures });

    if (result.code === 0 && total > 0 && completed >= total && failures === 0) {
      log('supervisor-finished', { completed, total, failures });
      stopping = true;
      break;
    }
    consecutiveRestarts = result.madeProgress ? 0 : consecutiveRestarts + 1;
  } catch (error) {
    consecutiveRestarts += 1;
    log('run-failed', { error: error.message, consecutiveRestarts });
  } finally {
    killProcessTree(activeBatch, 'batch');
    killProcessTree(activeRocket, 'rocketsolver');
    activeBatch = null;
    activeRocket = null;
  }

  if (consecutiveRestarts > maxConsecutiveRestarts) {
    log('supervisor-aborted', { reason: 'restart-limit', consecutiveRestarts });
    process.exitCode = 1;
    break;
  }
  log('restart-scheduled', { delayMs: restartDelayMs, consecutiveRestarts });
  await delay(restartDelayMs);
}
