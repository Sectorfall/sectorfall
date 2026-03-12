/**
 * assets.js
 * Centralized asset URL registry (Rosebud CDN).
 * All visual-only assets live here.
 */

export const ASSETS = {
  // Background
  background: "/assets/space-background.jpg.webp",

  // Celestial
  sun: "/assets/fiery-star-core.png.webp",
  planetRingedGold: "/assets/planet-ringed-gold.png.webp",

  // Nebulae
  // NOTE: `nebulaByType` is what the engine uses for color selection.
  // `nebulae` remains as a flat list for any legacy callers.
  nebulaByType: {
    blue: [
      "/assets/nebula-blue-v2.webp",
      "/assets/nebula-blue-cloud.webp",
    ],
    gold: [
      "/assets/nebula-gold-v2.webp",
      "/assets/nebula-gold-v3.webp",
    ],
    purple: [
      "/assets/nebula-purple-cloud.webp",
    ],
  },
  nebulae: [
    "/assets/nebula-blue-v2.webp",
    "/assets/nebula-gold-v2.webp",
    "/assets/nebula-gold-v3.webp",
    "/assets/nebula-blue-cloud.webp",
    "/assets/nebula-purple-cloud.webp",
  ],

  // POIs
  anomaly: "/assets/cosmic-anomaly-poi.webp",
  warpGateRing: "/assets/warp-gate-ring.webp.webp",

  // Stations (interiors)
  starportHangar: "/assets/massive-starport-hangar.webp.webp",
  starportInteriorDollhouse: "/assets/starport-interior-dollhouse.png.webp",

  // Asteroid
  asteroid: "/assets/asteroid-01.png.webp",

  // Weapon textures
  weapons: {
    whiteflux: "/assets/whiteflux.png",
  },

  // Lens flares
  flareGhostRing: "/assets/flare-ghost-ring.webp",
  flareGhostHex: "/assets/flare-ghost-hex.webp",
};

export const AUDIO_URLS = {
  backgroundMusic: "/assets/background.wav",
  welcomeCygnus: "/assets/welcometocygnus.mp3",
  arenaMusic: "/assets/Arena.mp3",
  battlegroundMusic: "/assets/Arena.mp3",
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
  omni: "/assets/federation-starport-station.webp",
  cartel: "/assets/cbase.png",
  industrial: "/assets/starportindust.png",
};
export const NEBULA_LIST = ASSETS.nebulae;

export const STRUCTURE_URLS = {
  arenaBeacon: "/assets/omniportal2.png",
  battlegroundBeacon: "/assets/omniportal2.png",
};