/**
 * thrusters.stats.js
 *
 * PHASE 1 (Clean Stats Refactor)
 * Pure thruster tables.
 */

export const ION_THRUSTER_BASE = {
  S: {
    baseSpeedBoostPercent: 60,
    baseSignaturePenalty: 6,
    baseEnergyDrain: 8,
    basePG: 20,
    baseCPU: 15,
    weight: 3.0,
  },
  M: {
    baseSpeedBoostPercent: 100,
    baseSignaturePenalty: 10,
    baseEnergyDrain: 12,
    basePG: 32,
    baseCPU: 22,
    weight: 4.0,
  },
  L: {
    baseSpeedBoostPercent: 150,
    baseSignaturePenalty: 15,
    baseEnergyDrain: 18,
    basePG: 55,
    baseCPU: 32,
    weight: 5.0,
  },
};