/**
 * ownedShips.js
 *
 * Canonical player-owned ship record helpers.
 * Hangar records, commander_data.owned_ships, and active ship selection should
 * all normalize through this file.
 */

import { uuid } from "../../utils.js";
import { createShipInstance } from "./ships.helpers.js";
import { normalizeShipId, getShipHull } from "./ships.registry.js";

function cloneObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : { ...fallback };
}

export function normalizeOwnedShipRecord(record, options = {}) {
  if (!record) return null;

  const shipId = normalizeShipId(record.ship_id || record.type || record.shipType || record.classId || record.name)
    || options.fallbackShipId
    || null;
  if (!shipId) return null;

  const hull = getShipHull(shipId);
  if (!hull) return null;

  const id = record.id || record.owned_ship_id || record.shipInstanceId || uuid();
  const fitted = cloneObject(record.fittedModules || record.fittings || hull.fittings, hull.fittings || {});
  const cargo = Array.isArray(record.cargo) ? record.cargo.slice() : [];
  const telemetry = cloneObject(record.telemetry || {});

  return {
    owned_ship_id: id,
    id,
    ship_id: shipId,
    type: shipId,
    shipType: shipId,
    name: record.name || hull.name,
    classId: record.classId || hull.classId || hull.name,
    isShip: true,
    hp: record.hp ?? record.currentHullHp ?? hull.hp,
    maxHp: record.maxHp ?? hull.hp,
    energy: record.energy ?? hull.baseEnergy,
    maxEnergy: record.maxEnergy ?? hull.baseEnergy,
    shields: record.shields ?? 0,
    maxShields: record.maxShields ?? 0,
    fittings: fitted,
    fittedModules: fitted,
    cargo,
    telemetry,
    starport_id: record.starport_id || record.starportId || null,
    system_id: record.system_id || record.systemId || null,
    storedInHangar: Boolean(record.storedInHangar || options.storedInHangar),
    registryKey: hull.registryKey || null,
    hullTemplateId: shipId,
    quality: record.quality ?? 50,
    rarity: record.rarity || "common",
    modifiedStats: record.modifiedStats || null,
  };
}

export function normalizeOwnedShipFleet(records, options = {}) {
  const seen = new Set();
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizeOwnedShipRecord(record, options);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

export function createOwnedShipRecord(input, overrides = {}) {
  const base = createShipInstance(input, overrides);
  return normalizeOwnedShipRecord({ ...base, ...overrides });
}

export function createStarterOwnedShipRecord(input = "ship_omni_scout", overrides = {}) {
  return createOwnedShipRecord(input, {
    quality: 50,
    rarity: "common",
    ...overrides,
  });
}

export function shipConfigToOwnedShipRecord(shipConfig, extra = {}) {
  if (!shipConfig) return null;
  return normalizeOwnedShipRecord({ ...shipConfig, ...extra }, { storedInHangar: extra.storedInHangar });
}

export function buildCommanderShipManifest(records, activeShipId = null) {
  const ownedShips = normalizeOwnedShipFleet(records);
  const resolvedActiveShipId = activeShipId && ownedShips.some((ship) => ship.id === activeShipId)
    ? activeShipId
    : (ownedShips[0]?.id || null);

  return {
    owned_ships: ownedShips,
    active_ship_id: resolvedActiveShipId,
  };
}