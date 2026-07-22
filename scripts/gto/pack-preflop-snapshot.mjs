import fs from 'node:fs/promises';
import path from 'node:path';

const inputPath = path.resolve(process.env.GTO_PREFLOP_RAW ?? 'src/data/gtoPreflopSnapshot.json');
const outputDirectory = path.resolve(process.env.GTO_PREFLOP_PUBLIC ?? 'public/data/gto/gg-rnc-6max-100bb-drop-1p5bb-v1');
const chunkNodeCount = 128;
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const rawNodes = raw.nodes;
const rootKey = raw.rootKey;
if (!rawNodes[rootKey]) throw new Error('完整翻前快照缺少根节点');

const orderedKeys = [];
const queue = [rootKey];
const seen = new Set();
while (queue.length) {
  const key = queue.shift();
  if (seen.has(key) || !rawNodes[key]) continue;
  seen.add(key);
  orderedKeys.push(key);
  for (const child of rawNodes[key].children) {
    if (rawNodes[child.key] && !seen.has(child.key)) queue.push(child.key);
  }
}
if (orderedKeys.length !== Object.keys(rawNodes).length) {
  throw new Error(`存在不可达翻前节点：可达 ${orderedKeys.length} / 总数 ${Object.keys(rawNodes).length}`);
}

const nodeIdByKey = new Map(orderedKeys.map((key, id) => [key, id]));
const handLabels = RANKS.flatMap((rowRank, rowIndex) => RANKS.map((columnRank, columnIndex) => {
  if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
  if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
  return `${columnRank}${rowRank}o`;
}));
const nodes = [];
const chunks = [];

function canonicalCombinationCount(label) {
  if (label[0] === label[1]) return 6;
  return label.endsWith('s') ? 4 : 12;
}

await fs.mkdir(outputDirectory, { recursive: true });

for (let chunkStart = 0; chunkStart < orderedKeys.length; chunkStart += chunkNodeCount) {
  const keys = orderedKeys.slice(chunkStart, chunkStart + chunkNodeCount);
  const buffers = [];
  let chunkOffset = 0;

  for (const key of keys) {
    const rawNode = rawNodes[key];
    const actionCount = rawNode.actions.length;
    const valuesPerHand = 2 + actionCount * 2;
    const buffer = Buffer.allocUnsafe(handLabels.length * valuesPerHand * 4);
    let byteOffset = 0;

    for (const label of handLabels) {
      const hand = rawNode.hands[label];
      const expectedCombinations = canonicalCombinationCount(label);
      if (hand.combinations !== expectedCombinations) {
        throw new Error(`${key}/${label} 组合数 ${hand.combinations}，应为 ${expectedCombinations}`);
      }
      const frequencies = rawNode.actions.map((action) => hand.actions[action].frequency);
      const frequencyTotal = frequencies.reduce((sum, frequency) => sum + frequency, 0);
      if (hand.reach > 1e-9 && Math.abs(frequencyTotal - 1) > 0.002) {
        throw new Error(`${key}/${label} 行动频率和为 ${frequencyTotal}`);
      }
      const values = [
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
  chunks.push({ filename, byteLength: payload.length, nodeStart: chunkStart, nodeEnd: chunkStart + keys.length - 1 });
}

const index = {
  schemaVersion: 3,
  generatedAt: raw.generatedAt,
  solutionId: raw.solutionId,
  nativeNodeCount: raw.nativeNodeCount,
  preflopDecisionNodes: nodes.length,
  rootId: 0,
  positions: { 0: 'BTN', 1: 'CO', 2: 'MP', 3: 'EP', 8: 'BB', 9: 'SB' },
  handLabels,
  chunks,
  nodes
};
await fs.writeFile(path.join(outputDirectory, 'index.json'), JSON.stringify(index), 'utf8');

const totalBinaryBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
console.log(JSON.stringify({
  outputDirectory,
  nodes: nodes.length,
  chunks: chunks.length,
  indexBytes: Buffer.byteLength(JSON.stringify(index)),
  totalBinaryBytes
}, null, 2));
