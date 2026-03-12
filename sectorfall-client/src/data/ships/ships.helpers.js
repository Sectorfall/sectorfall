/**
 * ships.helpers.js
 *
 * Canonical ship hull helpers.
 */

import { getShipHull, normalizeShipId } from "./ships.registry.js";

export function createShipInstance(input, overrides = {}) {
  const hull = getShipHull(input);
  if (!hull) return null;

  const shipId = overrides.id || overrides.shipId || hull.ship_id;
  const type = normalizeShipId(input) || hull.ship_id;

  const baseStats = {
    hp: hull.hp,
    maxHp: hull.hp,
    energy: hull.baseEnergy,
    maxEnergy: hull.baseEnergy,
    armor: hull.armor ?? 0,
    turnSpeed: hull.turnSpeed ?? 0,
    maxSpeed: hull.speed ?? hull.maxSpeed ?? 0,
    kineticRes: hull.kineticRes ?? 0,
    thermalRes: hull.thermalRes ?? 0,
    blastRes: hull.blastRes ?? 0,
    baseSigRadius: hull.baseSigRadius ?? 0,
  };

  return {
    id: shipId,
    ship_id: type,
    type,
    name: overrides.name || hull.name,
    classId: overrides.classId || hull.classId || hull.name,
    isShip: true,
    hp: overrides.hp ?? hull.hp,
    maxHp: overrides.maxHp ?? hull.hp,
    energy: overrides.energy ?? hull.baseEnergy,
    maxEnergy: overrides.maxEnergy ?? hull.baseEnergy,
    shields: overrides.shields ?? 0,
    maxShields: overrides.maxShields ?? 0,
    armor: overrides.armor ?? hull.armor ?? 0,
    turnSpeed: overrides.turnSpeed ?? hull.turnSpeed ?? 0,
    maxSpeed: overrides.maxSpeed ?? hull.speed ?? hull.maxSpeed ?? 0,
    spriteUrl: overrides.spriteUrl || hull.spriteUrl || '',
    visualScale: overrides.visualScale ?? hull.visualScale ?? 64,
    collisionRadius: overrides.collisionRadius ?? hull.collisionRadius ?? 20,
    baseStats: { ...baseStats, ...(overrides.baseStats || {}) },
    fittings: { ...(hull.fittings || {}), ...(overrides.fittings || {}) },
    telemetry: overrides.telemetry || null,
    ...overrides,
  };
}