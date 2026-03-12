import { PlayerManager } from "./playerManager.js";
export { ITEM_CATALOG } from "./data/items/catalog.js";
export { ITEMS, getItemDef, getItemTemplate } from "./data/items/items.registry.js";
export { STARTER_LOADOUTS, getStarterItemIds } from "./data/items/starterLoadouts.js";
export { STARTER_LOADOUTS_V2, getStarterLoadout } from "./data/items/starters.js";

export const InventorySystem = {
	async addItem(player, itemId, amount) {
    	player.cargo = player.cargo || {};
    	player.cargo[itemId] = (player.cargo[itemId] || 0) + amount;
    	await PlayerManager.savePlayer(player);
	},

	async removeItem(player, itemId, amount) {
    	if (!player.cargo?.[itemId]) return;
    	player.cargo[itemId] -= amount;
    	if (player.cargo[itemId] <= 0) delete player.cargo[itemId];
    	await PlayerManager.savePlayer(player);
	}
};