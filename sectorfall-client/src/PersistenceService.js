/**
 * PersistenceService / Sync Layer
 * Keeps React state <-> GameManager engine state in sync
 * without spreading assignments throughout App.js.
 *
 * NOTE: This is client-side sync only. Authoritative persistence remains in CloudService / EC2.
 */

export function syncGameStateToEngine(gameManager, gameState) {
  if (!gameManager || !gameState) return;

  // Core gameplay state mirrored into the engine
  gameManager.inventory = gameState.inventory || [];
  gameManager.fittings = gameState.fittings || {};
  gameManager.activeWeapons = gameState.activeWeapons || [];
  gameManager.commanderImplants = gameState.commanderImplants || {};
  gameManager.regionalStorage = gameState.regionalStorage || {};
  gameManager.globalMarkets = gameState.globalMarkets || {};
  gameManager.courierContracts = gameState.courierContracts || [];
  gameManager.factionStandings = gameState.factionStandings || {};

  // Cargo stats (used by capacity checks & HUD)
  if (gameManager.stats) {
    gameManager.stats.currentCargoWeight = gameState.currentCargoWeight || 0;
    gameManager.stats.currentCargoVolume = gameState.currentCargoVolume || 0;
    gameManager.stats.cargoHold = gameState.cargoHold || gameManager.stats.cargoHold || 60;
  }

  // Engine-side HUD refresh (fixes: cargo not showing after refresh until next pickup)
  if (typeof window !== "undefined" && window.HUD?.updateCargo) {
    window.HUD.updateCargo(gameManager.inventory);
  }
}