import fs from 'node:fs/promises';
import path from 'node:path';

const SUIT_COUNT = 4;
const CARD_COUNT = 52;
const COMBO_COUNT = 1326;
const EXPECTED_FLOP_COUNT = 1755;
const RAW_FLOP_COUNT = 22100;

function permutations(values) {
  if (values.length === 1) return [values];
  return values.flatMap((value, index) => permutations(
    values.filter((_, itemIndex) => itemIndex !== index)
  ).map((tail) => [value, ...tail]));
}
const SUIT_PERMUTATIONS = permutations([0, 1, 2, 3]);

export function canonicalFlop(cards) {
  let best = null;
  for (const suits of SUIT_PERMUTATIONS) {
    const candidate = cards
      .map((card) => Math.floor(card / SUIT_COUNT) * SUIT_COUNT + suits[card % SUIT_COUNT])
      .sort((left, right) => left - right);
    if (!best) {
      best = candidate;
      continue;
    }
    for (let index = 0; index < candidate.length; index += 1) {
      if (candidate[index] === best[index]) continue;
      if (candidate[index] < best[index]) best = candidate;
      break;
    }
  }
  return best;
}

export function buildCanonicalFlopMultiplicities() {
  const multiplicities = new Map();
  for (let first = 0; first < CARD_COUNT; first += 1) {
    for (let second = first + 1; second < CARD_COUNT; second += 1) {
      for (let third = second + 1; third < CARD_COUNT; third += 1) {
        const key = canonicalFlop([first, second, third]).join('-');
        multiplicities.set(key, (multiplicities.get(key) ?? 0) + 1);
      }
    }
  }
  const total = [...multiplicities.values()].reduce((sum, value) => sum + value, 0);
  if (multiplicities.size !== EXPECTED_FLOP_COUNT || total !== RAW_FLOP_COUNT) {
    throw new Error(`翻牌同构权重异常：${multiplicities.size} classes / ${total} concrete flops`);
  }
  return multiplicities;
}

export function classifyFlop(board) {
  if (!Array.isArray(board) || board.length !== 3) {
    throw new Error(`翻牌必须包含 3 张牌：${JSON.stringify(board)}`);
  }
  const ranks = board.map((card) => Math.floor(card / SUIT_COUNT) + 2);
  const suits = board.map((card) => card % SUIT_COUNT);
  const uniqueRanks = new Set(ranks);
  const uniqueSuits = new Set(suits);
  const rankCounts = [...uniqueRanks].map(
    (rank) => ranks.filter((candidate) => candidate === rank).length
  );
  const pairedness = rankCounts.includes(3)
    ? 'trips'
    : rankCounts.includes(2)
      ? 'paired'
      : 'unpaired';
  const suitedness = uniqueSuits.size === 1
    ? 'monotone'
    : uniqueSuits.size === 2
      ? 'two-tone'
      : 'rainbow';
  const straightWindows = [
    new Set([14, 2, 3, 4, 5]),
    ...Array.from({ length: 9 }, (_, index) => {
      const low = index + 2;
      return new Set([low, low + 1, low + 2, low + 3, low + 4]);
    })
  ];
  const maxRanksInWindow = Math.max(...straightWindows.map(
    (window) => [...uniqueRanks].filter((rank) => window.has(rank)).length
  ));
  const connectedness = maxRanksInWindow >= 3
    ? 'connected'
    : maxRanksInWindow === 2
      ? 'semi-connected'
      : 'disconnected';

  return {
    highRank: Math.max(...ranks),
    pairedness,
    suitedness,
    connectedness,
    broadwayCount: ranks.filter((rank) => rank >= 10).length
  };
}

function readNodeAggregate(buffer, metadata) {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + metadata.byteOffset,
    metadata.byteLength
  );
  const actionCount = metadata.actions.length;
  const valuesPerCombo = 2 + actionCount * 2;
  if (metadata.valuesPerCombo !== valuesPerCombo) {
    throw new Error(`${metadata.key} valuesPerCombo 不匹配`);
  }
  if (metadata.byteLength !== COMBO_COUNT * valuesPerCombo * 4) {
    throw new Error(`${metadata.key} 二进制长度不匹配`);
  }

  let reachWeight = 0;
  let evWeight = 0;
  const actionWeights = Array(actionCount).fill(0);
  let validCombos = 0;
  let reachableCombos = 0;
  let offset = 0;

  for (let comboIndex = 0; comboIndex < COMBO_COUNT; comboIndex += 1) {
    const reach = view.getFloat32(offset, true);
    const totalEv = view.getFloat32(offset + 4, true);
    offset += 8;
    const frequencies = [];
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
      frequencies.push(view.getFloat32(offset, true));
      offset += 8;
    }
    const valid = Number.isFinite(reach) &&
      Number.isFinite(totalEv) &&
      frequencies.every(Number.isFinite);
    if (!valid) continue;
    validCombos += 1;
    if (!(reach > 1e-9)) continue;
    reachableCombos += 1;
    const frequencyTotal = frequencies.reduce((sum, value) => sum + value, 0);
    if (Math.abs(frequencyTotal - 1) > 0.0035) {
      throw new Error(
        `${metadata.key} / combo ${comboIndex} 频率未闭合：${frequencyTotal}`
      );
    }
    reachWeight += reach;
    evWeight += reach * totalEv;
    frequencies.forEach((frequency, actionIndex) => {
      actionWeights[actionIndex] += reach * frequency;
    });
  }

  const denominator = reachWeight || 1;
  return {
    reachWeight,
    ev: reachWeight ? evWeight / denominator : null,
    frequencies: actionWeights.map((value) => reachWeight ? value / denominator : 0),
    validCombos,
    reachableCombos
  };
}

function initializeNode(metadata, nodeId) {
  const actor = metadata.state.players.find((player) => player.isCurrent)?.position ?? null;
  return {
    id: nodeId,
    key: metadata.key,
    actor,
    pot: metadata.state.pot,
    spr: metadata.state.spr,
    actions: metadata.actions,
    boards: [],
    totals: {
      boardWeight: 0,
      reachWeight: 0,
      evWeight: 0,
      actionWeights: Array(metadata.actions.length).fill(0)
    }
  };
}

function finalizeNode(node) {
  const denominator = node.totals.reachWeight || 1;
  return {
    id: node.id,
    key: node.key,
    actor: node.actor,
    pot: node.pot,
    spr: node.spr,
    actions: node.actions,
    aggregate: {
      boardWeight: node.totals.boardWeight,
      reachWeight: node.totals.reachWeight,
      ev: node.totals.reachWeight ? node.totals.evWeight / denominator : null,
      frequencies: node.totals.actionWeights.map(
        (value) => node.totals.reachWeight ? value / denominator : 0
      )
    },
    boards: node.boards
  };
}

export async function buildFlopAggregateReport({
  inputDirectory,
  allowPartial = false,
  maximumFlops = 0
}) {
  const checkpointPath = path.join(inputDirectory, 'checkpoint.json');
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  if (checkpoint.failures?.length) {
    throw new Error(`翻牌批次仍有 ${checkpoint.failures.length} 个失败项`);
  }
  const allCompleted = checkpoint.completed ?? [];
  if (!allowPartial && allCompleted.length !== checkpoint.requestedFlops) {
    throw new Error(
      `翻牌批次尚未完成：${allCompleted.length}/${checkpoint.requestedFlops}；` +
      '开发预览必须显式启用 allowPartial'
    );
  }
  const completed = maximumFlops > 0
    ? allCompleted.slice(0, maximumFlops)
    : allCompleted;
  if (!completed.length) throw new Error('没有可聚合的翻牌文件');

  const multiplicities = buildCanonicalFlopMultiplicities();
  const nodes = [];
  const seenBoards = new Set();

  for (const item of completed) {
    const metadataPath = path.join(inputDirectory, item.metadataFilename);
    const dataPath = path.join(inputDirectory, item.dataFilename);
    const [metadata, buffer] = await Promise.all([
      fs.readFile(metadataPath, 'utf8').then(JSON.parse),
      fs.readFile(dataPath)
    ]);
    if (metadata.schemaVersion !== 1 || metadata.comboCount !== COMBO_COUNT) {
      throw new Error(`${item.id} 元数据版本或组合数不正确`);
    }
    const boardKey = metadata.board.join('-');
    if (seenBoards.has(boardKey)) throw new Error(`重复翻牌：${boardKey}`);
    seenBoards.add(boardKey);
    const multiplicity = multiplicities.get(boardKey);
    if (!multiplicity) throw new Error(`无法识别翻牌同构权重：${boardKey}`);
    const texture = classifyFlop(metadata.board);

    metadata.nodes.forEach((nodeMetadata, nodeId) => {
      if (!nodes[nodeId]) nodes[nodeId] = initializeNode(nodeMetadata, nodeId);
      const node = nodes[nodeId];
      if (
        node.key !== nodeMetadata.key ||
        JSON.stringify(node.actions) !== JSON.stringify(nodeMetadata.actions)
      ) {
        throw new Error(`${item.id} 的节点 ${nodeId} 与首个翻牌树结构不一致`);
      }
      const aggregate = readNodeAggregate(buffer, nodeMetadata);
      const concreteReachWeight = aggregate.reachWeight * multiplicity;
      node.boards.push({
        id: item.id,
        board: metadata.board,
        multiplicity,
        texture,
        ...aggregate
      });
      node.totals.boardWeight += multiplicity;
      node.totals.reachWeight += concreteReachWeight;
      if (aggregate.ev !== null) {
        node.totals.evWeight += concreteReachWeight * aggregate.ev;
      }
      aggregate.frequencies.forEach((frequency, actionIndex) => {
        node.totals.actionWeights[actionIndex] += concreteReachWeight * frequency;
      });
    });
  }

  const finalizedNodes = nodes.map(finalizeNode);
  for (const node of finalizedNodes) {
    const closure = node.aggregate.frequencies.reduce((sum, value) => sum + value, 0);
    if (node.aggregate.reachWeight > 0 && Math.abs(closure - 1) > 0.001) {
      throw new Error(`${node.key} 聚合频率未闭合：${closure}`);
    }
  }

  return {
    schemaVersion: 1,
    datasetId: 'gg-rnc-6max-100bb-btn-vs-bb-srp-flop-aggregate-v1',
    generatedAt: new Date().toISOString(),
    solved: true,
    realtimeSolver: false,
    partial: completed.length !== checkpoint.requestedFlops,
    completedFlops: completed.length,
    totalCanonicalFlops: checkpoint.requestedFlops,
    concreteFlopWeight: finalizedNodes[0].aggregate.boardWeight,
    comboCount: COMBO_COUNT,
    nodeCount: finalizedNodes.length,
    positions: { 0: 'BTN', 8: 'BB' },
    nodes: finalizedNodes
  };
}
