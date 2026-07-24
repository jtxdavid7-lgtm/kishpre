import fs from 'node:fs/promises';
import path from 'node:path';

const inputPath = path.resolve(
  process.env.GTO_POSTFLOP_RAW ??
    'C:/Users/Administrator/Documents/kish/gto-work/btn-vs-bb-srp-as7d2c-validation-v1.json'
);
const outputDirectory = path.resolve(
  process.env.GTO_POSTFLOP_PUBLIC ??
    'public/data/gto/gg-rnc-6max-100bb-drop-1p5bb-postflop-validation-v1'
);
const chunkNodeCount = 64;
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
if (raw.schemaVersion !== 1) throw new Error(`不支持的翻后原始数据版本：${raw.schemaVersion}`);
if (!raw.nodes?.[raw.rootKey]) throw new Error('翻后快照缺少根节点');
if (!Array.isArray(raw.board) || raw.board.length !== 5) throw new Error('验证牌面必须包含完整五张公共牌');

const orderedKeys = [];
const queue = [raw.rootKey];
const seen = new Set();
while (queue.length) {
  const key = queue.shift();
  if (seen.has(key) || !raw.nodes[key]) continue;
  seen.add(key);
  orderedKeys.push(key);
  for (const child of raw.nodes[key].children) {
    if (raw.nodes[child.key] && !seen.has(child.key)) queue.push(child.key);
  }
}
if (orderedKeys.length !== Object.keys(raw.nodes).length) {
  throw new Error(`存在不可达翻后节点：可达 ${orderedKeys.length} / 总数 ${Object.keys(raw.nodes).length}`);
}

const handLabels = RANKS.flatMap((rowRank, rowIndex) => RANKS.map((columnRank, columnIndex) => {
  if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
  if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
  return `${columnRank}${rowRank}o`;
}));
const nodeIdByKey = new Map(orderedKeys.map((key, id) => [key, id]));
const nodes = [];
const chunks = [];

await fs.mkdir(outputDirectory, { recursive: true });

for (let chunkStart = 0; chunkStart < orderedKeys.length; chunkStart += chunkNodeCount) {
  const keys = orderedKeys.slice(chunkStart, chunkStart + chunkNodeCount);
  const buffers = [];
  let chunkOffset = 0;

  for (const key of keys) {
    const rawNode = raw.nodes[key];
    const valuesPerHand = 3 + rawNode.actions.length * 2;
    const buffer = Buffer.allocUnsafe(handLabels.length * valuesPerHand * 4);
    let byteOffset = 0;

    for (const label of handLabels) {
      const hand = rawNode.hands[label];
      if (!hand) throw new Error(`${key} 缺少手牌类别 ${label}`);
      const frequencies = rawNode.actions.map((action) => hand.actions[action]?.frequency);
      if (frequencies.some((frequency) => !Number.isFinite(frequency))) {
        throw new Error(`${key}/${label} 存在无效行动频率`);
      }
      const frequencyTotal = frequencies.reduce((sum, frequency) => sum + frequency, 0);
      if (hand.reach > 1e-9 && Math.abs(frequencyTotal - 1) > 0.002) {
        throw new Error(`${key}/${label} 行动频率和为 ${frequencyTotal}`);
      }
      const values = [
        hand.combinations,
        hand.reach,
        hand.totalEv,
        ...rawNode.actions.flatMap((action) => [hand.actions[action].frequency, hand.actions[action].ev])
      ];
      for (const value of values) {
        if (!Number.isFinite(value)) throw new Error(`${key}/${label} 存在非有限数值`);
        buffer.writeFloatLE(value, byteOffset);
        byteOffset += 4;
      }
    }

    const id = nodeIdByKey.get(key);
    const actor = rawNode.state.players.find((player) => player.isCurrent)?.position;
    const parentId = rawNode.state.parentKey === null ? null : nodeIdByKey.get(rawNode.state.parentKey);
    if (rawNode.state.parentKey !== null && parentId === undefined) {
      throw new Error(`${key} 缺少父节点 ${rawNode.state.parentKey}`);
    }
    nodes[id] = {
      id,
      parentId,
      street: rawNode.state.street,
      board: rawNode.board,
      actor,
      pot: rawNode.state.pot,
      potOdds: rawNode.state.potOdds,
      spr: rawNode.state.spr,
      actions: rawNode.actions,
      children: rawNode.children.map((child) => ({
        label: child.label,
        nextId: nodeIdByKey.get(child.key) ?? null,
        terminal: !nodeIdByKey.has(child.key)
      })),
      players: rawNode.state.players.map((player) => ({
        position: player.position,
        stack: player.stack,
        contributed: player.totalContributed,
        withCards: player.withCards,
        acted: player.acted
      })),
      chunk: chunks.length,
      byteOffset: chunkOffset,
      byteLength: buffer.length
    };
    buffers.push(buffer);
    chunkOffset += buffer.length;
  }

  const filename = `strategy-${String(chunks.length).padStart(3, '0')}.bin`;
  const payload = Buffer.concat(buffers);
  await fs.writeFile(path.join(outputDirectory, filename), payload);
  chunks.push({
    filename,
    byteLength: payload.length,
    nodeStart: chunkStart,
    nodeEnd: chunkStart + keys.length - 1
  });
}

const decisionsByStreet = Object.fromEntries([1, 2, 3].map((street) => [
  street,
  nodes.filter((node) => node.street === street).length
]));
const index = {
  schemaVersion: 1,
  generatedAt: raw.generatedAt,
  solutionId: raw.solutionId,
  source: raw.source,
  spot: raw.spot,
  board: raw.board,
  nativeNodeCount: raw.nativeNodeCount,
  postflopDecisionNodes: nodes.length,
  decisionsByStreet,
  rootId: 0,
  positions: { 0: 'BTN', 8: 'BB' },
  handLabels,
  chunks,
  nodes
};
await fs.writeFile(path.join(outputDirectory, 'index.json'), JSON.stringify(index), 'utf8');

const manifest = {
  schemaVersion: 1,
  datasetId: 'gg-rnc-6max-100bb-drop-1p5bb-postflop-validation-v1',
  generatedAt: raw.generatedAt,
  solved: true,
  realtimeSolver: false,
  scope: 'validation',
  spot: raw.spot,
  packs: [{
    id: 'as7d2c-kc-qc',
    label: 'A♠ 7♦ 2♣ · K♣ · Q♣',
    board: raw.board,
    index: 'index.json',
    postflopDecisionNodes: nodes.length,
    decisionsByStreet
  }]
};
await fs.writeFile(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest), 'utf8');

console.log(JSON.stringify({
  outputDirectory,
  nodes: nodes.length,
  decisionsByStreet,
  chunks: chunks.length,
  indexBytes: Buffer.byteLength(JSON.stringify(index)),
  totalBinaryBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
}, null, 2));
