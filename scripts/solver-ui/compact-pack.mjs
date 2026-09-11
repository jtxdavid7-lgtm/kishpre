import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const RANKS_ASCENDING = Object.freeze([
  '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'
]);
const RANKS_DESCENDING = Object.freeze([...RANKS_ASCENDING].reverse());

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function comboCards(comboIndex) {
  let remaining = comboIndex;
  for (let lowCard = 0; lowCard < 51; lowCard += 1) {
    const rowLength = 51 - lowCard;
    if (remaining < rowLength) return [lowCard + 1 + remaining, lowCard];
    remaining -= rowLength;
  }
  throw new Error(`具体组合索引无效：${comboIndex}`);
}

function handLabel(cards) {
  const [first, second] = cards;
  const firstRank = Math.floor(first / 4);
  const secondRank = Math.floor(second / 4);
  if (firstRank === secondRank) return `${RANKS_ASCENDING[firstRank]}${RANKS_ASCENDING[firstRank]}`;
  const high = firstRank > secondRank ? first : second;
  const low = firstRank > secondRank ? second : first;
  return (
    `${RANKS_ASCENDING[Math.floor(high / 4)]}${RANKS_ASCENDING[Math.floor(low / 4)]}` +
    (high % 4 === low % 4 ? 's' : 'o')
  );
}

export function solverMatrixLabels() {
  return RANKS_DESCENDING.flatMap((rowRank, row) =>
    RANKS_DESCENDING.map((columnRank, column) => {
      if (row === column) return `${rowRank}${rowRank}`;
      if (row < column) return `${rowRank}${columnRank}s`;
      return `${columnRank}${rowRank}o`;
    })
  );
}

async function readManifest(packPath) {
  const manifest = JSON.parse(await fs.readFile(path.join(packPath, 'manifest.json'), 'utf8'));
  assert(manifest.compactPackSchemaVersion === 1, '不支持的 compact pack 版本');
  assert(manifest.exactComboFormat?.comboCount === 1326, 'compact pack 组合数无效');
  assert(Array.isArray(manifest.nodes) && manifest.nodes.length > 0, 'compact pack 没有节点');
  assert(Array.isArray(manifest.groups) && manifest.groups.length > 0, 'compact pack 没有数据组');
  return manifest;
}

function nodeSummary(node) {
  return {
    id: node.id,
    key: node.key,
    actor: node.actor,
    street: node.street,
    currentBoard: node.currentBoard,
    currentBoardText: node.currentBoardText,
    history: node.history,
    state: node.state,
    actions: node.actions
  };
}

async function readNodeBuffer(packPath, manifest, node) {
  const layout = node.exactComboLayout;
  const group = manifest.groups.find((candidate) => candidate.id === layout?.groupId);
  assert(group, `节点 ${node.id} 引用了不存在的数据组`);
  const assetPath = path.resolve(packPath, group.asset);
  assert(assetPath.startsWith(`${path.resolve(packPath)}${path.sep}`), 'compact pack 资源越界');
  const buffer = await fs.readFile(assetPath);
  assert(buffer.byteLength === group.uncompressedBytes, `数据组 ${group.id} 长度不匹配`);
  const digest = createHash('sha256').update(buffer).digest('hex');
  assert(digest === group.sha256, `数据组 ${group.id} 哈希不匹配`);
  assert(
    layout.byteOffset >= 0 && layout.byteOffset + layout.byteLength <= buffer.byteLength,
    `节点 ${node.id} 布局越界`
  );
  return buffer;
}

export async function decodeCompactPackNode(packPath, nodeId = 0) {
  const manifest = await readManifest(packPath);
  const node = manifest.nodes.find((candidate) => candidate.id === Number(nodeId));
  assert(node, `找不到求解节点 ${nodeId}`);
  const buffer = await readNodeBuffer(packPath, manifest, node);
  const actions = node.actions;
  const valuesPerRow = 2 + actions.length * 2;
  const layout = node.exactComboLayout;
  assert(layout.valuesPerRow === valuesPerRow, `节点 ${node.id} 行布局无效`);
  assert(layout.byteLength === 1326 * valuesPerRow * 4, `节点 ${node.id} 字节长度无效`);
  const buckets = new Map(
    solverMatrixLabels().map((label) => [label, {
      combinations: 0,
      reach: 0,
      totalEvWeighted: 0,
      totalEvReach: 0,
      actionReach: Array(actions.length).fill(0),
      actionEvWeighted: Array(actions.length).fill(0),
      actionEvReach: Array(actions.length).fill(0)
    }])
  );
  const aggregate = {
    reach: 0,
    totalEvWeighted: 0,
    totalEvReach: 0,
    actionReach: Array(actions.length).fill(0),
    actionEvWeighted: Array(actions.length).fill(0),
    actionEvReach: Array(actions.length).fill(0)
  };
  for (let comboIndex = 0; comboIndex < 1326; comboIndex += 1) {
    const offset = layout.byteOffset + comboIndex * valuesPerRow * 4;
    const reach = buffer.readFloatLE(offset);
    if (!Number.isFinite(reach)) continue;
    const bucket = buckets.get(handLabel(comboCards(comboIndex)));
    bucket.combinations += 1;
    if (!(reach > 0)) continue;
    const totalEv = buffer.readFloatLE(offset + 4);
    bucket.reach += reach;
    aggregate.reach += reach;
    if (Number.isFinite(totalEv)) {
      bucket.totalEvWeighted += reach * totalEv;
      bucket.totalEvReach += reach;
      aggregate.totalEvWeighted += reach * totalEv;
      aggregate.totalEvReach += reach;
    }
    actions.forEach((action, actionIndex) => {
      const actionOffset = offset + (2 + actionIndex * 2) * 4;
      const frequency = buffer.readFloatLE(actionOffset);
      const actionEv = buffer.readFloatLE(actionOffset + 4);
      if (!Number.isFinite(frequency)) return;
      const weightedReach = reach * frequency;
      bucket.actionReach[actionIndex] += weightedReach;
      aggregate.actionReach[actionIndex] += weightedReach;
      if (weightedReach > 0 && Number.isFinite(actionEv)) {
        bucket.actionEvWeighted[actionIndex] += weightedReach * actionEv;
        bucket.actionEvReach[actionIndex] += weightedReach;
        aggregate.actionEvWeighted[actionIndex] += weightedReach * actionEv;
        aggregate.actionEvReach[actionIndex] += weightedReach;
      }
    });
  }
  const matrix = solverMatrixLabels().map((label, index) => {
    const bucket = buckets.get(label);
    return {
      label,
      row: Math.floor(index / 13),
      column: index % 13,
      combinations: bucket.combinations,
      reach: bucket.reach,
      totalEv: bucket.totalEvReach > 0 ? bucket.totalEvWeighted / bucket.totalEvReach : null,
      actions: Object.fromEntries(actions.map((action, actionIndex) => [
        action.id,
        bucket.reach > 0 ? bucket.actionReach[actionIndex] / bucket.reach : 0
      ])),
      actionEvs: Object.fromEntries(actions.map((action, actionIndex) => [
        action.id,
        bucket.actionEvReach[actionIndex] > 0
          ? bucket.actionEvWeighted[actionIndex] / bucket.actionEvReach[actionIndex]
          : null
      ]))
    };
  });
  return {
    schemaVersion: 1,
    manifest: {
      board: manifest.board,
      boardText: manifest.boardText,
      releaseStatus: manifest.releaseStatus,
      releaseEligible: manifest.releaseEligible,
      solve: manifest.solve,
      economics: manifest.economics,
      treeHash: manifest.treeHash,
      rangeHash: manifest.rangeHash,
      modelHash: manifest.modelHash,
      provenance: manifest.provenance,
      coverage: manifest.coverage
    },
    nodes: manifest.nodes.map(nodeSummary),
    selectedNode: {
      ...nodeSummary(node),
      matrix,
      aggregate: {
        reach: aggregate.reach,
        totalEv: aggregate.totalEvReach > 0
          ? aggregate.totalEvWeighted / aggregate.totalEvReach
          : null,
        actions: Object.fromEntries(actions.map((action, actionIndex) => [
          action.id,
          aggregate.reach > 0 ? aggregate.actionReach[actionIndex] / aggregate.reach : 0
        ])),
        actionEvs: Object.fromEntries(actions.map((action, actionIndex) => [
          action.id,
          aggregate.actionEvReach[actionIndex] > 0
            ? aggregate.actionEvWeighted[actionIndex] / aggregate.actionEvReach[actionIndex]
            : null
        ]))
      }
    }
  };
}

export async function buildWebsiteExport(packPath) {
  const manifest = await readManifest(packPath);
  const nodes = [];
  for (const node of manifest.nodes) {
    const decoded = await decodeCompactPackNode(packPath, node.id);
    nodes.push(decoded.selectedNode);
  }
  return {
    schemaVersion: 1,
    format: 'kishpoker-postflop-solver-website-export-v1',
    generatedAt: new Date().toISOString(),
    source: {
      compactPackSchemaVersion: manifest.compactPackSchemaVersion,
      treeHash: manifest.treeHash,
      rangeHash: manifest.rangeHash,
      modelHash: manifest.modelHash,
      provenance: manifest.provenance
    },
    board: manifest.board,
    boardText: manifest.boardText,
    solve: manifest.solve,
    economics: manifest.economics,
    coverage: manifest.coverage,
    nodes
  };
}
