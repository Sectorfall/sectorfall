/**
 * assets.js
 * Centralized asset URL registry (Rosebud CDN).
 * All visual-only assets live here.
 */

export const ASSETS = {
  // Background
  background: "https://rosebud.ai/assets/space-background.jpg.webp?ntpv",

  // Celestial
  sun: "https://rosebud.ai/assets/fiery-star-core.png.webp?CQyw",
  planetRingedGold: "https://rosebud.ai/assets/planet-ringed-gold.png.webp?33fy",

  // Nebulae
  // NOTE: `nebulaByType` is what the engine uses for color selection.
  // `nebulae` remains as a flat list for any legacy callers.
  nebulaByType: {
    blue: [
      "https://rosebud.ai/assets/nebula-blue-v2.webp?CB9X",
      "https://rosebud.ai/assets/nebula-blue-cloud.webp?HwHn",
    ],
    gold: [
      "https://rosebud.ai/assets/nebula-gold-v2.webp?ezfX",
      "https://rosebud.ai/assets/nebula-gold-v3.webp?006k",
    ],
    purple: [
      "https://rosebud.ai/assets/nebula-purple-cloud.webp?HG0M",
    ],
  },
  nebulae: [
    "https://rosebud.ai/assets/nebula-blue-v2.webp?CB9X",
    "https://rosebud.ai/assets/nebula-gold-v2.webp?ezfX",
    "https://rosebud.ai/assets/nebula-gold-v3.webp?006k",
    "https://rosebud.ai/assets/nebula-blue-cloud.webp?HwHn",
    "https://rosebud.ai/assets/nebula-purple-cloud.webp?HG0M",
  ],

  // POIs
  anomaly: "https://rosebud.ai/assets/cosmic-anomaly-poi.webp?qwAP",
  warpGateRing: "https://rosebud.ai/assets/warp-gate-ring.webp.webp?X1Hc",

  // Stations (interiors)
  starportHangar: "https://rosebud.ai/assets/massive-starport-hangar.webp.webp?UBdB",
  starportInteriorDollhouse: "https://rosebud.ai/assets/starport-interior-dollhouse.png.webp?vicq",

  // Asteroid
  asteroid: "https://rosebud.ai/assets/asteroid-01.png.webp?iIxE",

  // Weapon textures
  weapons: {
    whiteflux: "https://rosebud.ai/assets/whiteflux.png?cAKq",
  },

  // Lens flares
  flareGhostRing: "https://rosebud.ai/assets/flare-ghost-ring.webp?qQ3W",
  flareGhostHex: "https://rosebud.ai/assets/flare-ghost-hex.webp?6rbE",
};

export const AUDIO_URLS = {
  backgroundMusic: "https://rosebud.ai/assets/background.wav?HAL8",
  welcomeCygnus: "https://rosebud.ai/assets/welcometocygnus.mp3?7tSS",
  arenaMusic: "https://rosebud.ai/assets/Arena.mp3?6wcH",
  battlegroundMusic: "https://rosebud.ai/assets/Arena.mp3?6wcH",
};

// Compatibility named exports
export const SUN_URL = ASSETS.sun;
export const ANOMALY_URL = ASSETS.anomaly;
export const ASTEROID_URL = ASSETS.asteroid;
export const NEBULA_URLS = ASSETS.nebulaByType;
export const WEAPON_ASSETS = ASSETS.weapons;
export const WARP_GATE_URL = ASSETS.warpGateRing;
export const PLANET_URLS = {
  planetRingedGold: ASSETS.planetRingedGold,
  ringedGold: ASSETS.planetRingedGold,
};

export const FLARE_URLS = {
  ring: ASSETS.flareGhostRing,
  hex: ASSETS.flareGhostHex,
};

// --- STARPORTS (multi-faction support) ---
export const STARPORT_URL = {
  omni: "https://rosebud.ai/assets/federation-starport-station.webp?aZ5h",
  cartel: "https://rosebud.ai/assets/cbase.png?WFmT",
  industrial: "https://rosebud.ai/assets/starportindust.png?r7K5",
};
export const NEBULA_LIST = ASSETS.nebulae;

export const STRUCTURE_URLS = {
  arenaBeacon: "https://rosebud.ai/assets/omniportal2.png?qKiO",
  battlegroundBeacon: "https://rosebud.ai/assets/omniportal2.png?qKiO",
};