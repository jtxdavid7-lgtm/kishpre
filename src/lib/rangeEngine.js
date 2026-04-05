import { getBaseRange } from '../data/base';
import { PROFILES } from '../data/profiles';
import { RULES } from '../data/rules';

function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function evaluateTrigger(stats, trigger) {
  if (!trigger || !stats) return false;
  const statValue = stats[trigger.stat];
  if (typeof statValue === 'undefined') return false;
  switch (trigger.op) {
    case '>':
      return statValue > trigger.value;
    case '>=':
      return statValue >= trigger.value;
    case '<':
      return statValue < trigger.value;
    case '<=':
      return statValue <= trigger.value;
    case 'between':
      return statValue >= trigger.value[0] && statValue <= trigger.value[1];
    default:
      return false;
  }
}

function matchRules(sceneKey, stats) {
  return RULES.filter((rule) => rule.appliesTo.includes(sceneKey) && evaluateTrigger(stats, rule.trigger));
}

function applyAdjustments(baseMatrix = {}, rules = []) {
  const clone = { ...baseMatrix };
  rules.forEach((rule) => {
    rule.adjustments.forEach((adj) => {
      adj.hands.forEach((hand) => {
        const original = clone[hand] || { action: 'fold', freq: 0 };
        clone[hand] = {
          ...original,
          action: adj.action || original.action,
          freq: clamp((original.freq || 0) + (adj.delta || 0))
        };
      });
    });
  });
  return clone;
}

export function getRangePayload({ sceneKey, profileKey, customStats }) {
  const base = getBaseRange(sceneKey);
  if (!base) {
    return { exists: false, message: `未找到场景 ${sceneKey}` };
  }

  const profile = profileKey ? PROFILES[profileKey] : null;
  const stats = customStats || profile?.stats;
  const matchedRules = stats ? matchRules(sceneKey, stats) : [];
  const adjustedMatrix = applyAdjustments(base.matrix, matchedRules);

  return {
    exists: true,
    profile,
    stats,
    base,
    matchedRules,
    matrices: {
      base: base.matrix,
      adjusted: adjustedMatrix
    }
  };
}
