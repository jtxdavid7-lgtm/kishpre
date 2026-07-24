import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const seedPath = path.resolve(
  process.env.ROCKETSOLVER_POSTFLOP_SEED ??
    'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-100bb-seed.json'
);
const outputDirectory = path.resolve(
  process.env.ROCKETSOLVER_TURN_BATCH_OUTPUT ?? 'F:/kish-gto/turn-batch-v1'
);
const threadCount = Number.parseInt(process.env.ROCKETSOLVER_THREADS ?? '8', 10);
const targetAccuracy = Number.parseFloat(process.env.ROCKETSOLVER_TARGET_ACCURACY ?? '0.003');
const targetExploitability = Number.parseFloat(
  process.env.ROCKETSOLVER_BATCH_EXPLOITABILITY ?? '0.02'
);
const requestedLimit = Number.parseInt(process.env.ROCKETSOLVER_BATCH_LIMIT ?? '0', 10);
const solveTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_BOARD_SOLVE_TIMEOUT_MS ?? String(5 * 60 * 1000),
  10
);
const cdpTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_CDP_REQUEST_TIMEOUT_MS ?? '45000',
  10
);
const cdpConnectTimeoutMs = Number.parseInt(
  process.env.ROCKETSOLVER_CDP_CONNECT_TIMEOUT_MS ?? '90000',
  10
);
const checkpointPath = path.join(outputDirectory, 'checkpoint.json');
const heartbeatPath = path.join(outputDirectory, 'heartbeat.json');
const treePath = path.join(outputDirectory, 'turn-tree.json');

const RANKS = Object.freeze(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);
const HAND_LABELS = Object.freeze(RANKS.flatMap((rowRank, rowIndex) => RANKS.map(
  (columnRank, columnIndex) => {
    if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
    if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
    return `${columnRank}${rowRank}o`;
  }
)));

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
  return values.flatMap((value, index) => permutations(
    values.filter((_, itemIndex) => itemIndex !== index)
  ).map((tail) => [value, ...tail]));
}

const SUIT_PERMUTATIONS = permutations([0, 1, 2, 3]);

function mapCard(card, suits) {
  return Math.floor(card / 4) * 4 + suits[card % 4];
}

function compareBoards(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function canonicalFlop(cards) {
  let best = null;
  for (const suits of SUIT_PERMUTATIONS) {
    const candidate = cards.map((card) => mapCard(card, suits)).sort((left, right) => left - right);
    if (!best || compareBoards(candidate, best) < 0) best = candidate;
  }
  return best;
}

function enumerateCanonicalFlops() {
  const boards = new Map();
  for (let first = 0; first < 52; first += 1) {
    for (let second = first + 1; second < 52; second += 1) {
      for (let third = second + 1; third < 52; third += 1) {
        const board = canonicalFlop([first, second, third]);
        boards.set(board.join('-'), board);
      }
    }
  }
  return [...boards.values()].sort(compareBoards);
}

function sameBoard(left, right) {
  return left.length === right.length && left.every((card, index) => card === right[index]);
}

function enumerateCanonicalTurns(flop) {
  const normalizedFlop = [...flop].sort((left, right) => left - right);
  const flopCards = new Set(normalizedFlop);
  const stabilizer = SUIT_PERMUTATIONS.filter((suits) => sameBoard(
    normalizedFlop.map((card) => mapCard(card, suits)).sort((left, right) => left - right),
    normalizedFlop
  ));
  const representatives = new Map();
  for (let card = 0; card < 52; card += 1) {
    if (flopCards.has(card)) continue;
    const orbit = [...new Set(stabilizer.map((suits) => mapCard(card, suits)))].sort(
      (left, right) => left - right
    );
    const representative = orbit[0];
    if (!representatives.has(representative)) {
      representatives.set(representative, {
        card: representative,
        board: [...normalizedFlop, representative],
        orbitSize: orbit.length
      });
    }
  }
  const turns = [...representatives.values()].sort((left, right) => left.card - right.card);
  const totalOrbitSize = turns.reduce((sum, turn) => sum + turn.orbitSize, 0);
  if (totalOrbitSize !== 49) {
    throw new Error(`${flop.join('-')} 的转牌同构权重为 ${totalOrbitSize}，应为 49`);
  }
  return turns;
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
  const targets = await fetch(endpoint, { signal: AbortSignal.timeout(cdpTimeoutMs) })
    .then((response) => response.json());
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
  socket.addEventListener('close', () => rejectPending(new Error('CDP WebSocket 意外关闭')));
  socket.addEventListener('error', () => rejectPending(new Error('CDP WebSocket 传输错误')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), cdpTimeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    close() {
      rejectPending(new Error('CDP 客户端已关闭'));
      socket.close();
    },
    send(method, params = {}, timeoutMs = cdpTimeoutMs) {
      if (closedError) return Promise.reject(closedError);
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const error = new Error(`CDP ${method} 在 ${timeoutMs}ms 后超时`);
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

async function evaluate(client, expression, timeoutMs = cdpTimeoutMs) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, timeoutMs);
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    );
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

async function waitForSolve(client, id, board) {
  const deadline = Date.now() + solveTimeoutMs;
  let status = null;
  let lastHeartbeatAt = 0;
  while (Date.now() < deadline) {
    status = await evaluate(client, 'window.solver.solverStatus()');
    if (
      Number.isFinite(status?.exploitability) &&
      status.exploitability <= targetExploitability
    ) {
      break;
    }
    if (status && !status.isRunning) {
      throw new Error(`求解器提前停止：${JSON.stringify(status)}`);
    }
    if (Date.now() - lastHeartbeatAt >= 15000) {
      await writeHeartbeat({
        state: 'solving',
        id,
        board,
        iterations: status?.iterations ?? null,
        exploitability: status?.exploitability ?? null
      });
      lastHeartbeatAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (
    !Number.isFinite(status?.exploitability) ||
    status.exploitability > targetExploitability
  ) {
    throw new Error(`未在时限内达到 exploitability ${targetExploitability}`);
  }
  await evaluate(client, 'window.solver.stop()');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await evaluate(client, 'window.solver.solverStatus()');
    if (!status?.isRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (status?.isRunning) throw new Error(`${id} did not stop cleanly after reaching the target`);
  return status;
}

async function installTurnAggregator(client) {
  await evaluate(client, `(() => {
    const labels = ${JSON.stringify(HAND_LABELS)};
    globalThis.__kishTurnMasks = Object.fromEntries(labels.map((label) => {
      const weights = JSON.parse(window.solver.parseHoldemRange(label));
      return [label, weights.map((weight, index) => weight > 0 ? index : -1)
        .filter((index) => index >= 0)];
    }));
    globalThis.__kishAggregateTurn = (key, board) => {
      const [strategy] = window.solver.strategy(key, board, false);
      if (!strategy) throw new Error('缺少转牌策略：' + key + ' / ' + board.join(','));
      const values = [];
      for (const indices of Object.values(globalThis.__kishTurnMasks)) {
        let reachTotal = 0;
        let totalEv = 0;
        let combinations = 0;
        const actionFrequency = Array(strategy.actions.length).fill(0);
        const actionEv = Array(strategy.actions.length).fill(0);
        for (const index of indices) {
          const reach = strategy.reach[index];
          const valid = Number.isFinite(strategy.evPerHand[index]) &&
            strategy.actions.every((_action, actionIndex) =>
              Number.isFinite(strategy.strategyPerAction[actionIndex][index]) &&
              Number.isFinite(strategy.evPerAction[actionIndex][index]));
          if (!valid) continue;
          combinations += 1;
          if (!(reach > 0)) continue;
          reachTotal += reach;
          totalEv += reach * strategy.evPerHand[index];
          for (let actionIndex = 0; actionIndex < strategy.actions.length; actionIndex += 1) {
            actionFrequency[actionIndex] +=
              reach * strategy.strategyPerAction[actionIndex][index];
            actionEv[actionIndex] += reach * strategy.evPerAction[actionIndex][index];
          }
        }
        const denominator = reachTotal || 1;
        values.push(combinations, reachTotal / (combinations || 1), totalEv / denominator);
        for (let actionIndex = 0; actionIndex < strategy.actions.length; actionIndex += 1) {
          values.push(
            actionFrequency[actionIndex] / denominator,
            actionEv[actionIndex] / denominator
          );
        }
      }
      return values;
    };
    return Object.keys(globalThis.__kishTurnMasks).length;
  })()`);
}

async function scanTurnNodes(client) {
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
      if (state?.street !== 2 || !state.actions?.length) continue;
      nodes.push({ key, state, actions: state.actions.map((action) => action.label) });
    }
    return JSON.stringify(nodes, (_key, value) =>
      typeof value === 'bigint' ? Number(value) : value);
  })()`);
  const nodes = JSON.parse(nodesJson);
  nodes.sort((left, right) => left.key.localeCompare(right.key));
  if (nodes.length !== 72) throw new Error(`转牌决策节点为 ${nodes.length}，应为 72`);
  return nodes;
}

function packTurnValues(nodes, records) {
  const buffers = [];
  const metadata = [];
  let byteOffset = 0;
  nodes.forEach((node, nodeIndex) => {
    const valuesPerHand = 3 + node.actions.length * 2;
    const values = records[nodeIndex];
    if (!Array.isArray(values) || values.length !== HAND_LABELS.length * valuesPerHand) {
      throw new Error(`${node.key} 的聚合值长度无效`);
    }
    const buffer = Buffer.allocUnsafe(values.length * 4);
    values.forEach((value, valueIndex) => {
      if (!Number.isFinite(value)) {
        throw new Error(`${node.key} 的第 ${valueIndex} 个聚合值不是有限数`);
      }
      buffer.writeFloatLE(value, valueIndex * 4);
    });
    for (let handIndex = 0; handIndex < HAND_LABELS.length; handIndex += 1) {
      const offset = handIndex * valuesPerHand;
      const reach = values[offset + 1];
      if (!(reach > 1e-9)) continue;
      let closure = 0;
      for (let actionIndex = 0; actionIndex < node.actions.length; actionIndex += 1) {
        closure += values[offset + 3 + actionIndex * 2];
      }
      if (Math.abs(closure - 1) > 0.004) {
        throw new Error(`${node.key}/${HAND_LABELS[handIndex]} 频率未闭合：${closure}`);
      }
    }
    metadata.push({
      id: nodeIndex,
      key: node.key,
      actions: node.actions,
      byteOffset,
      byteLength: buffer.byteLength,
      valuesPerHand
    });
    buffers.push(buffer);
    byteOffset += buffer.byteLength;
  });
  return { payload: Buffer.concat(buffers), metadata };
}

async function extractTurn(client, nodes, turn) {
  const recordsJson = await evaluate(client, `JSON.stringify(
    ${JSON.stringify(nodes.map((node) => node.key))}
      .map((key) => globalThis.__kishAggregateTurn(key, ${JSON.stringify(turn.board)}))
  )`, Math.max(cdpTimeoutMs, 120000));
  return packTurnValues(nodes, JSON.parse(recordsJson));
}

async function solveAndExportFlop(client, seed, populationRules, flop) {
  const id = boardId(flop);
  await writeHeartbeat({ state: 'preparing', id, board: flop });
  await evaluate(
    client,
    `window.solver.newSolution(${JSON.stringify(JSON.stringify(POSTFLOP_PROTOTYPE))}, 0)`
  );
  await evaluate(
    client,
    `window.solver.populate('["Root"]', ` +
      `${JSON.stringify(JSON.stringify(populationRules))}, ` +
      `${JSON.stringify(JSON.stringify(POPULATION_SETTINGS))})`
  );
  const solverConfig = buildSolverConfig(seed, flop);
  const serializedConfig = JSON.stringify(solverConfig);
  const requiredMemory = await evaluate(
    client,
    `window.solver.requiredMemory(true, ${JSON.stringify(serializedConfig)})`
  );
  await evaluate(client, `window.solver.initializeVanilla(${JSON.stringify(serializedConfig)})`);
  const solveStartedAt = performance.now();
  await evaluate(client, `window.solver.run(${threadCount}, ${targetAccuracy})`);
  const status = await waitForSolve(client, id, flop);
  const solveElapsedMs = performance.now() - solveStartedAt;
  const nodes = await scanTurnNodes(client);
  await installTurnAggregator(client);
  const turns = enumerateCanonicalTurns(flop);
  const flopDirectory = path.join(outputDirectory, id);
  await fs.mkdir(flopDirectory, { recursive: true });
  const turnEntries = [];
  const exportStartedAt = performance.now();

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    await writeHeartbeat({
      state: 'exporting-turns',
      id,
      board: flop,
      turn: turnIndex + 1,
      turnTotal: turns.length
    });
    const packed = await extractTurn(client, nodes, turn);
    const filename = `${turn.card.toString(36).padStart(2, '0')}.bin`;
    const filePath = path.join(flopDirectory, filename);
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, packed.payload);
    await fs.rename(temporaryPath, filePath);
    turnEntries.push({
      card: turn.card,
      board: turn.board,
      orbitSize: turn.orbitSize,
      filename,
      byteLength: packed.payload.byteLength
    });
    if (!(await fs.stat(treePath).catch(() => null))) {
      await writeJsonAtomic(treePath, {
        schemaVersion: 1,
        handLabels: HAND_LABELS,
        nodeCount: nodes.length,
        nodes: nodes.map((node, nodeIndex) => ({
          ...packed.metadata[nodeIndex],
          state: node.state
        }))
      });
    }
  }

  const exportElapsedMs = performance.now() - exportStartedAt;
  await writeJsonAtomic(path.join(flopDirectory, 'index.json'), {
    schemaVersion: 1,
    id,
    flop,
    requiredMemory,
    solveElapsedMs,
    exportElapsedMs,
    exploitability: status.exploitability,
    iterations: status.iterations,
    turnCount: turnEntries.length,
    concreteTurnWeight: turnEntries.reduce((sum, entry) => sum + entry.orbitSize, 0),
    turns: turnEntries
  });
  return {
    id,
    flop,
    solveElapsedMs,
    exportElapsedMs,
    exploitability: status.exploitability,
    iterations: status.iterations,
    requiredMemory,
    turnCount: turnEntries.length,
    byteLength: turnEntries.reduce((sum, entry) => sum + entry.byteLength, 0)
  };
}

if (!Number.isInteger(threadCount) || threadCount < 1 || threadCount > 32) {
  throw new Error(`线程数必须在 1–32 之间：${threadCount}`);
}

const allFlops = enumerateCanonicalFlops();
if (allFlops.length !== 1755) throw new Error(`同构翻牌数量错误：${allFlops.length}`);
const totalCanonicalTurnHistories = allFlops.reduce(
  (sum, flop) => sum + enumerateCanonicalTurns(flop).length,
  0
);
if (totalCanonicalTurnHistories !== 63193) {
  throw new Error(`转牌同构历史数量错误：${totalCanonicalTurnHistories}`);
}
const selectedFlops = requestedLimit > 0 ? allFlops.slice(0, requestedLimit) : allFlops;
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
    datasetId: 'gg-rnc-6max-100bb-btn-vs-bb-srp-all-turns-v1',
    generatedAt: new Date().toISOString(),
    requestedFlops: selectedFlops.length,
    totalCanonicalFlops: 1755,
    totalCanonicalTurnHistories,
    threadCount,
    targetExploitability,
    completed: [],
    failures: []
  };
}

const completedIds = new Set(checkpoint.completed.map((entry) => entry.id));
const pendingFlops = selectedFlops.filter((flop) => !completedIds.has(boardId(flop)));
const client = await connect();
try {
  await client.send('Runtime.enable');
  await waitForRocketApi(client);
  await evaluate(client, 'window.electron.minimizeMainWindow(); true');
  const populationRules = await evaluate(
    client,
    'window.electron.getConfigValue("population")?.rules ?? []'
  );
  console.log(JSON.stringify({
    event: 'turn-batch-start',
    outputDirectory,
    selectedFlops: selectedFlops.length,
    alreadyCompleted: completedIds.size,
    pending: pendingFlops.length,
    threadCount,
    targetExploitability
  }));

  for (const flop of pendingFlops) {
    const id = boardId(flop);
    try {
      const result = await solveAndExportFlop(client, seed, populationRules, flop);
      checkpoint.failures = checkpoint.failures.filter((failure) => failure.id !== id);
      checkpoint.completed = checkpoint.completed.filter((entry) => entry.id !== id);
      checkpoint.completed.push({
        ...result,
        completedAt: new Date().toISOString()
      });
      completedIds.add(id);
      await writeJsonAtomic(checkpointPath, checkpoint);
      console.log(JSON.stringify({
        event: 'turn-flop-complete',
        progress: `${checkpoint.completed.length}/${selectedFlops.length}`,
        ...result
      }));
    } catch (error) {
      checkpoint.failures = checkpoint.failures.filter((failure) => failure.id !== id);
      checkpoint.failures.push({
        id,
        flop,
        error: error.message,
        failedAt: new Date().toISOString()
      });
      await writeJsonAtomic(checkpointPath, checkpoint);
      console.error(JSON.stringify({ event: 'turn-flop-failed', id, flop, error: error.message }));
      throw error;
    } finally {
      try {
        await evaluate(client, 'window.solver.unload()');
      } catch {}
    }
  }
  checkpoint.finishedAt = new Date().toISOString();
  await writeJsonAtomic(checkpointPath, checkpoint);
  await writeHeartbeat({
    state: 'finished',
    completed: checkpoint.completed.length,
    total: selectedFlops.length
  });
  console.log(JSON.stringify({
    event: 'turn-batch-finished',
    completed: checkpoint.completed.length,
    failures: checkpoint.failures.length,
    outputDirectory
  }));
} finally {
  try {
    await evaluate(client, 'window.solver.unload()');
  } catch {}
  client.close();
}
