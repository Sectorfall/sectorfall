/**
 * shields.stats.js
 *
 * PHASE 1 (Clean Stats Refactor)
 * Pure shield tables.
 */

export const SHIELD_ARRAY_BASE = {
  S: {
    name: 'Small Shield Array',
    baseCapacity: 500,
    baseRegen: 12,
    basePG: 22,
    baseCPU: 22,
    weight: 3.0,
  },
  M: {
    name: 'Medium Shield Array',
    baseCapacity: 1100,
    baseRegen: 16,
    basePG: 42,
    baseCPU: 38,
    weight: 4.0,
  },
  L: {
    name: 'Large Shield Array',
    baseCapacity: 2000,
    baseRegen: 20,
    basePG: 66,
    baseCPU: 51,
    weight: 5.0,
  },
};