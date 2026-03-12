/**
 * ships.registry.js
 *
 * Clean ship entrypoint. Hull templates remain in catalog.js; everything else
 * should import from here going forward.
 */

import {
  SHIP_CATALOG,
  SHIP_ID_ALIASES,
  resolveShipId,
  resolveShipTemplate,
  resolveShipRegistryKey
} from "./catalog.js";

export const SHIP_HULLS = SHIP_CATALOG;

export {
  SHIP_CATALOG,
  SHIP_ID_ALIASES,
  resolveShipId,
  resolveShipTemplate,
  resolveShipRegistryKey
};

export function normalizeShipId(input) {
  return resolveShipId(input) || null;
}

export function getShipHull(input) {
  return resolveShipTemplate(input) || null;
}

export function listShipIds() {
  return Object.keys(SHIP_HULLS);
}

/**
 * Legacy compatibility texture exports expected by src/shipRegistry.js
 */
export const OMNI_COMMAND_URL =
  SHIP_CATALOG?.ship_omni_command_t1?.spriteUrl || "";

export const OMNI_SCOUT_URL =
  SHIP_CATALOG?.ship_omni_scout_t1?.spriteUrl || "";

export const OMNI_GUNSHIP_URL =
  SHIP_CATALOG?.ship_omni_gunship_t1?.spriteUrl || "";

export const OMNI_HAULER_URL =
  SHIP_CATALOG?.ship_omni_hauler_t1?.spriteUrl || "";

export const OMNI_INTERCEPTOR_URL =
  SHIP_CATALOG?.ship_omni_interceptor_t1?.spriteUrl || "";

export const OMNI_MINING_SHIP_URL =
  SHIP_CATALOG?.ship_omni_mining_ship_t1?.spriteUrl || "";

export const SOVEREIGN_URL =
  SHIP_CATALOG?.ship_omni_sovereign_t1?.spriteUrl || "";

export const PIRATE_INTERCEPTOR_URL =
  SHIP_CATALOG?.ship_cartel_scout_t1?.spriteUrl || "";

export const PIRATE_GUNSHIP_URL =
  SHIP_CATALOG?.ship_cartel_gunship_t1?.spriteUrl || "";