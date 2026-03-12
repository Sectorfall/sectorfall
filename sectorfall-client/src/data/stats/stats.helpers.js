// src/data/stats/stats.helpers.js
//
// Phase 2 (Clean Stats): one canonical stat resolution path.
// - Pure functions
// - No imports from GameManager (avoids circular deps)
// - Uses the Phase 1 stat tables via the compatibility exports
//
// NOTE: This is intentionally defensive and will return null if it
// cannot confidently resolve stats for an item.

import {
  FLUX_LASER_CONFIGS,
  FLUX_RARITY_MODS,
  PULSE_CANNON_CONFIGS,
  PULSE_RARITY_MODS,
  MISSILE_CONFIGS,
  MISSILE_RARITY_MODS,
  MINING_LASER_CONFIGS,
  MINING_RARITY_MODS,
  DRONE_MODULE_CONFIGS,
  DRONE_STATS
} from "../weaponConfigs.js";

import { ION_THRUSTER_CONFIGS, SHIELD_MODULE_CONFIGS } from "../modules.js";

const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

export function parseRarityFromId(id) {
  if (!id || typeof id !== "string") return null;
  const lower = id.toLowerCase();
  for (const r of RARITIES) {
    if (lower.includes(`-${r}-`) || lower.endsWith(`-${r}`) || lower.includes(`_${r}_`) || lower.includes(`.${r}.`)) {
      return r;
    }
  }
  return null;
}

export function scaleStatsByQuality(baseStats, quality) {
  if (!baseStats || typeof baseStats !== "object") return baseStats;
  // Sectorfall baseline: 120 = "neutral"
  const q = typeof quality === "number" && isFinite(quality) ? quality : 120;
  const mult = q / 120;

  const out = Array.isArray(baseStats) ? [...baseStats] : { ...baseStats };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "number" && isFinite(v)) out[k] = v * mult;
  }
  return out;
}

function pickSize(item) {
  return item?.size || item?.weaponsize || item?.weaponSize || item?.meta?.size || item?.metadata?.size || null;
}

function pickRarity(item) {
  return item?.rarity || parseRarityFromId(item?.itemKey || item?.item_id || item?.id || item?.name) || "common";
}

function looksLikeShield(item) {
  const t = (item?.type || "").toLowerCase();
  const n = (item?.name || "").toLowerCase();
  const st = (item?.subtype || "").toLowerCase();
  return t === "shield" || st.includes("shield") || n.includes("shield");
}

function looksLikeThruster(item) {
  const t = (item?.type || "").toLowerCase();
  const n = (item?.name || "").toLowerCase();
  const st = (item?.subtype || "").toLowerCase();
  return t === "thruster" || st.includes("thruster") || n.includes("thruster") || n.includes("ion thruster");
}

function weaponFamily(item) {
  const fam = (item?.family || item?.weaponFamily || item?.weaponType || item?.subtype || "").toLowerCase();
  const n = (item?.name || "").toLowerCase();

  if (fam.includes("flux") || n.includes("flux")) return "flux";
  if (fam.includes("pulse") || n.includes("pulse")) return "pulse";
  if (fam.includes("missile") || fam.includes("seeker") || n.includes("seeker") || n.includes("missile")) return "missile";
  if (fam.includes("mining") || n.includes("mining")) return "mining";
  return null;
}

function looksLikeDroneModule(item) {
  const t = (item?.type || "").toLowerCase();
  const st = (item?.subtype || "").toLowerCase();
  const n = (item?.name || "").toLowerCase();
  return t === "drone-module" || st.includes("drone") || n.includes("drone module");
}

/**
 * Resolve the *base* stats block for an item. Returns null if unknown.
 * Returned object is a new object (safe to mutate by caller).
 */
export function resolveBaseStatsForItem(item) {
  if (!item || typeof item !== "object") return null;

  const size = pickSize(item);
  const rarity = pickRarity(item);

  // Shields
  if (looksLikeShield(item)) {
    const base = size && SHIELD_MODULE_CONFIGS?.[size] ? SHIELD_MODULE_CONFIGS[size] : null;
    if (!base) return null;
    return { ...base, rarity };
  }

  // Thrusters
  if (looksLikeThruster(item)) {
    const base = size && ION_THRUSTER_CONFIGS?.[size] ? ION_THRUSTER_CONFIGS[size] : null;
    if (!base) return null;
    return { ...base, rarity };
  }

  // Drone modules (these are keyed by NAME in your tables)
  if (looksLikeDroneModule(item)) {
    const nameKey = item.name || item.outputId || item.outputItemId;
    const cfg = nameKey && DRONE_MODULE_CONFIGS?.[nameKey] ? DRONE_MODULE_CONFIGS[nameKey] : null;
    if (!cfg) return null;
    return { ...cfg, rarity };
  }

  // Weapons
  const fam = weaponFamily(item);
  if (fam && size) {
    if (fam === "flux") {
      const base = FLUX_LASER_CONFIGS?.[size];
      if (!base) return null;
      const mod = FLUX_RARITY_MODS?.[rarity] || { dmg: 1, heat: 1, range: 1, falloff: 1 };
      return applyWeaponRarityMod(base, mod, rarity);
    }
    if (fam === "pulse") {
      const base = PULSE_CANNON_CONFIGS?.[size];
      if (!base) return null;
      const mod = PULSE_RARITY_MODS?.[rarity] || { dmg: 1, heat: 1, range: 1, falloff: 1 };
      return applyWeaponRarityMod(base, mod, rarity);
    }
    if (fam === "missile") {
      const base = MISSILE_CONFIGS?.[size];
      if (!base) return null;
      const mod = MISSILE_RARITY_MODS?.[rarity] || { dmg: 1, heat: 1, range: 1, falloff: 1 };
      return applyWeaponRarityMod(base, mod, rarity);
    }
    if (fam === "mining") {
      const base = MINING_LASER_CONFIGS?.[size];
      if (!base) return null;
      const mod = MINING_RARITY_MODS?.[rarity] || { dmg: 1, heat: 1, range: 1, falloff: 1 };
      return applyWeaponRarityMod(base, mod, rarity);
    }
  }

  return null;
}

function applyWeaponRarityMod(base, mod, rarity) {
  // Try to handle a few common stat key shapes defensively.
  const out = { ...base, rarity };

  // Damage-ish
  if (typeof out.damage === "number") out.damage *= (mod.dmg ?? 1);
  if (typeof out.dps === "number") out.dps *= (mod.dmg ?? 1);

  // Heat-ish
  if (typeof out.heat === "number") out.heat *= (mod.heat ?? 1);
  if (typeof out.heatPerShot === "number") out.heatPerShot *= (mod.heat ?? 1);

  // Range-ish
  if (typeof out.optimalRange === "number") out.optimalRange *= (mod.range ?? 1);
  if (typeof out.falloffRange === "number") out.falloffRange *= (mod.falloff ?? 1);

  // Missile specific
  if (typeof out.explosionRadius === "number" && typeof mod.explosionRadius === "number") out.explosionRadius *= mod.explosionRadius;
  if (typeof out.speed === "number" && typeof mod.speed === "number") out.speed *= mod.speed;

  return out;
}

/**
 * Resolve final stats for an item instance.
 * Adds a `stats` object scaled by quality (120 baseline).
 */
export function resolveStatsForItem(item) {
  const base = resolveBaseStatsForItem(item);
  if (!base) return null;

  const quality = typeof item.quality === "number" ? item.quality : 120;
  return scaleStatsByQuality(base, quality);
}