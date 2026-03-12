// src/data/items/items.helpers.js
//
// Clean Items (Phase 1+) with Clean Stats (Phase 2):
// - createItemInstance() remains the single instantiation path
// - hydrateItem() now delegates stat resolution to src/data/stats/stats.helpers.js
//
// This file is intentionally defensive to preserve backward compatibility.

import { ITEMS } from "./items.registry.js";
import { resolveStatsForItem } from "../stats/stats.helpers.js";

export function createItemInstance(itemKey, { id = null, quality = 120, overrides = {} } = {}) {
  const def = ITEMS[itemKey];
  if (!def) throw new Error(`Unknown itemKey: ${itemKey}`);

  const instanceId =
    id ||
    (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `itm-${Math.random().toString(16).slice(2)}-${Date.now()}`);

  return {
    id: instanceId,
    itemKey,
    // Keep legacy compatibility fields commonly used across the codebase
    item_id: def.item_id ?? itemKey,
    name: def.name,
    type: def.type,
    subtype: def.subtype,
    size: def.size,
    weaponsize: def.weaponsize,
    rarity: def.rarity,
    quality,
    stack: def.stack ?? 1,
    maxStack: def.maxStack ?? 1,
    metadata: def.metadata ? { ...def.metadata } : {},
    description: def.description ?? "",
    weight: def.weight ?? 0,
    volume: def.volume ?? 0,
    ...overrides,
  };
}

/**
 * Attempts to infer an output template id from a blueprint-like object.
 * Kept for compatibility; Phase 4 removes the need for this entirely.
 */
export function deriveItemIdFromBlueprint(blueprintData = {}) {
  const outputItemId = blueprintData.outputItemId || blueprintData.outputItemKey;
  if (outputItemId) return outputItemId;

  const outType = (blueprintData.outputType || "").toLowerCase();
  const outId = (blueprintData.outputId || blueprintData.outputName || "").toLowerCase();
  const rarity = (blueprintData.rarity || parseRarityFromString(outId) || "common").toLowerCase();
  const size = blueprintData.weaponsize || blueprintData.size || parseSizeFromString(outId) || "S";

  // Heuristic mapping to your catalog conventions
  if (outType === "shield" || outId.includes("shield")) return `${sizeToWord(size)}-${rarity}-shield-array`;
  if (outType === "thruster" || outId.includes("thruster")) return `${sizeToWord(size)}-${rarity}-ion-thruster`;
  if (outType === "weapon" || outId.includes("laser") || outId.includes("cannon") || outId.includes("seeker")) {
    if (outId.includes("flux")) return `${sizeToWord(size)}-${rarity}-flux-laser`;
    if (outId.includes("pulse")) return `${sizeToWord(size)}-${rarity}-pulse-cannon`;
    if (outId.includes("seeker") || outId.includes("missile")) return `${sizeToWord(size)}-${rarity}-seeker-pod`;
    if (outId.includes("mining")) return `${sizeToWord(size)}-${rarity}-mining-laser`;
  }
  if (outType === "drone-module" || outId.includes("drone module")) {
    // default combat if not specified
    const role = outId.includes("mining") ? "mining" : outId.includes("repair") ? "repair" : "combat";
    return `${sizeToWord(size)}-${rarity}-${role}-drone-module`;
  }

  return null;
}

function parseRarityFromString(s = "") {
  const lower = (s || "").toLowerCase();
  for (const r of ["legendary", "epic", "rare", "uncommon", "common"]) {
    if (lower.includes(r)) return r;
  }
  return null;
}

function parseSizeFromString(s = "") {
  const lower = (s || "").toLowerCase();
  if (lower.includes("small") || lower.includes(" s ")) return "S";
  if (lower.includes("medium") || lower.includes(" m ")) return "M";
  if (lower.includes("large") || lower.includes(" l ")) return "L";
  return null;
}

function sizeToWord(size) {
  if (size === "S") return "small";
  if (size === "M") return "medium";
  if (size === "L") return "large";
  return "small";
}

/**
 * Hydration step: attaches computed `stats` if resolvable.
 * This does NOT delete existing stats; it only fills missing ones.
 */
export function hydrateItem(instance) {
  if (!instance || typeof instance !== "object") return instance;

  // If stats already exist, don't overwrite (preserves crafted mods, etc.)
  if (!instance.stats) {
    const stats = resolveStatsForItem(instance);
    if (stats) instance.stats = stats;
  }

  return instance;
}