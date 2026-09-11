import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SOLVER_JOB_INPUT,
  normalizeBoard,
  normalizeSolverJobInput,
  SOLVER_TREE_POLICY_ID,
  solverInputSha256
} from '../scripts/solver-ui/protocol.mjs';

describe('solver UI protocol', () => {
  it('normalizes the confirmed v1 tree request without changing its economics', () => {
    const input = normalizeSolverJobInput(DEFAULT_SOLVER_JOB_INPUT);
    expect(input.board).toBe('AsKh9c');
    expect(input.treePolicyId).toBe(SOLVER_TREE_POLICY_ID);
    expect(input.economics).toEqual({
      model: 'gg-rnc-rb40',
      rakeRate: 0.03,
      rakeCapBb: 1.8,
      flatDropThresholdBb: 30,
      flatDropAmountBb: 1.5
    });
  });

  it('accepts readable board separators and rejects duplicate cards', () => {
    expect(normalizeBoard('as / KH, 9c')).toBe('AsKh9c');
    expect(() => normalizeBoard('As As 9c')).toThrow('重复牌');
  });

  it('validates exact-combo f32le range size', () => {
    const data = Buffer.alloc(1326 * 4).toString('base64');
    const input = normalizeSolverJobInput({
      ...DEFAULT_SOLVER_JOB_INPUT,
      ranges: {
        oop: { format: 'f32le-base64', data },
        ip: DEFAULT_SOLVER_JOB_INPUT.ranges.ip
      }
    });
    expect(input.ranges.oop.data).toBe(data);
    expect(() => normalizeSolverJobInput({
      ...DEFAULT_SOLVER_JOB_INPUT,
      ranges: {
        oop: { format: 'f32le-base64', data: Buffer.alloc(4).toString('base64') },
        ip: DEFAULT_SOLVER_JOB_INPUT.ranges.ip
      }
    })).toThrow('1326');
  });

  it('uses a stable input hash independent of object key order', () => {
    const input = normalizeSolverJobInput(DEFAULT_SOLVER_JOB_INPUT);
    expect(solverInputSha256(input)).toBe(solverInputSha256({
      solve: input.solve,
      ranges: input.ranges,
      schemaVersion: input.schemaVersion,
      treePolicyId: input.treePolicyId,
      economics: input.economics,
      effectiveStackBb: input.effectiveStackBb,
      potBb: input.potBb,
      board: input.board,
      export: input.export
    }));
  });
});
