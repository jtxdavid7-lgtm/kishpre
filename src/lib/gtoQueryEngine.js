import { describeGtoAction, preflopCombinationCount } from '../data/gtoFormal.js';

const DATA_BASE = '/data/gto/gg-rnc-6max-100bb-drop-1p5bb-v1';
const POSTFLOP_DATA_BASE = '/data/gto/gg-rnc-6max-100bb-drop-1p5bb-postflop-validation-v1';
const FLOP_DATA_BASE = '/data/gto/gg-rnc-6max-100bb-drop-1p5bb-flop-v1';
const FLOP_AGGREGATE_DATA_BASE =
  '/data/gto/gg-rnc-6max-100bb-drop-1p5bb-flop-aggregate-v1';
let indexPromise;
let postflopManifestPromise;
let flopManifestPromise;
let flopAggregateManifestPromise;
const postflopIndexPromises = new Map();
const flopAggregateNodePromises = new Map();
const chunkPromises = new Map();
const nodePromises = new Map();
const postflopChunkPromises = new Map();
const postflopNodePromises = new Map();
const flopPackPromises = new Map();
const flopNodePromises = new Map();

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

export function loadGtoPostflopManifest() {
  if (!postflopManifestPromise) {
    postflopManifestPromise = fetchRequired(`${POSTFLOP_DATA_BASE}/manifest.json`, 'json').then((manifest) => {
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packs) || !manifest.packs.length) {
        throw new Error('GTO 翻后数据清单格式不正确');
      }
      return manifest;
    });
  }
  return postflopManifestPromise;
}

export function loadGtoFlopManifest() {
  if (!flopManifestPromise) {
    flopManifestPromise = fetchRequired(`${FLOP_DATA_BASE}/manifest.json`, 'json').then((manifest) => {
      if (
        manifest.schemaVersion !== 2 ||
        manifest.scope !== 'complete-flop' ||
        manifest.canonicalFlops !== 1755 ||
        manifest.concreteFlopWeight !== 22100 ||
        manifest.postflopDecisionNodes !== manifest.nodes?.length ||
        !Array.isArray(manifest.packs) ||
        manifest.packs.length !== 1755
      ) {
        throw new Error('GTO 完整翻牌数据清单格式不正确');
      }
      return manifest;
    });
  }
  return flopManifestPromise;
}

async function decompressGzip(buffer) {
  if (
    typeof DecompressionStream === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof Response === 'undefined'
  ) {
    throw new Error('当前浏览器不支持翻牌策略包解压，请升级浏览器后重试');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function loadGtoFlopPack(pack) {
  if (!pack?.id || !pack.filename) {
    return Promise.reject(new Error('未选择完整翻牌数据包'));
  }
  if (!flopPackPromises.has(pack.id)) {
    flopPackPromises.set(
      pack.id,
      fetchRequired(`${FLOP_DATA_BASE}/${pack.filename}`, 'arrayBuffer')
        .then((buffer) => (
          buffer.byteLength === pack.uncompressedBytes
            ? buffer
            : decompressGzip(buffer)
        ))
        .then((buffer) => {
          if (buffer.byteLength !== pack.uncompressedBytes) {
            throw new Error(`GTO 翻牌策略包长度不正确：${pack.id}`);
          }
          return buffer;
        })
    );
  }
  return flopPackPromises.get(pack.id);
}

export function loadGtoFlopNode(index, packId, nodeId) {
  const cacheKey = `${packId}:${nodeId}`;
  if (!flopNodePromises.has(cacheKey)) {
    const metadata = index.nodes[nodeId];
    const pack = index.packs.find((candidate) => candidate.id === packId);
    if (!metadata) return Promise.reject(new Error(`GTO 翻牌节点不存在：${nodeId}`));
    if (!pack) return Promise.reject(new Error(`GTO 翻牌数据包不存在：${packId}`));
    flopNodePromises.set(
      cacheKey,
      loadGtoFlopPack(pack).then((buffer) => decodeGtoPostflopNode(index, {
        ...metadata,
        board: pack.board
      }, buffer))
    );
  }
  return flopNodePromises.get(cacheKey);
}

export function loadGtoFlopAggregateManifest() {
  if (!flopAggregateManifestPromise) {
    flopAggregateManifestPromise = fetchRequired(
      `${FLOP_AGGREGATE_DATA_BASE}/manifest.json`,
      'json'
    ).then((manifest) => {
      if (
        manifest.schemaVersion !== 1 ||
        manifest.partial ||
        manifest.completedFlops !== 1755 ||
        manifest.concreteFlopWeight !== 22100 ||
        !Array.isArray(manifest.nodes)
      ) {
        throw new Error('GTO 翻牌聚合报告尚未完成或格式不正确');
      }
      return manifest;
    });
  }
  return flopAggregateManifestPromise;
}

export function loadGtoFlopAggregateNode(metadata) {
  if (!metadata?.filename) {
    return Promise.reject(new Error('未选择翻牌聚合节点'));
  }
  if (!flopAggregateNodePromises.has(metadata.id)) {
    flopAggregateNodePromises.set(
      metadata.id,
      fetchRequired(`${FLOP_AGGREGATE_DATA_BASE}/${metadata.filename}`, 'json').then((node) => {
        if (
          node.schemaVersion !== undefined ||
          node.id !== metadata.id ||
          node.key !== metadata.key ||
          !Array.isArray(node.boards) ||
          !Array.isArray(node.actions)
        ) {
          throw new Error(`GTO 翻牌聚合节点格式不正确：${metadata.id}`);
        }
        return node;
      })
    );
  }
  return flopAggregateNodePromises.get(metadata.id);
}

export function loadGtoPostflopIndex(pack) {
  if (!pack?.id || !pack.index) return Promise.reject(new Error('未选择翻后牌面数据包'));
  if (!postflopIndexPromises.has(pack.id)) {
    postflopIndexPromises.set(pack.id, fetchRequired(`${POSTFLOP_DATA_BASE}/${pack.index}`, 'json').then((index) => {
      if (index.schemaVersion !== 1 || index.postflopDecisionNodes !== index.nodes.length) {
        throw new Error('GTO 翻后索引版本或节点数量不正确');
      }
      return index;
    }));
  }
  return postflopIndexPromises.get(pack.id);
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

export function decodeGtoPostflopNode(index, metadata, chunkBuffer) {
  const actionDescriptors = metadata.actions.map((label) => describeGtoAction(label, metadata));
  const view = new DataView(chunkBuffer, metadata.byteOffset, metadata.byteLength);
  const matrix = [];
  let byteOffset = 0;

  for (let handIndex = 0; handIndex < index.handLabels.length; handIndex++) {
    const label = index.handLabels[handIndex];
    const combinations = view.getFloat32(byteOffset, true);
    const reach = view.getFloat32(byteOffset + 4, true);
    const totalEv = view.getFloat32(byteOffset + 8, true);
    byteOffset += 12;
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
      combinations,
      reach,
      totalEv,
      actions,
      actionEvs,
      note: 'RocketSolver 翻后静态求解快照；频率与 EV 按未被公共牌阻断的同类花色组合及到达权重聚合。'
    });
  }

  return {
    ...metadata,
    actorLabel: index.positions[metadata.actor],
    actionDescriptors,
    matrix
  };
}

export function loadGtoPostflopNode(index, packId, nodeId) {
  const cacheKey = `${packId}:${nodeId}`;
  if (!postflopNodePromises.has(cacheKey)) {
    const metadata = index.nodes[nodeId];
    if (!metadata) return Promise.reject(new Error(`GTO 翻后节点不存在：${nodeId}`));
    const chunkKey = `${packId}:${metadata.chunk}`;
    if (!postflopChunkPromises.has(chunkKey)) {
      const chunk = index.chunks[metadata.chunk];
      if (!chunk) return Promise.reject(new Error(`GTO 翻后数据块不存在：${metadata.chunk}`));
      postflopChunkPromises.set(
        chunkKey,
        fetchRequired(`${POSTFLOP_DATA_BASE}/${chunk.filename}`, 'arrayBuffer')
      );
    }
    postflopNodePromises.set(
      cacheKey,
      postflopChunkPromises.get(chunkKey).then((buffer) => decodeGtoPostflopNode(index, metadata, buffer))
    );
  }
  return postflopNodePromises.get(cacheKey);
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
  postflopManifestPromise = undefined;
  flopManifestPromise = undefined;
  flopAggregateManifestPromise = undefined;
  postflopIndexPromises.clear();
  flopAggregateNodePromises.clear();
  chunkPromises.clear();
  nodePromises.clear();
  postflopChunkPromises.clear();
  postflopNodePromises.clear();
  flopPackPromises.clear();
  flopNodePromises.clear();
}
