/**
 * modules.js
 *
 * PHASE 1 (Clean Stats Refactor)
 *
 * This file is now PURE-DATA + compatibility exports.
 *
 * Logic helpers like getShieldModuleStats / getIonThrusterStats live in GameManager.js
 * to avoid circular dependencies.
 */

import { ION_THRUSTER_BASE } from './stats/thrusters.stats.js';
import { SHIELD_ARRAY_BASE } from './stats/shields.stats.js';

// Legacy export names expected by GameManager imports
export const ION_THRUSTER_CONFIGS = ION_THRUSTER_BASE;

// Legacy name expected elsewhere: SHIELD_MODULE_CONFIGS (keyed by size)
export const SHIELD_MODULE_CONFIGS = SHIELD_ARRAY_BASE;