import { supabase as anonSupabase } from './supabaseClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { nowISO } from "./utils/time.js";

// Use administrative client if available
const supabase = supabaseAdmin || anonSupabase;


export const WorldObjects = {
	async getById(objectId) {
		if (!objectId || objectId === 'undefined') {
			console.warn("[WorldObjects] getById called with invalid objectId:", objectId);
			return null;
		}
		const { data, error } = await supabase
			.from("world_objects")
			.select("object_id, type, x, y, rot, data, updated_at, respawn_at, hp")
			.eq("object_id", objectId)
			.maybeSingle();

		if (error) {
			console.error("[WorldObjects] Error fetching object by id:", objectId, error.message);
			return null;
		}
		return data;
	},

	async getByType(type) {
		if (!type) {
			console.warn("[WorldObjects] getByType called without type");
			return [];
		}
		const { data, error } = await supabase
			.from("world_objects")
			.select("object_id, type, x, y, rot, data, updated_at, respawn_at, hp")
			.eq("type", type);

		if (error) {
			console.error("[WorldObjects] Error fetching objects by type:", type, error.message);
			return [];
		}
		return data || [];
	},

    sanitize(obj) {
        if (!obj) return null;
        const sanitized = { ...obj };
        
        // Ensure coordinates are finite numbers
        sanitized.x = isFinite(sanitized.x) ? Number(Number(sanitized.x).toFixed(2)) : 0;
        sanitized.y = isFinite(sanitized.y) ? Number(Number(sanitized.y).toFixed(2)) : 0;
        sanitized.rot = isFinite(sanitized.rot) ? Number(Number(sanitized.rot).toFixed(2)) : 0;
        
        // Ensure data is a valid object (mapping from payload if needed)
        const rawData = sanitized.data || sanitized.data_json || sanitized.payload;
        if (rawData === undefined || rawData === null) {
            sanitized.data = {};
        } else if (typeof rawData !== 'object') {
            sanitized.data = { value: rawData };
        } else {
            sanitized.data = rawData;
        }
        
        // Remove legacy fields
        delete sanitized.id;
        delete sanitized.data_json;
        delete sanitized.payload;
        delete sanitized.system_id;
        delete sanitized.created_at;
        delete sanitized.created_by;
        
        // Ensure type is a valid string
        sanitized.type = String(sanitized.type || 'unknown');
        
        // HP sanitization
        if ('hp' in sanitized) sanitized.hp = isFinite(sanitized.hp) ? Math.max(0, Number(sanitized.hp)) : 0;
        
        return sanitized;
    },

	async save(obj) {
		if (!obj || (!obj.object_id && !obj.id)) {
			console.error("[WorldObjects] Cannot save object without object_id");
			return;
		}
		
        const sanitized = this.sanitize(obj);
        // Map id to object_id if it's coming from a legacy source
        if (!sanitized.object_id && obj.id) sanitized.object_id = obj.id;

		sanitized.updated_at = nowISO();
        
		await supabase
			.from("world_objects")
			.upsert(sanitized);
	},

	async markDestroyed(objectId, respawnTime) {
		if (!objectId || objectId === 'undefined') {
			console.warn("[WorldObjects] markDestroyed called with invalid objectId:", objectId);
			return;
		}
    	await supabase
        	.from("world_objects")
        	.update({
            	respawn_at: respawnTime,
                hp: 0
        	})
        	.eq("object_id", objectId);
	}
};
