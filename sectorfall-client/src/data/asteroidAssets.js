/**
 * asteroidAssets.js
 * Asset URL(s) for asteroid textures/sprites.
 *
 * IMPORTANT:
 * - GameManager expects a URL string for THREE.TextureLoader.loadAsync().
 * - You may also export a map (common/rare/etc). GameManager will pick `.common`,
 *   then `.default`, then the first value.
 */

export const ASTEROID_URL =
  // Set this to the actual path of your asteroid texture in Rosebud:
  // Example: "./assets/textures/asteroids.png"
"https://rosebud.ai/assets/asteroid-01.png.webp?iIxE";
// Optional: if you have multiple variants, you can switch ASTEROID_URL to this map instead:
// export const ASTEROID_URL = {
//   common: "./assets/asteroids/common.png",
//   rare: "./assets/asteroids/rare.png",
// };