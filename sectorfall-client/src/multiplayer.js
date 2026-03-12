import { uuid } from "./utils/id.js";

const UPDATE_RATE = 100;
const DB_UPDATE_RATE = 5000;
export const ROOM_ID = "global_room";

// Legacy Supabase multiplayer transport is intentionally disabled.
// Live movement/combat replication now runs through the EC2 websocket backend.
// Leaving this enabled causes very high Supabase Realtime usage because it
// publishes frequent broadcast events and subscribes to hot tables.
export const multiplayerEnabled = false;

let game = null;
let localPlayerId = null;
let syncInterval = null;
let channel = null;
let channelStatus = 'CLOSED';
let supabaseClient = null;

export async function initMultiplayer(gameRef, supabase, forcePlayerId = null) {
    if (!multiplayerEnabled) return;

    // If already initialized, we just want to ensure we're in the right system
    if (game && supabaseClient) {
        return switchSystem(game.currentSystemId);
    }

    game = gameRef;
    supabaseClient = supabase;
    localPlayerId = forcePlayerId || localPlayerId || uuid();

    await switchSystem(game.currentSystemId || 'cygnus-prime');

    if (!syncInterval) {
        syncInterval = setInterval(() => {
            if (channelStatus === 'SUBSCRIBED') {
                sendLocalUpdate();
                sendShipUpdate();
            }
        }, UPDATE_RATE);
    }
}

export async function switchSystem(systemId) {
    if (!multiplayerEnabled || !supabaseClient) return;

    // Cleanup old channel if it exists
    if (channel) {
        console.log(`[Multiplayer] Leaving sector: ${channel.topic}`);
        channelStatus = 'CLOSED';
        await channel.unsubscribe();
        channel = null;
    }

    // ... (rest of cleanup logic) ...
    if (game) {
        if (game.remotePlayers) {
            game.remotePlayers.forEach(player => {
                if (player.sprite) game.scene.remove(player.sprite);
                if (player.nameSprite) game.scene.remove(player.nameSprite);
                if (player.shieldMesh) game.scene.remove(player.shieldMesh);
            });
            game.remotePlayers.clear();
        }
        
        if (game.lootObjects) {
            game.lootObjects.forEach(loot => {
                if (loot.destroy) loot.destroy();
            });
            game.lootObjects = [];
        }
    }

    channel = supabaseClient.channel(`sector_${systemId}`); // Unique channel per system
    
    channel
    .on(
        "broadcast",
// ... (rest of the .on calls) ...

        { event: "player_update" },
        (payload) => handleRemoteUpdate(payload.payload)
    )
    .on(
        "broadcast",
        { event: "ship_update" },
        (payload) => handleRemoteShipUpdate(payload.payload)
    )
    .on(
        "broadcast",
        { event: "fire_item" },
        (payload) => game?.onRemoteFireItem?.(payload.payload)
    )
    .on(
        "broadcast",
        { event: "fx_trigger" },
        (payload) => game?.onRemoteFxTrigger?.(payload.payload)
    )
    .on(
        "broadcast",
        { event: "drone_launch" },
        (payload) => game?.onRemoteDroneLaunch?.(payload.payload)
    )
    .on(
        "broadcast",
        { event: "drone_attack" },
        (payload) => game?.onRemoteDroneAttack?.(payload.payload)
    )
    .on(
        "broadcast",
        { event: "drone_return" },
        (payload) => game?.onRemoteDroneReturn?.(payload.payload)
    )
    .on(
        "broadcast",
        { event: "object_removed" },
        (payload) => {
            const { object_id, player_id } = payload.payload;
            if (player_id === localPlayerId) return;
            if (game.onNetworkObjectRemoved) {
                game.onNetworkObjectRemoved(object_id);
            }
        }
    )
    .on(
        "postgres_changes",
        {
            event: "*",
            schema: "public",
            table: "ship_states_v2"
        },
        (payload) => {
            // Explicitly ignore our own records from DB updates
            const newRecord = payload.new;
            if (newRecord && newRecord.player_id === localPlayerId) return;
            handleShipUpdate(payload);
        }
    )
    .on(
        "postgres_changes",
        {
            event: "*",
            schema: "public",
            table: "world_objects"
        },
        (payload) => {
            handleWorldObjectChange(payload);
        }
    );

    channel.subscribe((status) => {
        channelStatus = status;
        if (status === 'SUBSCRIBED') {
            console.log(`[Multiplayer] Entered sector: ${systemId}`);
            // Send an immediate update to announce presence in new system
            sendLocalUpdate();
            sendShipUpdate();
        }
    });
}

export function disconnectMultiplayer() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    if (channel) {
        channel.unsubscribe();
        channel = null;
    }
    game = null;
}

function sendLocalUpdate() {
    if (!game?.player || !channel) return;

    channel.send({
        type: "broadcast",
        event: "player_update",
        payload: {
            player_id: localPlayerId,
            name: game.commanderName || "COMMANDER",
            portrait_url: game.portraitUrl || 'https://rosebud.ai/assets/captain-portrait.png.webp?eV4E',
            ship_type: game.ship.type,
            x: game.player.x,
            y: game.player.y,
            rot: game.player.rot,
            timestamp: Date.now()
        }
    });
}

function sendShipUpdate() {
    // Only send updates if the ship and its telemetry are ready
    if (!game?.ship?.sprite || !game.stats || game.ship.type === 'PENDING' || !channel) return;

    const animationState = game.getAnimationState ? game.getAnimationState() : {};
    const visualConfig = game.getVisualConfig ? game.getVisualConfig() : {};

    channel.send({
        type: "broadcast",
        event: "ship_update",
        payload: {
            player_id: localPlayerId,
            ship_id: game.ship.id || localPlayerId,
            system_id: game.currentSystemId,
            ship_type: game.ship.type,
            name: game.commanderName || "COMMANDER",
            portrait_url: game.portraitUrl || 'https://rosebud.ai/assets/captain-portrait.png.webp?eV4E',
            x: game.ship.sprite.position.x,
            y: game.ship.sprite.position.y,
            rot: game.ship.rotation,
            vx: game.ship.velocity.x,
            vy: game.ship.velocity.y,
            hp: game.stats.hp,
            maxHp: game.stats.maxHp,
            shields: game.stats.shields,
            maxShields: game.stats.maxShields,
            energy: game.stats.energy,
            maxEnergy: game.stats.maxEnergy,
            fittings: game.gameState?.fittings || {},
            activeWeapons: game.activeWeapons || {},
            animation_state: animationState,
            visual_config: visualConfig,
            timestamp: Date.now()
        }
    });
}

export function broadcastFxEvent(event, payload) {
    if (!channel) return;
    channel.send({
        type: "broadcast",
        event: event,
        payload: {
            ...payload,
            player_id: localPlayerId,
            timestamp: Date.now()
        }
    });
}

export function broadcastObjectRemoval(objectId) {
    if (!channel) return;
    channel.send({
        type: "broadcast",
        event: "object_removed",
        payload: {
            object_id: objectId,
            player_id: localPlayerId,
            timestamp: Date.now()
        }
    });
}

function handleRemoteUpdate(state) {
    if (!state || state.player_id === localPlayerId) return;
    if (game.spawnOrUpdateRemotePlayer) {
        // Map player_id to id for GameManager internal consumption if needed
        const mappedState = { ...state, id: state.player_id };
        game.spawnOrUpdateRemotePlayer(mappedState);
    }
}

function handleRemoteShipUpdate(state) {
    if (!state || state.player_id === localPlayerId) return;
    if (game.updateRemoteShip) {
        // Map player_id to id for GameManager internal consumption if needed
        const mappedState = { ...state, id: state.player_id };
        game.updateRemoteShip(mappedState);
    }
}

function handleShipUpdate(payload) {
    const { eventType, new: newRecord } = payload;
    
    // We only care about updates/inserts for position tracking
    if (eventType === "DELETE") return;
    if (!newRecord || newRecord.player_id === localPlayerId) return;

    const mappedState = mapDbToBroadcastFormat(newRecord);
    
    // If the player isn't in our local tracking yet, spawn them
    if (!game.remotePlayers.has(mappedState.player_id)) {
        game.spawnRemoteShip(mappedState.player_id, mappedState.ship_type, mappedState.x, mappedState.y, mappedState.rot);
    }
    
    // Standard ship update logic
    if (game.updateRemoteShip) {
        game.updateRemoteShip({ ...mappedState, id: mappedState.player_id });
    }
}

function handleWorldObjectChange(payload) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === "INSERT") {
        if (game.onNetworkObjectSpawned) {
            game.onNetworkObjectSpawned(newRecord);
        }
    } else if (eventType === "DELETE") {
        if (game.onNetworkObjectRemoved) {
            // Standardize ID access (object_id)
            game.onNetworkObjectRemoved(oldRecord.object_id || oldRecord.id);
        }
    } else if (eventType === "UPDATE") {
        if (newRecord.destroyed && game.onNetworkObjectRemoved) {
            game.onNetworkObjectRemoved(newRecord.object_id || newRecord.id);
        }
    }
}

function mapDbToBroadcastFormat(dbState) {
    const tel = dbState.telemetry || {};
    const gameState = tel.gameState || dbState.game_state || {};
    return {
        player_id: dbState.player_id,
        ship_id: dbState.ship_id || dbState.player_id,
        system_id: dbState.system_id,
        name: dbState.commander_name || tel.name || "COMMANDER",
        ship_type: dbState.ship_type || tel.ship_type || "OMNI SCOUT",
        x: dbState.x || tel.x || 0,
        y: dbState.y || tel.y || 0,
        rot: dbState.rot || tel.rot || 0,
        vx: tel.vx || 0,
        vy: tel.vy || 0,
        hp: tel.hp || 100,
        maxHp: tel.maxHp || 100,
        shields: tel.shields || 100,
        maxShields: tel.maxShields || 100,
        energy: tel.energy || 100,
        maxEnergy: tel.maxEnergy || 100,
        fittings: gameState.fittings || tel.fittings || {},
        activeWeapons: tel.activeWeapons || {},
        animation_state: dbState.animation_state || {},
        visual_config: dbState.visual_config || {},
        timestamp: Date.now()
    };
}