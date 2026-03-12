// InventoryService.js
import { broadcastObjectRemoval } from "./multiplayer.js";
import { calcCargoWeight } from "./LootRules.js";

/**
 * Helpers to apply authoritative inventory updates to GameManager state.
 * Keeps GameManager slimmer and prevents future regressions.
 */
export function applyAuthoritativeInventory(gameManager, updatedInventory) {
  const totalWeight = calcCargoWeight(updatedInventory);

  gameManager.stats.currentCargoWeight = totalWeight;
  gameManager.inventory = updatedInventory;

  gameManager.setGameState(prev => ({
    ...prev,
    inventory: updatedInventory,
    currentCargoWeight: totalWeight
  }));

  if (typeof window !== "undefined" && window.HUD?.updateCargo) {
    window.HUD.updateCargo(updatedInventory);
  }

  return totalWeight;
}

export function broadcastLootRemoval(objectId) {
  broadcastObjectRemoval(objectId);
}

/**
 * Reuses your existing "batched toast" behavior from GameManager.
 */
export function queueLootToast(gameManager, itemData) {
  const itemName = (itemData?.name || "LOOT").toUpperCase();
  gameManager.pendingLoot.set(itemName, (gameManager.pendingLoot.get(itemName) || 0) + 1);

  if (gameManager.lootBatchTimer) clearTimeout(gameManager.lootBatchTimer);

  gameManager.lootBatchTimer = setTimeout(() => {
    if (typeof window !== "undefined" && window.HUD?.showToast) {
      gameManager.pendingLoot.forEach((count, name) => {
        window.HUD.showToast(`+${count} ${name}`);
      });
    }
    gameManager.pendingLoot.clear();
  }, 650);
}