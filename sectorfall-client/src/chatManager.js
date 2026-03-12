import { supabase } from "./supabaseClient.js";
import { uuid } from "./utils/id.js";

/**
 * ChatManager
 * Handles persistent global world chat via Supabase. LEGACY DO NOT USE
 */
export const ChatManager = {
    /**
     * Inserts a new message into the world_chat table.
     * @param {string} playerId - The unique ID of the player sending the message.
     * @param {string} text - The content of the message.
     */
    async sendMessage(playerId, text) {
        if (!text || text.trim() === "") return;

        const { error } = await supabase
            .from("world_chat")
            .insert({
                id: uuid(),
                player_id: playerId,
                message: text,
                created_at: new Date().toISOString()
            })
            .select();
        
        if (error) {
            console.error("ChatManager: Error sending message:", error.message);
        }
    },

    /**
     * Subscribes to new messages in the world_chat table.
     * @param {function} callback - Function called when a new message is received.
     * @returns {object} The Supabase Realtime channel for cleanup.
     */
    subscribeToMessages(callback) {
        const channel = supabase
            .channel("world-chat")
            .on(
                "postgres_changes",
                {
                    event: "INSERT",
                    schema: "public",
                    table: "world_chat"
                },
                (payload) => {
                    // Extract the new message row and pass to callback
                    if (payload.new && callback) {
                        callback(payload.new);
                    }
                }
            )
            .subscribe((status) => {
                if (status === "SUBSCRIBED") {
                    console.log("ChatManager: Successfully subscribed to world-chat channel.");
                }
            });

        return channel;
    }
};