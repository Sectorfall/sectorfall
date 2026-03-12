/**
 * drones.stats.js
 *
 * PHASE 1 (Clean Stats Refactor)
 * Pure drone tables (no logic).
 */

export const DRONE_MODULE_CONFIGS = {
  'Small Combat Drone Module': {
    drones: [{ type: 'Light Combat', count: 2 }],
    energyDrain: 6,
    pg: 14,
    cpu: 16,
    controlRange: 650,
    size: 'S',
  },
  'Medium Combat Drone Module': {
    drones: [{ type: 'Light Combat', count: 2 }, { type: 'Heavy Combat', count: 2 }],
    energyDrain: 9,
    pg: 24,
    cpu: 30,
    controlRange: 700,
    size: 'M',
  },
  'Large Combat Drone Module': {
    drones: [{ type: 'Light Combat', count: 4 }, { type: 'Heavy Combat', count: 4 }],
    energyDrain: 16,
    pg: 40,
    cpu: 46,
    controlRange: 750,
    size: 'L',
  },
  'Small Mining Drone Module': {
    drones: [{ type: 'Mining', count: 2 }],
    energyDrain: 6,
    pg: 14,
    cpu: 16,
    controlRange: 650,
    size: 'S',
  },
  'Medium Mining Drone Module': {
    drones: [{ type: 'Mining', count: 4 }],
    energyDrain: 9,
    pg: 24,
    cpu: 30,
    controlRange: 700,
    size: 'M',
  },
  'Large Mining Drone Module': {
    drones: [{ type: 'Mining', count: 8 }],
    energyDrain: 16,
    pg: 40,
    cpu: 46,
    controlRange: 750,
    size: 'L',
  },
  'Small Repair Drone Module': {
    drones: [{ type: 'Repair', count: 1 }],
    energyDrain: 6,
    pg: 14,
    cpu: 16,
    controlRange: 650,
    size: 'S',
  },
  'Medium Repair Drone Module': {
    drones: [{ type: 'Repair', count: 2 }],
    energyDrain: 9,
    pg: 24,
    cpu: 30,
    controlRange: 700,
    size: 'M',
  },
  'Large Repair Drone Module': {
    drones: [{ type: 'Repair', count: 4 }],
    energyDrain: 16,
    pg: 40,
    cpu: 46,
    controlRange: 750,
    size: 'L',
  },
};

export const DRONE_STATS = {
  'Light Combat': {
    hull: 200,
    shield: 100,
    speed: 420,
    signature: 10,
    orbitRange: [150, 200],
    damagePerTick: 2,
    ticksPerSecond: 12,
    accuracy: 0.55,
    optimalRange: 350,
    rebuildTime: 60,
  },
  'Heavy Combat': {
    hull: 420,
    shield: 200,
    speed: 260,
    signature: 16,
    orbitRange: [250, 350],
    damagePerTick: 4,
    ticksPerSecond: 12,
    accuracy: 0.60,
    optimalRange: 450,
    rebuildTime: 120,
  },
  Mining: {
    hull: 150,
    shield: 80,
    speed: 320,
    signature: 12,
    miningRate: 1.6,
    capacity: 10,
    rebuildTime: 45,
  },
  Repair: {
    hull: 300,
    shield: 150,
    speed: 280,
    signature: 14,
    repairRate: 10,
    range: 120,
    rebuildTime: 120,
  },
};