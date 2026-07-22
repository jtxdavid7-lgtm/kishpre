import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const solutionPath = process.env.ROCKETSOLVER_SOLUTION;
const outputPath = path.resolve(process.env.ROCKETSOLVER_OUTPUT ?? 'src/data/gtoPreflopSnapshot.json');
const scanOnly = process.argv.includes('--scan-only');

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const HAND_LABELS = RANKS.flatMap((rowRank, rowIndex) => RANKS.map((columnRank, columnIndex) => {
  if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
  if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
  return `${columnRank}${rowRank}o`;
}));

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
  if (solutionPath) {
    await evaluate(client, `window.solver.loadSolution(${JSON.stringify(solutionPath)})`);
  }
  const nodeCount = await evaluate(client, 'window.solver.nodeCount()');
  if (nodeCount < 1000) throw new Error(`当前不是已求解文件，节点数只有 ${nodeCount}`);

  const treeJson = await evaluate(client, `(() => {
    const stack = ['["Root"]'];
    const seen = new Set();
    const nodes = [];
    while (stack.length) {
      const key = stack.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const state = window.solver.pokerTableState(key);
      if (!state || state.street !== 0) continue;
      const children = window.solver.treeViewChildren(key) || [];
      if (state.actions?.length) nodes.push({ key, state, children });
      for (const child of children) {
        if (!child.isLeaf) stack.push(child.key);
      }
    }
    return JSON.stringify(nodes, (_key, value) => typeof value === 'bigint' ? Number(value) : value);
  })()`);
  const nodes = JSON.parse(treeJson);
  const actionLabels = [...new Set(nodes.flatMap((node) => node.state.actions.map((action) => action.label)))];
  const actors = Object.fromEntries(nodes.map((node) => [node.state.players.find((player) => player.isCurrent)?.position, true]));
  console.log(JSON.stringify({ nodeCount, preflopDecisionNodes: nodes.length, actionLabels, actorPositions: Object.keys(actors) }, null, 2));
  if (scanOnly) process.exit(0);

  await evaluate(client, `(() => {
    const labels = ${JSON.stringify(HAND_LABELS)};
    globalThis.__kishMasks = Object.fromEntries(labels.map((label) => {
      const weights = JSON.parse(window.solver.parseHoldemRange(label));
      return [label, weights.map((weight, index) => weight > 0 ? index : -1).filter((index) => index >= 0)];
    }));
    globalThis.__kishAggregateNode = (key) => {
      const [strategy] = window.solver.strategy(key, [], false);
      if (!strategy) throw new Error('缺少策略：' + key);
      const hands = {};
      for (const [label, indices] of Object.entries(globalThis.__kishMasks)) {
        let reachTotal = 0;
        let totalEv = 0;
        const actionFrequency = Array(strategy.actions.length).fill(0);
        const actionEv = Array(strategy.actions.length).fill(0);
        for (const index of indices) {
          const reach = strategy.reach[index];
          reachTotal += reach;
          totalEv += reach * strategy.evPerHand[index];
          for (let actionIndex = 0; actionIndex < strategy.actions.length; actionIndex++) {
            actionFrequency[actionIndex] += reach * strategy.strategyPerAction[actionIndex][index];
            actionEv[actionIndex] += reach * strategy.evPerAction[actionIndex][index];
          }
        }
        const denominator = reachTotal || indices.length || 1;
        hands[label] = {
          combinations: indices.length,
          reach: reachTotal / (indices.length || 1),
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
  const batchSize = 20;
  for (let offset = 0; offset < nodes.length; offset += batchSize) {
    const batch = nodes.slice(offset, offset + batchSize);
    const batchJson = await evaluate(client, `JSON.stringify(${JSON.stringify(batch.map((node) => node.key))}.map((key) => globalThis.__kishAggregateNode(key)), (_key, value) => typeof value === 'bigint' ? Number(value) : value)`);
    const strategies = JSON.parse(batchJson);
    batch.forEach((node, index) => {
      exportedNodes[node.key] = {
        key: node.key,
        state: node.state,
        children: node.children,
        ...strategies[index]
      };
    });
    console.log(`已导出 ${Math.min(offset + batch.length, nodes.length)} / ${nodes.length} 个翻前节点`);
  }

  const payload = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    solutionId: 'gg-rnc-6max-100bb-drop-1p5bb-v1',
    nativeNodeCount: nodeCount,
    rootKey: '["Root"]',
    nodes: exportedNodes
  };
  await fs.writeFile(outputPath, JSON.stringify(payload), 'utf8');
  console.log(`完整翻前快照已写入 ${outputPath}`);
} finally {
  client.close();
}
