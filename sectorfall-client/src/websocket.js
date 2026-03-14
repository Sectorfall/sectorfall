/**
 * Sectorfall Backend Connection Manager
 *
 * Includes:
 * - Authority-first spawn (prevents starport flash on refresh)
 * - sendDock() to persist last-space coords at dock time
 * - Telemetry uses world coords and is gated by awaitingSpawn
 * - WELCOME epsilon guard to prevent tiny "1cm" snap on refresh
 */

import { supabase } from "./supabaseClient.js";
import { STARPORT_TO_SYSTEM } from "./data/systemsRegistry.js";

// -----------------------------------------------------
// REMOTE PLAYER REGISTRY
// -----------------------------------------------------
export const remotePlayers = new Map();
// userId -> { sprite, x, y, rot, targetX, targetY, targetRot, vx, vy }



const REQUIRED_AUTHORITATIVE_COMBAT_STAT_KEYS = [
  'maxHp',
  'maxEnergy',
  'armor',
  'powergrid',
  'cpu',
  'maxVelocity',
  'thrustImpulse',
  'angularMomentum',
  'scanRange',
  'lockOnRange',
  'signatureRadius',
  'cargoCapacity'
];

function getCombatStatsPayload(data = {}) {
  if (data?.combat_stats && typeof data.combat_stats === 'object') return data.combat_stats;
  if (data?.combatStats && typeof data.combatStats === 'object') return data.combatStats;
  return null;
}

function validateAuthoritativeCombatStats(data = {}, label = 'AUTHORITATIVE_SHIP_STATE') {
  const combatStats = getCombatStatsPayload(data);
  const missing = [];
  if (!combatStats) {
    missing.push('combat_stats');
  } else {
    for (const key of REQUIRED_AUTHORITATIVE_COMBAT_STAT_KEYS) {
      const value = combatStats[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) missing.push(key);
    }
  }
  if (missing.length <= 0) return { ok: true, combatStats, missing: [] };

  console.error(`[${label}] Missing authoritative combat stats:`, missing, combatStats || null);
  try {
    window.dispatchEvent(new CustomEvent('sectorfall:authoritative_ship_state_invalid', {
      detail: { label, missing, payload: data }
    }));
  } catch {}
  return { ok: false, combatStats, missing };
}

function normalizeRemotePlayerState(raw = {}) {
  const stats = (raw && typeof raw.stats === "object" && raw.stats) ? raw.stats : {};
  const telemetry = (raw && typeof raw.telemetry === "object" && raw.telemetry) ? raw.telemetry : {};
  const fittings = raw.fittings || stats.fittings || telemetry.fittings || {};
  const animation_state = raw.animation_state || stats.animation_state || telemetry.animation_state || {};
  const visual_config = raw.visual_config || stats.visual_config || telemetry.visual_config || {};

  return {
    id: raw.userId || raw.id,
    x: raw.x ?? telemetry.x ?? 0,
    y: raw.y ?? telemetry.y ?? 0,
    rot: raw.rot ?? telemetry.rot ?? 0,
    name: raw.name || raw.commanderName || `CMDR_${String(raw.userId || raw.id || '').slice(0, 4)}`,
    shipType: raw.shipType || raw.ship_type || stats.shipType || stats.ship_type || telemetry.shipType || telemetry.ship_type || "OMNI SCOUT",
    ship_type: raw.ship_type || raw.shipType || stats.ship_type || stats.shipType || telemetry.ship_type || telemetry.shipType || "OMNI SCOUT",
    visual_config,
    animation_state,
    stats: {
      hp: raw.hp ?? raw.hull ?? stats.hp ?? stats.hull ?? telemetry.hp ?? telemetry.hull,
      maxHp: raw.maxHp ?? stats.maxHp ?? telemetry.maxHp,
      shields: raw.shields ?? stats.shields ?? telemetry.shields,
      maxShields: raw.maxShields ?? stats.maxShields ?? telemetry.maxShields,
      energy: raw.energy ?? stats.energy ?? telemetry.energy,
      maxEnergy: raw.maxEnergy ?? stats.maxEnergy ?? telemetry.maxEnergy,
      armor: raw.armor ?? stats.armor ?? telemetry.armor ?? 0,
      resistances: (raw.resistances && typeof raw.resistances === 'object') ? raw.resistances : ((stats.resistances && typeof stats.resistances === 'object') ? stats.resistances : ((telemetry.resistances && typeof telemetry.resistances === 'object') ? telemetry.resistances : {})),
      combat_stats: raw.combat_stats ?? raw.combatStats ?? stats.combat_stats ?? stats.combatStats ?? telemetry.combat_stats ?? telemetry.combatStats ?? null,
      fittings,
      animation_state,
      visual_config
    }
  };
}

export class BackendSocket {
  constructor(url = "wss://ws.sectorfall.win") {
    this.url = url;
    this.socket = null;

    this.seq = 0;
    this.userId = null;

    this.currentSystemId = null;

    this.isDocked = false;
    this.starportId = null;

    // prevents local/default spawns showing before authoritative WELCOME
    this.awaitingSpawn = true;

    // internal debug flags
    this._telemetryShapeLogged = false;
    this._didRefreshAfterWelcome = false;

    // dock guard
    this._dockSentThisDock = false;

    // debug counter
    this._tCalls = 0;

    // telemetry throttle (client -> EC2)
    this.telemetryMinIntervalMs = 50; // 20/s max
    this._lastTelemetrySentAt = 0;

    // telemetry ack log throttle
    this._lastAckLogAt = 0;

    // reconnect guard / backoff
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;

    this._pendingCollects = new Map();
    this._pendingCollectsByObjectId = new Map();
    this._collectedObjectIds = new Set();
    this._pendingSpawns = new Map();
    this._pendingCommanderRequests = new Map();
    this._pendingCommanderProfileUpdates = new Map();
    this._pendingRepairRequests = new Map();
    this._pendingActivateRequests = new Map();
    this._pendingFabricationRequests = new Map();
    this._pendingMarketRequests = new Map();
    this._pendingRespawnRequests = new Map();
    this.arenaHooks = null;
    this.battlegroundHooks = null;
    this.instanceBoundaryHooks = null;
  }

  setArenaHooks(hooks = null) {
    this.arenaHooks = hooks && typeof hooks === 'object' ? hooks : null;
  }

  setBattlegroundHooks(hooks = null) {
    this.battlegroundHooks = hooks && typeof hooks === 'object' ? hooks : null;
  }

  setInstanceBoundaryHooks(hooks = null) {
    this.instanceBoundaryHooks = hooks && typeof hooks === 'object' ? hooks : null;
  }

  // -----------------------------------------------------
  // SYSTEM ID NORMALIZATION (CRITICAL)
  // Accepts:
  // - "cygnus-prime"
  // - { id: "cygnus-prime", ... }
  // Returns: "cygnus-prime"
  // -----------------------------------------------------
  normalizeSystemId(systemId) {
    if (typeof systemId === "string") return systemId;
    if (systemId && typeof systemId.id === "string") return systemId.id;
    return "cygnus-prime";
  }

  // -----------------------------------------------------
  // SMALL HELPERS
  // -----------------------------------------------------
  pickNum(...vals) {
    for (const v of vals) {
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  }

  _scheduleReconnect() {
    // prevent stacking reconnect timers
    if (this._reconnectTimer) return;

    // exponential backoff with cap
    const attempt = (this._reconnectAttempts || 0) + 1;
    this._reconnectAttempts = attempt;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(5, attempt - 1))); // 1s,2s,4s,8s,16s,32s cap->30s

    console.warn(`[Backend] Connection died. Reconnecting in ${Math.round(delay/1000)}s... (attempt ${attempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(this.currentSystemId);
    }, delay);
  }
  async connect(systemId) {
    const nextSystemId = this.normalizeSystemId(systemId);
    const prevSystemId = this.currentSystemId;

    // If already connected, either jump systems (OPEN) or do nothing (CONNECTING).
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      if (this.socket.readyState === WebSocket.OPEN) {
        // Same system: nothing to do
        if (nextSystemId && prevSystemId && nextSystemId === prevSystemId) return;

        // Different system: send JUMP_SYSTEM so EC2 updates system_id and replies with WELCOME
        if (nextSystemId && prevSystemId && nextSystemId !== prevSystemId) {
          let snap = { x: undefined, y: undefined, rot: 0, vx: 0, vy: 0 };

          try {
            const gm = window.game?.manager || window.gameManager || window.game;
            const s = gm?.ship;
            if (s) {
              snap.x = (typeof s.x === "number") ? s.x : (typeof s.sprite?.x === "number" ? s.sprite.x : undefined);
              snap.y = (typeof s.y === "number") ? s.y : (typeof s.sprite?.y === "number" ? s.sprite.y : undefined);
              snap.rot = (typeof s.rotation === "number") ? s.rotation : (typeof s.sprite?.rotation === "number" ? s.sprite.rotation : 0);
              snap.vx = (typeof s.vx === "number") ? s.vx : 0;
              snap.vy = (typeof s.vy === "number") ? s.vy : 0;
            }
          } catch {
            // ignore
          }

          this.currentSystemId = nextSystemId;
          this.send({
            type: "JUMP_SYSTEM",
            userId: this.userId,
            system_id: nextSystemId,
            x: snap.x,
            y: snap.y,
            rot: snap.rot,
            vx: snap.vx,
            vy: snap.vy
          });
          return;
        }
      }
      // CONNECTING or cannot determine: let the existing connect proceed
      return;
    }

    // Fresh connection path
    this.currentSystemId = nextSystemId;

    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      console.error("[Backend] No Supabase user session found:", error);
      return;
    }

    this.userId = data.user.id;
    console.log("[Backend] Using Supabase UID:", this.userId);

    console.log("[Backend] Connecting to " + this.url + "...");
    this.socket = new WebSocket(this.url);

    this.socket.onopen = () => {
      // reset reconnect backoff
      this._reconnectAttempts = 0;
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      console.log("Connected to backend");

      // On any fresh socket open, wait for authoritative spawn
      this.awaitingSpawn = true;

      // ✅ HIDE SHIP IMMEDIATELY so default starport spawn never renders
      try {
        const gm = window.game?.manager || window.gameManager;
        if (gm?.ship?.sprite) gm.ship.sprite.visible = false;
        if (gm?.nameSprite) gm.nameSprite.visible = false;
        if (gm?.shieldMesh) gm.shieldMesh.visible = false;
      } catch {
        // ignore
      }

      this.send({
        type: "HELLO",
        userId: this.userId,
        msg: "hello from the game"
      });

      // DO NOT JOIN_SYSTEM here.
      // Wait for DOCKED or WELCOME from server.
    };

    this.socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.warn("[Backend] Invalid JSON from server:", event.data);
        return;
      }
      this.routeMessage(msg);
    };

    this.socket.onclose = (event) => {
      if (event.wasClean) {
        console.log(
          "[Backend] Connection closed cleanly, code=" +
            event.code +
            " reason=" +
            event.reason
        );
      } else {
        this._scheduleReconnect();
      }
    };

    this.socket.onerror = (error) => {
      console.error("[Backend] WebSocket Error:", error);
    };
  }

  // -----------------------------------------------------
  // ROUTER FOR SERVER MESSAGES
  // -----------------------------------------------------
  routeMessage(data) {
    switch (data.type) {
      case "DOCKED":
        this.handleDocked(data);
        break;

      case "WELCOME":
        this.handleWelcome(data);
        break;

      case "INITIAL_PLAYERS":
        this.handleInitialPlayers(data.players);
        break;

      case "PLAYER_UPDATE":
        this.handlePlayerUpdate(data);
        break;

      case "PLAYER_LEFT":
        this.handlePlayerLeft(data.userId);
        break;

      case "WEAPON_FIRED":
        this.handleWeaponFired(data);
        break;

      // Visual-only FX events (shield impacts, explosions, misc)
      case "FX_EVENT":
        this.handleFxEvent(data);
        break;

      case "DAMAGE_EVENT":
        this.handleDamageEvent(data);
        break;

      case "SHIP_DESTROYED":
        this.handleShipDestroyed(data);
        break;

      case "ARENA_JOINED":
        this.handleArenaJoined(data);
        break;

      case "ARENA_JOIN_FAILED":
        this.handleArenaJoinFailed(data);
        break;

      case "ARENA_RESPAWN":
        this.handleArenaRespawn(data);
        break;

      case "ARENA_LEFT":
        this.handleArenaLeft(data);
        break;

      case "ARENA_READY_ACK":
        this.handleArenaReadyAck(data);
        break;

      case "BATTLEGROUND_DEFINITION":
        this.handleBattlegroundDefinition(data);
        break;

      case "BATTLEGROUND_INSPECT_FAILED":
        this.handleBattlegroundEnterFailed(data);
        break;

      case "BATTLEGROUND_ENTERED":
        this.handleBattlegroundEntered(data);
        break;

      case "BATTLEGROUND_ENTER_READY":
        this.handleBattlegroundEnterReady(data);
        break;

      case "BATTLEGROUND_ENTER_FAILED":
        this.handleBattlegroundEnterFailed(data);
        break;

      case "BATTLEGROUND_LEFT":
        this.handleBattlegroundLeft(data);
        break;

      case "BATTLEGROUND_STATE":
        this.handleBattlegroundState(data);
        break;

      case "BATTLEGROUND_WAVE_STARTED":
        this.handleBattlegroundWaveStarted(data);
        break;

      case "INITIAL_NPCS":
        this.handleInitialNpcs(data.npcs || []);
        break;

      case "BATTLEGROUND_NPC_SPAWNED":
        this.handleBattlegroundNpcSpawned(data);
        break;

      case "BATTLEGROUND_WAVE_CLEARED":
        this.handleBattlegroundWaveCleared(data);
        break;

      case "BATTLEGROUND_COMPLETED":
        this.handleBattlegroundCompleted(data);
        break;

      case "BATTLEGROUND_EXTRACT_STARTED":
        this.handleBattlegroundExtractStarted(data);
        break;

      case "BATTLEGROUND_FAILED":
        this.handleBattlegroundFailed(data);
        break;

      case "INSTANCE_BOUNDARY_CONFIG":
        this.handleInstanceBoundaryConfig(data);
        break;

      case "INSTANCE_BOUNDARY_STATE":
        this.handleInstanceBoundaryState(data);
        break;

      case "SYSTEM_STRUCTURES":
        this.handleSystemStructures(data);
        break;

      case "NPC_DAMAGE_EVENT":
        this.handleNpcDamageEvent(data);
        break;

      case "NPC_DESTROYED":
        this.handleNpcDestroyed(data);
        break;

      case "NPC_COMBAT_STATE":
        this.handleNpcCombatState(data);
        break;

      case "ASTEROID_DAMAGE_EVENT":
        this.handleAsteroidDamageEvent(data);
        break;

      case "ASTEROID_DEPLETED":
        this.handleAsteroidDepleted(data);
        break;

      case "MINING_STATE":
        this.handleMiningState(data);
        break;

      case "TELEMETRY_ACK":
        this.handleTelemetryAck(data);
        break;

      case "WORLD_OBJECT_SPAWNED":
        this.handleWorldObjectSpawned(data);
        break;

      case "WORLD_OBJECT_REMOVED":
        this.handleWorldObjectRemoved(data);
        break;

      case "CARGO_SYNC":
        this.handleCargoSync(data);
        break;

      case "COLLECT_WORLD_OBJECT_RESULT":
        this.handleCollectWorldObjectResult(data);
        break;

      case "SPAWN_WORLD_OBJECT_RESULT":
        this.handleSpawnWorldObjectResult(data);
        break;

      case "TARGET_LOCK_INVALIDATED":
        this.handleTargetLockInvalidated(data);
        break;

      case "COMMANDER_STATE":
        this.handleCommanderState(data);
        break;

      case "COMMANDER_REPAIR_RESULT":
        this.handleCommanderRepairResult(data);
        break;

      case "COMMANDER_ACTIVATE_RESULT":
        this.handleCommanderActivateResult(data);
        break;

      case "FABRICATION_RESULT":
        this.handleFabricationResult(data);
        break;

      case "RESPAWN_HOME_RESULT":
        this.handleRespawnHomeResult(data);
        break;
      case "COMMANDER_PROFILE_RESULT":
        this.handleCommanderProfileResult(data);
        break;

      case "FLEET_INVITE_RECEIVED":
        this.handleFleetInviteReceived(data);
        break;

      case "FLEET_INVITE_RESULT":
        this.handleFleetInviteResult(data);
        break;

      case "FLEET_STATE":
        this.handleFleetState(data);
        break;

      case "FLEET_ERROR":
        this.handleFleetError(data);
        break;

      case "MARKET_DATA_RESULT":
        this.handleMarketDataResult(data);
        break;

      case "MARKET_ACTION_RESULT":
        this.handleMarketActionResult(data);
        break;

      case "PONG":
        // optional
        break;

      default:
        console.log("[Backend] Unhandled server message:", data);
    }
  }


  handleNpcCombatState(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleNpcCombatState === "function") {
        gm.handleNpcCombatState(data);
      }
    } catch (err) {
      console.warn("[Backend] NPC_COMBAT_STATE handler failed:", err);
    }
  }

  // -----------------------------------------------------
  // FX EVENT (VISUAL ONLY)
  // -----------------------------------------------------
  handleFxEvent(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      // Prefer direct hook on GameManager
      if (gm && typeof gm.onRemoteFxTrigger === "function") {
        // Normalize to the same payload shape you previously used via Supabase broadcasts
        gm.onRemoteFxTrigger({
          player_id: data.userId,
          fx_type: data.fx_type,
          x: data.x,
          y: data.y,
          angle: data.angle,
          t: data.t || data.serverTime || Date.now()
        });
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:fx_event", { detail: data }));
    } catch {
      // ignore
    }
  }
  handleFleetInviteReceived(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleFleetInviteReceived === "function") {
        gm.handleFleetInviteReceived(data);
      }
    } catch (err) {
      console.warn("[Backend] FLEET_INVITE_RECEIVED handler failed:", err);
    }
  }

  handleFleetInviteResult(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleFleetInviteResult === "function") {
        gm.handleFleetInviteResult(data);
      }
    } catch (err) {
      console.warn("[Backend] FLEET_INVITE_RESULT handler failed:", err);
    }
  }

  handleFleetState(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.applyFleetState === "function") {
        gm.applyFleetState(data);
      }
    } catch (err) {
      console.warn("[Backend] FLEET_STATE handler failed:", err);
    }
  }

  handleFleetError(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleFleetError === "function") {
        gm.handleFleetError(data);
      }
    } catch (err) {
      console.warn("[Backend] FLEET_ERROR handler failed:", err);
    }
  }


  // -----------------------------------------------------
  // DOCKED HANDLER
  // -----------------------------------------------------
  async handleDocked(data) {
    console.log("[Dock][Client] received DOCKED", data);

    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm?.stats) {
        if (typeof data.hp === "number") gm.stats.hp = data.hp;
        if (typeof data.maxHp === "number") gm.stats.maxHp = data.maxHp;
        if (typeof data.shields === "number") gm.stats.shields = data.shields;
        if (typeof data.maxShields === "number") gm.stats.maxShields = data.maxShields;
        if (typeof data.energy === "number") gm.stats.energy = data.energy;
        if (typeof data.maxEnergy === "number") gm.stats.maxEnergy = data.maxEnergy;
        if (typeof gm.updateUi === "function") gm.updateUi();
      }
    } catch {}

    this.isDocked = true;
    this.starportId = data.starport_id;
    this.currentSystemId = STARPORT_TO_SYSTEM[String(data.starport_id || '').trim().toUpperCase()] || this.currentSystemId;
    validateAuthoritativeCombatStats(data, 'DOCKED');
    try { window.dispatchEvent(new CustomEvent("sectorfall:authoritative_ship_state", { detail: data })); } catch {}

    // while docked, we are not in space with a valid spawn
    this.awaitingSpawn = true;

    const gm = window.game?.manager || window.gameManager || window.game;
    const targetSystemId = STARPORT_TO_SYSTEM[String(data.starport_id || '').trim().toUpperCase()] || null;
    const localSysRaw = gm?.currentSystemId || gm?.currentSystem || gm?.systemId || gm?.system_id || this.currentSystemId;
    const localSys = this.normalizeSystemId(localSysRaw);

    if (gm && targetSystemId && localSys && targetSystemId !== localSys && typeof gm.loadSystem === "function") {
      try {
        console.log("[Dock][Client] System mismatch on DOCKED. Local:", localSys, "Server starport system:", targetSystemId, "-> switching");
        const p = gm.loadSystem(targetSystemId, null);
        if (p && typeof p.then === "function") {
          await p;
        }
      } catch (e) {
        console.warn("[Dock][Client] loadSystem before dock UI failed:", e?.message || e);
      }
    }

    const applyDockUI = () => {
      if (
        window.game &&
        typeof window.game.hideSpaceScene === "function" &&
        typeof window.game.showStarportUI === "function"
      ) {
        window.game.hideSpaceScene();
        window.game.showStarportUI(data.starport_id);
        console.log("[DockUI] Applied dock UI successfully.");
        return true;
      }
      return false;
    };

    if (applyDockUI()) return;

    let attempts = 0;
    const maxAttempts = 60; // 60 * 50ms = 3s
    const timer = setInterval(() => {
      attempts++;
      if (applyDockUI() || attempts >= maxAttempts) {
        clearInterval(timer);
        if (attempts >= maxAttempts) {
          console.warn(
            "[DockUI] Gave up waiting for window.game. Starport UI did not show."
          );
        }
      }
    }, 50);
  }

  // -----------------------------------------------------
  // WELCOME HANDLER (IN SPACE)
  // - hides ship until spawn is applied
  // - clears buffers
  // - EPSILON GUARD to prevent tiny snap if already placed
  // -----------------------------------------------------
  // -----------------------------------------------------
  // WELCOME HANDLER (IN SPACE)
  // - authoritative spawn from EC2
  // - CRITICAL: if server system != local system, load the correct system BEFORE spawn apply
  // -----------------------------------------------------
  async handleWelcome(data) {
    const sys = this.normalizeSystemId(data.system_id);

    console.log("[WELCOME RAW]", data);
    const authoritativeValidation = validateAuthoritativeCombatStats(data, 'WELCOME');
    console.log("[WELCOME DEFENSE]", { armor: data?.armor, resistances: data?.resistances || {}, combat_stats: data?.combat_stats || data?.combatStats || null, authoritative_ok: authoritativeValidation.ok, missing: authoritativeValidation.missing });
    this._dockSentThisDock = false;
    console.log("[WELCOME SPAWN]", data.x, data.y, data.rot, "system_id=", sys);

    const gm = window.game?.manager || window.gameManager || window.game;
    if (!gm) {
      console.warn("[WELCOME] No GameManager available yet.");
      return;
    }

    // Determine what the client thinks is currently loaded
    const localSysRaw =
      gm.currentSystemId || gm.currentSystem || gm.systemId || gm.system_id || this.currentSystemId;
    const localSys = this.normalizeSystemId(localSysRaw);

    // If server says different system, switch the engine world first.
    if (sys && localSys && sys !== localSys) {
      console.warn("[WELCOME] System mismatch. Local:", localSys, "Server:", sys, "-> switching");

      // Clear any dock/starport notion (we are in space)
      try {
        if ("currentStarportId" in gm) gm.currentStarportId = null;
        if ("isDocked" in gm) gm.isDocked = false;
        if (typeof gm.setDocked === "function") gm.setDocked(false);
      } catch {}

      // Switch multiplayer channels if available
      try {
        if (window.multiplayer?.leaveSector) window.multiplayer.leaveSector(localSys);
      } catch {}
      try {
        if (window.multiplayer?.enterSector) window.multiplayer.enterSector(sys);
      } catch {}

      // Load the correct system scene
      try {
        if (typeof gm.loadSystem === "function") {
          const p = gm.loadSystem(sys, null);
          if (p && typeof p.then === "function") {
            await p;
          }
        }
      } catch (e) {
        console.warn("[WELCOME] loadSystem failed:", e?.message || e);
      }
    }

    // Mark space state
    this.isDocked = false;
    this.starportId = null;
    this.currentSystemId = sys;

    // Allow telemetry now that authoritative spawn is here
    this.awaitingSpawn = false;

    // Ensure ship visuals are visible (Authority-First mode hides them until spawn)
    try {
      const gm2 = window.game?.manager || window.gameManager || window.game;
      if (gm2?.ship?.sprite) gm2.ship.sprite.visible = true;
      if (gm2?.nameSprite) gm2.nameSprite.visible = true;
      if (gm2?.shieldMesh) gm2.shieldMesh.visible = true;
    } catch {}

    // Apply authoritative spawn
    if (typeof window.game?.setLocalPlayerSpawn === "function") {
      window.game.setLocalPlayerSpawn(data.x, data.y, data.rot);
    } else if (typeof gm.setLocalPlayerSpawn === "function") {
      gm.setLocalPlayerSpawn(data.x, data.y, data.rot);
    } else {
      // best-effort fallback
      try {
        if (gm.ship) {
          gm.ship.x = data.x;
          gm.ship.y = data.y;
          gm.ship.rotation = data.rot;
          if (gm.ship.sprite) {
            gm.ship.sprite.x = data.x;
            gm.ship.sprite.y = data.y;
            gm.ship.sprite.rotation = data.rot;
          }
        }
      } catch {}
    }

    try { window.dispatchEvent(new CustomEvent("sectorfall:authoritative_ship_state", { detail: data })); } catch {}

    console.log("[Backend] Handshake complete (in space)");
    if (data.server_id) console.log("[WELCOME SERVER_ID]", data.server_id);

    // Now join system for remote players
    this.send({
      type: "JOIN_SYSTEM",
      system_id: sys
    });
    console.log("[Backend] JOIN_SYSTEM sent for:", sys);
  }


  handleSystemStructures(data) {
    try {
      const gm = window.game?.manager || window.gameManager || window.game;
      if (gm && typeof gm.syncSystemStructures === 'function') {
        gm.syncSystemStructures(Array.isArray(data?.structures) ? data.structures : [], this.normalizeSystemId(data?.system_id || this.currentSystemId));
      }
    } catch (e) {
      console.warn('[Arena] handleSystemStructures failed:', e?.message || e);
    }
  }

  handleArenaJoined(data) {
    if (this.arenaHooks?.onJoined) this.arenaHooks.onJoined(data);
  }

  handleArenaJoinFailed(data) {
    if (this.arenaHooks?.onJoinFailed) this.arenaHooks.onJoinFailed(data);
  }

  handleArenaRespawn(data) {
    const gm = window.game?.manager || window.gameManager || window.game;
    try {
      if (gm && typeof gm.setLocalPlayerSpawn === 'function' && data?.spawn) {
        gm.setLocalPlayerSpawn(data.spawn.x, data.spawn.y, data.spawn.rot || 0);
      }
    } catch {}
    if (this.arenaHooks?.onRespawn) this.arenaHooks.onRespawn(data);
  }

  handleArenaLeft(data) {
    if (this.arenaHooks?.onLeft) this.arenaHooks.onLeft(data);
  }

  handleArenaReadyAck(data) {
    if (this.arenaHooks?.onReadyAck) this.arenaHooks.onReadyAck(data);
  }

  handleBattlegroundDefinition(data) {
    if (this.battlegroundHooks?.onBattlegroundDefinition) this.battlegroundHooks.onBattlegroundDefinition(data);
  }

  handleBattlegroundEntered(data) {
    if (this.battlegroundHooks?.onBattlegroundEntered) this.battlegroundHooks.onBattlegroundEntered(data);
  }

  handleBattlegroundEnterReady(data) {
    if (this.battlegroundHooks?.onBattlegroundEnterReady) this.battlegroundHooks.onBattlegroundEnterReady(data);
  }

  handleBattlegroundEnterFailed(data) {
    if (this.battlegroundHooks?.onBattlegroundEnterFailed) this.battlegroundHooks.onBattlegroundEnterFailed(data);
  }

  handleBattlegroundLeft(data) {
    if (this.battlegroundHooks?.onBattlegroundLeft) this.battlegroundHooks.onBattlegroundLeft(data);
  }

  handleBattlegroundState(data) {
    if (this.battlegroundHooks?.onBattlegroundState) this.battlegroundHooks.onBattlegroundState(data);
  }

  handleBattlegroundWaveStarted(data) {
    try {
      const gm = window.game?.manager || window.gameManager || window.game;
      if (gm && typeof gm.handleBattlegroundWaveStarted === 'function') gm.handleBattlegroundWaveStarted(data);
    } catch {}
    if (this.battlegroundHooks?.onBattlegroundWaveStarted) this.battlegroundHooks.onBattlegroundWaveStarted(data);
  }

  handleBattlegroundWaveCleared(data) {
    if (this.battlegroundHooks?.onBattlegroundWaveCleared) this.battlegroundHooks.onBattlegroundWaveCleared(data);
  }

  handleInitialNpcs(npcs) {
    try {
      const gm = window.game?.manager || window.gameManager || window.game;
      if (gm && typeof gm.handleInitialNpcs === 'function') gm.handleInitialNpcs(npcs);
    } catch {}
  }

  handleBattlegroundNpcSpawned(data) {
    try {
      const gm = window.game?.manager || window.gameManager || window.game;
      if (gm && typeof gm.handleBattlegroundNpcSpawned === 'function') gm.handleBattlegroundNpcSpawned(data);
    } catch {}
  }

  handleBattlegroundCompleted(data) {
    if (this.battlegroundHooks?.onBattlegroundCompleted) this.battlegroundHooks.onBattlegroundCompleted(data);
  }

  handleBattlegroundExtractStarted(data) {
    if (this.battlegroundHooks?.onBattlegroundExtractStarted) this.battlegroundHooks.onBattlegroundExtractStarted(data);
  }

  handleBattlegroundFailed(data) {
    if (this.battlegroundHooks?.onBattlegroundFailed) this.battlegroundHooks.onBattlegroundFailed(data);
  }


  handleInstanceBoundaryConfig(data) {
    try {
      const gm = window.game?.manager || window.gameManager || window.game;
      if (gm && typeof gm.setInstanceBoundaryConfig === 'function') gm.setInstanceBoundaryConfig(data || null);
    } catch {}
    if (this.instanceBoundaryHooks?.onBoundaryConfig) this.instanceBoundaryHooks.onBoundaryConfig(data);
  }

  handleInstanceBoundaryState(data) {
    try {
      const gm = window.game?.manager || window.gameManager || window.game;
      if (gm && typeof gm.setInstanceBoundaryState === 'function') gm.setInstanceBoundaryState(data || null);
    } catch {}
    if (this.instanceBoundaryHooks?.onBoundaryState) this.instanceBoundaryHooks.onBoundaryState(data);
  }

  // -----------------------------------------------------
  // INITIAL PLAYERS HANDLER
  // -----------------------------------------------------
  handleInitialPlayers(players) {
    if (this.isDocked) return;

    console.log("[Backend] Received INITIAL_PLAYERS:", players);
    if (!players || !players.length) return;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.userId === this.userId) continue;

      // Prefer the modern GameManager remote-player pipeline
      if (window.game && typeof window.game.upsertRemotePlayer === "function") {
        window.game.upsertRemotePlayer({
          id: p.userId,
          x: p.x,
          y: p.y,
          rot: p.rot,
          name: p.name || `CMDR_${String(p.userId).slice(0, 4)}`,
          shipType: p.shipType || p.ship_type || "OMNI SCOUT",
          ship_type: p.ship_type || p.shipType || "OMNI SCOUT",
          stats: p.stats,
          visual_config: p.visual_config,
          animation_state: p.animation_state
        });
      } else {
        // Fallback to legacy spawnRemoteShip hook
        this.spawnRemoteShip(p.userId, p.x, p.y, p.rot);
      }

      // Track presence only (rendering/movement is handled by GameManager)
      if (!remotePlayers.has(p.userId)) remotePlayers.set(p.userId, { userId: p.userId });
    }
  }

  // -----------------------------------------------------
  // PLAYER UPDATE HANDLER
  // -----------------------------------------------------
  handlePlayerUpdate(data) {
    if (this.isDocked) return;

    const state = normalizeRemotePlayerState(data || {});
    const id = state.id;
    if (!id || id === this.userId) return;

    if (!remotePlayers.has(id)) remotePlayers.set(id, { userId: id });

    if (window.game && typeof window.game.upsertRemotePlayer === "function") {
      window.game.upsertRemotePlayer(state);
    } else {
      if (!remotePlayers.get(id)?.sprite) this.spawnRemoteShip(id, state.x, state.y, state.rot);
    }
  }

  // -----------------------------------------------------
  // PLAYER LEFT HANDLER
  // -----------------------------------------------------
  handlePlayerLeft(userId) {
    if (this.isDocked) return;

    console.log("[Backend] Player left:", userId);

    // Tell GameManager to clean up meshes/name tags etc
    if (window.game && typeof window.game.despawnRemotePlayer === "function") {
      window.game.despawnRemotePlayer(userId);
    }
    remotePlayers.delete(userId);
  }

  // -----------------------------------------------------
  // REMOTE SHIP SPAWNER
  // -----------------------------------------------------
  spawnRemoteShip(userId, x, y, rot) {
    if (!window.game || typeof window.game.spawnRemoteShip !== "function") {
      console.error(
        "spawnRemoteShip missing: define window.game.spawnRemoteShip(userId, x, y, rot)"
      );
      return null;
    }

    // Spawn via GameManager wrapper; movement is handled by GameManager.
    window.game.spawnRemoteShip(userId, x, y, rot);

    return { userId };
  }

  // -----------------------------------------------------
  // TELEMETRY ACK / RTT
  // -----------------------------------------------------
  // -----------------------------------------------------
  // TELEMETRY ACK / RTT (throttled)
  // -----------------------------------------------------
  handleTelemetryAck(data) {
    if (this.isDocked) return;

    const now = Date.now();
    if (now - (this._lastAckLogAt || 0) < 2000) return; // log at most every 2s
    this._lastAckLogAt = now;

    const rtt = now - (data.clientTime || 0);
    console.log("REAL LATENCY: " + rtt + "ms (seq=" + (data.seq || 0) + ")");
  }


  // -----------------------------------------------------
  // SAFE SEND
  // -----------------------------------------------------
  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      this.socket.send(payload);
    } else {
      console.warn("[Backend] Cannot send message, socket not open.");
    }
  }

  // -----------------------------------------------------
  // DOCK REQUEST (NEW)
  // Persist "last space" telemetry at the moment docking starts/completes.
  // -----------------------------------------------------
  sendDock(starportId, telemetry) {
    if (!starportId) {
      console.warn("[Dock][Client] sendDock aborted: missing starportId");
      return;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn("[Dock][Client] sendDock aborted: socket not open", {
        starportId,
        readyState: this.socket?.readyState
      });
      return;
    }

    if (this._dockSentThisDock) {
      console.log("[Dock][Client] sendDock skipped: already sent for this dock", { starportId });
      return;
    }

    const payload = {
      type: "DOCK",
      userId: this.userId,
      starport_id: starportId
    };

    if (telemetry && typeof telemetry === "object") {
      const x = Number(telemetry.x);
      const y = Number(telemetry.y);
      const rot = Number(telemetry.rot);
      const vx = Number(telemetry.vx);
      const vy = Number(telemetry.vy);

      if (Number.isFinite(x)) payload.x = x;
      if (Number.isFinite(y)) payload.y = y;
      if (Number.isFinite(rot)) payload.rot = rot;
      if (Number.isFinite(vx)) payload.vx = vx;
      if (Number.isFinite(vy)) payload.vy = vy;
    }

    console.log("[Dock][Client] sending DOCK", payload);

    this._dockSentThisDock = true;
    this.awaitingSpawn = true;
    this.send(payload);
  }

  // -----------------------------------------------------
  // UNDOCK REQUEST (helper)
  // -----------------------------------------------------
  sendUndock(systemId, x, y, rot) {
    const payload = {
      type: "UNDOCK",
      userId: this.userId,
      system_id: this.normalizeSystemId(systemId)
    };

    // Only include coords if explicitly provided
    if (typeof x === "number") payload.x = x;
    if (typeof y === "number") payload.y = y;
    if (typeof rot === "number") payload.rot = rot;

    // Reset dock guard on undock so future docks can send again
    this._dockSentThisDock = false;

    // When undocking, wait for WELCOME before allowing local spawns
    this.awaitingSpawn = true;

    console.log("[Dock][Client] sending UNDOCK", payload);
    this.send(payload);
  }

  // -----------------------------------------------------
  // FIRE WEAPON REQUEST
  // -----------------------------------------------------
  sendFireWeapon(ship, weaponId = "primary", weaponMeta = null, fireSolution = null) {
    if (this.isDocked) return;
    if (this.awaitingSpawn) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!ship) return;

    let x =
      typeof ship.x === "number" ? ship.x : ship.sprite?.position?.x ?? ship.sprite?.x;
    let y =
      typeof ship.y === "number" ? ship.y : ship.sprite?.position?.y ?? ship.sprite?.y;

    const r0 = ship.rotation;
    const r1 = ship.rot;
    const r2 = ship.sprite?.rotation;
    let rot =
      typeof r0 === "number"
        ? r0
        : typeof r1 === "number"
        ? r1
        : typeof r2 === "number"
        ? r2
        : 0;

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

// Optional authoritative fire solution from GameManager (world-space muzzle + aim)
if (fireSolution && typeof fireSolution === "object") {
  const fx = Number(fireSolution.x);
  const fy = Number(fireSolution.y);
  const frot = Number(fireSolution.rot);
  if (Number.isFinite(fx) && Number.isFinite(fy)) {
    x = fx;
    y = fy;
  }
  if (Number.isFinite(frot)) {
    rot = frot;
  }
}


    const payload = {
      type: "FIRE_WEAPON",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      weapon_id: weaponId,
      // Optional metadata for server-side validation / weapon identification
      item_id: weaponMeta?.item_id || undefined,
      instance_id: weaponMeta?.instance_id || undefined,
      weapon_name: weaponMeta?.name || undefined,
      weapon_type: weaponMeta?.type || undefined,
      weapon_subtype: weaponMeta?.subtype || undefined,
      weaponsize: weaponMeta?.weaponsize || undefined,
      rarity: weaponMeta?.rarity || undefined,
      x,
      y,
      rot,
      aimX: (fireSolution && Number.isFinite(fireSolution.aimX)) ? fireSolution.aimX : undefined,
      aimY: (fireSolution && Number.isFinite(fireSolution.aimY)) ? fireSolution.aimY : undefined,
      vx: (fireSolution && Number.isFinite(fireSolution.vx)) ? fireSolution.vx : undefined,
      vy: (fireSolution && Number.isFinite(fireSolution.vy)) ? fireSolution.vy : undefined,
      t: (fireSolution && Number.isFinite(fireSolution.t)) ? fireSolution.t : Date.now(),
      beamRange: (fireSolution && Number.isFinite(fireSolution.beamRange)) ? fireSolution.beamRange : undefined,
      weapon_stats: (fireSolution && fireSolution.weapon_stats && typeof fireSolution.weapon_stats === 'object') ? fireSolution.weapon_stats : undefined,
      clientTime: Date.now()
    };

    this.socket.send(JSON.stringify(payload));
  }

  // -----------------------------------------------------
  // SELF / ENVIRONMENT DAMAGE (client -> EC2)
  // Used for collisions, NPC hits (until NPCs are server-sim), hazards.
  // We send already-applied deltas to avoid mismatched resist/armor math.
  // -----------------------------------------------------
  // -----------------------------------------------------
  // WORLD AUTHORITY REQUESTS
  // -----------------------------------------------------
  sendNpcHitRequest(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: "NPC_HIT_REQUEST",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now(),
      ...payload
    }));
  }

  sendAsteroidHitRequest(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: "ASTEROID_HIT_REQUEST",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now(),
      ...payload
    }));
  }

  sendStartMining(targetId, extra = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!targetId) return;
    const now = Date.now();
    const sameTarget = this._activeMiningTargetId && this._activeMiningTargetId === targetId;
    if (sameTarget && (now - this._lastMiningStartSentAt) < 150) return;
    this._activeMiningTargetId = targetId;
    this._lastMiningStartSentAt = now;
    this.socket.send(JSON.stringify({
      type: "START_MINING",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      target_id: targetId,
      clientTime: now,
      ...extra
    }));
  }

  sendStopMining(targetId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const finalTargetId = targetId || this._activeMiningTargetId || undefined;
    this._activeMiningTargetId = null;
    this._lastMiningStartSentAt = 0;
    this.socket.send(JSON.stringify({
      type: "STOP_MINING",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      target_id: finalTargetId,
      clientTime: Date.now()
    }));
  }


  sendLockTargetState({ targetId, isFriendly = false, targetType = undefined, lockRange = undefined, state = "lock" } = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!targetId && state !== "clear") return;

    const payload = {
      type: "LOCK_TARGET_STATE",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      state,
      target_id: targetId || undefined,
      isFriendly: !!isFriendly,
      targetType,
      lockRange: Number.isFinite(Number(lockRange)) ? Number(lockRange) : undefined,
      clientTime: Date.now()
    };
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });
    this.socket.send(JSON.stringify(payload));
  }

  clearLockTargetState(targetId = undefined, isFriendly = undefined) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const payload = {
      type: "LOCK_TARGET_STATE",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      state: "clear",
      target_id: targetId || undefined,
      isFriendly: (typeof isFriendly === "boolean") ? !!isFriendly : undefined,
      clientTime: Date.now()
    };
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });
    this.socket.send(JSON.stringify(payload));
  }

  sendSelfDamage({ hullDamage = 0, shieldDamage = 0, source = "environment", reason = "collision" } = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const h = Number(hullDamage);
    const s = Number(shieldDamage);

    if ((!Number.isFinite(h) || h <= 0) && (!Number.isFinite(s) || s <= 0)) return;

    this.socket.send(JSON.stringify({
      type: "SELF_DAMAGE",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      mode: "applied",
      hullDamage: Number.isFinite(h) ? h : 0,
      shieldDamage: Number.isFinite(s) ? s : 0,
      source,
      reason,
      clientTime: Date.now()
    }));
  }

  sendArenaEnter(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'ARENA_ENTER',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      beaconId: payload?.beaconId || null,
      clientTime: Date.now()
    }));
  }

  sendArenaLeave(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'ARENA_LEAVE',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now()
    }));
  }

  sendArenaReady(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'ARENA_READY',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now()
    }));
  }

  sendBattlegroundInspect(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'BATTLEGROUND_INSPECT',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      structureId: payload?.structureId || payload?.beaconId || null,
      clientTime: Date.now()
    }));
  }

  sendBattlegroundEnter(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'BATTLEGROUND_ENTER',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      structureId: payload?.structureId || payload?.beaconId || null,
      clientTime: Date.now()
    }));
  }

  sendBattlegroundReady(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'BATTLEGROUND_READY',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now()
    }));
  }

  sendBattlegroundLeave(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'BATTLEGROUND_LEAVE',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now()
    }));
  }

  sendBattlegroundExtract(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'BATTLEGROUND_EXTRACT',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now()
    }));
  }

  sendBattlegroundContinue(payload = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'BATTLEGROUND_CONTINUE',
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      clientTime: Date.now()
    }));
  }

  // -----------------------------------------------------
  // FX EVENT SENDER (client -> EC2)
  // Visual-only events that should be seen by other players.
  // Example: shield impact ripples.
  // -----------------------------------------------------
  sendFxEvent({ fx_type, x, y, angle, extra = null } = {}) {
    if (this.isDocked) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!fx_type) return;

    const payload = {
      type: "FX_EVENT",
      userId: this.userId,
      system_id: this.normalizeSystemId(this.currentSystemId),
      fx_type,
      x: Number.isFinite(Number(x)) ? Number(x) : undefined,
      y: Number.isFinite(Number(y)) ? Number(y) : undefined,
      angle: Number.isFinite(Number(angle)) ? Number(angle) : undefined,
      extra: (extra && typeof extra === "object") ? extra : undefined,
      clientTime: Date.now()
    };

    // Remove undefined keys
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });

    this.socket.send(JSON.stringify(payload));
  }

  // -----------------------------------------------------
  // TELEMETRY SENDER
  // -----------------------------------------------------
  // -----------------------------------------------------
  // TELEMETRY SENDER (client -> EC2)
  // - throttled (prevents spamming)
  // - world coords only
  // - robust vitals extraction (hp/shields/energy)
  // -----------------------------------------------------
  sendTelemetry(ship) {
    if (this.isDocked) return;
    if (this.awaitingSpawn) return; // prevent poisoning persistence during transitions
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!ship) return;

    // throttle (default 20/s)
    const now = Date.now();
    const minMs = this.telemetryMinIntervalMs || 0;
    if (minMs > 0 && now - (this._lastTelemetrySentAt || 0) < minMs) return;
    this._lastTelemetrySentAt = now;

    // Prefer authoritative/world coords
    let x =
      typeof ship.x === "number"
        ? ship.x
        : typeof ship.position?.x === "number"
        ? ship.position.x
        : typeof ship.body?.position?.x === "number"
        ? ship.body.position.x
        : undefined;

    let y =
      typeof ship.y === "number"
        ? ship.y
        : typeof ship.position?.y === "number"
        ? ship.position.y
        : typeof ship.body?.position?.y === "number"
        ? ship.body.position.y
        : undefined;

    const r0 = ship.rotation;
    const r1 = ship.rot;
    const r2 = ship.sprite?.rotation;
    let rot =
      typeof r0 === "number"
        ? r0
        : typeof r1 === "number"
        ? r1
        : typeof r2 === "number"
        ? r2
        : 0;

    const vx =
      typeof ship.vx === "number"
        ? ship.vx
        : typeof ship.velocity?.x === "number"
        ? ship.velocity.x
        : 0;

    const vy =
      typeof ship.vy === "number"
        ? ship.vy
        : typeof ship.velocity?.y === "number"
        ? ship.velocity.y
        : 0;

    if (!this._telemetryShapeLogged) {
      this._telemetryShapeLogged = true;
      console.log("[Telemetry SHAPE]", {
        hasSprite: !!ship.sprite,
        hasPos: !!ship.sprite?.position,
        shipX: ship.x,
        shipY: ship.y,
        spriteX: ship.sprite?.x,
        spriteY: ship.sprite?.y,
        posX: ship.sprite?.position?.x,
        posY: ship.sprite?.position?.y
      });
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;



    const sys = this.normalizeSystemId(ship.system_id || this.currentSystemId);

    // Robust vitals extraction (supports different engine shapes)
    const hp = this.pickNum(ship.hp, ship.hull, ship.health, ship.stats?.hp, ship.vitals?.hp);
    const maxHp = this.pickNum(ship.maxHp, ship.maxHull, ship.maxHealth, ship.stats?.maxHp, ship.vitals?.maxHp);

    const shields = this.pickNum(ship.shields, ship.stats?.shields, ship.vitals?.shields);
    const maxShields = this.pickNum(ship.maxShields, ship.stats?.maxShields, ship.vitals?.maxShields);

    const energy = this.pickNum(ship.energy, ship.stats?.energy, ship.vitals?.energy);
    const maxEnergy = this.pickNum(ship.maxEnergy, ship.stats?.maxEnergy, ship.vitals?.maxEnergy);

    const gm = window.game?.manager || window.gameManager || window.game;
    const animation_state = (gm && typeof gm.getAnimationState === "function") ? (gm.getAnimationState() || {}) : undefined;
    const visual_config = (gm && typeof gm.getVisualConfig === "function") ? (gm.getVisualConfig() || {}) : undefined;
    const fittings = gm?.fittings || gm?.gameState?.fittings || ship.fittings || ship.stats?.fittings || undefined;

    const payload = {
      type: "TELEMETRY",
      userId: this.userId,
      system_id: sys,
      seq: this.seq++,
      clientTime: now,
      x,
      y,
      rot,
      vx,
      vy,
      hp,
      maxHp,
      shields,
      maxShields,
      energy,
      maxEnergy,
      fittings,
      animation_state,
      visual_config
    };

    // Remove undefined vitals keys
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });

    this.socket.send(JSON.stringify(payload));
  }


  sendSpawnWorldObject(type = "loot", data = {}, pos = { x: 0, y: 0 }) {
    if (this.isDocked) return Promise.resolve(null);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);

    const requestId = `spawn-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingSpawns.set(requestId, { resolve, createdAt: Date.now() });
      this.socket.send(JSON.stringify({
        type: "SPAWN_WORLD_OBJECT",
        userId: this.userId,
        system_id: this.normalizeSystemId(this.currentSystemId),
        requestId,
        object_type: type,
        data,
        x: Number.isFinite(Number(pos?.x)) ? Number(pos.x) : 0,
        y: Number.isFinite(Number(pos?.y)) ? Number(pos.y) : 0,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingSpawns.get(requestId);
        if (pending) {
          this._pendingSpawns.delete(requestId);
          pending.resolve(null);
        }
      }, 4000);
    });
  }

  sendCollectWorldObject(objectId) {
    if (this.isDocked) return Promise.resolve(null);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    if (!objectId) return Promise.resolve(null);
    if (this._collectedObjectIds.has(objectId)) return Promise.resolve(null);

    const existingRequestId = this._pendingCollectsByObjectId.get(objectId);
    if (existingRequestId) {
      const existingPending = this._pendingCollects.get(existingRequestId);
      if (existingPending?.promise) return existingPending.promise;
      this._pendingCollectsByObjectId.delete(objectId);
    }

    const requestId = `collect-${Date.now()}-${++this.seq}`;
    const promise = new Promise((resolve) => {
      this._pendingCollects.set(requestId, { resolve, createdAt: Date.now(), objectId, promise: null });
      this._pendingCollectsByObjectId.set(objectId, requestId);

      let clientX = undefined;
      let clientY = undefined;
      let clientRot = undefined;
      try {
        const gm = window.game?.manager || window.gameManager || window.game;
        const s = gm?.ship;
        if (s) {
          clientX = (typeof s.x === "number") ? s.x : (typeof s.sprite?.x === "number" ? s.sprite.x : undefined);
          clientY = (typeof s.y === "number") ? s.y : (typeof s.sprite?.y === "number" ? s.sprite.y : undefined);
          clientRot = (typeof s.rotation === "number") ? s.rotation : (typeof s.sprite?.rotation === "number" ? s.sprite.rotation : undefined);
        }
      } catch {}

      this.socket.send(JSON.stringify({
        type: "COLLECT_WORLD_OBJECT",
        userId: this.userId,
        system_id: this.normalizeSystemId(this.currentSystemId),
        requestId,
        object_id: objectId,
        x: Number.isFinite(Number(clientX)) ? Number(clientX) : undefined,
        y: Number.isFinite(Number(clientY)) ? Number(clientY) : undefined,
        rot: Number.isFinite(Number(clientRot)) ? Number(clientRot) : undefined,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingCollects.get(requestId);
        if (pending) {
          this._pendingCollects.delete(requestId);
          if (pending.objectId) this._pendingCollectsByObjectId.delete(pending.objectId);
          pending.resolve(null);
        }
      }, 4000);
    });

    const pending = this._pendingCollects.get(requestId);
    if (pending) pending.promise = promise;
    return promise;
  }

  handleWorldObjectSpawned(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      const obj = data?.object || data;
      const objectId = obj?.id || obj?.object_id || obj?.objectId;
      if (objectId) this._collectedObjectIds.delete(objectId);
      if (gm && typeof gm.onNetworkObjectSpawned === "function") {
        gm.onNetworkObjectSpawned(obj);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:world_object_spawned", { detail: obj }));
    } catch {
      // ignore
    }
  }

  handleWorldObjectRemoved(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      const objectId = data?.object_id || data?.objectId || data;
      if (objectId) {
        this._collectedObjectIds.add(objectId);
        const pendingRequestId = this._pendingCollectsByObjectId.get(objectId);
        if (pendingRequestId) {
          this._pendingCollectsByObjectId.delete(objectId);
          const pending = this._pendingCollects.get(pendingRequestId);
          if (pending) this._pendingCollects.delete(pendingRequestId);
        }
      }
      if (gm && typeof gm.onNetworkObjectRemoved === "function") {
        gm.onNetworkObjectRemoved(objectId);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:world_object_removed", { detail: { objectId } }));
    } catch {
      // ignore
    }
  }

  handleCargoSync(data) {
    try {
      const pending = data?.requestId ? this._pendingCollects.get(data.requestId) : null;
      if (pending) {
        this._pendingCollects.delete(data.requestId);
        if (pending.objectId) {
          this._pendingCollectsByObjectId.delete(pending.objectId);
          this._collectedObjectIds.add(pending.objectId);
        }
        pending.resolve(Array.isArray(data?.cargo) ? data.cargo : (Array.isArray(data?.inventory) ? data.inventory : null));
      }

      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleCargoSync === "function") {
        gm.handleCargoSync(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:cargo_sync", { detail: data }));
    } catch {
      // ignore
    }
  }

  handleCollectWorldObjectResult(data) {
    const pending = data?.requestId ? this._pendingCollects.get(data.requestId) : null;
    if (pending) {
      this._pendingCollects.delete(data.requestId);
      if (pending.objectId) this._pendingCollectsByObjectId.delete(pending.objectId);
      if (data?.ok) {
        if (pending.objectId) this._collectedObjectIds.add(pending.objectId);
        if (Array.isArray(data?.cargo) || Array.isArray(data?.inventory)) {
          pending.resolve(Array.isArray(data?.cargo) ? data.cargo : data.inventory);
        } else {
          pending.resolve([]);
        }
      } else {
        if (data?.reason === 'not_found' && pending.objectId) {
          this._collectedObjectIds.add(pending.objectId);
        }
        console.warn("[Backend] COLLECT_WORLD_OBJECT rejected:", data?.reason || "unknown", data);
        pending.resolve(null);
      }
    } else if (data?.ok === false) {
      const objectId = data?.object_id || data?.objectId;
      if (data?.reason === 'not_found' && objectId) this._collectedObjectIds.add(objectId);
      console.warn("[Backend] COLLECT_WORLD_OBJECT rejected:", data?.reason || "unknown", data);
    }
  }

  handleNpcDamageEvent(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleServerNpcDamageEvent === "function") {
        gm.handleServerNpcDamageEvent(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:npc_damage", { detail: data }));
    } catch {}
  }

  handleNpcDestroyed(data) {
    try {
      this.lastNpcDestroyedEvent = {
        targetId: data?.targetId || null,
        killCreditId: data?.killCreditId || null,
        killCreditType: data?.killCreditType || null,
        finalBlowId: data?.finalBlowId || null,
        finalBlowType: data?.finalBlowType || null,
        assists: Array.isArray(data?.assists) ? data.assists : []
      };
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleServerNpcDestroyed === "function") {
        gm.handleServerNpcDestroyed(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:npc_destroyed", { detail: data }));
    } catch {}
  }

  handleAsteroidDamageEvent(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleServerAsteroidDamageEvent === "function") {
        gm.handleServerAsteroidDamageEvent(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:asteroid_damage", { detail: data }));
    } catch {}
  }

  handleAsteroidDepleted(data) {
    try {
      if (data?.targetId && this._activeMiningTargetId === data.targetId) {
        this._activeMiningTargetId = null;
        this._lastMiningStartSentAt = 0;
      }
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleServerAsteroidDepleted === "function") {
        gm.handleServerAsteroidDepleted(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:asteroid_depleted", { detail: data }));
    } catch {}
  }

  handleMiningState(data) {
    try {
      if (data?.state === 'stop') {
        this._activeMiningTargetId = null;
        this._lastMiningStartSentAt = 0;
      } else if (data?.state === 'start' && data?.targetId) {
        this._activeMiningTargetId = data.targetId;
      }
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleServerMiningState === "function") {
        gm.handleServerMiningState(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:mining_state", { detail: data }));
    } catch {}
  }

  handleTargetLockInvalidated(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleServerTargetLockInvalidated === "function") {
        gm.handleServerTargetLockInvalidated(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:target_lock_invalidated", { detail: data }));
    } catch {}
  }

  handleSpawnWorldObjectResult(data) {
    const pending = data?.requestId ? this._pendingSpawns.get(data.requestId) : null;
    if (!pending) return;
    this._pendingSpawns.delete(data.requestId);
    pending.resolve(data?.ok ? (data?.object || null) : null);
  }


  // -----------------------------------------------------
  // WEAPON FIRED (VISUAL ONLY)
  // -----------------------------------------------------
  handleWeaponFired(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleWeaponFired === "function") {
        gm.handleWeaponFired(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:weapon_fired", { detail: data }));
    } catch {
      // ignore
    }
  }

  // -----------------------------------------------------
  // SERVER-AUTH DAMAGE (AUTHORITATIVE VITALS)
  // -----------------------------------------------------
  handleDamageEvent(data) {
    try {
      const gm = window.game?.manager || window.gameManager;

      // Preferred: let GameManager handle it (updates local + remote)
      if (gm && typeof gm.handleServerDamageEvent === "function") {
        gm.handleServerDamageEvent(data);
        try {
          window.dispatchEvent(new CustomEvent("sectorfall:authoritative_ship_state", {
            detail: {
              hp: typeof data.hull === 'number' ? data.hull : data.hp,
              maxHp: data.maxHp,
              shields: data.shields,
              maxShields: data.maxShields,
              energy: data.energy,
              maxEnergy: data.maxEnergy,
              armor: data.armor,
              resistances: data.resistances,
              combat_stats: data.combat_stats || data.combatStats || null,
              fittings: data.fittings && typeof data.fittings === 'object' ? data.fittings : undefined
            }
          }));
        } catch {}
        return;
      }

      // Fallback: if this is damage to us, update the core stats object if present
      if (data?.targetId && data.targetId === this.userId && gm?.stats) {
        if (typeof data.hull === "number") gm.stats.hp = data.hull;
        if (typeof data.maxHp === "number") gm.stats.maxHp = data.maxHp;
        if (typeof data.shields === "number") gm.stats.shields = data.shields;
        if (typeof data.maxShields === "number") gm.stats.maxShields = data.maxShields;
        if (typeof gm.updateUi === "function") gm.updateUi();
      }
    } catch {
      // ignore
    }
  }

  // -----------------------------------------------------
  // SHIP DESTROYED
  // -----------------------------------------------------
  handleShipDestroyed(data) {
    try {
      const gm = window.game?.manager || window.gameManager;
      if (gm && typeof gm.handleShipDestroyed === "function") {
        gm.handleShipDestroyed(data);
        return;
      }
      window.dispatchEvent(new CustomEvent("sectorfall:ship_destroyed", { detail: data }));
    } catch {
      // ignore
    }
  }



  requestCommanderState() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId) return Promise.resolve(null);
    const requestId = `cmd-state-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingCommanderRequests.set(requestId, { resolve, createdAt: Date.now() });
      this.socket.send(JSON.stringify({
        type: "COMMANDER_GET_STATE",
        requestId,
        userId: this.userId,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingCommanderRequests.get(requestId);
        if (pending) {
          this._pendingCommanderRequests.delete(requestId);
          pending.resolve(null);
        }
      }, 4000);
    });
  }

  requestActivateShip({ shipId } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId || !shipId) return Promise.resolve(null);
    const requestId = `cmd-activate-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingActivateRequests.set(requestId, { resolve, createdAt: Date.now(), shipId });
      this.socket.send(JSON.stringify({
        type: "COMMANDER_ACTIVATE_SHIP",
        requestId,
        userId: this.userId,
        shipId,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingActivateRequests.get(requestId);
        if (pending) {
          this._pendingActivateRequests.delete(requestId);
          pending.resolve(null);
        }
      }, 6000);
    });
  }

  requestCommanderProfileUpdate({ commanderName = null, homeStarport = null, commanderStats = null } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId) return Promise.resolve(null);
    const requestId = `cmd-profile-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingCommanderProfileUpdates.set(requestId, { resolve, createdAt: Date.now() });
      this.socket.send(JSON.stringify({
        type: "COMMANDER_UPDATE_PROFILE",
        requestId,
        userId: this.userId,
        commander_name: commanderName,
        home_starport: homeStarport,
        commander_stats: commanderStats,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingCommanderProfileUpdates.get(requestId);
        if (pending) {
          this._pendingCommanderProfileUpdates.delete(requestId);
          pending.resolve(null);
        }
      }, 5000);
    });
  }

  requestRepairShip({ shipId, repairPercent } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId) return Promise.resolve(null);
    if (!shipId) return Promise.resolve(null);
    const requestId = `repair-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingRepairRequests.set(requestId, { resolve, createdAt: Date.now(), shipId });
      this.socket.send(JSON.stringify({
        type: "COMMANDER_REPAIR_SHIP",
        requestId,
        userId: this.userId,
        shipId,
        repairPercent: Number.isFinite(Number(repairPercent)) ? Number(repairPercent) : 0,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingRepairRequests.get(requestId);
        if (pending) {
          this._pendingRepairRequests.delete(requestId);
          pending.resolve(null);
        }
      }, 6000);
    });
  }


  requestRespawnHome({ starportId } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId || !starportId) return Promise.resolve(null);
    const requestId = `respawn-home-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingRespawnRequests.set(requestId, { resolve, createdAt: Date.now(), starportId });
      this.socket.send(JSON.stringify({
        type: 'RESPAWN_HOME',
        requestId,
        userId: this.userId,
        starport_id: starportId,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingRespawnRequests.get(requestId);
        if (pending) {
          this._pendingRespawnRequests.delete(requestId);
          pending.resolve(null);
        }
      }, 7000);
    });
  }

  requestFabricateBlueprint({ starportId, blueprintInstanceId, blueprintId, ingredients = [] } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId || !starportId || !blueprintInstanceId) return Promise.resolve(null);
    const requestId = `fabricate-${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this._pendingFabricationRequests.set(requestId, { resolve, createdAt: Date.now(), blueprintInstanceId, blueprintId });
      this.socket.send(JSON.stringify({
        type: 'FABRICATE_BLUEPRINT_REQUEST',
        requestId,
        userId: this.userId,
        starport_id: starportId,
        blueprintInstanceId,
        blueprintId,
        ingredients,
        clientTime: Date.now()
      }));
      setTimeout(() => {
        const pending = this._pendingFabricationRequests.get(requestId);
        if (pending) {
          this._pendingFabricationRequests.delete(requestId);
          pending.resolve(null);
        }
      }, 9000);
    });
  }

requestMarketData({ starportId, filter = "listings" } = {}) {
  if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId || !starportId) return Promise.resolve(null);
  const requestId = `market-data-${Date.now()}-${++this.seq}`;
  return new Promise((resolve) => {
    this._pendingMarketRequests.set(requestId, { resolve, createdAt: Date.now(), kind: "data" });
    this.socket.send(JSON.stringify({
      type: "MARKET_FETCH_DATA",
      requestId,
      userId: this.userId,
      starport_id: starportId,
      filter,
      clientTime: Date.now()
    }));
    setTimeout(() => {
      const pending = this._pendingMarketRequests.get(requestId);
      if (pending) {
        this._pendingMarketRequests.delete(requestId);
        pending.resolve(null);
      }
    }, 5000);
  });
}

requestCreateSellOrder({ itemType, quantity, pricePerUnit, starportId, itemData } = {}) {
  const payload = {
    item_type: itemType,
    quantity,
    price_per_uni: pricePerUnit,
    starport_id: starportId,
    item_data: itemData && typeof itemData === "object" ? itemData : null
  };
  console.log("[Market][Client->WS] requestCreateSellOrder", {
    itemType,
    quantity,
    pricePerUnit,
    starportId,
    hasItemData: !!payload.item_data,
    itemDataName: payload.item_data?.name || null,
    itemDataType: payload.item_data?.type || null
  });
  return this._requestMarketAction("MARKET_CREATE_SELL_ORDER", payload);
}

requestCreateBuyOrder({ itemType, quantity, pricePerUnit, starportId } = {}) {
  return this._requestMarketAction("MARKET_CREATE_BUY_ORDER", {
    item_type: itemType,
    quantity,
    price_per_uni: pricePerUnit,
    starport_id: starportId
  });
}

requestBuyListing({ listingId, quantity = 1, starportId } = {}) {
  return this._requestMarketAction("MARKET_BUY_LISTING", {
    listing_id: listingId,
    quantity,
    starport_id: starportId
  });
}

requestCancelSellOrder({ listingId, starportId } = {}) {
  return this._requestMarketAction("MARKET_CANCEL_SELL_ORDER", {
    listing_id: listingId,
    starport_id: starportId
  });
}

requestCancelBuyOrder({ orderId, starportId } = {}) {
  return this._requestMarketAction("MARKET_CANCEL_BUY_ORDER", {
    order_id: orderId,
    starport_id: starportId
  });
}

requestSeedNpcBlueprints({ starportId } = {}) {
  return this._requestMarketAction("MARKET_SEED_VENDOR", {
    starport_id: starportId
  });
}

_requestMarketAction(type, payload = {}) {
  if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.userId) return Promise.resolve(null);
  const requestId = `market-${Date.now()}-${++this.seq}`;
  return new Promise((resolve) => {
    this._pendingMarketRequests.set(requestId, { resolve, createdAt: Date.now(), kind: "action", type });
    this.socket.send(JSON.stringify({
      type,
      requestId,
      userId: this.userId,
      clientTime: Date.now(),
      ...payload
    }));
    setTimeout(() => {
      const pending = this._pendingMarketRequests.get(requestId);
      if (pending) {
        this._pendingMarketRequests.delete(requestId);
        pending.resolve(null);
      }
    }, 7000);
  });
}

handleMarketDataResult(data) {
  try {
    const requestId = data?.requestId;
    if (requestId) {
      const pending = this._pendingMarketRequests.get(requestId);
      if (pending) {
        this._pendingMarketRequests.delete(requestId);
        pending.resolve(data);
      }
    }
    window.dispatchEvent(new CustomEvent("sectorfall:market_data", { detail: data }));
  } catch {
    // ignore
  }
}

handleMarketActionResult(data) {
  try {
    const requestId = data?.requestId;
    if (requestId) {
      const pending = this._pendingMarketRequests.get(requestId);
      if (pending) {
        this._pendingMarketRequests.delete(requestId);
        pending.resolve(data);
      }
    }
    if (data?.commanderState && typeof data.commanderState === 'object') {
      window.dispatchEvent(new CustomEvent("sectorfall:commander_state", { detail: data.commanderState }));
    }
    window.dispatchEvent(new CustomEvent("sectorfall:market_action_result", { detail: data }));
  } catch {
    // ignore
  }
}

  handleCommanderState(data) {
    try {
      const requestId = data?.requestId;
      if (requestId) {
        const pending = this._pendingCommanderRequests.get(requestId);
        if (pending) {
          this._pendingCommanderRequests.delete(requestId);
          pending.resolve(data);
        }
      }
      window.dispatchEvent(new CustomEvent("sectorfall:commander_state", { detail: data }));
      if (data?.active_ship_stats) {
        window.dispatchEvent(new CustomEvent("sectorfall:authoritative_ship_state", { detail: data.active_ship_stats }));
      }
    } catch {
      // ignore
    }
  }

  handleCommanderProfileResult(data) {
    try {
      const requestId = data?.requestId;
      if (requestId) {
        const pending = this._pendingCommanderProfileUpdates.get(requestId);
        if (pending) {
          this._pendingCommanderProfileUpdates.delete(requestId);
          pending.resolve(data);
        }
      }
      if (data?.commanderState && typeof data.commanderState === "object") {
        window.dispatchEvent(new CustomEvent("sectorfall:commander_state", { detail: data.commanderState }));
      }
      window.dispatchEvent(new CustomEvent("sectorfall:commander_profile_result", { detail: data }));
    } catch {
      // ignore
    }
  }

  handleCommanderRepairResult(data) {
    try {
      const requestId = data?.requestId;
      if (requestId) {
        const pending = this._pendingRepairRequests.get(requestId);
        if (pending) {
          this._pendingRepairRequests.delete(requestId);
          pending.resolve(data);
        }
      }
      window.dispatchEvent(new CustomEvent("sectorfall:commander_repair_result", { detail: data }));
    } catch {
      // ignore
    }
  }

  handleCommanderActivateResult(data) {
    try {
      const requestId = data?.requestId;
      if (requestId) {
        const pending = this._pendingActivateRequests.get(requestId);
        if (pending) {
          this._pendingActivateRequests.delete(requestId);
          pending.resolve(data);
        }
      }
      if (data?.commanderState && typeof data.commanderState === "object") {
        window.dispatchEvent(new CustomEvent("sectorfall:commander_state", { detail: data.commanderState }));
      }
      if (data?.active_ship_stats && typeof data.active_ship_stats === "object") {
        window.dispatchEvent(new CustomEvent("sectorfall:authoritative_ship_state", { detail: data.active_ship_stats }));
      }
      window.dispatchEvent(new CustomEvent("sectorfall:commander_activate_result", { detail: data }));
    } catch {
      // ignore
    }
  }

  handleFabricationResult(data) {
    try {
      const requestId = data?.requestId;
      if (requestId) {
        const pending = this._pendingFabricationRequests.get(requestId);
        if (pending) {
          this._pendingFabricationRequests.delete(requestId);
          pending.resolve(data);
        }
      }
      if (data?.commanderState && typeof data.commanderState === 'object') {
        window.dispatchEvent(new CustomEvent('sectorfall:commander_state', { detail: data.commanderState }));
      }
      window.dispatchEvent(new CustomEvent('sectorfall:fabrication_result', { detail: data }));
    } catch {
      // ignore
    }
  }

  handleRespawnHomeResult(data) {
    try {
      const requestId = data?.requestId;
      if (requestId) {
        const pending = this._pendingRespawnRequests.get(requestId);
        if (pending) {
          this._pendingRespawnRequests.delete(requestId);
          pending.resolve(data);
        }
      }
      window.dispatchEvent(new CustomEvent('sectorfall:respawn_home_result', { detail: data }));
    } catch {
      // ignore
    }
  }



  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
} // ✅ IMPORTANT: class ends here

export const backendSocket = new BackendSocket();

// expose globally so app.js spawn-guard can read awaitingSpawn reliably
try {
  window.backendSocket = backendSocket;
} catch {
  // ignore in non-browser env
}