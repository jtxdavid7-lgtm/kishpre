import { describeGtoAction, preflopCombinationCount } from '../data/gtoFormal.js';

const DATA_BASE = '/data/gto/gg-rnc-6max-100bb-drop-1p5bb-v1';
let indexPromise;
const chunkPromises = new Map();
const nodePromises = new Map();

async function fetchRequired(url, type) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GTO 数据加载失败（${response.status}）：${url}`);
  return type === 'json' ? response.json() : response.arrayBuffer();
}

export function loadGtoPreflopIndex() {
  if (!indexPromise) {
    indexPromise = fetchRequired(`${DATA_BASE}/index.json`, 'json').then((index) => {
      if (index.schemaVersion !== 3 || index.preflopDecisionNodes !== index.nodes.length) {
        throw new Error('GTO 翻前索引版本或节点数量不正确');
      }
      return index;
    });
  }
  return indexPromise;
}

function loadChunk(index, chunkId) {
  if (!chunkPromises.has(chunkId)) {
    const chunk = index.chunks[chunkId];
    if (!chunk) return Promise.reject(new Error(`GTO 数据块不存在：${chunkId}`));
    chunkPromises.set(chunkId, fetchRequired(`${DATA_BASE}/${chunk.filename}`, 'arrayBuffer'));
  }
  return chunkPromises.get(chunkId);
}

export function decodeGtoNode(index, metadata, chunkBuffer) {
  const actionDescriptors = metadata.actions.map((label) => describeGtoAction(label, metadata));
  const view = new DataView(chunkBuffer, metadata.byteOffset, metadata.byteLength);
  const matrix = [];
  let byteOffset = 0;

  for (let handIndex = 0; handIndex < index.handLabels.length; handIndex++) {
    const label = index.handLabels[handIndex];
    const reach = view.getFloat32(byteOffset, true);
    const totalEv = view.getFloat32(byteOffset + 4, true);
    byteOffset += 8;
    const actions = {};
    const actionEvs = {};
    for (const action of metadata.actions) {
      actions[action] = view.getFloat32(byteOffset, true);
      actionEvs[action] = view.getFloat32(byteOffset + 4, true);
      byteOffset += 8;
    }
    matrix.push({
      label,
      rowIndex: Math.floor(handIndex / 13),
      columnIndex: handIndex % 13,
      combinations: preflopCombinationCount(label),
      reach,
      totalEv,
      actions,
      actionEvs,
      note: 'RocketSolver 完整翻前静态快照；频率与 EV 按同类花色组合的到达权重聚合。'
    });
  }

  return {
    ...metadata,
    actorLabel: index.positions[metadata.actor],
    actionDescriptors,
    matrix
  };
}

export function loadGtoPreflopNode(index, nodeId) {
  if (!nodePromises.has(nodeId)) {
    const metadata = index.nodes[nodeId];
    if (!metadata) return Promise.reject(new Error(`GTO 节点不存在：${nodeId}`));
    nodePromises.set(nodeId, loadChunk(index, metadata.chunk).then((buffer) => decodeGtoNode(index, metadata, buffer)));
  }
  return nodePromises.get(nodeId);
}

export function getGtoDecisionTrail(index, nodeId) {
  const trail = [];
  let current = index.nodes[nodeId];
  while (current) {
    trail.push(current);
    current = current.parentId === null ? null : index.nodes[current.parentId];
  }
  trail.reverse();
  return trail.map((node, indexInTrail) => {
    const nextNode = trail[indexInTrail + 1];
    const selectedAction = nextNode
      ? node.children.find((child) => child.nextId === nextNode.id)?.label ?? null
      : null;
    return { node, selectedAction };
  });
}

export function advanceByFoldsToActor(index, startNodeId, targetActor) {
  let current = index.nodes[startNodeId];
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    if (current.actor === targetActor) return current.id;
    visited.add(current.id);
    const fold = current.children.find((child) => child.label === 'Fold');
    current = fold?.nextId === null || fold?.nextId === undefined ? null : index.nodes[fold.nextId];
  }
  return null;
}

export function findSeatDecisionNode(index, currentNodeId, targetActor) {
  const trail = getGtoDecisionTrail(index, currentNodeId);
  const existing = [...trail].reverse().find((entry) => entry.node.actor === targetActor);
  if (existing) return existing.node.id;
  return advanceByFoldsToActor(index, currentNodeId, targetActor)
    ?? advanceByFoldsToActor(index, index.rootId, targetActor);
}

export function findActionTransition(index, nodeId, actionLabel) {
  return index.nodes[nodeId]?.children.find((child) => child.label === actionLabel) ?? null;
}

export function summarizeStrategy(node) {
  if (!node) return {};
  const weighted = {};
  let combinations = 0;
  node.matrix.forEach((hand) => {
    const weight = hand.combinations * hand.reach;
    combinations += weight;
    Object.entries(hand.actions).forEach(([action, frequency]) => {
      weighted[action] = (weighted[action] ?? 0) + frequency * weight;
    });
  });
  if (!combinations) return Object.fromEntries(node.actions.map((action) => [action, 0]));
  return Object.fromEntries(Object.entries(weighted).map(([action, value]) => [action, value / combinations]));
}

export function strategyGradient(actions = {}, actionDescriptors = []) {
  const colorByAction = Object.fromEntries(actionDescriptors.map((action) => [action.key, action.color]));
  const segments = [];
  let offset = 0;
  Object.entries(actions).forEach(([key, frequency]) => {
    if (frequency <= 0) return;
    const end = offset + frequency * 100;
    const color = colorByAction[key] ?? '#334155';
    segments.push(`${color} ${offset}%`, `${color} ${end}%`);
    offset = end;
  });
  if (!segments.length) return '#263449';
  return `linear-gradient(90deg, ${segments.join(', ')})`;
}

export function resetGtoDataCacheForTests() {
  indexPromise = undefined;
  chunkPromises.clear();
  nodePromises.clear();
}
