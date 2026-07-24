import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const solutionPath = process.env.ROCKETSOLVER_SOLUTION;
const outputPath = path.resolve(
  process.env.ROCKETSOLVER_POSTFLOP_OUTPUT ??
    'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-as7d2c-validation-v1.json'
);
const scanOnly = process.argv.includes('--scan-only');

const STREET_CARD_COUNT = Object.freeze([0, 3, 4, 5]);
const SAMPLE_BOARD = Object.freeze([49, 22, 3, 47, 43]); // As 7d 2c Kc Qc
const RANKS = Object.freeze(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);
const HAND_LABELS = Object.freeze(RANKS.flatMap((rowRank, rowIndex) => RANKS.map((columnRank, columnIndex) => {
  if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
  if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
  return `${columnRank}${rowRank}o`;
})));

async function connect() {
  const targets = await fetch(endpoint).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
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
  await evaluate(client, 'window.electron.minimizeMainWindow(); true');
  if (solutionPath) {
    await evaluate(client, `window.solver.loadSolution(${JSON.stringify(solutionPath)})`);
  }

  const scanJson = await evaluate(client, `(() => {
    const stack = ['["Root"]'];
    const seen = new Set();
    const nodes = [];
    while (stack.length) {
      const key = stack.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const state = window.solver.pokerTableState(key);
      const children = window.solver.treeViewChildren(key) || [];
      if (state?.actions?.length) nodes.push({ key, state, children });
      for (const child of children) {
        if (!child.isLeaf) stack.push(child.key);
      }
    }
    return JSON.stringify(nodes, (_key, value) => typeof value === 'bigint' ? Number(value) : value);
  })()`);
  const nodes = JSON.parse(scanJson);
  const samples = [];
  for (const street of [1, 2, 3]) {
    const node = nodes.find((candidate) => candidate.state.street === street);
    if (!node) continue;
    const board = SAMPLE_BOARD.slice(0, STREET_CARD_COUNT[street]);
    const strategyJson = await evaluate(client, `(() => {
      const [strategy] = window.solver.strategy(${JSON.stringify(node.key)}, ${JSON.stringify(board)}, false);
      if (!strategy) return null;
      return JSON.stringify({
        actions: strategy.actions,
        reachLength: strategy.reach?.length,
        evLength: strategy.evPerHand?.length,
        strategyLengths: strategy.strategyPerAction?.map((values) => values.length),
        actionEvLengths: strategy.evPerAction?.map((values) => values.length)
      });
    })()`);
    samples.push({ street, key: node.key, board, strategy: strategyJson ? JSON.parse(strategyJson) : null });
  }

  const summary = {
    nativeNodeCount: await evaluate(client, 'window.solver.nodeCount()'),
    decisionNodes: nodes.length,
    decisionsByStreet: Object.fromEntries([1, 2, 3].map((street) => [
      street,
      nodes.filter((node) => node.state.street === street).length
    ])),
    actionsByStreet: Object.fromEntries([1, 2, 3].map((street) => [
      street,
      [...new Set(nodes
        .filter((node) => node.state.street === street)
        .flatMap((node) => node.state.actions.map((action) => action.label)))]
    ])),
    samples
  };
  console.log(JSON.stringify(summary, null, 2));
  if (scanOnly) process.exit(0);

  await evaluate(client, `(() => {
    const labels = ${JSON.stringify(HAND_LABELS)};
    globalThis.__kishPostflopMasks = Object.fromEntries(labels.map((label) => {
      const weights = JSON.parse(window.solver.parseHoldemRange(label));
      return [label, weights.map((weight, index) => weight > 0 ? index : -1).filter((index) => index >= 0)];
    }));
    globalThis.__kishAggregatePostflopNode = (key, board) => {
      const [strategy] = window.solver.strategy(key, board, false);
      if (!strategy) throw new Error('缺少翻后策略：' + key + ' / ' + board.join(','));
      const hands = {};
      for (const [label, indices] of Object.entries(globalThis.__kishPostflopMasks)) {
        let reachTotal = 0;
        let totalEv = 0;
        let availableCombinations = 0;
        const actionFrequency = Array(strategy.actions.length).fill(0);
        const actionEv = Array(strategy.actions.length).fill(0);
        for (const index of indices) {
          const reach = strategy.reach[index];
          const isAvailable = Number.isFinite(strategy.evPerHand[index]) &&
            strategy.actions.every((_action, actionIndex) =>
              Number.isFinite(strategy.strategyPerAction[actionIndex][index]) &&
              Number.isFinite(strategy.evPerAction[actionIndex][index]));
          if (!isAvailable) continue;
          availableCombinations += 1;
          if (!(reach > 0)) continue;
          reachTotal += reach;
          totalEv += reach * strategy.evPerHand[index];
          for (let actionIndex = 0; actionIndex < strategy.actions.length; actionIndex++) {
            actionFrequency[actionIndex] += reach * strategy.strategyPerAction[actionIndex][index];
            actionEv[actionIndex] += reach * strategy.evPerAction[actionIndex][index];
          }
        }
        const denominator = reachTotal || 1;
        hands[label] = {
          combinations: availableCombinations,
          reach: reachTotal / (availableCombinations || 1),
          totalEv: totalEv / denominator,
          actions: Object.fromEntries(strategy.actions.map((action, actionIndex) => [action, {
            frequency: actionFrequency[actionIndex] / denominator,
            ev: actionEv[actionIndex] / denominator
          }]))
        };
      }
      return { actions: strategy.actions, hands };
    };
  })()`);

  const exportedNodes = {};
  const batchSize = 12;
  for (let offset = 0; offset < nodes.length; offset += batchSize) {
    const batch = nodes.slice(offset, offset + batchSize);
    const requests = batch.map((node) => ({
      key: node.key,
      board: SAMPLE_BOARD.slice(0, STREET_CARD_COUNT[node.state.street])
    }));
    const batchJson = await evaluate(
      client,
      `JSON.stringify(${JSON.stringify(requests)}.map(({ key, board }) => globalThis.__kishAggregatePostflopNode(key, board)), (_key, value) => typeof value === 'bigint' ? Number(value) : value)`
    );
    const strategies = JSON.parse(batchJson);
    batch.forEach((node, index) => {
      exportedNodes[node.key] = {
        key: node.key,
        state: node.state,
        children: node.children,
        board: requests[index].board,
        ...strategies[index]
      };
    });
    console.log(`已导出 ${Math.min(offset + batch.length, nodes.length)} / ${nodes.length} 个翻后节点`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    solutionId: 'gg-rnc-6max-100bb-btn-vs-bb-srp-as7d2c-validation-v1',
    source: 'locally-solved RocketSolver static snapshot',
    spot: 'BTN raise 2.5bb / SB fold / BB call',
    board: SAMPLE_BOARD,
    nativeNodeCount: summary.nativeNodeCount,
    rootKey: '["Root"]',
    nodes: exportedNodes
  }), 'utf8');
  console.log(`完整验证牌面快照已写入 ${outputPath}`);
} finally {
  client.close();
}
