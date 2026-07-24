import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const solutionPath = process.env.ROCKETSOLVER_SOLUTION;
const outputPath = path.resolve(
  process.env.ROCKETSOLVER_POSTFLOP_SEED ??
    'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-100bb-seed.json'
);

const LINE = Object.freeze([
  { actor: 3, action: 'Fold' },
  { actor: 2, action: 'Fold' },
  { actor: 1, action: 'Fold' },
  { actor: 0, action: 'Raise 2.5 bb', capture: 'BTN' },
  { actor: 9, action: 'Fold' },
  { actor: 8, action: 'Call', capture: 'BB' }
]);

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

  const seedJson = await evaluate(client, `(() => {
    const line = ${JSON.stringify(LINE)};
    let key = '["Root"]';
    const ranges = {};
    const trail = [];

    for (const step of line) {
      const state = window.solver.pokerTableState(key);
      const actor = state.players.find((player) => player.isCurrent)?.position;
      if (actor !== step.actor) {
        throw new Error('行动人不匹配：' + actor + ' / ' + step.actor + ' @ ' + key);
      }
      const actionIndex = state.actions.findIndex((action) => action.label === step.action);
      if (actionIndex < 0) throw new Error('节点缺少行动：' + step.action + ' @ ' + key);

      if (step.capture) {
        const [strategy] = window.solver.strategy(key, [], false);
        const raw = strategy.reach.map((reach, index) =>
          reach * strategy.strategyPerAction[actionIndex][index]
        );
        const maximum = Math.max(...raw);
        if (!(maximum > 0)) throw new Error(step.capture + ' 范围为空');
        ranges[step.capture] = Array.from(raw, (weight) => weight / maximum);
      }

      const children = window.solver.treeViewChildren(key) || [];
      const child = children.find((item) => item.label === step.action);
      if (!child) throw new Error('节点缺少子分支：' + step.action + ' @ ' + key);
      trail.push({ key, actor, action: step.action, nextKey: child.key, isLeaf: child.isLeaf });
      key = child.key;
    }

    return JSON.stringify({
      schemaVersion: 1,
      source: 'gg-rnc-6max-100bb-drop-1p5bb-formal-v1.rsl',
      spot: 'BTN raise 2.5bb / SB fold / BB call',
      pot: 5.5,
      effectiveStack: 97.5,
      ranges,
      trail
    });
  })()`);

  const seed = JSON.parse(seedJson);
  if (seed.ranges.BTN.length !== 1326 || seed.ranges.BB.length !== 1326) {
    throw new Error('翻后起始范围必须各含 1326 个组合权重');
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(seed), 'utf8');
  console.log(JSON.stringify({
    outputPath,
    spot: seed.spot,
    pot: seed.pot,
    effectiveStack: seed.effectiveStack,
    btnCombos: seed.ranges.BTN.filter((weight) => weight > 1e-8).length,
    bbCombos: seed.ranges.BB.filter((weight) => weight > 1e-8).length,
    trail: seed.trail.map(({ actor, action, isLeaf }) => ({ actor, action, isLeaf }))
  }, null, 2));
} finally {
  client.close();
}
