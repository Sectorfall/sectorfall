import { supabase as anonSupabase } from './supabaseClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';

// Use administrative client if available
const supabase = supabaseAdmin || anonSupabase;


export const ShipManager = {
	async getShipsForPlayer(playerId) {
    	const { data } = await supabase
        	.from("ships")
        	.select("*")
        	.eq("owner_id", playerId);
    	return data || [];
	},

	async saveShip(ship) {
    	await supabase
        	.from("ships")
        	.upsert(ship)
            .select();
	}
};
