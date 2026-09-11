export function sameHistory(left, right) {
  return left.length === right.length && left.every((step, index) => {
    const other = right[index];
    return step.id === other?.id && step.actor === other?.actor && step.street === other?.street;
  });
}

export function childNodesForAction(nodes, node, action) {
  return nodes.filter((candidate) => {
    if (candidate.history.length !== node.history.length + 1) return false;
    if (!sameHistory(candidate.history.slice(0, -1), node.history)) return false;
    const step = candidate.history.at(-1);
    return step?.id === action.id && step?.actor === node.actor && step?.street === node.street;
  });
}
