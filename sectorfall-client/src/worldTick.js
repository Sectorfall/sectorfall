import { WorldObjects } from "./worldObjects.js";
import { secondsFromNow } from "./utils/time.js";

export async function runWorldTick(type) {
	if (!type) {
		console.warn("[WorldTick] runWorldTick called without a type filter");
		return;
	}
	const objects = await WorldObjects.getByType(type);

	for (const obj of objects) {
    	if (obj.hp <= 0 && obj.respawn_at && new Date(obj.respawn_at) < new Date()) {
        	obj.hp = obj.max_hp || 100;
        	obj.respawn_at = null;
        	await WorldObjects.save(obj);
    	}
	}
}
