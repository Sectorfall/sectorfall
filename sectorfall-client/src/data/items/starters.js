/**
 * starters.js
 *
 * Clean starter loadout structure:
 * - Use objects (with explicit quality) instead of raw string ids.
 * - Phase 1 uses itemKey === item_id.
 */

export const STARTER_LOADOUTS_V2 = {
  OMNI_SCOUT: [
    { itemKey: "small-common-mining-laser", quality: 120 },
    { itemKey: "small-common-flux-laser", quality: 120 },
    { itemKey: "small-common-pulse-cannon", quality: 120 },
    { itemKey: "small-common-seeker-pod", quality: 120 },
    { itemKey: "small-common-shield-array", quality: 50 },
  ],
};

export function getStarterLoadout(shipType) {
  const key = shipType || "OMNI_SCOUT";
  return STARTER_LOADOUTS_V2[key] || STARTER_LOADOUTS_V2.OMNI_SCOUT;
}