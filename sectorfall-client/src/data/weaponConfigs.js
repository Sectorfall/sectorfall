/**
 * weaponConfigs.js
 *
 * PHASE 1 (Clean Stats Refactor)
 *
 * This file is now a compatibility layer.
 * Existing imports keep working, but the source of truth lives in:
 *   src/data/stats/*.stats.js
 */

import {
  FLUX_LASER_BASE,
  FLUX_RARITY_MODS,
  PULSE_CANNON_BASE,
  PULSE_RARITY_MODS,
  MISSILE_BASE,
  MISSILE_RARITY_MODS,
  MINING_LASER_BASE,
  MINING_RARITY_MODS,
} from './stats/weapons.stats.js';

import { DRONE_MODULE_CONFIGS, DRONE_STATS } from './stats/drones.stats.js';

// Keep legacy export names
export const FLUX_LASER_CONFIGS = FLUX_LASER_BASE;
export { FLUX_RARITY_MODS };

export const PULSE_CANNON_CONFIGS = PULSE_CANNON_BASE;
export { PULSE_RARITY_MODS };

export const MISSILE_CONFIGS = MISSILE_BASE;
export { MISSILE_RARITY_MODS };

export const MINING_LASER_CONFIGS = MINING_LASER_BASE;
export { MINING_RARITY_MODS };

export { DRONE_MODULE_CONFIGS, DRONE_STATS };