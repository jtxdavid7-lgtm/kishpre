import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const createPrototype = process.argv.includes('--create-prototype');
const populatePrototype = process.argv.includes('--populate-prototype');
const estimatePrototype = process.argv.includes('--estimate-prototype');
const initializePrototype = process.argv.includes('--initialize-prototype');
const runPrototype = process.argv.includes('--run-prototype');
const savePrototype = process.argv.includes('--save-prototype');
const loadPrototype = process.argv.includes('--load-prototype');
const stopSolver = process.argv.includes('--stop');
const unloadSolution = process.argv.includes('--unload');
const seedPath =
  process.env.ROCKETSOLVER_POSTFLOP_SEED ??
  'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-100bb-seed.json';
const threadCount = Number.parseInt(process.env.ROCKETSOLVER_THREADS ?? '8', 10);
const targetAccuracy = Number.parseFloat(process.env.ROCKETSOLVER_TARGET_ACCURACY ?? '0.003');
const benchmarkIterations = Number.parseInt(process.env.ROCKETSOLVER_BENCHMARK_ITERATIONS ?? '0', 10);
const benchmarkEntropy = Number.parseFloat(process.env.ROCKETSOLVER_BENCHMARK_ENTROPY ?? '0');
const benchmarkExploitability = Number.parseFloat(process.env.ROCKETSOLVER_BENCHMARK_EXPLOITABILITY ?? '0');
const compactReport = process.argv.includes('--compact-report');
const solutionPath = path.resolve(
  process.env.ROCKETSOLVER_POSTFLOP_SOLUTION ??
    'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-as7d2c-validation-v1.rsl'
);

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

// RocketSolver encodes cards by rank (2..A) and suit (h, s, d, c).
const prototypeBoard = Object.freeze(
  (process.env.ROCKETSOLVER_BOARD ?? '49,22,3').split(',').map((value) => Number.parseInt(value.trim(), 10))
); // Default: As 7d 2c
const abstractionPreset = process.env.ROCKETSOLVER_ABSTRACTION ?? 'perfect';
const useVanillaSolver = abstractionPreset === 'perfect';

function parseAbstraction() {
  if (abstractionPreset === 'perfect') return [null, null, null, null];
  if (/^\d+$/.test(abstractionPreset)) {
    const buckets = Number.parseInt(abstractionPreset, 10);
    return [null, 'perfect', { clusterize: buckets }, { clusterize: buckets }];
  }
  const parsed = JSON.parse(abstractionPreset);
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw new Error(`ROCKETSOLVER_ABSTRACTION 必须为 perfect、桶数量或四项 JSON 数组：${abstractionPreset}`);
  }
  return parsed;
}

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

function buildSolverConfig(seed) {
  if (seed?.ranges?.BTN?.length !== 1326 || seed?.ranges?.BB?.length !== 1326) {
    throw new Error(`翻后种子范围格式无效：${seedPath}`);
  }
  return {
    board: prototypeBoard,
    // RocketSolver rewrites the prototype player order to BB, BTN.
    ranges: [seed.ranges.BB, seed.ranges.BTN],
    rakePercentage: 0.05,
    rakeCap: 3,
    flatDrop: 1.5,
    flatDropCondition: { condition: 'potSize', potSize: 30 },
    rakeTakePreflop: 'no',
    abstraction: parseAbstraction(),
    saveEv: [0, 0, 0, 0],
    bunchingRanges: [],
    compactMode: false
  };
}

async function connect() {
  let targets = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        targets = await response.json();
        if (targets.some((target) => target.type === 'page' && target.webSocketDebuggerUrl)) break;
      }
    } catch {
      // The Electron debug endpoint may need a few seconds after process launch.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const target = targets?.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error(`未找到 RocketSolver 调试页面：${endpoint}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let requestId = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
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

const client = await connect();
try {
  await client.send('Runtime.enable');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(client, `typeof window.electron === 'object' && typeof window.solver === 'object'`)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await evaluate(client, 'window.electron.minimizeMainWindow(); true');
  if (loadPrototype) {
    await evaluate(client, `window.solver.loadSolution(${JSON.stringify(solutionPath)})`);
  }
  if (createPrototype) {
    await evaluate(
      client,
      `window.solver.newSolution(${JSON.stringify(JSON.stringify(POSTFLOP_PROTOTYPE))}, 0)`
    );
  }
  if (populatePrototype) {
    const rules = await evaluate(client, 'window.electron.getConfigValue("population")?.rules ?? []');
    if (!rules.some((rule) => rule.streets?.slice(1).some(Boolean))) {
      throw new Error('RocketSolver 当前配置中没有可用的翻后建树规则');
    }
    await evaluate(
      client,
      `window.solver.populate('["Root"]', ${JSON.stringify(JSON.stringify(rules))}, ${JSON.stringify(
        JSON.stringify(POPULATION_SETTINGS)
      )})`
    );
  }

  let requiredMemory = null;
  let initialized = false;
  let runStarted = false;
  let runElapsedMs = null;
  let statusAfterRun = null;
  let savedSolutionPath = null;
  if (estimatePrototype || initializePrototype || runPrototype) {
    const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'));
    const solverConfig = buildSolverConfig(seed);
    const serializedConfig = JSON.stringify(solverConfig);
    requiredMemory = await evaluate(
      client,
      `window.solver.requiredMemory(${useVanillaSolver}, ${JSON.stringify(serializedConfig)})`
    );
    if (initializePrototype || runPrototype) {
      await evaluate(
        client,
        `window.solver.${useVanillaSolver ? 'initializeVanilla' : 'initializeMonteCarlo'}(${JSON.stringify(serializedConfig)})`
      );
      initialized = true;
    }
    if (runPrototype) {
      if (!Number.isInteger(threadCount) || threadCount < 1 || threadCount > 32) {
        throw new Error(`后台验证线程数必须在 1–32 之间，当前为 ${threadCount}`);
      }
      if (!(targetAccuracy > 0 && targetAccuracy <= 0.01)) {
        throw new Error(`目标精度必须在 (0, 0.01] 之间，当前为 ${targetAccuracy}`);
      }
      const runStartedAt = performance.now();
      await evaluate(client, `window.solver.run(${threadCount}, ${targetAccuracy})`);
      if (benchmarkIterations > 0 || benchmarkEntropy > 0 || benchmarkExploitability > 0) {
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          statusAfterRun = await evaluate(client, 'window.solver.solverStatus()');
          const reachedIterations = benchmarkIterations > 0 && (statusAfterRun?.iterations ?? 0) >= benchmarkIterations;
          const reachedEntropy = benchmarkEntropy > 0 && Number.isFinite(statusAfterRun?.entropy) && statusAfterRun.entropy <= benchmarkEntropy;
          const reachedExploitability = benchmarkExploitability > 0 && Number.isFinite(statusAfterRun?.exploitability) && statusAfterRun.exploitability <= benchmarkExploitability;
          if (reachedIterations || reachedEntropy || reachedExploitability) break;
          if (statusAfterRun && !statusAfterRun.isRunning) {
            throw new Error(`求解器在达到基准目标前停止：${JSON.stringify(statusAfterRun)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const reachedBenchmark =
          (benchmarkIterations > 0 && (statusAfterRun?.iterations ?? 0) >= benchmarkIterations) ||
          (benchmarkEntropy > 0 && Number.isFinite(statusAfterRun?.entropy) && statusAfterRun.entropy <= benchmarkEntropy) ||
          (benchmarkExploitability > 0 && Number.isFinite(statusAfterRun?.exploitability) && statusAfterRun.exploitability <= benchmarkExploitability);
        if (!reachedBenchmark) {
          throw new Error(`求解器未在五分钟内达到基准目标（迭代 ${benchmarkIterations} / entropy ${benchmarkEntropy} / exploitability ${benchmarkExploitability}）`);
        }
        await evaluate(client, 'window.solver.stop()');
        for (let attempt = 0; attempt < 100; attempt += 1) {
          statusAfterRun = await evaluate(client, 'window.solver.solverStatus()');
          if (!statusAfterRun?.isRunning) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } else {
        statusAfterRun = await evaluate(client, 'window.solver.solverStatus()');
      }
      runElapsedMs = performance.now() - runStartedAt;
      runStarted = true;
    }
  }
  if (savePrototype) {
    const statusBeforeSave = await evaluate(client, 'window.solver.solverStatus()');
    if (!statusBeforeSave || statusBeforeSave.isRunning) {
      throw new Error('只能保存已经完成的验证解');
    }
    await fs.mkdir(path.dirname(solutionPath), { recursive: true });
    await evaluate(
      client,
      `window.solver.saveSolution(${JSON.stringify(solutionPath)}, ${JSON.stringify(
        JSON.stringify(statusBeforeSave.lastStreet)
      )}, ${JSON.stringify(JSON.stringify(null))})`
    );
    savedSolutionPath = solutionPath;
  }
  if (stopSolver) {
    await evaluate(client, 'window.solver.stop(); true');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const stoppedStatus = await evaluate(client, 'try { window.solver.solverStatus() } catch { null }');
      if (!stoppedStatus?.isRunning) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (unloadSolution) {
    await evaluate(client, 'window.solver.unload()');
  }
  const [args, nodeCount, status, treeParams, solverParams, initialBoard, savedConfig, solverMethods] = await Promise.all([
    evaluate(client, 'window.electron.getArgs()'),
    evaluate(client, 'try { window.solver.nodeCount() } catch { 0 }'),
    evaluate(client, 'try { window.solver.solverStatus() } catch { null }'),
    evaluate(client, 'try { window.solver.treeParams() } catch { null }'),
    evaluate(client, 'try { window.solver.solverParams() } catch { null }'),
    evaluate(client, 'try { window.solver.initialBoard() } catch { null }'),
    evaluate(client, `(() => {
      const keys = [
        'population', 'threadCount', 'targetAccuracy', 'compactMode',
        'rakeEnabled', 'rakePercentage', 'rakeCap', 'rakeTakePreflop',
        'flatDropEnabled', 'flatDropCondition', 'flatDrop', 'flatDropPotSize',
        'convertCapToAllIn', 'betToAllInThresholdPostflop', 'callToAllInThreshold'
      ];
      return Object.fromEntries(keys.map((key) => [key, window.electron.getConfigValue(key)]));
    })()`),
    evaluate(client, `(() => {
      const own = Object.getOwnPropertyNames(window.solver);
      const prototype = Object.getOwnPropertyNames(Object.getPrototypeOf(window.solver));
      return [...new Set([...own, ...prototype])].sort();
    })()`)
  ]);
  const parsedSolverParams = solverParams ? JSON.parse(solverParams) : null;
  const solverParamsSummary = parsedSolverParams
    ? {
        board: parsedSolverParams.board,
        rangeLengths: parsedSolverParams.ranges?.map((range) => range.length),
        rakePercentage: parsedSolverParams.rakePercentage,
        rakeCap: parsedSolverParams.rakeCap,
        flatDrop: parsedSolverParams.flatDrop,
        flatDropCondition: parsedSolverParams.flatDropCondition,
        rakeTakePreflop: parsedSolverParams.rakeTakePreflop,
        abstraction: parsedSolverParams.abstraction,
        compactMode: parsedSolverParams.compactMode
      }
    : null;
  const report = {
    connected: true,
    minimized: true,
    createdPrototype: createPrototype,
    loadedPrototype: loadPrototype,
    unloadedSolution: unloadSolution,
    stoppedSolver: stopSolver,
    populatedPrototype: populatePrototype,
    requiredMemory,
    initialized,
    runStarted,
    runElapsedMs,
    statusAfterRun,
    threadCount: runStarted ? threadCount : null,
    targetAccuracy: runStarted ? targetAccuracy : null,
    benchmarkIterations: runStarted ? benchmarkIterations : null,
    benchmarkEntropy: runStarted ? benchmarkEntropy : null,
    benchmarkExploitability: runStarted ? benchmarkExploitability : null,
    solverMode: useVanillaSolver ? 'vanilla-perfect' : 'monte-carlo-abstracted',
    savedSolutionPath,
    args,
    nodeCount,
    status,
    initialBoard,
    savedConfig,
    solverMethods,
    treeParams: treeParams ? JSON.parse(treeParams) : null,
    solverParams: solverParamsSummary
  };
  console.log(JSON.stringify(compactReport ? {
    connected: report.connected,
    board: prototypeBoard,
    solverMode: report.solverMode,
    threadCount: report.threadCount,
    requiredMemory: report.requiredMemory,
    runElapsedMs: report.runElapsedMs,
    statusAfterRun: report.statusAfterRun,
    nodeCount: report.nodeCount,
    unloadedSolution: report.unloadedSolution
  } : report, null, 2));
} finally {
  client.close();
}
