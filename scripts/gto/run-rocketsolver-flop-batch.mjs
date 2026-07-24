import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const seedPath = path.resolve(
  process.env.ROCKETSOLVER_POSTFLOP_SEED ??
    'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-100bb-seed.json'
);
const outputDirectory = path.resolve(
  process.env.ROCKETSOLVER_FLOP_BATCH_OUTPUT ??
    'C:/Users/Administrator/Documents/kish/gto-work/flop-batch-v1'
);
// Default conservatively: this machine has shown kernel instability under the former 24-thread load.
// A higher count remains available as an explicit environment override after hardware validation.
const threadCount = Number.parseInt(process.env.ROCKETSOLVER_THREADS ?? '4', 10);
const targetAccuracy = Number.parseFloat(process.env.ROCKETSOLVER_TARGET_ACCURACY ?? '0.003');
const targetExploitability = Number.parseFloat(
  process.env.ROCKETSOLVER_BATCH_EXPLOITABILITY ?? '0.02'
);
const requestedLimit = Number.parseInt(process.env.ROCKETSOLVER_BATCH_LIMIT ?? '0', 10);
const retryCount = Number.parseInt(process.env.ROCKETSOLVER_BATCH_RETRIES ?? '2', 10);
const cdpConnectTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_CDP_CONNECT_TIMEOUT_MS ?? '30000',
  10
);
const cdpRequestTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_CDP_REQUEST_TIMEOUT_MS ?? '45000',
  10
);
const solveTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_BOARD_SOLVE_TIMEOUT_MS ?? String(5 * 60 * 1000),
  10
);
const checkpointPath = path.join(outputDirectory, 'checkpoint.json');
const treePath = path.join(outputDirectory, 'tree.json');
const heartbeatPath = path.join(outputDirectory, 'heartbeat.json');

const POSTFLOP_PROTOTYPE = Object.freeze({
  gameType: 0,
  betType: 0,
  initialStreet: 1,
  isHeadsUp: true,
  bigBlind: 1,
  deadMoney: 5.5,
  firstPlayer: null,
  players: [
    { position: 0, initialStack: 97.5, blind: null },
    { position: 8, initialStack: 97.5, blind: null }
  ]
});

const POPULATION_SETTINGS = Object.freeze({
  convertCapToAllIn: false,
  betToAllInThresholdPreflop: 0.35,
  betToAllInThresholdPostflop: 0.5,
  callToAllInThreshold: 0.8,
  maxLimps: 3,
  maxCalls: 2,
  preflopColdCalls: Object.fromEntries(
    [2, 3, 4, 5].map((playerCount) => [
      playerCount,
      [false, false, false, false, false, false, false, false, true, false]
    ])
  )
});

function permutations(values) {
  if (values.length === 1) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, itemIndex) => itemIndex !== index))
    .map((tail) => [value, ...tail]));
}

const SUIT_PERMUTATIONS = permutations([0, 1, 2, 3]);

function canonicalBoard(cards) {
  let best = null;
  for (const suits of SUIT_PERMUTATIONS) {
    const candidate = cards
      .map((card) => Math.floor(card / 4) * 4 + suits[card % 4])
      .sort((left, right) => left - right);
    if (!best || candidate.some((card, index) => card !== best[index] && card < best[index])) {
      const firstDifference = best ? candidate.findIndex((card, index) => card !== best[index]) : 0;
      if (!best || candidate[firstDifference] < best[firstDifference]) best = candidate;
    }
  }
  return best;
}

function enumerateCanonicalFlops() {
  const boards = new Map();
  for (let first = 0; first < 52; first += 1) {
    for (let second = first + 1; second < 52; second += 1) {
      for (let third = second + 1; third < 52; third += 1) {
        const board = canonicalBoard([first, second, third]);
        boards.set(board.join('-'), board);
      }
    }
  }
  return [...boards.values()].sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  });
}

function boardId(board) {
  return board.map((card) => card.toString(36).padStart(2, '0')).join('');
}

function buildSolverConfig(seed, board) {
  return {
    board,
    ranges: [seed.ranges.BB, seed.ranges.BTN],
    rakePercentage: 0.05,
    rakeCap: 3,
    flatDrop: 1.5,
    flatDropCondition: { condition: 'potSize', potSize: 30 },
    rakeTakePreflop: 'no',
    abstraction: [null, null, null, null],
    saveEv: [0, 0, 0, 0],
    bunchingRanges: [],
    compactMode: false
  };
}

async function connect() {
  const targets = await fetch(endpoint, { signal: AbortSignal.timeout(cdpConnectTimeoutMs) })
    .then((response) => {
      if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
      return response.json();
    });
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error(`未找到 RocketSolver 调试页面：${endpoint}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let requestId = 0;
  let closedError = null;

  function rejectPending(error) {
    closedError = error;
    for (const handler of pending.values()) {
      clearTimeout(handler.timer);
      handler.reject(error);
    }
    pending.clear();
  }

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    clearTimeout(handler.timer);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });
  socket.addEventListener('close', () => rejectPending(new Error('CDP WebSocket closed unexpectedly')));
  socket.addEventListener('error', () => rejectPending(new Error('CDP WebSocket transport error')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP WebSocket connect timed out after ${cdpConnectTimeoutMs}ms`)),
      cdpConnectTimeoutMs
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket failed to connect'));
    }, { once: true });
  });
  return {
    close() {
      rejectPending(new Error('CDP client closed'));
      socket.close();
    },
    send(method, params = {}, timeoutMs = cdpRequestTimeoutMs) {
      if (closedError) return Promise.reject(closedError);
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const error = new Error(`CDP ${method} timed out after ${timeoutMs}ms`);
          error.code = 'CDP_TIMEOUT';
          reject(error);
          rejectPending(error);
          socket.close();
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    }
  };
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitForRocketApi(client) {
  const deadline = Date.now() + cdpConnectTimeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      client,
      `typeof window.electron === 'object' && typeof window.solver === 'object'`
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`RocketSolver API did not become ready within ${cdpConnectTimeoutMs}ms`);
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function writeHeartbeat(state) {
  await writeJsonAtomic(heartbeatPath, {
    schemaVersion: 1,
    processId: process.pid,
    updatedAt: new Date().toISOString(),
    ...state
  });
}

function isFatalAutomationError(error) {
  return error?.code === 'CDP_TIMEOUT' ||
    /CDP|WebSocket|fetch failed|ECONNREFUSED/i.test(error?.message ?? '');
}

function packFlopStrategies(nodes) {
  const metadata = [];
  const buffers = [];
  let byteOffset = 0;
  let validComboRows = 0;
  for (const node of nodes) {
    const valueCount = 2 + node.actions.length * 2;
    const buffer = Buffer.allocUnsafe(1326 * valueCount * 4);
    let localOffset = 0;
    for (let comboIndex = 0; comboIndex < 1326; comboIndex += 1) {
      const values = [node.reach[comboIndex], node.evPerHand[comboIndex]];
      for (let actionIndex = 0; actionIndex < node.actions.length; actionIndex += 1) {
        values.push(node.strategyPerAction[actionIndex][comboIndex]);
        values.push(node.evPerAction[actionIndex][comboIndex]);
      }
      const valid = values.every(Number.isFinite);
      if (valid) {
        validComboRows += 1;
        const frequencyTotal = node.strategyPerAction.reduce(
          (sum, actionValues) => sum + actionValues[comboIndex],
          0
        );
        if (node.reach[comboIndex] > 1e-9 && Math.abs(frequencyTotal - 1) > 0.003) {
          throw new Error(`${node.key} / combo ${comboIndex} 频率未闭合：${frequencyTotal}`);
        }
      }
      for (const value of values) {
        buffer.writeFloatLE(Number.isFinite(value) ? value : Number.NaN, localOffset);
        localOffset += 4;
      }
    }
    metadata.push({
      key: node.key,
      state: node.state,
      actions: node.actions,
      byteOffset,
      byteLength: buffer.byteLength,
      valuesPerCombo: valueCount
    });
    buffers.push(buffer);
    byteOffset += buffer.byteLength;
  }
  return { metadata, payload: Buffer.concat(buffers), validComboRows };
}

async function solveBoard(client, seed, populationRules, board, id, attempt) {
  await writeHeartbeat({ state: 'preparing', id, board, attempt });
  await evaluate(client, `window.solver.newSolution(${JSON.stringify(JSON.stringify(POSTFLOP_PROTOTYPE))}, 0)`);
  await evaluate(
    client,
    `window.solver.populate('["Root"]', ${JSON.stringify(JSON.stringify(populationRules))}, ${JSON.stringify(JSON.stringify(POPULATION_SETTINGS))})`
  );
  const solverConfig = buildSolverConfig(seed, board);
  const serializedConfig = JSON.stringify(solverConfig);
  const requiredMemory = await evaluate(
    client,
    `window.solver.requiredMemory(true, ${JSON.stringify(serializedConfig)})`
  );
  await evaluate(client, `window.solver.initializeVanilla(${JSON.stringify(serializedConfig)})`);
  const startedAt = performance.now();
  await evaluate(client, `window.solver.run(${threadCount}, ${targetAccuracy})`);
  let status = null;
  const deadline = Date.now() + solveTimeoutMs;
  let lastHeartbeatAt = 0;
  while (Date.now() < deadline) {
    status = await evaluate(client, 'window.solver.solverStatus()');
    if (Number.isFinite(status?.exploitability) && status.exploitability <= targetExploitability) break;
    if (status && !status.isRunning) throw new Error(`求解器提前停止：${JSON.stringify(status)}`);
    if (Date.now() - lastHeartbeatAt >= 15000) {
      await writeHeartbeat({
        state: 'solving',
        id,
        board,
        attempt,
        iterations: status?.iterations ?? null,
        exploitability: status?.exploitability ?? null
      });
      lastHeartbeatAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(Number.isFinite(status?.exploitability) && status.exploitability <= targetExploitability)) {
    throw new Error(`五分钟内未达到 exploitability ${targetExploitability}`);
  }
  await evaluate(client, 'window.solver.stop()');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await evaluate(client, 'window.solver.solverStatus()');
    if (!status?.isRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const solveElapsedMs = performance.now() - startedAt;
  const nodesJson = await evaluate(client, `(() => {
    const stack = ['["Root"]'];
    const seen = new Set();
    const nodes = [];
    while (stack.length) {
      const key = stack.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const state = window.solver.pokerTableState(key);
      const children = window.solver.treeViewChildren(key) || [];
      for (const child of children) if (!child.isLeaf) stack.push(child.key);
      if (state?.street !== 1 || !state.actions?.length) continue;
      const [strategy] = window.solver.strategy(key, ${JSON.stringify(board)}, false);
      if (!strategy) throw new Error('缺少翻牌策略：' + key);
      nodes.push({
        key,
        state,
        actions: strategy.actions,
        reach: strategy.reach,
        evPerHand: strategy.evPerHand,
        strategyPerAction: strategy.strategyPerAction,
        evPerAction: strategy.evPerAction
      });
    }
    return JSON.stringify(nodes, (_key, value) => typeof value === 'bigint' ? Number(value) : value);
  })()`);
  return { requiredMemory, solveElapsedMs, status, nodes: JSON.parse(nodesJson) };
}

if (!Number.isInteger(threadCount) || threadCount < 1 || threadCount > 32) {
  throw new Error(`线程数必须在 1–32 之间：${threadCount}`);
}
if (!(targetExploitability > 0 && targetExploitability <= 0.1)) {
  throw new Error(`exploitability 目标无效：${targetExploitability}`);
}

const boards = enumerateCanonicalFlops();
if (boards.length !== 1755) throw new Error(`同构翻牌数量错误：${boards.length}`);
const selectedBoards = requestedLimit > 0 ? boards.slice(0, requestedLimit) : boards;
const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
if (seed?.ranges?.BTN?.length !== 1326 || seed?.ranges?.BB?.length !== 1326) {
  throw new Error(`翻后种子范围格式无效：${seedPath}`);
}
await fs.mkdir(outputDirectory, { recursive: true });
let checkpoint;
try {
  checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
} catch {
  checkpoint = {
    schemaVersion: 1,
    datasetId: 'gg-rnc-6max-100bb-btn-vs-bb-srp-all-flops-v1',
    generatedAt: new Date().toISOString(),
    totalCanonicalFlops: 1755,
    requestedFlops: selectedBoards.length,
    threadCount,
    targetExploitability,
    completed: [],
    failures: []
  };
}
const completedIds = new Set(checkpoint.completed.map((item) => item.id));
const client = await connect();
try {
  await client.send('Runtime.enable');
  await waitForRocketApi(client);
  await evaluate(client, 'window.electron.minimizeMainWindow(); true');
  const populationRules = await evaluate(client, 'window.electron.getConfigValue("population")?.rules ?? []');
  const pendingBoards = selectedBoards.filter((board) => !completedIds.has(boardId(board)));
  console.log(JSON.stringify({
    event: 'batch-start',
    outputDirectory,
    totalCanonicalFlops: boards.length,
    selectedFlops: selectedBoards.length,
    alreadyCompleted: completedIds.size,
    pending: pendingBoards.length,
    threadCount,
    targetExploitability
  }));

  const batchStartedAt = Date.now();
  for (let pendingIndex = 0; pendingIndex < pendingBoards.length; pendingIndex += 1) {
    const board = pendingBoards[pendingIndex];
    const id = boardId(board);
    let lastError = null;
    for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
      try {
        const result = await solveBoard(client, seed, populationRules, board, id, attempt);
        if (result.nodes.length !== 12) throw new Error(`翻牌节点数量错误：${result.nodes.length}`);
        const packed = packFlopStrategies(result.nodes);
        const dataFilename = `${id}.bin`;
        const metadataFilename = `${id}.json`;
        await fs.writeFile(path.join(outputDirectory, dataFilename), packed.payload);
        await writeJsonAtomic(path.join(outputDirectory, metadataFilename), {
          schemaVersion: 1,
          id,
          board,
          requiredMemory: result.requiredMemory,
          solveElapsedMs: result.solveElapsedMs,
          status: result.status,
          comboCount: 1326,
          nodes: packed.metadata
        });
        if (!(await fs.stat(treePath).catch(() => null))) {
          await writeJsonAtomic(treePath, {
            schemaVersion: 1,
            nodeCount: packed.metadata.length,
            nodes: packed.metadata.map(({ key, state, actions }) => ({ key, state, actions }))
          });
        }
        checkpoint.failures = checkpoint.failures.filter((failure) => failure.id !== id);
        checkpoint.completed = checkpoint.completed.filter((entry) => entry.id !== id);
        checkpoint.completed.push({
          id,
          board,
          dataFilename,
          metadataFilename,
          byteLength: packed.payload.byteLength,
          validComboRows: packed.validComboRows,
          solveElapsedMs: result.solveElapsedMs,
          exploitability: result.status.exploitability,
          iterations: result.status.iterations,
          completedAt: new Date().toISOString()
        });
        completedIds.add(id);
        await writeJsonAtomic(checkpointPath, checkpoint);
        await writeHeartbeat({
          state: 'completed',
          id,
          board,
          completed: checkpoint.completed.length,
          total: selectedBoards.length
        });
        const totalCompleted = checkpoint.completed.length;
        const elapsedMs = Date.now() - batchStartedAt;
        const rateMs = elapsedMs / (pendingIndex + 1);
        console.log(JSON.stringify({
          event: 'flop-complete',
          id,
          board,
          progress: `${totalCompleted}/${selectedBoards.length}`,
          solveElapsedMs: Math.round(result.solveElapsedMs),
          exploitability: result.status.exploitability,
          requiredMemory: result.requiredMemory,
          bytes: packed.payload.byteLength,
          etaMinutes: Math.round((selectedBoards.length - totalCompleted) * rateMs / 60000)
        }));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.error(JSON.stringify({ event: 'flop-attempt-failed', id, board, attempt, error: error.message }));
        if (isFatalAutomationError(error)) throw error;
        try { await evaluate(client, 'window.solver.stop()'); } catch {}
        try { await evaluate(client, 'window.solver.unload()'); } catch {}
      }
    }
    if (lastError) {
      checkpoint.failures = checkpoint.failures.filter((failure) => failure.id !== id);
      checkpoint.failures.push({ id, board, error: lastError.message, failedAt: new Date().toISOString() });
      await writeJsonAtomic(checkpointPath, checkpoint);
    }
    try { await evaluate(client, 'window.solver.unload()'); } catch {}
  }
  checkpoint.finishedAt = new Date().toISOString();
  await writeJsonAtomic(checkpointPath, checkpoint);
  console.log(JSON.stringify({
    event: 'batch-finished',
    completed: checkpoint.completed.length,
    failures: checkpoint.failures.length,
    outputDirectory
  }));
} finally {
  try { await evaluate(client, 'window.solver.unload()'); } catch {}
  client.close();
}
