import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  buildCanonicalFlopMultiplicities,
  classifyFlop
} from './lib/flop-aggregate-report.mjs';

const gzipAsync = promisify(gzip);
const COMBO_COUNT = 1326;
const RANKS = Object.freeze(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);
const CARD_RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
const CARD_SUITS = Object.freeze(['h', 's', 'd', 'c']);
const HAND_LABELS = Object.freeze(RANKS.flatMap((rowRank, rowIndex) => (
  RANKS.map((columnRank, columnIndex) => {
    if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
    if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
    return `${columnRank}${rowRank}o`;
  })
)));

const inputDirectory = path.resolve(
  process.env.GTO_FLOP_BATCH_INPUT ?? 'F:/kish-gto/flop-batch-v1'
);
const maskPath = path.resolve(
  process.env.GTO_HAND_MASKS ??
    'F:/kish-gto/postflop-pipeline/holdem-hand-class-masks.json'
);
const outputDirectory = path.resolve(
  process.env.GTO_FLOP_STRATEGY_OUTPUT ??
    'public/data/gto/gg-rnc-6max-100bb-drop-1p5bb-flop-v1'
);
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='));
const maximumFlops = limitArgument
  ? Number.parseInt(limitArgument.slice('--limit='.length), 10)
  : 0;

function describeCard(code) {
  return `${CARD_RANKS[Math.floor(code / 4)]}${CARD_SUITS[code % 4]}`;
}

function boardLabel(board) {
  return board.map(describeCard).join(' ');
}

function readCombo(view, comboIndex, valuesPerCombo) {
  const offset = comboIndex * valuesPerCombo * 4;
  const values = [];
  for (let valueIndex = 0; valueIndex < valuesPerCombo; valueIndex += 1) {
    values.push(view.getFloat32(offset + valueIndex * 4, true));
  }
  return values;
}

export function aggregateNodeByHandClass(buffer, metadata, masks, handLabels = HAND_LABELS) {
  const actionCount = metadata.actions.length;
  const valuesPerCombo = 2 + actionCount * 2;
  if (
    metadata.valuesPerCombo !== valuesPerCombo ||
    metadata.byteLength !== COMBO_COUNT * valuesPerCombo * 4
  ) {
    throw new Error(`${metadata.key} 的二进制结构与元数据不一致`);
  }
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + metadata.byteOffset,
    metadata.byteLength
  );
  const output = Buffer.allocUnsafe(
    handLabels.length * (3 + actionCount * 2) * 4
  );
  let outputOffset = 0;

  for (const label of handLabels) {
    const comboIndices = masks[label];
    if (!Array.isArray(comboIndices) || !comboIndices.length) {
      throw new Error(`缺少手牌类别掩码：${label}`);
    }
    let combinations = 0;
    let reachTotal = 0;
    let totalEvWeight = 0;
    const frequencyWeights = Array(actionCount).fill(0);
    const actionEvWeights = Array(actionCount).fill(0);

    for (const comboIndex of comboIndices) {
      const values = readCombo(view, comboIndex, valuesPerCombo);
      if (!values.every(Number.isFinite)) continue;
      combinations += 1;
      const reach = values[0];
      if (!(reach > 0)) continue;
      reachTotal += reach;
      totalEvWeight += reach * values[1];
      for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
        frequencyWeights[actionIndex] += reach * values[2 + actionIndex * 2];
        actionEvWeights[actionIndex] += reach * values[3 + actionIndex * 2];
      }
    }

    const denominator = reachTotal || 1;
    const frequencies = frequencyWeights.map((value) => value / denominator);
    const closure = frequencies.reduce((sum, value) => sum + value, 0);
    if (reachTotal > 1e-9 && Math.abs(closure - 1) > 0.004) {
      throw new Error(`${metadata.key}/${label} 的行动频率未闭合：${closure}`);
    }
    const values = [
      combinations,
      reachTotal / (combinations || 1),
      totalEvWeight / denominator,
      ...frequencies.flatMap((frequency, actionIndex) => [
        frequency,
        actionEvWeights[actionIndex] / denominator
      ])
    ];
    for (const value of values) {
      output.writeFloatLE(Number.isFinite(value) ? value : 0, outputOffset);
      outputOffset += 4;
    }
  }
  return output;
}

function buildTreeIndex(tree) {
  const nodeIdByKey = new Map(tree.nodes.map((node, id) => [node.key, id]));
  let byteOffset = 0;
  const nodes = tree.nodes.map((node, id) => {
    const actor = node.state.players.find((player) => player.isCurrent)?.position ?? null;
    const parentId = node.state.parentKey === null
      ? null
      : nodeIdByKey.get(node.state.parentKey) ?? null;
    const byteLength = HAND_LABELS.length * (3 + node.actions.length * 2) * 4;
    const result = {
      id,
      key: node.key,
      parentId,
      street: 1,
      actor,
      pot: node.state.pot,
      potOdds: node.state.potOdds,
      spr: node.state.spr,
      actions: node.actions,
      children: node.actions.map((label) => {
        const action = node.state.actions.find((candidate) => candidate.label === label);
        const nextId = action ? nodeIdByKey.get(action.key) : undefined;
        return {
          label,
          nextId: nextId ?? null,
          terminal: nextId === undefined
        };
      }),
      players: node.state.players.map((player) => ({
        position: player.position,
        stack: player.stack,
        contributed: player.totalContributed,
        withCards: player.withCards,
        acted: player.acted
      })),
      byteOffset,
      byteLength
    };
    byteOffset += byteLength;
    return result;
  });
  const rootId = nodeIdByKey.get('["Root"]');
  if (rootId === undefined) throw new Error('翻牌行动树缺少根节点');
  return { rootId, nodes, uncompressedBytes: byteOffset };
}

async function writeAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, value);
  await fs.rename(temporaryPath, filePath);
}

const [checkpoint, tree, masksDocument] = await Promise.all([
  fs.readFile(path.join(inputDirectory, 'checkpoint.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(inputDirectory, 'tree.json'), 'utf8').then(JSON.parse),
  fs.readFile(maskPath, 'utf8').then(JSON.parse)
]);

if (checkpoint.failures?.length) {
  throw new Error(`翻牌批次仍有 ${checkpoint.failures.length} 个失败项`);
}
if (!maximumFlops && checkpoint.completed.length !== 1755) {
  throw new Error(`完整网站包必须包含 1755 个翻牌，当前为 ${checkpoint.completed.length}`);
}
if (
  masksDocument.schemaVersion !== 1 ||
  JSON.stringify(masksDocument.labels) !== JSON.stringify(HAND_LABELS)
) {
  throw new Error('手牌类别掩码版本或顺序不正确');
}

const completed = maximumFlops
  ? checkpoint.completed.slice(0, maximumFlops)
  : checkpoint.completed;
const multiplicities = buildCanonicalFlopMultiplicities();
const treeIndex = buildTreeIndex(tree);
const packsDirectory = path.join(outputDirectory, 'packs');
await fs.mkdir(packsDirectory, { recursive: true });

const packs = [];
let totalCompressedBytes = 0;
let totalUncompressedBytes = 0;
const startedAt = Date.now();

for (let itemIndex = 0; itemIndex < completed.length; itemIndex += 1) {
  const item = completed[itemIndex];
  const [metadata, buffer] = await Promise.all([
    fs.readFile(path.join(inputDirectory, item.metadataFilename), 'utf8').then(JSON.parse),
    fs.readFile(path.join(inputDirectory, item.dataFilename))
  ]);
  if (
    metadata.schemaVersion !== 1 ||
    metadata.comboCount !== COMBO_COUNT ||
    metadata.nodes.length !== treeIndex.nodes.length
  ) {
    throw new Error(`${item.id} 的翻牌元数据不完整`);
  }

  const nodeBuffers = metadata.nodes.map((node, nodeId) => {
    const expected = treeIndex.nodes[nodeId];
    if (
      node.key !== expected.key ||
      JSON.stringify(node.actions) !== JSON.stringify(expected.actions)
    ) {
      throw new Error(`${item.id} 的行动树结构与公共索引不一致：${nodeId}`);
    }
    return aggregateNodeByHandClass(buffer, node, masksDocument.masks);
  });
  const payload = Buffer.concat(nodeBuffers);
  if (payload.length !== treeIndex.uncompressedBytes) {
    throw new Error(`${item.id} 的压缩前策略长度不正确`);
  }
  const compressed = await gzipAsync(payload, { level: 6 });
  const filename = `${item.id}.bin.gz`;
  await writeAtomic(path.join(packsDirectory, filename), compressed);

  const boardKey = metadata.board.join('-');
  const multiplicity = multiplicities.get(boardKey);
  if (!multiplicity) throw new Error(`无法确定 ${item.id} 的同构权重`);
  packs.push({
    id: item.id,
    label: boardLabel(metadata.board),
    board: metadata.board,
    filename: `packs/${filename}`,
    multiplicity,
    texture: classifyFlop(metadata.board),
    compressedBytes: compressed.length,
    uncompressedBytes: payload.length
  });
  totalCompressedBytes += compressed.length;
  totalUncompressedBytes += payload.length;

  if ((itemIndex + 1) % 100 === 0 || itemIndex + 1 === completed.length) {
    console.log(JSON.stringify({
      completed: itemIndex + 1,
      total: completed.length,
      compressedMB: Number((totalCompressedBytes / 1024 / 1024).toFixed(2)),
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
    }));
  }
}

const manifest = {
  schemaVersion: 2,
  datasetId: 'gg-rnc-6max-100bb-drop-1p5bb-flop-v1',
  generatedAt: new Date().toISOString(),
  source: 'locally solved RocketSolver static snapshots',
  solved: true,
  realtimeSolver: false,
  scope: maximumFlops ? 'development-preview' : 'complete-flop',
  spot: 'BTN raise 2.5bb / SB fold / BB call',
  canonicalFlops: packs.length,
  concreteFlopWeight: packs.reduce((sum, pack) => sum + pack.multiplicity, 0),
  postflopDecisionNodes: treeIndex.nodes.length,
  decisionsByStreet: { 1: treeIndex.nodes.length, 2: 0, 3: 0 },
  rootId: treeIndex.rootId,
  positions: { 0: 'BTN', 8: 'BB' },
  handLabels: HAND_LABELS,
  nodes: treeIndex.nodes,
  packs
};
await writeAtomic(
  path.join(outputDirectory, 'manifest.json'),
  JSON.stringify(manifest)
);

console.log(JSON.stringify({
  outputDirectory,
  packs: packs.length,
  nodes: treeIndex.nodes.length,
  totalCompressedBytes,
  totalUncompressedBytes,
  compressionRatio: Number((totalCompressedBytes / totalUncompressedBytes).toFixed(4))
}, null, 2));
