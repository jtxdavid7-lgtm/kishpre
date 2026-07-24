import fs from 'node:fs/promises';
import path from 'node:path';

const HAND_COUNT = 169;

function readFloat(view, offset) {
  const value = view.getFloat32(offset, true);
  if (!Number.isFinite(value)) throw new Error(`转牌聚合数据包含非有限数：${offset}`);
  return value;
}

export function classifyTurn(flop, turnCard) {
  const flopRanks = flop.map((card) => Math.floor(card / 4) + 2);
  const turnRank = Math.floor(turnCard / 4) + 2;
  const ranks = [...flopRanks, turnRank];
  const suits = [...flop, turnCard].map((card) => card % 4);
  const rankCounts = [...new Set(ranks)]
    .map((rank) => ranks.filter((candidate) => candidate === rank).length)
    .sort((left, right) => right - left);
  const maximumSuitCount = Math.max(
    ...[0, 1, 2, 3].map((suit) => suits.filter((candidate) => candidate === suit).length)
  );
  const windows = [
    new Set([14, 2, 3, 4, 5]),
    ...Array.from({ length: 9 }, (_, index) => {
      const low = index + 2;
      return new Set([low, low + 1, low + 2, low + 3, low + 4]);
    })
  ];
  const uniqueRanks = new Set(ranks);
  const maximumRanksInWindow = Math.max(
    ...windows.map((window) => [...uniqueRanks].filter((rank) => window.has(rank)).length)
  );
  let pairedness = 'unpaired';
  if (rankCounts[0] === 4) pairedness = 'quads';
  else if (rankCounts[0] === 3) pairedness = 'trips';
  else if (rankCounts[0] === 2 && rankCounts[1] === 2) pairedness = 'two-pair';
  else if (rankCounts[0] === 2) pairedness = 'paired';

  return {
    rank: turnRank,
    rankRelation: flopRanks.includes(turnRank)
      ? 'pairs-board'
      : turnRank > Math.max(...flopRanks)
        ? 'overcard'
        : turnRank < Math.min(...flopRanks)
          ? 'undercard'
          : 'middle-card',
    pairedness,
    flushiness: maximumSuitCount === 4
      ? 'four-flush'
      : maximumSuitCount === 3
        ? 'three-flush'
        : 'no-three-flush',
    connectedness: maximumRanksInWindow >= 4
      ? 'four-connected'
      : maximumRanksInWindow === 3
        ? 'three-connected'
        : 'disconnected'
  };
}

export function aggregateTurnNode(buffer, metadata) {
  const expectedValuesPerHand = 3 + metadata.actions.length * 2;
  if (metadata.valuesPerHand !== expectedValuesPerHand) {
    throw new Error(`${metadata.key} valuesPerHand 不匹配`);
  }
  const expectedByteLength = HAND_COUNT * expectedValuesPerHand * 4;
  if (metadata.byteLength !== expectedByteLength) {
    throw new Error(`${metadata.key} 二进制长度不匹配`);
  }
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + metadata.byteOffset,
    metadata.byteLength
  );
  let reachWeight = 0;
  let evWeight = 0;
  let validHands = 0;
  let reachableHands = 0;
  const actionWeights = Array(metadata.actions.length).fill(0);

  for (let handIndex = 0; handIndex < HAND_COUNT; handIndex += 1) {
    const baseOffset = handIndex * expectedValuesPerHand * 4;
    const combinations = readFloat(view, baseOffset);
    const averageReach = readFloat(view, baseOffset + 4);
    const totalEv = readFloat(view, baseOffset + 8);
    const handReachWeight = combinations * averageReach;
    validHands += combinations > 0 ? 1 : 0;
    if (!(handReachWeight > 1e-9)) continue;
    reachableHands += 1;
    reachWeight += handReachWeight;
    evWeight += handReachWeight * totalEv;
    let closure = 0;
    for (let actionIndex = 0; actionIndex < metadata.actions.length; actionIndex += 1) {
      const frequency = readFloat(view, baseOffset + (3 + actionIndex * 2) * 4);
      closure += frequency;
      actionWeights[actionIndex] += handReachWeight * frequency;
    }
    if (Math.abs(closure - 1) > 0.004) {
      throw new Error(`${metadata.key} / hand ${handIndex} 频率未闭合：${closure}`);
    }
  }

  return {
    reachWeight,
    ev: reachWeight ? evWeight / reachWeight : null,
    frequencies: actionWeights.map((weight) => reachWeight ? weight / reachWeight : 0),
    validHands,
    reachableHands
  };
}

export async function buildTurnAggregateForFlop({ inputDirectory, flopEntry, tree }) {
  const flopDirectory = path.join(inputDirectory, flopEntry.id);
  const index = JSON.parse(await fs.readFile(path.join(flopDirectory, 'index.json'), 'utf8'));
  if (
    index.schemaVersion !== 1 ||
    index.id !== flopEntry.id ||
    index.concreteTurnWeight !== 49 ||
    !Array.isArray(index.turns)
  ) {
    throw new Error(`${flopEntry.id} 的转牌索引格式无效`);
  }
  const nodes = tree.nodes.map((metadata) => ({
    id: metadata.id,
    key: metadata.key,
    actor: metadata.state.players.find((player) => player.isCurrent)?.position ?? null,
    pot: metadata.state.pot,
    spr: metadata.state.spr,
    actions: metadata.actions,
    turns: [],
    totals: {
      concreteTurnWeight: 0,
      reachWeight: 0,
      evWeight: 0,
      actionWeights: Array(metadata.actions.length).fill(0)
    }
  }));

  for (const turn of index.turns) {
    const buffer = await fs.readFile(path.join(flopDirectory, turn.filename));
    for (const node of nodes) {
      const aggregate = aggregateTurnNode(buffer, tree.nodes[node.id]);
      const concreteReachWeight = aggregate.reachWeight * turn.orbitSize;
      node.turns.push({
        card: turn.card,
        board: turn.board,
        orbitSize: turn.orbitSize,
        texture: classifyTurn(index.flop, turn.card),
        ...aggregate
      });
      node.totals.concreteTurnWeight += turn.orbitSize;
      node.totals.reachWeight += concreteReachWeight;
      if (aggregate.ev !== null) node.totals.evWeight += concreteReachWeight * aggregate.ev;
      aggregate.frequencies.forEach((frequency, actionIndex) => {
        node.totals.actionWeights[actionIndex] += concreteReachWeight * frequency;
      });
    }
  }

  return {
    schemaVersion: 1,
    datasetId: 'gg-rnc-6max-100bb-btn-vs-bb-srp-turn-aggregate-v1',
    generatedAt: new Date().toISOString(),
    solved: true,
    realtimeSolver: false,
    id: index.id,
    flop: index.flop,
    canonicalTurnCount: index.turnCount,
    concreteTurnWeight: index.concreteTurnWeight,
    nodeCount: nodes.length,
    nodes: nodes.map((node) => {
      const denominator = node.totals.reachWeight || 1;
      const aggregate = {
        concreteTurnWeight: node.totals.concreteTurnWeight,
        reachWeight: node.totals.reachWeight,
        ev: node.totals.reachWeight ? node.totals.evWeight / denominator : null,
        frequencies: node.totals.actionWeights.map(
          (weight) => node.totals.reachWeight ? weight / denominator : 0
        )
      };
      const closure = aggregate.frequencies.reduce((sum, frequency) => sum + frequency, 0);
      if (aggregate.reachWeight > 0 && Math.abs(closure - 1) > 0.001) {
        throw new Error(`${index.id} / ${node.key} 的聚合频率未闭合：${closure}`);
      }
      return {
        id: node.id,
        key: node.key,
        actor: node.actor,
        pot: node.pot,
        spr: node.spr,
        actions: node.actions,
        aggregate,
        turns: node.turns
      };
    })
  };
}
