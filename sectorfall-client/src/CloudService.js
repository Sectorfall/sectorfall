/**
 * CloudService.js
 * Handles multiplayer synchronization and telemetry broadcasting.
 * Build Version: 1.0.3 - Ore Quality-Band Stacking Restored
 */

import { supabase as anonSupabase } from "./supabaseClient.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { uuid } from "./utils.js";
import { SHIP_REGISTRY } from "./shipRegistry.js";
import { resolveShipId, resolveShipRegistryKey } from "./data/ships/catalog.js";
import { ITEM_CATALOG } from "./data/items/catalog.js";
import { createItemInstance } from "./data/items/items.helpers.js";
import { getStarterLoadout } from "./data/items/starters.js";

// Use the administrative client if available, otherwise fallback to anon
const supabase = supabaseAdmin || anonSupabase;



// -----------------------------------------------------
// CLOUD SERVICE CONFIG
// -----------------------------------------------------
// Supabase Realtime broadcasts are great for chat/events, but NOT for high-frequency ship telemetry.
// Route realtime telemetry over AWS WebSocket instead.
const CLOUD_CONFIG = {
  enableSupabaseRealtimeTelemetry: false, // ✅ keep false for performance/cost
  enableAwsTelemetry: true,
  awsTelemetryMinIntervalMs: 50, // throttle client->AWS sends (20/s)
};
class CloudService {
  constructor() {
    console.log(
      `[CloudService] [BOOT] ITEM_CATALOG Registry Integrity Check: ${
        Object.keys(ITEM_CATALOG).length
      } definitions detected.`
    );
    this.user = null;
    this.STORAGE_KEY = "arc_space_flight_cloud_data";
    this.isSyncing = false;
    this.channel = null;
    this.onMessageCallback = null;

    // optional AWS WS bridge (only used if you wire it)
    this.awsSocket = null;
  

    // throttle for AWS telemetry (prevents sending on every render tick)
    this._lastAwsTelemetrySentAt = 0;
}

  /**
   * Initializes the multiplayer channel after auth is established.
   */
  initMultiplayerChannel() {
    if (this.channel) return;

    console.log(
      "[CloudService] Initializing multiplayer channel with authenticated session..."
    );
    this.channel = supabase.channel("arc_space_multiplayer", {
      config: {
        broadcast: { self: false },
      },
    });

    this.channel
      .on("broadcast", { event: "game_message" }, (payload) => {
        if (this.onMessageCallback) {
          this.onMessageCallback(payload.payload);
        }
      })
      .subscribe((status) => {
        console.log(`[CloudService] Multiplayer channel status: ${status}`);
      });
  }

  /**
   * Subscribes to network messages.
   */
  subscribe(callback) {
    this.onMessageCallback = callback;
  }

  /**
   * Broadcasts a chat message to the network.
   */
  broadcastChatMessage(content, channelName = "SYSTEM", systemId = null) {
    if (!this.user || !this.channel) return;
    this.channel.send({
      type: "broadcast",
      event: "game_message",
      payload: {
        type: "CHAT_MESSAGE",
        player_id: this.user.id,
        userName: this.user.name,
        channel: channelName,
        content,
        timestamp: Date.now(),
        systemId,
      },
    });
  }

  /**
   * Broadcasts the local player's telemetry to the network.
   */
  /**
   * Broadcasts the local player's telemetry to the network.
   *
   * IMPORTANT:
   * - Supabase Realtime is NOT used for high-frequency telemetry (position/vitals) by default.
   * - Realtime telemetry should go over AWS WebSocket (EC2) instead.
   */
  broadcastTelemetry(telemetry) {
    if (!this.user) return;

    // Optional: Supabase Realtime telemetry (keep OFF for performance/cost)
    if (this.channel && CLOUD_CONFIG.enableSupabaseRealtimeTelemetry) {
      this.channel.send({
        type: "broadcast",
        event: "game_message",
        payload: {
          type: "TELEMETRY",
          player_id: this.user.id,
          userName: this.user.name,
          ...telemetry,
        },
      });
    }

    // ✅ Primary realtime path: AWS WebSocket bridge
    if (CLOUD_CONFIG.enableAwsTelemetry) {
      this.sendTelemetryToAWS(telemetry);
    }
  }


  /**
   * Broadcasts a combat event (e.g. firing weapons).
   */
  broadcastCombatEvent(eventData) {
    if (!this.user || !this.channel) return;
    this.channel.send({
      type: "broadcast",
      event: "game_message",
      payload: {
        type: "COMBAT_EVENT",
        player_id: this.user.id,
        userName: this.user.name,
        ...eventData,
      },
    });
  }

  /**
   * Broadcasts a generic game event (fleet, sync, etc.)
   */
  broadcastGameEvent(eventData) {
    if (!this.user || !this.channel) return;
    this.channel.send({
      type: "broadcast",
      event: "game_message",
      payload: {
        player_id: this.user.id,
        userName: this.user.name,
        ...eventData,
      },
    });
  }

  async login(provider) {
    console.log(`[Supabase Multiplayer] Initializing ${provider} session...`);

    try {
      // 1. Check for existing session first to prevent ID regeneration
      const {
        data: { session },
      } = await supabase.auth.getSession();

      let authUser = session?.user;

      if (authUser) {
        console.log(
          `[Supabase Multiplayer] Restored existing session: ${authUser.id}`
        );
      } else {
        const { data, error } = await supabase.auth.signInAnonymously();
        if (error) throw error;
        authUser = data.user;
        console.log(
          `[Supabase Multiplayer] Created new anonymous session: ${authUser.id}`
        );
      }

      const newAuthId = authUser.id;

      this.user = {
        id: newAuthId,
        name:
          localStorage.getItem("arc_commander_name") ||
          `Commander_${newAuthId.substring(0, 4)}`,
        provider,
      };

      // 2. Ensure commander data exists
      await this.syncCommanderData(newAuthId);

      // 3. Initialize multiplayer channel
      this.initMultiplayerChannel();
    } catch (err) {
      console.warn(
        "Supabase auth sequence failed, using fresh guest identity:",
        err.message
      );

      // Always use a fresh UUID if auth fails
      const guestId = uuid();
      this.user = {
        id: guestId,
        name:
          localStorage.getItem("arc_commander_name") ||
          `Commander_${Math.floor(Math.random() * 9999)}`,
        provider,
      };

      this.initMultiplayerChannel();
    }

    return this.user;
  }

  /**
   * Ensures commander_data exists for the current Auth UID.
   */
  async syncCommanderData(newId) {
    try {
      const { data: existing } = await supabase
        .from("commander_data")
        .select("id, credits, experience, level")
        .eq("id", newId)
        .maybeSingle();

      if (existing) {
        console.log("[CloudService] Commander data verified for current UID.");
        this.user.commander_id = existing.id;
        return;
      }

      console.log("[CloudService] Initializing fresh commander_data for new UID.");
      const { data: newEntry, error: insertError } = await supabase
        .from("commander_data")
        .insert({
          id: newId,
          credits: 1000,
          experience: 0,
          level: 1,
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (insertError) throw insertError;
      if (newEntry) this.user.commander_id = newEntry.id;
    } catch (e) {
      console.warn(
        "[CloudService] syncCommanderData encountered an error (likely RLS):",
        e.message
      );
    }
  }

  /**
   * Save ship state (physical manifest) to ship_states_v2
   */
  async saveToCloud(playerId, starportId, data) {
    if (!playerId) {
      console.warn("[CloudService] saveToCloud: MISSING player_id.");
      return { success: false, error: "Missing player_id" };
    }

    // Cargo integrity check (unchanged)
    const shipType =
      data.ship_type || data.telemetry?.shipType || data.telemetry?.ship_type;

    // Resolve cargo carefully: if not provided, leave undefined so we do NOT overwrite existing DB cargo.
    const resolvedCargo = Array.isArray(data.cargo)
      ? data.cargo
      : Array.isArray(data.telemetry?.cargo)
        ? data.telemetry.cargo
        : undefined;


    // Cargo integrity check uses an empty list if missing
    const cargo = Array.isArray(resolvedCargo) ? resolvedCargo : [];
    const _registryKey = resolveShipRegistryKey(shipType) || shipType;
    const shipConfig = SHIP_REGISTRY[_registryKey];

    if (shipConfig) {
      const maxWeight = shipConfig.cargoHold || 50;
      const maxVolume = shipConfig.cargoMaxVolume || maxWeight * 2;

      let totalWeight = 0;
      let totalVolume = 0;

      cargo.forEach((item) => {
        const itemWeight = parseFloat(item?.weight) || 0;
        const itemVolume = parseFloat(item?.volume) || (parseFloat(item?.weight) * 1.5) || 0;
        totalWeight += itemWeight;
        totalVolume += itemVolume;
      });

      if (totalWeight > maxWeight + 0.001) {
        return {
          success: false,
          error: `MANIFEST REJECTED: VESSEL MASS OVERLOAD (${totalWeight.toFixed(
            1
          )}/${maxWeight} units)`,
        };
      }
      if (totalVolume > maxVolume + 0.001) {
        return {
          success: false,
          error: `MANIFEST REJECTED: CARGO BAY VOLUME EXCEEDED (${totalVolume.toFixed(
            1
          )}/${maxVolume} units)`,
        };
      }
    }

    this.isSyncing = true;

    try {
      // IMPORTANT: do NOT infer docked from starportId alone.
      // Only write starport_id if the caller explicitly says they’re docked.
      const isDocked =
        data?.isDocked === true ||
        data?.docked === true ||
        data?.telemetry?.isDocked === true ||
        data?.telemetry?.docked === true;

      const normalizedStarportId =
        isDocked && starportId ? String(starportId).toLowerCase().trim() : null;

      // Telemetry may be included (safe to store if present)
      const telemetry = data.telemetry && typeof data.telemetry === "object"
        ? { ...data.telemetry }
        : undefined;

      if (telemetry && !(data && data.allowVitalsWrite)) {
        delete telemetry.hp;
        delete telemetry.maxHp;
        delete telemetry.shields;
        delete telemetry.maxShields;
        delete telemetry.energy;
        delete telemetry.maxEnergy;
      }

      const persistentState = {
        player_id: playerId,
        starport_id: normalizedStarportId,
        ship_type: shipType,
        cargo: resolvedCargo,
        fittings: data.fittings || {},
                // ✅ v2 physical columns
        // IMPORTANT: vitals (hull/shields/energy) are authoritative on EC2.
        // By default we DO NOT write them from the client, because stale defaults can overwrite real damage.
        // Only allow vitals writes when explicitly requested (e.g. repairs/refuel UI).
        ...(data && data.allowVitalsWrite ? {
          hull: data.hull ?? data.hp ?? telemetry?.hp ?? undefined,
          maxHp: data.maxHp ?? telemetry?.maxHp,
          shields: data.shields ?? telemetry?.shields,
          maxShields: data.maxShields ?? telemetry?.maxShields,
          energy: data.energy ?? telemetry?.energy,
          maxEnergy: data.maxEnergy ?? telemetry?.maxEnergy,
        } : {}),
system_id: data.system_id || telemetry?.system_id || undefined,
        telemetry: telemetry, // ✅ this prevents “0,0” loads if you pass it
        updated_at: new Date().toISOString(),
      };

      // Remove undefined keys (keeps Supabase cleaner)
      Object.keys(persistentState).forEach((k) => {
        if (persistentState[k] === undefined) delete persistentState[k];
      });

      const { data: upsertData, error } = await supabase
        .from("ship_states_v2")
        .upsert(persistentState, { onConflict: "player_id" })
        .select()
        .single();

      if (error) {
        console.warn("[CloudService] Supabase save error:", error.message);
        this.isSyncing = false;
        return { success: false, error: error.message };
      }

      this.isSyncing = false;
      return { success: true, data: upsertData };
    } catch (e) {
      console.warn("[CloudService] Supabase save exception:", e);
      this.isSyncing = false;
      return { success: false, error: e.message };
    }
  }

  /**
   * Load ship state (physical manifest) from ship_states_v2
   *
   * ✅ FIX: include telemetry (and system_id/vitals) so you don’t “spawn near starport then jump”
   */
  async loadFromCloud(playerId, starportId) {
    if (!playerId) {
      console.warn("[CloudService] loadFromCloud missing playerId");
      return null;
    }

    try {
      const { data, error } = await supabase
        .from("ship_states_v2")
        .select(
          "player_id, system_id, starport_id, ship_type, telemetry, hull, maxHp, shields, maxShields, energy, maxEnergy, cargo, fittings, updated_at"
        )
        .eq("player_id", playerId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn("[CloudService] Supabase load error:", error.message);
        return null;
      }

      if (data) {
        console.log("[CloudService] [LOAD] Persistent ship data:", data);
        if (Array.isArray(data.cargo)) {
          console.log(
            `[CloudService] [LOAD] Cargo manifest loaded. Items: ${data.cargo.length}`
          );
        }
      }
      // -----------------------------------------------------
      // ✅ Normalize v2 columns into telemetry (compat layer)
      // Many older hydration paths read vitals from data.telemetry.*.
      // ship_states_v2 stores these as top-level columns (hull/maxHp/shields/energy).
      // -----------------------------------------------------
      if (data) {
        if (!data.telemetry || typeof data.telemetry !== "object") data.telemetry = {};

        // Keep cargo mirrored inside telemetry for legacy code paths that read telemetry.cargo.
        if (Array.isArray(data.cargo) && !Array.isArray(data.telemetry.cargo)) {
          data.telemetry.cargo = data.cargo;
        }

        if (typeof data.telemetry.hp !== "number" && typeof data.hull === "number") {
          data.telemetry.hp = data.hull;
        }
        if (typeof data.telemetry.maxHp !== "number" && typeof data.maxHp === "number") {
          data.telemetry.maxHp = data.maxHp;
        }
        if (typeof data.telemetry.shields !== "number" && typeof data.shields === "number") {
          data.telemetry.shields = data.shields;
        }
        if (typeof data.telemetry.maxShields !== "number" && typeof data.maxShields === "number") {
          data.telemetry.maxShields = data.maxShields;
        }
        if (typeof data.telemetry.energy !== "number" && typeof data.energy === "number") {
          data.telemetry.energy = data.energy;
        }
        if (typeof data.telemetry.maxEnergy !== "number" && typeof data.maxEnergy === "number") {
          data.telemetry.maxEnergy = data.maxEnergy;
        }
      }


      return data || null;
    } catch (e) {
      console.warn("[CloudService] Supabase load exception:", e.message);
      return null;
    }
  }

  async getCommanderData(playerId) {
    if (!playerId || (this.user && playerId !== this.user.id)) {
      console.warn(
        `[CloudService] Skipping commander_data fetch for non-matching ID: ${playerId}. Current user: ${this.user?.id}`
      );
      return null;
    }

    try {
      const { data, error } = await supabase
        .from("commander_data")
        .select("*")
        .eq("id", playerId)
        .maybeSingle();

      if (error) throw error;
      return data;
    } catch (e) {
      console.warn("[CloudService] Failed to load commander_data:", e.message);
      return null;
    }
  }

  async getCommanderProfile(playerId) {
    if (!playerId || (this.user && playerId !== this.user.id)) {
      console.warn(
        `[CloudService] Skipping commander_profiles fetch for non-matching ID: ${playerId}. Current user: ${this.user?.id}`
      );
      return null;
    }

    try {
      const { data, error } = await supabase
        .from("commander_profiles")
        .select("*")
        .eq("commander_id", playerId)
        .maybeSingle();

      if (error) throw error;
      return data;
    } catch (e) {
      console.warn("[CloudService] Failed to load commander_profiles:", e.message);
      return null;
    }
  }

  async updateCommanderProfile(playerId, payload) {
    if (!playerId || (this.user && playerId !== this.user.id)) {
      console.warn(
        `[CloudService] Skipping commander_profiles update for non-matching ID: ${playerId}`
      );
      return null;
    }

    try {
      const nextPayload = { ...(payload || {}) };
      delete nextPayload.commander_profile;
      if (nextPayload.commander_name) {
        nextPayload.commander_name = String(nextPayload.commander_name).trim().toUpperCase();
      }
      const { data, error } = await supabase
        .from("commander_profiles")
        .upsert({ commander_id: playerId, ...nextPayload }, { onConflict: "commander_id" })
        .select("*")
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (e) {
      console.warn("[CloudService] Failed to update/upsert commander_profiles:", e.message);
      return { success: false, error: e.message };
    }
  }

  async getCredits(playerId) {
    if (!playerId) return 0;
    try {
      const { data, error } = await supabase
        .from("commander_data")
        .select("credits")
        .eq("id", playerId)
        .maybeSingle();
      if (error) throw error;
      return data?.credits || 0;
    } catch (e) {
      console.warn(`[CloudService] Failed to fetch credits for ${playerId}:`, e.message);
      return 0;
    }
  }

  async getInventoryState(playerId, starportId) {
    try {
      const normalizedStarportId = String(starportId || "cygnus-prime")
        .toLowerCase()
        .trim();
      const { data, error } = await supabase
        .from("inventory_states")
        .select("player_id, starport_id, items")
        .eq("player_id", playerId)
        .eq("starport_id", normalizedStarportId)
        .maybeSingle();

      if (error) throw error;
      if (data && !Array.isArray(data.items)) data.items = [];
      return data;
    } catch (e) {
      console.warn(
        `[CloudService] Failed to load inventory_states for starport ${starportId}:`,
        e.message
      );
      return null;
    }
  }

  async checkInventoryManifest(playerId, starportId) {
    if (!playerId || !starportId) return null;
    const normalizedStarportId = String(starportId).toLowerCase().trim();

    try {
      const { data, error } = await supabase
        .from("inventory_states")
        .select("*")
        .eq("player_id", playerId)
        .eq("starport_id", normalizedStarportId)
        .maybeSingle();

      if (error) throw error;
      if (data && !Array.isArray(data.items)) data.items = [];
      return data;
    } catch (e) {
      console.warn(`[CloudService] checkInventoryManifest failed:`, e.message);
      return null;
    }
  }

  async getHangarShips(playerId, starportId) {
    try {
      const normalizedStarportId = String(starportId || "cygnus-prime")
        .toLowerCase()
        .trim();
      const { data, error } = await supabase
        .from("hangar_states")
        .select("player_id, starport_id, ship_id, ship_config, updated_at")
        .eq("player_id", playerId)
        .eq("starport_id", normalizedStarportId);

      if (error) throw error;
      return data || [];
    } catch (e) {
      console.warn(
        `[CloudService] Failed to load hangar_states for starport ${starportId}:`,
        e.message
      );
      return [];
    }
  }

  async saveToHangar(playerId, starportId, shipId, shipConfig) {
    try {
      const normalizedStarportId = String(starportId || "cygnus-prime")
        .toLowerCase()
        .trim();
      const payload = {
        player_id: playerId,
        starport_id: normalizedStarportId,
        ship_id: shipId || shipConfig.id || uuid(),
        ship_config: shipConfig,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("hangar_states")
        .upsert(payload)
        .select("ship_id, ship_config")
        .single();

      if (error) throw error;
      return data;
    } catch (e) {
      console.warn(
        `[CloudService] Failed to save hangar_states for ship ${shipId}:`,
        e.message
      );
      return null;
    }
  }

  async removeFromHangar(playerId, shipId) {
    try {
      const { error } = await supabase
        .from("hangar_states")
        .delete()
        .eq("player_id", playerId)
        .eq("ship_id", shipId);

      if (error) throw error;
      return true;
    } catch (e) {
      console.warn(
        `[CloudService] Failed to remove ship ${shipId} from hangar:`,
        e.message
      );
      return false;
    }
  }

                     async getAllInventoryStates(playerId) {
                       try {
                         const { data, error } = await supabase
                           .from("inventory_states")
                           .select("starport_id, items")
                           .eq("player_id", playerId);

                         if (error) throw error;
                         return data || [];
                       } catch (e) {
                         console.warn("[CloudService] Failed to fetch all inventory_states:", e.message);
                         return [];
                       }
                     }

                     async getAllHangarStates(playerId) {
                       try {
                         const { data, error } = await supabase
                           .from("hangar_states")
                           .select("starport_id, ship_id, ship_config")
                           .eq("player_id", playerId);

                         if (error) throw error;
                         return data || [];
                       } catch (e) {
                         console.warn("[CloudService] Failed to fetch all hangar_states:", e.message);
                         return [];
                       }
                     }


async saveInventoryState(playerId, starportId, items, context = "unknown") {
    console.log(
      `[CloudService] [STORAGE UPDATE] Triggered by: ${context}. Starport: ${starportId}. Items: ${
        (items || []).length
      }`
    );

    try {
      const normalizedStarportId = String(starportId || "cygnus-prime")
        .toLowerCase()
        .trim();

      const filteredItems = (items || []).filter(
        (i) => i.type !== "ship" && !i.isShip
      );

      const upsertPayload = {
        player_id: playerId,
        starport_id: normalizedStarportId,
        items: filteredItems,
      };

      const { data, error } = await supabase
        .from("inventory_states")
        .upsert(upsertPayload, { onConflict: "player_id,starport_id" })
        .select();

      if (error) {
        console.error("[INVENTORY UPSERT ERROR]", error);
        throw error;
      }

      return data;
    } catch (e) {
      console.warn(
        `[CloudService] [SOURCE:${context}] saveInventoryState Exception:`,
        e.message
      );
      return null;
    }
  }

  async updateCommanderData(playerId, payload) {
    if (!playerId || (this.user && playerId !== this.user.id)) {
      console.warn(
        `[CloudService] Skipping commander_data update for non-matching ID: ${playerId}`
      );
      return null;
    }

    try {
      const nextPayload = { ...(payload || {}) };
      delete nextPayload.commander_profile;
      const explicitClearActiveShipId = nextPayload.explicit_clear_active_ship_id === true;
      delete nextPayload.explicit_clear_active_ship_id;

      if (nextPayload.commander_name) {
        const normalizedName = nextPayload.commander_name.trim().toUpperCase();
        const { data: existing, error: checkError } = await supabase
          .from("commander_data")
          .select("id")
          .eq("commander_name", normalizedName)
          .neq("id", playerId)
          .maybeSingle();

        if (checkError) throw checkError;

        if (existing) {
          return { success: false, error: "NAME_TAKEN" };
        }

        if (this.user && this.user.id === playerId) {
          this.user.name = normalizedName;
          localStorage.setItem("arc_commander_name", normalizedName);
        }
      }

      if (Object.prototype.hasOwnProperty.call(nextPayload, 'active_ship_id')) {
        const normalizedActiveShipId = String(nextPayload.active_ship_id || '').trim();
        const isPersistableActiveShipId = !!normalizedActiveShipId && normalizedActiveShipId.toUpperCase() !== 'PENDING' && normalizedActiveShipId.toLowerCase() !== 'null';
        if (!isPersistableActiveShipId) {
          if (explicitClearActiveShipId) {
            nextPayload.active_ship_id = null;
          } else {
            delete nextPayload.active_ship_id;
          }
        } else {
          nextPayload.active_ship_id = normalizedActiveShipId;
        }
      }

      const { data, error } = await supabase
        .from("commander_data")
        .upsert({ id: playerId, ...nextPayload, updated_at: new Date().toISOString() })
        .select("*")
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (e) {
      console.warn(
        "[CloudService] Failed to update/upsert commander_data:",
        e.message
      );
      return { success: false, error: e.message };
    }
  }

  async initializeInventory(playerId, starportId) {
    const normalizedStarportId = String(starportId || "cygnus-prime")
      .toLowerCase()
      .trim();
    console.log(
      `[CloudService] Initializing empty inventory for ${playerId} at ${normalizedStarportId}`
    );
    return { success: true, items: [] };
  }

  async grantStarterKit(playerId, starportId) {
    const normalizedStarportId = String(starportId || "cygnus-prime")
      .toLowerCase()
      .trim();
    console.log(
      `[CloudService] Granting starter kit items to ${playerId} at ${normalizedStarportId}`
    );

    try {
      const starterShipId = uuid();
      const starterTemplateId = resolveShipId("ship_omni_scout") || resolveShipId("OMNI SCOUT") || "ship_omni_scout";
      const starterRegistryKey = resolveShipRegistryKey(starterTemplateId) || "OMNI SCOUT";
      const registry = SHIP_REGISTRY[starterRegistryKey] || SHIP_REGISTRY["OMNI SCOUT"];
      const starterShip = {
        id: starterShipId,
        type: starterTemplateId,
        classId: registry.name || registry.classId || "OMNI SCOUT",
        isShip: true,
        name: registry.name || "OMNI SCOUT",
        rarity: "common",
        quality: 50,
        hp: registry.hp,
        maxHp: registry.hp,
        energy: registry.baseEnergy,
        maxEnergy: registry.baseEnergy,
        fittings: {
          weapon1: null,
          weapon2: null,
          weapon3: null,
          active1: null,
          active2: null,
          active3: null,
          active4: null,
          passive1: null,
          passive2: null,
          passive3: null,
          passive4: null,
          rig1: null,
          rig2: null,
          rig3: null,
          rig4: null,
          synapse1: null,
          synapse2: null,
          synapse3: null,
        },
      };

      await supabase.from("hangar_states").insert({
        player_id: playerId,
        starport_id: normalizedStarportId,
        ship_id: starterShipId,
        ship_config: starterShip,
      });

      const starterEquipment = getStarterLoadout(starterShip?.ship_type || starterShip?.name || null)
  .map(({ itemKey, quality }) => createItemInstance(itemKey, { id: uuid(), quality }))
  .filter(Boolean);

      const existingInventoryState = await this.getInventoryState(playerId, normalizedStarportId);
      const existingStorageItems = Array.isArray(existingInventoryState?.items)
        ? existingInventoryState.items
        : [];
      const mergedStorageItems = [...existingStorageItems, ...starterEquipment];

      await this.saveInventoryState(
        playerId,
        normalizedStarportId,
        mergedStorageItems,
        "grantStarterKit"
      );

      return { success: true };
    } catch (e) {
      console.error("[CloudService] Failed to grant starter kit:", e.message);
      return { success: false, error: e.message };
    }
  }

  async issueStarterKit(playerId, starportId) {
    const normalizedStarportId = String(starportId || "cygnus-prime")
      .toLowerCase()
      .trim();
    console.log(
      `[CloudService] Authoritative manifest check for ${playerId} at ${normalizedStarportId}`
    );

    try {
      // ✅ Only suppress if the player already has at least one ship stored at THIS starport.
      // IMPORTANT: Do NOT suppress based on inventory manifest existence. Players can have an inventory_states
      // row (even empty, or only ore/modules) but no ships, and they must still receive a starter ship.
      const { data: existingHangarShips, error: hangarErr } = await supabase
        .from("hangar_states")
        .select("ship_id")
        .eq("player_id", playerId)
        .eq("starport_id", normalizedStarportId)
        .limit(1);
      if (hangarErr) {
        console.warn("[CloudService] Hangar check failed (non-fatal):", hangarErr.message);
      } else if (existingHangarShips && existingHangarShips.length > 0) {
        console.log("[CloudService] Existing hangar ship detected. Starter ship issuance suppressed.");
        return { success: true, manifestExists: true };
      }


      await this.grantStarterKit(playerId, normalizedStarportId);
      return { success: true, manifestExists: false };
    } catch (e) {
      console.error("[CloudService] Failed to issue starter kit:", e.message);
      return { success: false, error: e.message };
    }
  }

  async createDefaultShip(playerId, starportId, shipType, telemetry) {
    const normalizedStarportId = starportId
      ? String(starportId).toLowerCase().trim()
      : "active";

    console.log(
      `%c[CloudService] [EXECUTION START] Manifesting vessel for UID: ${playerId} at ${normalizedStarportId}`,
      "color: #00ccff; font-weight: bold;"
    );

    const shipId = resolveShipId(shipType) || shipType;

    const registryKey = resolveShipRegistryKey(shipId) || resolveShipRegistryKey(shipType) || shipType;
    const shipConfig = SHIP_REGISTRY[registryKey] || SHIP_REGISTRY["OMNI SCOUT"];

    const payload = {
      player_id: playerId,
      starport_id: normalizedStarportId,
      ship_type: shipId,
      cargo: shipConfig.defaultCargo || [],
      fittings: shipConfig.defaultFittings || {},
      maxHp: shipConfig.hp,
      maxEnergy: shipConfig.baseEnergy,
      maxShields: shipConfig.maxShields || 0,
      telemetry: telemetry || {},
      updated_at: new Date().toISOString(),
    };

    try {
      const { data, error } = await supabase
        .from("ship_states_v2")
        .upsert(payload, { onConflict: "player_id" })
        .select("player_id")
        .single();

      if (error) throw error;

      console.log(
        `%c[CloudService] [EXECUTION COMPLETE] Manifest verified for UID: ${playerId}`,
        "color: #00ff66; font-weight: bold;"
      );

      return data;
    } catch (e) {
      console.error(
        "%c[CloudService] [CRITICAL EXCEPTION] during manifestation:",
        "color: #ff4444; font-weight: bold;",
        e
      );
      return null;
    }
  }

  logout() {
    this.user = null;
  }

  // --- MARKETPLACE SERVER-SIDE WRAPPERS ---
  async apiMarketAction(action, payload) {
    const response = await fetch("/api/market", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json();
    if (!response.ok || result.error)
      throw new Error(result.error || `API error: ${action}`);
    return result;
  }

  buyListing(listing_id, commander_id) {
    return this.apiMarketAction("buyListing", { listing_id, commander_id });
  }

  createSellOrder(item_type, quantity, price_per_uni, starport_id, seller_id) {
    return this.apiMarketAction("createSellOrder", {
      item_type,
      quantity,
      price_per_uni,
      starport_id,
      seller_id,
    });
  }

  createBuyOrder(item_type, quantity, price_per_uni, starport_id, buyer_id) {
    return this.apiMarketAction("createBuyOrder", {
      item_type,
      quantity,
      price_per_uni,
      starport_id,
      buyer_id,
    });
  }

  cancelSellOrder(listing_id, commander_id) {
    return this.apiMarketAction("cancelSellOrder", { listing_id, commander_id });
  }

  seedNPCBlueprints(starport_id) {
    return this.apiMarketAction("seedNPCBlueprints", { starport_id });
  }

  async fetchMarketData(starportId, filter) {
    const response = await fetch(
      `/api/market?starport_id=${starportId}&filter=${filter || "listings"}`
    );
    const result = await response.json();
    if (!response.ok || result.error)
      throw new Error(result.error || "Failed to fetch market data");
    return result;
  }

  // -----------------------------
  // OPTIONAL: AWS SOCKET TELEMETRY
  // -----------------------------
  // -----------------------------
  // OPTIONAL: AWS SOCKET TELEMETRY
  // -----------------------------
  sendTelemetryToAWS(telemetry) {
    if (!this.awsSocket || this.awsSocket.readyState !== WebSocket.OPEN) return;

    // throttle to avoid spamming on every render tick
    const now = Date.now();
    const minMs = CLOUD_CONFIG.awsTelemetryMinIntervalMs || 0;
    if (minMs > 0 && now - (this._lastAwsTelemetrySentAt || 0) < minMs) return;
    this._lastAwsTelemetrySentAt = now;

    this.awsSocket.send(
      JSON.stringify({
        type: "TELEMETRY",
        player_id: this.user?.id,
        ...telemetry,
      })
    );
  }




  // -----------------------------------------------------
  // WORLD OBJECTS (LOOT / ORE / SALVAGE)
  // -----------------------------------------------------
  /**
   * Spawns an authoritative world object record in Supabase.
   * Used by GameManager.spawnLoot() (mining/combat drops).
   *
   * @param {string} type - e.g. 'ore', 'loot', 'salvage'
   * @param {object} data - item payload (will be stored in world_objects.data)
   * @param {{x:number,y:number,z?:number}} pos - world position
   * @param {string} systemId - current system (stored inside data.systemId for now)
   * @returns {object|null} inserted world object row (must include object_id)
   */
  async spawnWorldObject(type = "loot", data = {}, pos = { x: 0, y: 0 }, systemId = null) {
    try {
      const x = Number.isFinite(pos?.x) ? Number(Number(pos.x).toFixed(2)) : 0;
      const y = Number.isFinite(pos?.y) ? Number(Number(pos.y).toFixed(2)) : 0;

      const payload = {
        object_id: `wo-${uuid()}`,
        type: String(type || "loot"),
        x,
        y,
        rot: 0,
        hp: 1,
        respawn_at: null,
        updated_at: new Date().toISOString(),
        data: {
          ...(typeof data === "object" && data ? data : { value: data }),
          ...(systemId ? { systemId } : {}),
        },
      };

      const { data: row, error } = await supabase
        .from("world_objects")
        .insert(payload)
        .select("object_id, type, x, y, rot, data, updated_at, respawn_at, hp")
        .single();

      if (error) {
        console.warn("[CloudService] spawnWorldObject insert failed:", error.message);
        return null;
      }

      return row || null;
    } catch (e) {
      console.warn("[CloudService] spawnWorldObject exception:", e?.message || e);
      return null;
    }
  }

  /**
   * Collect a world object into inventory and delete the object record.
   * Used by tractor beam (GameManager.requestLootCollection()).
   *
   * Returns the updated inventory array (same shape as inventory_states.items).
   */
  
/**
 * Collect a world object into STARPORT storage (inventory_states) and delete the object record.
 * Used by tractor beam in station contexts (legacy).
 *
 * Returns the updated inventory array (same shape as inventory_states.items).
 */
async collectWorldObject(objectId, playerId, starportId) {
  try {
    if (!objectId || !playerId) return null;

    const normalizedStarportId = String(starportId || "cygnus-prime")
      .toLowerCase()
      .trim();

    // 1) Fetch world object payload
    const { data: wo, error: fetchErr } = await supabase
      .from("world_objects")
      .select("object_id, type, data")
      .eq("object_id", objectId)
      .maybeSingle();

    if (fetchErr) {
      console.warn("[CloudService] collectWorldObject fetch failed:", fetchErr.message);
      return null;
    }
    if (!wo) return null;

    const invItem = (wo.data && typeof wo.data === "object") ? wo.data : { value: wo.data };
    if (!invItem) return null;

    // 2) Load current station inventory
    const { data: invRow, error: invErr } = await supabase
      .from("inventory_states")
      .select("items")
      .eq("player_id", playerId)
      .eq("starport_id", normalizedStarportId)
      .maybeSingle();

    if (invErr) {
      console.warn("[CloudService] collectWorldObject inventory fetch failed:", invErr.message);
      return null;
    }

    const items = Array.isArray(invRow?.items) ? [...invRow.items] : [];

    // 3) Merge / stack
    const amountToAdd = Number.isFinite(invItem.amount) ? Number(invItem.amount) : 1;
    const maxStack = Number.isFinite(invItem.maxStack) ? Number(invItem.maxStack) : 999;

    const keyMatch = (a, b) => {
      if (!a || !b) return false;
      // Prefer explicit itemId match if present
      if (a.itemId && b.itemId) return a.itemId === b.itemId;
      // Otherwise stack common resources by core identifiers
      return (
        a.type === b.type &&
        a.name === b.name &&
        a.oreType === b.oreType &&
        a.qlBand === b.qlBand &&
        a.rarity === b.rarity
      );
    };

    let remaining = amountToAdd;
    for (let i = 0; i < items.length && remaining > 0; i++) {
      const it = items[i];
      if (!keyMatch(it, invItem)) continue;
      const cur = Number.isFinite(it.amount) ? Number(it.amount) : 1;
      const space = Math.max(0, maxStack - cur);
      if (space <= 0) continue;
      const add = Math.min(space, remaining);
      items[i] = { ...it, amount: cur + add };
      remaining -= add;
    }

    if (remaining > 0) {
      items.push({ ...invItem, amount: remaining });
    }

    // 4) Delete object (authoritative removal)
    const { error: delErr } = await supabase
      .from("world_objects")
      .delete()
      .eq("object_id", objectId);

    if (delErr) {
      console.warn("[CloudService] collectWorldObject delete failed:", delErr.message);
      // Don't abort: we still upsert inventory; worst case object needs cleanup later.
    }

    // 5) Upsert inventory state
    const { error: upErr } = await supabase
      .from("inventory_states")
      .upsert(
        { player_id: playerId, starport_id: normalizedStarportId, items },
        { onConflict: "player_id,starport_id" }
      );

    if (upErr) {
      console.warn("[CloudService] collectWorldObject inventory upsert failed:", upErr.message);
      return null;
    }

    return items;
  } catch (e) {
    console.warn("[CloudService] collectWorldObject exception:", e?.message || e);
    return null;
  }
}

/**
 * Collect a world object into SHIP cargo (ship_states_v2.cargo) and delete the object record.
 * Used by tractor beam in space (GameManager.requestLootCollection()).
 *
 * Returns the updated cargo array (same shape as ship_states_v2.cargo).
 */
async collectWorldObjectToCargo(objectId, playerId) {
  try {
    if (!objectId || !playerId) return null;

    // 1) Fetch world object payload
    const { data: wo, error: fetchErr } = await supabase
      .from("world_objects")
      .select("object_id, type, data")
      .eq("object_id", objectId)
      .maybeSingle();

    if (fetchErr) {
      console.warn("[CloudService] collectWorldObjectToCargo fetch failed:", fetchErr.message);
      return null;
    }
    if (!wo) return null;

    const cargoItem = (wo.data && typeof wo.data === "object") ? wo.data : { value: wo.data };
    if (!cargoItem) return null;

    // 2) Load current ship cargo
    const { data: shipRow, error: shipErr } = await supabase
      .from("ship_states_v2")
      .select("cargo")
      .eq("player_id", playerId)
      .maybeSingle();

    if (shipErr) {
      console.warn("[CloudService] collectWorldObjectToCargo cargo fetch failed:", shipErr.message);
      return null;
    }

    const cargo = Array.isArray(shipRow?.cargo) ? [...shipRow.cargo] : [];

    // 3) Merge / stack into cargo
    const amountToAdd = Number.isFinite(cargoItem.amount) ? Number(cargoItem.amount) : 1;
    const maxStack = Number.isFinite(cargoItem.maxStack) ? Number(cargoItem.maxStack) : 999;

    const keyMatch = (a, b) => {
      if (!a || !b) return false;
      if (a.itemId && b.itemId) return a.itemId === b.itemId;
      return (
        a.type === b.type &&
        a.name === b.name &&
        a.oreType === b.oreType &&
        a.qlBand === b.qlBand &&
        a.rarity === b.rarity
      );
    };

    let remaining = amountToAdd;
    for (let i = 0; i < cargo.length && remaining > 0; i++) {
      const it = cargo[i];
      if (!keyMatch(it, cargoItem)) continue;
      const cur = Number.isFinite(it.amount) ? Number(it.amount) : 1;
      const space = Math.max(0, maxStack - cur);
      if (space <= 0) continue;
      const add = Math.min(space, remaining);
      cargo[i] = { ...it, amount: cur + add };
      remaining -= add;
    }

    if (remaining > 0) {
      cargo.push({ ...cargoItem, amount: remaining });
    }

    // 4) Delete object (authoritative removal)
    const { error: delErr } = await supabase
      .from("world_objects")
      .delete()
      .eq("object_id", objectId);

    if (delErr) {
      console.warn("[CloudService] collectWorldObjectToCargo delete failed:", delErr.message);
    }

    // 5) Persist cargo
    const { error: upErr } = await supabase
      .from("ship_states_v2")
      .upsert({ player_id: playerId, cargo }, { onConflict: "player_id" });

    if (upErr) {
      console.warn("[CloudService] collectWorldObjectToCargo cargo upsert failed:", upErr.message);
      return null;
    }

    return cargo;
  } catch (e) {
    console.warn("[CloudService] collectWorldObjectToCargo exception:", e?.message || e);
    return null;
  }
}

  async getNearbyShips(systemId) {
    console.warn(
      "[CloudService] getNearbyShips() is not implemented yet. Returning empty list."
    );
    return [];
  }
}

export const cloudService = new CloudService();