/**
 * weaponAssets.js
 * Pure asset URL registry for weapon textures (client-side only).
 * Keep this separate from stats/config so data extraction doesn't mix shaders/assets into gameplay registries.
 *
 * NOTE: It's safe for this to be empty — the engine will just skip loading weapon textures.
 * Add entries as needed:
 *   export const WEAPON_ASSETS = { "flux_beam": "/assets/flux_beam.png" };
 */
export const WEAPON_ASSETS = {
  // Example:
  // "flux_beam": "/assets/flux_beam.png",
};