import { WorldObjects } from "./worldObjects.js";

export let worldCache = [];

export const WorldManager = {
	async initialize(type) {
		if (!type) {
			console.warn("[WORLD] Initialize called without a type filter");
			return;
		}
    	worldCache = await WorldObjects.getByType(type);
    	console.log(`[WORLD] Loaded objects for type ${type}:`, worldCache.length);
	},

	getObjects() {
    	return worldCache;
	}
};
