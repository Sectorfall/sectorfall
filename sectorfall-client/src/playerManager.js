import { supabase as anonSupabase } from './supabaseClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';

// Use administrative client if available
const supabase = supabaseAdmin || anonSupabase;


export const PlayerManager = {
	async loadPlayer(playerId) {
        console.log("[PlayerManager] loadPlayer for:", playerId);
        if (!playerId) {
            console.warn("[PlayerManager] loadPlayer called with invalid playerId:", playerId);
            return null;
        }

    	const { data, error } = await supabase
        	.from("ship_states_v2")
        	.select("player_id, ship_type, telemetry, updated_at")
        	.eq("player_id", playerId)
        	.maybeSingle();

        if (error) {
            console.warn("[PlayerManager] Supabase load error:", error.message);
        }

    	return data ? { ...data, id: data.player_id } : null;
	},

	async savePlayer(player) {
        // Strictly only use columns verified to exist: player_id, ship_type, telemetry, updated_at
        // Removing game_state from root and nesting it in telemetry per schema constraints
    	await supabase
        	.from("ship_states_v2")
        	.upsert({
                player_id: player.player_id || player.id,
                ship_type: player.ship_type || player.telemetry?.shipType || player.telemetry?.ship_type,
                telemetry: {
                    ...(player.telemetry || {}),
                    gameState: player.game_state || {},
                    x: player.x,
                    y: player.y,
                    rot: player.rot,
                    commander_name: player.commander_name
                },
                updated_at: new Date().toISOString()
            });
	},

	async updatePosition(playerId, x, y, rot) {
        if (!playerId) return;
        // Removing implicit .select() to bypass RLS broad selection triggers
    	await supabase
        	.from("ship_states_v2")
        	.update({
            	telemetry: { x, y, rot },
            	updated_at: new Date().toISOString(),
        	})
        	.eq("player_id", playerId);
	}
};