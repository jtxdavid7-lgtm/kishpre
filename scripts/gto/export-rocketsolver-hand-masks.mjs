import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.ROCKETSOLVER_CDP ?? 'http://127.0.0.1:9229/json';
const outputPath = path.resolve(
  process.env.ROCKETSOLVER_HAND_MASKS_OUTPUT ??
    'F:/kish-gto/postflop-pipeline/holdem-hand-class-masks.json'
);
const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const labels = ranks.flatMap((rowRank, rowIndex) => ranks.map((columnRank, columnIndex) => {
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
  const masks = await evaluate(client, `(() => {
    const labels = ${JSON.stringify(labels)};
    return Object.fromEntries(labels.map((label) => {
      const weights = JSON.parse(window.solver.parseHoldemRange(label));
      return [label, weights.map((weight, index) => weight > 0 ? index : -1)
        .filter((index) => index >= 0)];
    }));
  })()`);
  const ownership = Array(1326).fill(0);
  for (const label of labels) {
    const expected = label[0] === label[1] ? 6 : label.endsWith('s') ? 4 : 12;
    if (masks[label]?.length !== expected) {
      throw new Error(`${label} 组合数为 ${masks[label]?.length}，应为 ${expected}`);
    }
    masks[label].forEach((index) => {
      if (index < 0 || index >= 1326) throw new Error(`${label} 包含非法组合索引 ${index}`);
      ownership[index] += 1;
    });
  }
  if (ownership.some((count) => count !== 1)) {
    throw new Error('169 类起手牌没有完整且唯一地覆盖 1,326 个组合');
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    comboCount: 1326,
    labels,
    masks
  }), 'utf8');
  console.log(JSON.stringify({ outputPath, labels: labels.length, comboCount: ownership.length }));
} finally {
  client.close();
}
