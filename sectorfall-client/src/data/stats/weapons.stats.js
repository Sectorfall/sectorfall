/**
 * weapons.stats.js
 *
 * PHASE 1 (Clean Stats Refactor)
 *
 * Pure stat tables (no game logic, no imports).
 * These values were previously stored in src/data/weaponConfigs.js.
 */

export const FLUX_LASER_BASE = {
  S: {
    damagePerTick: 12,
    damageType: 'thermal',
    fireRate: 12,
    optimalRange: 300,
    falloffRange: 500,
    heatPerSecond: 28,
    heatCapacity: 100,
    cooldownTime: 3.5,
    lockTime: 1.5,
    power: 15,
    cpu: 12,
    hitArc: 22.5,
    baseAccuracy: 0.72,
    tracking: 24,
    weaponType: 'laser',
    weight: 3.0,
  },
  M: {
    damagePerTick: 16,
    damageType: 'thermal',
    fireRate: 12,
    optimalRange: 400,
    falloffRange: 600,
    heatPerSecond: 38,
    heatCapacity: 100,
    cooldownTime: 4.0,
    lockTime: 1.5,
    power: 28,
    cpu: 18,
    hitArc: 22.5,
    baseAccuracy: 0.72,
    tracking: 28,
    weaponType: 'laser',
    weight: 4.0,
  },
  L: {
    damagePerTick: 22,
    damageType: 'thermal',
    fireRate: 12,
    optimalRange: 450,
    falloffRange: 700,
    heatPerSecond: 52,
    heatCapacity: 100,
    cooldownTime: 4.5,
    lockTime: 2.0,
    power: 45,
    cpu: 28,
    hitArc: 22.5,
    baseAccuracy: 0.72,
    tracking: 32,
    weaponType: 'laser',
    weight: 5.0,
  },
};

export const FLUX_RARITY_MODS = {
  common: { dmg: 1.0, range: 1.0, heatEff: 0 },
  uncommon: { dmg: 1.10, range: 1.05, heatEff: 0.10 },
  rare: { dmg: 1.20, range: 1.10, heatEff: 0.20 },
  epic: { dmg: 1.35, range: 1.15, heatEff: 0.30 },
  legendary: { dmg: 1.50, range: 1.20, heatEff: 0.40 },
};

export const PULSE_CANNON_BASE = {
  S: {
    damage: 64,
    reload: 1.1,
    fireRate: 4.0,
    magazine: 10,
    optimalRange: 400,
    tracking: 22,
    baseAccuracy: 0.70,
    projectileSpeed: 4.8,
    power: 12,
    cpu: 10,
    lockTime: 0.5,
    weaponType: 'cannon',
    weight: 3.0,
  },
  M: {
    damage: 82,
    reload: 1.2,
    fireRate: 3.4,
    magazine: 10,
    optimalRange: 500,
    tracking: 21,
    baseAccuracy: 0.70,
    projectileSpeed: 4.2,
    power: 25,
    cpu: 16,
    lockTime: 0.5,
    weaponType: 'cannon',
    weight: 4.0,
  },
  L: {
    damage: 101,
    reload: 1.3,
    fireRate: 3.0,
    magazine: 8,
    optimalRange: 650,
    tracking: 20,
    baseAccuracy: 0.70,
    projectileSpeed: 3.6,
    power: 42,
    cpu: 24,
    lockTime: 0.7,
    weaponType: 'cannon',
    weight: 5.0,
  },
};

export const PULSE_RARITY_MODS = {
  common: { dmg: 1.0, acc: 0, reload: 1.0 },
  uncommon: { dmg: 1.10, acc: 0.05, reload: 0.95 },
  rare: { dmg: 1.20, acc: 0.10, reload: 0.90 },
  epic: { dmg: 1.35, acc: 0.12, reload: 0.85 },
  legendary: { dmg: 1.50, acc: 0.20, reload: 0.80 },
};

export const MISSILE_BASE = {
  S: {
    damage: 180,
    reload: 3.0,
    optimalRange: 700,
    aoeRadius: 40,
    tracking: 24,
    missileSpeed: 9.0,
    flightTime: 2.0,
    power: 14,
    cpu: 18,
    damageType: 'blast',
    baseAccuracy: 0.85,
    weight: 3.0,
  },
  M: {
    damage: 240,
    reload: 3.5,
    optimalRange: 900,
    aoeRadius: 55,
    tracking: 26,
    missileSpeed: 9.75,
    flightTime: 2.5,
    power: 32,
    cpu: 22,
    damageType: 'blast',
    baseAccuracy: 0.85,
    weight: 4.0,
  },
  L: {
    damage: 330,
    reload: 4.0,
    optimalRange: 1200,
    aoeRadius: 75,
    tracking: 28,
    missileSpeed: 10.5,
    flightTime: 3.0,
    power: 55,
    cpu: 32,
    damageType: 'blast',
    baseAccuracy: 0.85,
    weight: 5.0,
  },
};

export const MISSILE_RARITY_MODS = {
  common: { dmg: 1.0, speed: 1.0, reload: 1.0, tracking: 1.0, aoe: 1.0 },
  uncommon: { dmg: 1.05, speed: 1.05, reload: 1.0, tracking: 1.0, aoe: 1.0 },
  rare: { dmg: 1.10, speed: 1.10, reload: 0.95, tracking: 1.0, aoe: 1.0 },
  epic: { dmg: 1.15, speed: 1.15, reload: 0.90, tracking: 1.10, aoe: 1.0 },
  legendary: { dmg: 1.20, speed: 1.20, reload: 0.85, tracking: 1.15, aoe: 1.10 },
};

export const MINING_LASER_BASE = {
  S: {
    power: 10,
    cpu: 14,
    falloffRange: 400,
    baseExtraction: 1.0,
    fireRate: 1.0,
    hitArc: 45,
    weaponType: 'mining',
    weight: 3.0,
  },
  M: {
    power: 18,
    cpu: 24,
    falloffRange: 500,
    baseExtraction: 1.5,
    fireRate: 1.5,
    hitArc: 45,
    weaponType: 'mining',
    weight: 4.0,
  },
  L: {
    power: 30,
    cpu: 36,
    falloffRange: 600,
    baseExtraction: 2.0,
    fireRate: 2.0,
    hitArc: 45,
    weaponType: 'mining',
    weight: 5.0,
  },
};

export const MINING_RARITY_MODS = {
  common: { extraction: 1.0, fireRate: 1.0, range: 1.0 },
  uncommon: { extraction: 1.10, fireRate: 1.05, range: 1.05 },
  rare: { extraction: 1.20, fireRate: 1.10, range: 1.10 },
  epic: { extraction: 1.35, fireRate: 1.12, range: 1.15 },
  legendary: { extraction: 1.50, fireRate: 1.20, range: 1.20 },
};