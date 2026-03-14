import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";
import { supabase } from "./supabaseClient.js";

const SERVER_ID = `EC2-${process.pid}`;

// -----------------------------------------------------
// TUNABLES
// -----------------------------------------------------
const PERSIST_INTERVAL_MS = 15000; // ✅ batch persist at most once per 15s per player
const DIRTY_MIN_INTERVAL_MS = 5000; // never persist more frequently than this
const MOVE_EPS = 10;                // minimum movement to consider "dirty"
const ROT_EPS = 0.25;               // minimum rotation delta to consider "dirty"
const VITALS_EPS = { hp: 2, shields: 2, energy: 5 }; // minimum vital change to persist
const BROADCAST_INTERVAL_MS = 50;   // server->clients update broadcast throttle (~20/s)
const SERVER_TICK_MS = 50;        // unified server simulation tick (~20/s)
const WORLD_CLEANUP_INTERVAL_MS = 5000;
const NPC_STATE_TTL_MS = 60000;
const ASTEROID_STATE_TTL_MS = 180000;


// -----------------------------------------------------
// NPC MODIFIERS (Phase 2)
// -----------------------------------------------------
const npcModifierRegistry = new Map();

function normalizeNpcModifierRow(row = {}) {
  return {
    id: row.id ?? null,
    key: String(row.key || "").trim(),
    displayName: String(row.display_name || row.displayName || row.key || "").trim(),
    description: String(row.description || "").trim(),
    effectText: String(row.effect_text || row.effectText || "").trim(),
    rarity: String(row.rarity || "rare").trim(),
    nameColor: String(row.name_color || row.nameColor || "yellow").trim(),
    spawnWeight: Number(row.spawn_weight ?? row.spawnWeight ?? 0) || 0,
    enabled: row.enabled !== false,
    shieldMult: Number(row.shield_mult ?? row.shieldMult ?? 1) || 1,
    hullMult: Number(row.hull_mult ?? row.hullMult ?? 1) || 1,
    damageMult: Number(row.damage_mult ?? row.damageMult ?? 1) || 1,
    speedMult: Number(row.speed_mult ?? row.speedMult ?? 1) || 1,
    allowedNpcTypes: Array.isArray(row.allowed_npc_types) ? row.allowed_npc_types : [],
    allowedZoneTypes: Array.isArray(row.allowed_zone_types) ? row.allowed_zone_types : [],
    minWave: row.min_wave ?? null,
    maxWave: row.max_wave ?? null,
    extraData: row.extra_data && typeof row.extra_data === "object" ? row.extra_data : {},
  };
}

async function loadNpcModifiers() {
  try {
    const { data, error } = await supabase
      .from("npc_modifiers")
      .select("*")
      .eq("enabled", true)
      .order("id", { ascending: true });

    if (error) {
      console.warn("[NPC Modifiers] failed to load definitions:", error?.message || error);
      return;
    }

    npcModifierRegistry.clear();

    for (const row of (data || [])) {
      const mod = normalizeNpcModifierRow(row);
      if (!mod.key) continue;
      npcModifierRegistry.set(mod.key, mod);
    }

    const count = npcModifierRegistry.size;
    const keys = [...npcModifierRegistry.keys()];
    if (count <= 0) {
      console.warn("[NPC Modifiers] loaded 0 definitions (table empty or all disabled)");
      return;
    }

    console.log(`[NPC Modifiers] loaded ${count} definition${count === 1 ? "" : "s"}`);
    console.log(`[NPC Modifiers] keys: ${keys.join(", ")}`);
  } catch (err) {
    console.warn("[NPC Modifiers] unexpected load failure:", err?.message || err);
  }
}

function getNpcModifierDefinition(key) {
  if (!key) return null;
  return npcModifierRegistry.get(String(key).trim()) || null;
}

function npcModifierAllowsValue(list, value) {
  if (!Array.isArray(list) || list.length <= 0) return true;
  const wanted = String(value || '').trim().toLowerCase();
  if (!wanted) return false;
  return list.some((entry) => String(entry || '').trim().toLowerCase() === wanted);
}

function isNpcModifierEligible(mod, { npcType = '', zoneType = '', waveNumber = 0 } = {}) {
  if (!mod || mod.enabled === false) return false;
  if (!npcModifierAllowsValue(mod.allowedNpcTypes, npcType)) return false;
  if (!npcModifierAllowsValue(mod.allowedZoneTypes, zoneType)) return false;
  const wave = Number(waveNumber) || 0;
  if (Number.isFinite(mod.minWave) && mod.minWave !== null && wave < Number(mod.minWave)) return false;
  if (Number.isFinite(mod.maxWave) && mod.maxWave !== null && wave > Number(mod.maxWave)) return false;
  return true;
}

function chooseNpcModifierForSpawn(context = {}) {
  const mods = [...npcModifierRegistry.values()].filter((mod) => isNpcModifierEligible(mod, context));
  if (mods.length <= 0) return null;
  const totalWeight = mods.reduce((sum, mod) => sum + Math.max(0, Number(mod.spawnWeight) || 0), 0);
  if (totalWeight <= 0) return mods[0] || null;
  let roll = Math.random() * totalWeight;
  for (const mod of mods) {
    roll -= Math.max(0, Number(mod.spawnWeight) || 0);
    if (roll <= 0) return mod;
  }
  return mods[mods.length - 1] || null;
}


// -----------------------------------------------------
// PLAYER REGISTRY
// -----------------------------------------------------
// socket -> playerState
const players = new Map();
const fleetsById = new Map(); // fleetId -> { fleetId, leaderId, memberIds, createdAt, updatedAt }
const fleetIdByUserId = new Map(); // userId -> fleetId
const pendingFleetInvites = new Map(); // inviteId -> { inviteId, fleetId, inviterId, targetUserId, createdAt, expiresAt }
const COLLECT_RANGE_AUTHORITATIVE = 260;
const COLLECT_RANGE_CLIENT_HINT = 900;
const COLLECT_SERVER_SNAPSHOT_GRACE = 1200;
const PLAYER_LOCK_MAX_RANGE = 5000;
const SECURE_SPACE_PVP_THRESHOLD = 0.5;
const SYSTEM_SECURITY_VALUES = Object.freeze({
  'cygnus-prime': 1.0,
  'aurelia-ridge': 0.9,
  'novara-reach': 0.8,
  'krios-void': 0.8,
  'helios-fringe': 0.7,
  'solaris-bay': 0.7,
  'veiled-nebula': 0.6,
  'obsidian-void': 0.5,
  'plasma-fringe': 0.7,
  'iron-reach': 0.6,
  'pulsar-point': 0.5,
  'void-reach': 0.3,
  'shattered-echo': 0.2,
  'abyssal-rift': 0.4,
  'obsidian-fringe': 0.3,
  'nebula-heart': 0.2,
  'event-horizon': 0.1,
  'frozen-waste': 0.0,
  'dark-core': 0.0,
  'terminal-void': 0.1,
  'stygian-reach': 0.0,
  'abyssal-maw': 0.0,
  'entropy-pulse': 0.1,
  'singularity-edge': 0.0,
  'oblivion-fringe': 0.1,
  'zenith-null': 0.0,
  'nadir-point': 0.1,
  'calamity-rift': 0.0,
  'penumbra-gate': 0.1,
  'umbra-shard': 0.0,
  'gloom-basin': 0.1,
  'silent-echo': 0.0,
  'whispering-void': 0.1,
  'revenant-reach': 0.0,
  'spectre-point': 0.1,
  'phantom-sector': 0.0,
  'wraith-cluster': 0.1,
  'banshee-call': 0.0,
  'nightmare-realm': 0.1,
  'dread-anchor': 0.0,
  'despair-horizon': 0.1,
  'hopes-end': 0.0,
  'omega-void': 0.1,
  'alpha-decay': 0.0,
  'quantum-grave': 0.1,
  'stellar-tomb': 0.0
});
const FLEET_MAX_MEMBERS = 4;
const FLEET_INVITE_EXPIRE_MS = 30000;
const FLEET_INVITE_COOLDOWN_MS = 2500;


function createDirtySections() {
  return {
    telemetry: false,
    ship: false,
    commander: false,
    profile: false,
  };
}

function ensureDirtySections(player) {
  if (!player) return createDirtySections();
  if (!player._dirtySections || typeof player._dirtySections !== "object") {
    player._dirtySections = createDirtySections();
  } else {
    if (player._dirtySections.telemetry !== true) player._dirtySections.telemetry = false;
    if (player._dirtySections.ship !== true) player._dirtySections.ship = false;
    if (player._dirtySections.commander !== true) player._dirtySections.commander = false;
    if (player._dirtySections.profile !== true) player._dirtySections.profile = false;
  }
  return player._dirtySections;
}

function hasDirtySections(player) {
  const dirty = ensureDirtySections(player);
  return !!(dirty.telemetry || dirty.ship || dirty.commander || dirty.profile);
}

function clearDirtySections(player, sections = ["telemetry", "ship", "commander", "profile"]) {
  const dirty = ensureDirtySections(player);
  for (const section of sections) dirty[section] = false;
  player._dirty = hasDirtySections(player);
}

function markPlayerDirty(player, sections = ["ship"], options = {}) {
  if (!player) return;
  const dirty = ensureDirtySections(player);
  const list = Array.isArray(sections) ? sections : [sections];
  for (const section of list) {
    if (section && Object.prototype.hasOwnProperty.call(dirty, section)) {
      dirty[section] = true;
    }
  }
  player._dirty = true;
  if (options.forceImmediatePersist) {
    player._lastPersistAt = 0;
  }
}

// -----------------------------------------------------
// PHASE 2B WORLD AUTHORITY REGISTRIES (hybrid first pass)
// -----------------------------------------------------
const npcStatesBySystem = new Map();      // systemId -> Map(targetId -> npcState)
const asteroidStatesBySystem = new Map(); // systemId -> Map(targetId -> asteroidState)
const projectileStatesBySystem = new Map(); // systemId -> Map(projectileId -> projectileState)

const NPC_MAX_RANGE = 2200;
const ASTEROID_MAX_RANGE = 1200;
const PROJECTILE_STATE_TTL_MS = 8000;
const MISSILE_TURN_RATE_RAD = 0.12;
const MISSILE_AOE_RADIUS = 90;
const WORLD_MAX_DAMAGE = 500;
const MINING_CYCLE_MS_MIN = 250;
const MINING_CYCLE_MS_MAX = 4000;
const MINING_YIELD_MAX = 250;
const MINING_REFRESH_TIMEOUT_MS = 1500;
const DAMAGE_CONTRIBUTION_WINDOW_MS = 30000;
const LOOT_PUBLIC_TIMEOUT_MS = 45000;

// targetKey -> [{ attackerId, sourceType, sourceId, amount, weapon_id, weapon_name, damageMode, timestamp }]
const recentDamageByTarget = new Map();
const arenaInstances = new Map();
const battlegroundInstances = new Map();
const NPC_DETECTION_RANGE_DEFAULT = 1200;
const NPC_LEASH_RADIUS_DEFAULT = 2200;
const NPC_ALLY_ASSIST_RANGE = 1200;
const NPC_THREAT_DECAY_PER_SEC = 6;
const NPC_DETECTION_THREAT_PER_SEC = 4;
const NPC_DIRECT_DAMAGE_THREAT_MULT = 1.0;
const NPC_ALLY_DAMAGE_THREAT_MULT = 0.5;
const NPC_STATE_BROADCAST_MIN_MS = 250;

const ARENA_SYSTEM_PREFIX = 'arena:';
const BATTLEGROUND_SYSTEM_PREFIX = 'bg:pve:';
const ARENA_RESPAWN_DELAY_MS = 1800;
const ARENA_INSTANCE_CAP = 24;
const BATTLEGROUND_WAVE_COUNTDOWN_MS = 5000;
const BATTLEGROUND_NPC_LOADOUTS = {
  cartel_patrol: { loadoutId: 'cartel_patrol_scout', spawnRadius: 520, collisionRadius: 22 },
  pirate_interceptor: { loadoutId: 'cartel_patrol_scout', spawnRadius: 520, collisionRadius: 22 },
  cartel_gunship: { loadoutId: 'cartel_patrol_gunship', spawnRadius: 620, collisionRadius: 32 },
  pirate_gunship: { loadoutId: 'cartel_patrol_gunship', spawnRadius: 620, collisionRadius: 32 },
};

const INSTANCE_BOUNDARY_STATE_BROADCAST_MIN_MS = 250;
const ARENA_BOUNDARY_DEFAULT = Object.freeze({
  enabled: true,
  centerX: 0,
  centerY: 0,
  safeRadius: 700,
  softRadius: 900,
  hardRadius: 1100,
  speedMultiplierSoft: 0.8,
  speedMultiplierHard: 0.55,
  damagePerSecondSoft: 4,
  damagePerSecondHard: 22,
  maxDamagePerSecond: 42,
  visual: {
    type: 'nebula_ring',
    assetKey: 'arena_boundary_nebula_01',
    theme: 'arena'
  }
});
const BATTLEGROUND_BOUNDARY_DEFAULT = Object.freeze({
  enabled: true,
  centerX: 0,
  centerY: 0,
  safeRadius: 900,
  softRadius: 1100,
  hardRadius: 1400,
  speedMultiplierSoft: 0.5,
  speedMultiplierHard: 0.12,
  damagePerSecondSoft: 18,
  damagePerSecondHard: 160,
  maxDamagePerSecond: 260,
  visual: {
    type: 'nebula_ring',
    assetKey: 'battleground_boundary_nebula_01',
    theme: 'battleground'
  }
});

const NPC_REWARD_MODE_WORLD_LOOT = 'world_loot';
const NPC_REWARD_MODE_ACTIVITY = 'activity_reward';
const NPC_REWARD_MODE_NONE = 'none';

function isBattlegroundNpc(npc) {
  return !!(npc && (npc.runtimeContext === 'battleground' || npc.ruleProfile === 'battleground_wave' || npc.battlegroundInstanceId));
}

function shouldNpcUsePassiveThreatDetection(npc) {
  return true;
}

function shouldNpcUseWorldLeash(npc) {
  return !isBattlegroundNpc(npc);
}

function shouldNpcUseAllyAssist(npc) {
  return !isBattlegroundNpc(npc);
}

function isBattlegroundSystemId(systemId) {
  return typeof systemId === 'string' && systemId.startsWith(BATTLEGROUND_SYSTEM_PREFIX);
}

function isInstancedSystemId(systemId) {
  return isArenaSystemId(systemId) || isBattlegroundSystemId(systemId);
}


function mergeBoundaryConfig(baseConfig, overrideConfig = null) {
  const base = (baseConfig && typeof baseConfig === 'object') ? baseConfig : {};
  const override = (overrideConfig && typeof overrideConfig === 'object' && !Array.isArray(overrideConfig)) ? overrideConfig : {};
  const visual = {
    ...((base.visual && typeof base.visual === 'object') ? base.visual : {}),
    ...((override.visual && typeof override.visual === 'object') ? override.visual : {})
  };
  return {
    ...base,
    ...override,
    visual,
    enabled: override.enabled !== false && base.enabled !== false,
    centerX: finiteNum(override.centerX, finiteNum(base.centerX, 0)),
    centerY: finiteNum(override.centerY, finiteNum(base.centerY, 0)),
    safeRadius: Math.max(100, finiteNum(override.safeRadius, finiteNum(base.safeRadius, 700))),
    softRadius: Math.max(100, finiteNum(override.softRadius, finiteNum(base.softRadius, 900))),
    hardRadius: Math.max(100, finiteNum(override.hardRadius, finiteNum(base.hardRadius, 1100))),
    speedMultiplierSoft: clamp(finiteNum(override.speedMultiplierSoft, finiteNum(base.speedMultiplierSoft, 0.8)), 0.15, 1),
    speedMultiplierHard: clamp(finiteNum(override.speedMultiplierHard, finiteNum(base.speedMultiplierHard, 0.55)), 0.1, 1),
    damagePerSecondSoft: Math.max(0, finiteNum(override.damagePerSecondSoft, finiteNum(base.damagePerSecondSoft, 4))),
    damagePerSecondHard: Math.max(0, finiteNum(override.damagePerSecondHard, finiteNum(base.damagePerSecondHard, 22))),
    maxDamagePerSecond: Math.max(0, finiteNum(override.maxDamagePerSecond, finiteNum(base.maxDamagePerSecond, 42)))
  };
}

function getInstanceBoundaryConfig(systemId) {
  const sys = String(systemId || '').trim();
  if (!sys) return null;
  if (isArenaSystemId(sys)) {
    const inst = Array.from(arenaInstances.values()).find((row) => row?.system_id === sys) || null;
    return mergeBoundaryConfig(ARENA_BOUNDARY_DEFAULT, inst?.boundary || null);
  }
  if (isBattlegroundSystemId(sys)) {
    const inst = findBattlegroundInstanceBySystemId(sys);
    const override = inst?.boundary || inst?.config?.boundary || null;
    return mergeBoundaryConfig(BATTLEGROUND_BOUNDARY_DEFAULT, override);
  }
  return null;
}

function buildInstanceBoundaryPayload(systemId) {
  const cfg = getInstanceBoundaryConfig(systemId);
  if (!cfg || cfg.enabled === false) return null;
  return {
    type: 'INSTANCE_BOUNDARY_CONFIG',
    system_id: String(systemId || '').trim() || null,
    enabled: true,
    centerX: cfg.centerX,
    centerY: cfg.centerY,
    safeRadius: cfg.safeRadius,
    softRadius: cfg.softRadius,
    hardRadius: cfg.hardRadius,
    speedMultiplierSoft: cfg.speedMultiplierSoft,
    speedMultiplierHard: cfg.speedMultiplierHard,
    damagePerSecondSoft: cfg.damagePerSecondSoft,
    damagePerSecondHard: cfg.damagePerSecondHard,
    maxDamagePerSecond: cfg.maxDamagePerSecond,
    visual: cfg.visual || null,
    serverTime: Date.now()
  };
}

function sendInstanceBoundaryConfig(socket, systemId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const payload = buildInstanceBoundaryPayload(systemId) || {
    type: 'INSTANCE_BOUNDARY_CONFIG',
    system_id: String(systemId || '').trim() || null,
    enabled: false,
    serverTime: Date.now()
  };
  socket.send(JSON.stringify(payload));
}

function getBoundaryZoneState(systemId, x, y) {
  const cfg = getInstanceBoundaryConfig(systemId);
  if (!cfg || cfg.enabled === false) return null;
  const dx = finiteNum(x, 0) - cfg.centerX;
  const dy = finiteNum(y, 0) - cfg.centerY;
  const distance = Math.hypot(dx, dy);
  let zone = 'safe';
  if (distance >= cfg.hardRadius) zone = 'hard';
  else if (distance >= cfg.softRadius) zone = 'soft';
  const softSpan = Math.max(1, cfg.hardRadius - cfg.softRadius);
  const depthBeyondSoft = Math.max(0, distance - cfg.softRadius);
  const depthRatio = Math.max(0, Math.min(1.75, depthBeyondSoft / softSpan));
  let speedMultiplier = 1;
  let damagePerSecond = 0;
  if (zone === 'soft') {
    const t = Math.max(0, Math.min(1, depthRatio));
    const edgeSoftMultiplier = Math.max(cfg.speedMultiplierSoft, 0.92);
    speedMultiplier = edgeSoftMultiplier - ((edgeSoftMultiplier - cfg.speedMultiplierSoft) * t);
    damagePerSecond = cfg.damagePerSecondSoft + ((cfg.damagePerSecondHard - cfg.damagePerSecondSoft) * t * 0.45);
  } else if (zone === 'hard') {
    const t = Math.max(0, Math.min(1, depthRatio));
    const hardFloor = Math.max(0.12, cfg.speedMultiplierHard * 0.7);
    speedMultiplier = cfg.speedMultiplierHard - ((cfg.speedMultiplierHard - hardFloor) * t);
    damagePerSecond = Math.min(cfg.maxDamagePerSecond, cfg.damagePerSecondHard + ((cfg.maxDamagePerSecond - cfg.damagePerSecondHard) * t));
  }
  return {
    config: cfg,
    distance,
    zone,
    depthRatio,
    speedMultiplier: clamp(speedMultiplier, 0.1, 1),
    damagePerSecond: Math.max(0, damagePerSecond),
    warningText: zone === 'hard'
      ? 'Boundary storm critical. Structural integrity collapsing.'
      : (zone === 'soft' ? 'Boundary storm detected. Thrusters disrupted.' : null)
  };
}

function tickInstanceBoundaries(now, dtMs = SERVER_TICK_MS) {
  const dtSeconds = Math.max(0, finiteNum(dtMs, SERVER_TICK_MS)) / 1000;
  for (const [socket, player] of players) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !player || player.docked || !isInstancedSystemId(player.system_id)) continue;
    const state = getBoundaryZoneState(player.system_id, player.x, player.y);
    if (!state) continue;

    if (state.zone !== 'safe') {
      const radialDx = finiteNum(player.x, 0) - finiteNum(state.config?.centerX, 0);
      const radialDy = finiteNum(player.y, 0) - finiteNum(state.config?.centerY, 0);
      const radialLen = Math.hypot(radialDx, radialDy);
      const ux = radialLen > 0.0001 ? (radialDx / radialLen) : 1;
      const uy = radialLen > 0.0001 ? (radialDy / radialLen) : 0;
      const vx = finiteNum(player.vx, 0);
      const vy = finiteNum(player.vy, 0);
      const radialVelocity = (vx * ux) + (vy * uy);
      const tangentX = vx - (radialVelocity * ux);
      const tangentY = vy - (radialVelocity * uy);
      const depthT = Math.max(0, Math.min(1, finiteNum(state.depthRatio, 0)));
      const isBattleground = isBattlegroundSystemId(player.system_id);

      let outwardMultiplier;
      let inwardMultiplier;
      let tangentMultiplier;

      if (state.zone === 'hard') {
        outwardMultiplier = isBattleground
          ? (0.12 - (0.1 * depthT))
          : Math.max(0.18, Math.min(0.72, state.speedMultiplier + 0.03));
        inwardMultiplier = isBattleground ? 0.78 : 0.72;
        tangentMultiplier = isBattleground ? 0.4 : 0.52;
      } else {
        outwardMultiplier = isBattleground
          ? (0.45 - (0.2 * depthT))
          : Math.max(0.4, Math.min(0.9, state.speedMultiplier + 0.06));
        inwardMultiplier = isBattleground ? 0.9 : 0.86;
        tangentMultiplier = isBattleground ? 0.72 : 0.78;
      }

      const nextRadialVelocity = radialVelocity >= 0
        ? (radialVelocity * Math.max(0.02, outwardMultiplier))
        : (radialVelocity * Math.max(0.25, inwardMultiplier));
      player.vx = (ux * nextRadialVelocity) + (tangentX * Math.max(0.15, tangentMultiplier));
      player.vy = (uy * nextRadialVelocity) + (tangentY * Math.max(0.15, tangentMultiplier));
      if (player.lastSpaceTelemetry) {
        player.lastSpaceTelemetry.vx = player.vx;
        player.lastSpaceTelemetry.vy = player.vy;
      }
      const tickDamage = state.damagePerSecond * dtSeconds;
      if (tickDamage > 0.01) {
        applyAuthoritativePlayerDamage({
          systemId: player.system_id,
          target: player,
          attackerId: null,
          sourceType: 'environment',
          sourceId: 'instance_boundary',
          weapon_id: 'instance_boundary',
          weapon_name: 'Boundary Storm',
          rawAmount: tickDamage,
          damageType: 'thermal',
          damageMode: 'hazard',
          source: 'environment',
          reason: 'instance_boundary',
          impactX: player.x,
          impactY: player.y,
          serverTime: now,
        });
      }
    }

    const lastSentAt = finiteNum(player._instanceBoundaryLastSentAt, 0);
    const lastZone = String(player._instanceBoundaryLastZone || '');
    if (lastZone !== state.zone || (now - lastSentAt) >= INSTANCE_BOUNDARY_STATE_BROADCAST_MIN_MS) {
      player._instanceBoundaryLastZone = state.zone;
      player._instanceBoundaryLastSentAt = now;
      socket.send(JSON.stringify({
        type: 'INSTANCE_BOUNDARY_STATE',
        system_id: player.system_id,
        zone: state.zone,
        distance: Number(state.distance.toFixed(2)),
        speedMultiplier: state.speedMultiplier,
        damagePerSecond: Number(state.damagePerSecond.toFixed(2)),
        centerX: state.config.centerX,
        centerY: state.config.centerY,
        safeRadius: state.config.safeRadius,
        softRadius: state.config.softRadius,
        hardRadius: state.config.hardRadius,
        warningText: state.warningText,
        visual: state.config.visual || null,
        serverTime: now
      }));
    }
  }
}

function isArenaSystemId(systemId) {
  return typeof systemId === 'string' && systemId.startsWith(ARENA_SYSTEM_PREFIX);
}

function makeArenaSystemId(instanceId) {
  return `${ARENA_SYSTEM_PREFIX}${String(instanceId || 'arena-001')}`;
}

function makeBattlegroundSystemId(instanceId) {
  return `${BATTLEGROUND_SYSTEM_PREFIX}${String(instanceId || 'instance')}`;
}

function pickArenaSpawn(index = 0) {
  const spawns = [
    { x: -520, y: 0, rot: 0 },
    { x: 520, y: 0, rot: Math.PI },
    { x: 0, y: 520, rot: -Math.PI / 2 },
    { x: 0, y: -520, rot: Math.PI / 2 }
  ];
  return spawns[Math.abs(index) % spawns.length];
}

function getOrCreateArenaInstance() {
  for (const [, inst] of arenaInstances) {
    if ((inst.members?.size || 0) < ARENA_INSTANCE_CAP) return inst;
  }
  const instanceId = `arena-${String(arenaInstances.size + 1).padStart(3, '0')}`;
  const inst = { instanceId, system_id: makeArenaSystemId(instanceId), members: new Set(), respawnCursor: 0, boundary: mergeBoundaryConfig(ARENA_BOUNDARY_DEFAULT, null) };
  arenaInstances.set(instanceId, inst);
  return inst;
}

function removePlayerFromArenaInstances(userId) {
  for (const [instanceId, inst] of arenaInstances) {
    inst.members?.delete(userId);
    if ((inst.members?.size || 0) <= 0) arenaInstances.delete(instanceId);
  }
}

function createBattlegroundInstance(definition, structure) {
  const instanceId = `pve-${crypto.randomUUID().slice(0, 8)}`;
  const inst = {
    instanceId,
    system_id: makeBattlegroundSystemId(instanceId),
    battlegroundKey: definition?.key || null,
    structureId: structure?.id || null,
    members: new Set(),
    createdAt: Date.now(),
    config: (definition?.config && typeof definition.config === 'object') ? definition.config : {},
    rewardMode: definition?.reward_mode || null,
    rewardCurrency: definition?.reward_currency || 'credits',
    dropPolicy: definition?.drop_policy || 'none',
    phase: 'idle',
    statusLabel: 'STANDBY',
    currentWave: 0,
    pendingWaveNumber: 0,
    countdownEndsAt: 0,
    bankedCredits: 0,
    waveDefinitions: [],
    activeNpcIds: new Set(),
    pendingNpcActivations: [],
    boundary: mergeBoundaryConfig(BATTLEGROUND_BOUNDARY_DEFAULT, definition?.config?.boundary || null)
  };
  battlegroundInstances.set(instanceId, inst);
  return inst;
}

function findBattlegroundInstanceBySystemId(systemId) {
  for (const inst of battlegroundInstances.values()) {
    if (inst?.system_id === systemId) return inst;
  }
  return null;
}

function removePlayerFromBattlegroundInstances(userId) {
  for (const [instanceId, inst] of battlegroundInstances) {
    inst.members?.delete(userId);
    if ((inst.members?.size || 0) <= 0) battlegroundInstances.delete(instanceId);
  }
}

function movePlayerToArenaInstance(player, instance) {
  if (!player || !instance) return null;
  const cameFromArena = isArenaSystemId(player.system_id) || !!player?.arenaState?.inArena;
  const returnSnapshot = cameFromArena ? (player?.arenaState?.returnSnapshot || null) : {
    system_id: player.system_id,
    x: finiteNum(player.x, 0),
    y: finiteNum(player.y, 0),
    rot: finiteNum(player.rot, 0),
    vx: finiteNum(player.vx, 0),
    vy: finiteNum(player.vy, 0),
    starport_id: player.starport_id || null,
    docked: false
  };
  removePlayerFromArenaInstances(player.userId);
  instance.members.add(player.userId);
  const spawn = pickArenaSpawn(instance.respawnCursor++);
  player.arenaState = player.arenaState || {};
  player.arenaState.inArena = true;
  player.arenaState.instanceId = instance.instanceId;
  player.arenaState.returnSnapshot = returnSnapshot;
  player.arenaState.awaitingReady = true;
  player.arenaState.snapshot = {
    hp: finiteNum(player.maxHp, player.hp || 100),
    shields: finiteNum(player.maxShields, player.shields || 0),
    energy: finiteNum(player.maxEnergy, player.energy || 100),
    ship_type: player.ship_type || 'OMNI SCOUT'
  };
  player.system_id = instance.system_id;
  player.docked = false;
  player.starport_id = null;
  player.x = spawn.x;
  player.y = spawn.y;
  player.rot = spawn.rot;
  player.vx = 0;
  player.vy = 0;
  player.hp = player.arenaState.snapshot.hp;
  player.shields = player.arenaState.snapshot.shields;
  player.energy = player.arenaState.snapshot.energy;
  player.lastSpaceTelemetry = { x: spawn.x, y: spawn.y, rot: spawn.rot, vx: 0, vy: 0 };
  clearValidatedLock(player);
  return spawn;
}

function sendArenaRespawn(socket, player, now = Date.now()) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !player) return;
  const instanceId = player?.arenaState?.instanceId || 'arena-001';
  socket.send(JSON.stringify({
    type: 'ARENA_RESPAWN',
    instanceId,
    system_id: player.system_id,
    spawn: { x: player.x, y: player.y, rot: player.rot },
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    serverTime: now
  }));
}

function queueArenaRespawn(target, targetSocket, attackerId = null, serverTime = Date.now()) {
  if (!target || !targetSocket) return;
  const instanceId = target?.arenaState?.instanceId || 'arena-001';
  const inst = arenaInstances.get(instanceId) || { instanceId, system_id: target.system_id, members: new Set([target.userId]), respawnCursor: 0 };
  if (!arenaInstances.has(instanceId)) arenaInstances.set(instanceId, inst);
  broadcastToSystem(target.system_id, {
    type: 'FX_EVENT',
    fx_type: 'arena_destruction',
    attackerId,
    targetId: target.userId,
    x: target.x,
    y: target.y,
    serverTime
  });
  setTimeout(() => {
    if (!players.has(targetSocket)) return;
    const current = players.get(targetSocket);
    if (!current || !current.arenaState?.inArena) return;
    const snapshot = current.arenaState?.snapshot || {};
    const spawn = pickArenaSpawn(inst.respawnCursor++);
    current.x = spawn.x;
    current.y = spawn.y;
    current.rot = spawn.rot;
    current.vx = 0;
    current.vy = 0;
    current.hp = finiteNum(current.maxHp, snapshot.hp || current.hp || 100);
    current.shields = finiteNum(current.maxShields, snapshot.shields || current.shields || 0);
    current.energy = finiteNum(current.maxEnergy, snapshot.energy || current.energy || 100);
    if (current.arenaState) current.arenaState.awaitingReady = true;
    markPlayerDirty(current, ["ship", "telemetry"]);
    sendArenaRespawn(targetSocket, current, Date.now());
  }, ARENA_RESPAWN_DELAY_MS);
}

async function loadPublicStructuresForSystem(systemId) {
  const sys = String(systemId || 'cygnus-prime');
  try {
    const { data, error } = await supabase
      .from('syndicate_structures')
      .select('id, syndicate_id, system_id, parent_starport_id, structure_type, asset_key, x, y, rotation, collision_radius, interaction_radius, state, is_public, is_targetable, is_destroyable, structure_name, config, metadata')
      .eq('system_id', sys)
      .eq('state', 'active')
      .eq('is_public', true);
    if (error) {
      console.warn('[Structures] load failed:', sys, error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[Structures] exception:', sys, e?.message || e);
    return [];
  }
}

async function sendSystemStructures(socket, systemId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const structures = await loadPublicStructuresForSystem(systemId);
  socket.send(JSON.stringify({ type: 'SYSTEM_STRUCTURES', system_id: systemId, structures }));
}

async function loadBattlegroundDefinitionByKey(key) {
  const battlegroundKey = String(key || '').trim();
  if (!battlegroundKey) return null;
  try {
    const { data, error } = await supabase
      .from('battleground_definitions')
      .select('id, key, display_name, mode_type, owner_faction, is_public, max_public_wave, reward_mode, reward_currency, drop_policy, config')
      .eq('key', battlegroundKey)
      .maybeSingle();
    if (error) {
      console.warn('[Battleground] definition load failed:', battlegroundKey, error.message);
      return null;
    }
    return data ? normalizeBattlegroundDefinitionRow(data) : null;
  } catch (e) {
    console.warn('[Battleground] definition load exception:', battlegroundKey, e?.message || e);
    return null;
  }
}

async function resolveBattlegroundStructure(systemId, structureId) {
  const structures = await loadPublicStructuresForSystem(systemId);
  const wantedId = String(structureId || '').trim();
  return structures.find((row) => String(row?.id || '') === wantedId && String(row?.structure_type || '').toLowerCase() === 'battleground_beacon') || null;
}


function safeParseBattlegroundJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizeBattlegroundDefinitionRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    config: safeParseBattlegroundJson(row.config, {}) || {}
  };
}

function normalizeBattlegroundWaveRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    spawn_config: safeParseBattlegroundJson(row.spawn_config, { spawns: [] }) || { spawns: [] }
  };
}

async function loadBattlegroundWaveDefinitions(definitionId) {
  if (!definitionId) return [];
  try {
    const { data, error } = await supabase
      .from('battleground_wave_definitions')
      .select('id, battleground_definition_id, wave_number, spawn_config, credit_reward, threat_label')
      .eq('battleground_definition_id', definitionId)
      .order('wave_number', { ascending: true });
    if (error) {
      console.warn('[Battleground] wave load failed:', definitionId, error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[Battleground] wave load exception:', definitionId, e?.message || e);
    return [];
  }
}

function battlegroundSpawnPoint(index = 0, radius = 520) {
  const points = [
    { x: 0, y: -1 },
    { x: 0.92, y: -0.34 },
    { x: 0.92, y: 0.34 },
    { x: 0, y: 1 },
    { x: -0.92, y: 0.34 },
    { x: -0.92, y: -0.34 },
  ];
  const base = points[Math.abs(index) % points.length];
  return {
    x: Number((base.x * radius).toFixed(1)),
    y: Number((base.y * radius).toFixed(1)),
    rot: Number((Math.atan2(-base.y, -base.x)).toFixed(4))
  };
}

function sendBattlegroundState(inst, extra = {}) {
  if (!inst?.system_id) return;
  const enemiesRemaining = inst.activeNpcIds instanceof Set ? inst.activeNpcIds.size : 0;
  const displayedWave = inst.phase === 'countdown'
    ? finiteNum(extra.waveNumber ?? inst.pendingWaveNumber ?? inst.currentWave, 0)
    : finiteNum(extra.waveNumber ?? inst.currentWave, 0);
  const payload = {
    type: 'BATTLEGROUND_STATE',
    instanceId: inst.instanceId,
    battlegroundKey: inst.battlegroundKey || null,
    system_id: inst.system_id,
    phase: inst.phase || 'idle',
    currentWave: displayedWave,
    waveNumber: displayedWave,
    maxWave: Array.isArray(inst.waveDefinitions) ? inst.waveDefinitions.length : 0,
    enemiesRemaining,
    bankedCredits: Math.max(0, Math.round(finiteNum(inst.bankedCredits, 0))),
    rewardMode: inst.rewardMode || null,
    rewardCurrency: inst.rewardCurrency || null,
    canExtract: !!extra.canExtract,
    canContinue: !!extra.canContinue,
    statusLabel: extra.statusLabel || inst.statusLabel || 'STANDBY',
    choice: extra.choice || null,
    reason: extra.reason || null,
    waveReward: Math.max(0, Math.round(finiteNum(extra.waveReward, 0))),
    serverTime: Date.now(),
  };
  if (Number.isFinite(extra.countdownRemaining)) payload.countdownRemaining = Math.max(0, Math.ceil(extra.countdownRemaining));
  broadcastToSystem(inst.system_id, payload);
}

function cleanupBattlegroundNpcState(inst) {
  if (!inst?.system_id) return;
  const reg = npcStatesBySystem.get(inst.system_id);
  if (!reg) return;
  const ids = new Set();
  if (inst.activeNpcIds instanceof Set) {
    for (const id of inst.activeNpcIds) ids.add(id);
  }
  const pending = Array.isArray(inst.pendingNpcActivations) ? inst.pendingNpcActivations : [];
  for (const entry of pending) {
    if (entry?.npcState?.id) ids.add(entry.npcState.id);
  }
  for (const id of ids) reg.delete(id);
  if (reg.size === 0) npcStatesBySystem.delete(inst.system_id);
  inst.activeNpcIds = new Set();
  inst.pendingNpcActivations = [];
}

function clearBattlegroundPlayerAggro(userId, systemId, now = Date.now()) {
  const targetUserId = String(userId || '').trim();
  if (!targetUserId || !isBattlegroundSystemId(systemId)) return;

  const npcRegistry = npcStatesBySystem.get(systemId);
  if (npcRegistry) {
    for (const [, npc] of npcRegistry) {
      if (!npc || npc.destroyed) continue;
      let changed = false;
      if (npc.threatTable && Object.prototype.hasOwnProperty.call(npc.threatTable, targetUserId)) {
        delete npc.threatTable[targetUserId];
        changed = true;
      }
      if (npc.targetId === targetUserId) {
        npc.targetId = null;
        npc.targetType = 'player';
        npc.combatState = 'IDLE';
        npc.leashing = false;
        changed = true;
      }
      if (changed) broadcastNpcCombatState(systemId, npc, now, true);
    }
  }

  const projectileRegistry = projectileStatesBySystem.get(systemId);
  if (projectileRegistry) {
    for (const [projectileId, proj] of projectileRegistry) {
      if (!proj) continue;
      const ownedByBattlegroundNpc = typeof proj.ownerId === 'string' && proj.ownerId.startsWith(`bg-`);
      if (proj.targetId === targetUserId || ownedByBattlegroundNpc) {
        projectileRegistry.delete(projectileId);
      }
    }
    if (projectileRegistry.size === 0) projectileStatesBySystem.delete(systemId);
  }
}

function createBattlegroundNpcState(inst, waveNumber, spawnDef, groupIndex, npcIndex, delayMs = 0) {
  const npcType = String(spawnDef?.npcType || 'cartel_patrol').trim().toLowerCase();
  const profile = BATTLEGROUND_NPC_LOADOUTS[npcType] || BATTLEGROUND_NPC_LOADOUTS.cartel_patrol;
  const point = battlegroundSpawnPoint((groupIndex * 3) + npcIndex, profile.spawnRadius || 520);
  const npcId = `bg-${inst.instanceId}-w${waveNumber}-g${groupIndex}-n${npcIndex}`;
  const isGunship = profile.loadoutId === 'cartel_patrol_gunship';
  const baseShipType = isGunship ? 'PIRATE GUNSHIP' : 'PIRATE INTERCEPTOR';
  const baseMaxHp = isGunship ? 420 : 220;
  const baseMaxShields = isGunship ? 240 : 90;
  const shouldRollModifier = Math.random() < 0.10;
  const appliedModifier = shouldRollModifier ? chooseNpcModifierForSpawn({ npcType, zoneType: 'battleground', waveNumber }) : null;
  const maxHp = Math.max(1, Math.round(baseMaxHp * (Number(appliedModifier?.hullMult) || 1)));
  const maxShields = Math.max(0, Math.round(baseMaxShields * (Number(appliedModifier?.shieldMult) || 1)));
  const shipType = appliedModifier?.displayName ? `${appliedModifier.displayName} ${baseShipType}` : baseShipType;
  if (appliedModifier) {
    console.log(`[NPC Modifiers] battleground spawn modifier applied: key=${appliedModifier.key} npcId=${npcId} npcType=${npcType} wave=${Number(waveNumber) || 0}`);
  }
  const npcState = {
    id: npcId,
    type: 'NPC',
    shipType,
    classId: profile.loadoutId,
    isBio: false,
    cargo: 0,
    cargoType: undefined,
    cargoQL: 1,
    cargoQLBand: undefined,
    x: point.x,
    y: point.y,
    spawnX: point.x,
    spawnY: point.y,
    hp: maxHp,
    maxHp,
    shields: maxShields,
    maxShields,
    armor: isGunship ? 0.24 : 0.16,
    kineticRes: isGunship ? 0.12 : 0.05,
    thermalRes: isGunship ? 0.08 : 0.04,
    blastRes: isGunship ? 0.12 : 0.04,
    collisionRadius: profile.collisionRadius || (isGunship ? 32 : 22),
    detectionRadius: 1200,
    leashRadius: 1200,
    factionKey: 'Crimson Rift Cartel',
    threatTable: {},
    combatState: 'IDLE',
    targetId: null,
    targetType: 'player',
    destroyed: false,
    battlegroundInstanceId: inst.instanceId,
    battlegroundWave: waveNumber,
    battlegroundNpcType: npcType,
    modifierKeys: appliedModifier ? [appliedModifier.key] : [],
    modifiers: appliedModifier ? [{
      key: appliedModifier.key,
      displayName: appliedModifier.displayName,
      description: appliedModifier.description,
      effectText: appliedModifier.effectText,
      nameColor: appliedModifier.nameColor,
      rarity: appliedModifier.rarity,
    }] : [],
    nameColor: appliedModifier?.nameColor || null,
    rewardMode: NPC_REWARD_MODE_ACTIVITY,
    activityRewardMode: inst?.rewardMode || NPC_REWARD_MODE_ACTIVITY,
    worldLootClass: 'instance_activity',
    dropPolicy: 'activity_reward',
    runtimeContext: 'battleground',
    ruleProfile: 'battleground_wave',
    suppressLoot: true,
    suppressRespawn: true,
    lastUpdatedAt: Date.now(),
    lastBroadcastAt: 0,
    _lastBroadcastState: '',
  };
  return {
    dueAt: Date.now() + Math.max(0, finiteNum(delayMs, 0)),
    npcState,
    clientSpawn: {
      id: npcId,
      x: point.x,
      y: point.y,
      rot: point.rot,
      delayMs: Math.max(0, finiteNum(delayMs, 0)),
      loadoutId: profile.loadoutId,
      shipType,
      hp: maxHp,
      maxHp,
      shields: maxShields,
      maxShields,
      instanceId: inst.instanceId,
      waveNumber,
      npcType,
      modifierKeys: appliedModifier ? [appliedModifier.key] : [],
      modifiers: appliedModifier ? [{
        key: appliedModifier.key,
        displayName: appliedModifier.displayName,
        description: appliedModifier.description,
        effectText: appliedModifier.effectText,
        nameColor: appliedModifier.nameColor,
        rarity: appliedModifier.rarity,
      }] : [],
      nameColor: appliedModifier?.nameColor || null
    }
  };
}

function queueBattlegroundWave(inst, waveNumber, now = Date.now()) {
  const waveDef = Array.isArray(inst?.waveDefinitions) ? inst.waveDefinitions.find((row) => finiteNum(row?.wave_number, 0) === finiteNum(waveNumber, 0)) : null;
  if (!inst || !waveDef) return false;
  cleanupBattlegroundNpcState(inst);
  inst.phase = 'countdown';
  inst.statusLabel = 'WAVE INBOUND';
  inst.currentWave = finiteNum(waveNumber, 0);
  inst.pendingWaveNumber = finiteNum(waveNumber, 0);
  inst.countdownEndsAt = now + BATTLEGROUND_WAVE_COUNTDOWN_MS;
  inst.pendingNpcActivations = [];
  inst.activeNpcIds = new Set();
  sendBattlegroundState(inst, {
    statusLabel: 'WAVE INBOUND',
    waveNumber: inst.pendingWaveNumber,
    countdownRemaining: BATTLEGROUND_WAVE_COUNTDOWN_MS / 1000
  });
  return true;
}

function activateBattlegroundWave(inst, waveDef, now = Date.now()) {
  if (!inst || !waveDef) return;
  const normalizedWaveDef = normalizeBattlegroundWaveRow(waveDef);
  const spawnGroups = Array.isArray(normalizedWaveDef?.spawn_config?.spawns) ? normalizedWaveDef.spawn_config.spawns : [];
  console.log(`[Battleground] activating wave: instance=${inst.instanceId} wave=${finiteNum(normalizedWaveDef?.wave_number, 0)} groups=${spawnGroups.length}`);
  if (spawnGroups.length <= 0) {
    console.warn(`[Battleground] wave has no usable spawn groups after normalization: instance=${inst.instanceId} wave=${finiteNum(normalizedWaveDef?.wave_number, 0)}`);
  }
  const pendingActivations = [];
  const spawns = [];
  let groupIndex = 0;
  for (const group of spawnGroups) {
    const count = Math.max(0, Math.round(finiteNum(group?.count, 0)));
    const delayMs = Math.max(0, finiteNum(group?.delayMs, 0));
    for (let i = 0; i < count; i += 1) {
      const built = createBattlegroundNpcState(inst, normalizedWaveDef.wave_number, group, groupIndex, i, delayMs);
      pendingActivations.push({ dueAt: now + built.clientSpawn.delayMs, npcState: built.npcState, clientSpawn: built.clientSpawn });
      spawns.push(built.clientSpawn);
    }
    groupIndex += 1;
  }
  inst.currentWave = finiteNum(normalizedWaveDef.wave_number, 0);
  inst.pendingWaveNumber = inst.currentWave;
  inst.phase = 'active';
  inst.statusLabel = 'WAVE ACTIVE';
  inst.activeNpcIds = new Set(spawns.map((row) => row.id));
  inst.pendingNpcActivations = pendingActivations;
  broadcastToSystem(inst.system_id, {
    type: 'BATTLEGROUND_WAVE_STARTED',
    instanceId: inst.instanceId,
    battlegroundKey: inst.battlegroundKey || null,
    waveNumber: inst.currentWave,
    enemiesRemaining: inst.activeNpcIds.size,
    spawns,
    serverTime: now
  });
  sendBattlegroundState(inst, { statusLabel: 'WAVE ACTIVE', waveNumber: inst.currentWave });
}

async function resolveBattlegroundWaveCleared(inst, now = Date.now()) {
  if (!inst || inst.phase === 'awaiting_choice' || inst.phase === 'completed' || inst.phase === 'failed') return;
  const waveDef = Array.isArray(inst.waveDefinitions) ? inst.waveDefinitions.find((row) => finiteNum(row?.wave_number, 0) === finiteNum(inst.currentWave, 0)) : null;
  const waveReward = Math.max(0, Math.round(finiteNum(waveDef?.credit_reward, 0)));
  inst.bankedCredits = Math.max(0, Math.round(finiteNum(inst.bankedCredits, 0))) + waveReward;
  const nextWave = Array.isArray(inst.waveDefinitions) ? inst.waveDefinitions.find((row) => finiteNum(row?.wave_number, 0) === (finiteNum(inst.currentWave, 0) + 1)) : null;
  const canContinue = !!(inst.config?.continueAfterWave && nextWave);
  const canExtract = !!inst.config?.extractAfterWave;
  inst.phase = canContinue || canExtract ? 'awaiting_choice' : 'completed';
  inst.statusLabel = inst.phase === 'completed' ? 'ALL WAVES CLEARED' : 'WAVE CLEARED';
  broadcastToSystem(inst.system_id, {
    type: 'BATTLEGROUND_WAVE_CLEARED',
    instanceId: inst.instanceId,
    battlegroundKey: inst.battlegroundKey || null,
    waveNumber: inst.currentWave,
    waveReward,
    bankedCredits: inst.bankedCredits,
    canExtract,
    canContinue,
    nextWaveNumber: nextWave?.wave_number || null,
    serverTime: now
  });
  if (inst.phase === 'completed') {
    broadcastToSystem(inst.system_id, {
      type: 'BATTLEGROUND_COMPLETED',
      instanceId: inst.instanceId,
      battlegroundKey: inst.battlegroundKey || null,
      bankedCredits: inst.bankedCredits,
      currentWave: inst.currentWave,
      canExtract,
      canContinue: false,
      serverTime: now
    });
  }
  sendBattlegroundState(inst, {
    statusLabel: inst.statusLabel,
    canExtract: canExtract || inst.phase === 'completed',
    canContinue,
    choice: (canExtract || canContinue) ? 'extract_continue' : null,
    waveReward,
    waveNumber: inst.currentWave
  });
}

function onBattlegroundNpcDestroyed(inst, npcId, now = Date.now()) {
  if (!inst || !(inst.activeNpcIds instanceof Set) || !npcId) return;
  inst.activeNpcIds.delete(npcId);
  sendBattlegroundState(inst, { statusLabel: 'WAVE ACTIVE', waveNumber: inst.currentWave });
  if (inst.activeNpcIds.size <= 0 && (!Array.isArray(inst.pendingNpcActivations) || inst.pendingNpcActivations.length <= 0)) {
    resolveBattlegroundWaveCleared(inst, now).catch((e) => {
      console.warn('[Battleground] resolve wave cleared failed:', e?.message || e);
    });
  }
}

async function finalizeBattlegroundFailure(player, reason = 'destroyed') {
  if (!player?.battlegroundState?.instanceId) return;
  clearBattlegroundPlayerAggro(player.userId, player.system_id, Date.now());
  const instanceId = player.battlegroundState.instanceId;
  const inst = battlegroundInstances.get(instanceId);
  if (inst && inst.phase === 'failed') return;

  const definitionKey = player?.battlegroundState?.definitionKey || inst?.battlegroundKey || null;
  const lostBank = !!(inst?.config?.failLosesBank ?? true);

  if (inst) {
    inst.phase = 'failed';
    if (lostBank) inst.bankedCredits = 0;
    inst.statusLabel = 'RUN FAILED';
    cleanupBattlegroundNpcState(inst);
    sendBattlegroundState(inst, { statusLabel: 'RUN FAILED', reason, waveNumber: inst.currentWave });
    broadcastToSystem(inst.system_id, {
      type: 'BATTLEGROUND_COMPLETED',
      instanceId: inst.instanceId,
      battlegroundKey: inst.battlegroundKey || null,
      failed: true,
      reason,
      bankedCredits: Math.max(0, Math.round(finiteNum(inst.bankedCredits, 0))),
      currentWave: inst.currentWave || 0,
      canExtract: false,
      canContinue: false,
      serverTime: Date.now()
    });
  }

  const ref = findPlayerSocketByUserId(player.userId);
  removePlayerFromBattlegroundInstances(player.userId);
  player.battlegroundState = null;
  player.battlegroundReturnSnapshot = null;
  clearValidatedLock(player);
  markPlayerDirty(player, ['ship', 'telemetry']);

  try {
    await clearArenaReturnSnapshot(player.userId);
  } catch (e) {
    console.warn('[Battleground] failed to clear return snapshot after destruction:', player.userId, e?.message || e);
  }

  if (!ref?.socket) return;

  ref.socket.send(JSON.stringify({
    type: 'BATTLEGROUND_FAILED',
    instanceId: inst?.instanceId || instanceId,
    battlegroundKey: definitionKey,
    reason,
    lostBank,
    bankedCredits: Math.max(0, Math.round(finiteNum(inst?.bankedCredits, 0))),
    currentWave: finiteNum(inst?.currentWave, 0),
    serverTime: Date.now()
  }));
}

async function handleBattlegroundExtract(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.battlegroundState?.inBattleground) return;
  const inst = battlegroundInstances.get(player.battlegroundState.instanceId);
  if (!inst) return;
  const phase = String(inst.phase || '');
  if (phase !== 'awaiting_choice' && phase !== 'completed') return;

  const payout = Math.max(0, Math.round(finiteNum(inst.bankedCredits, 0)));
  const highestWave = Math.max(1, Math.round(finiteNum(inst.currentWave, 0)));
  const durationSeconds = Math.max(0, Math.round((Date.now() - finiteNum(inst.createdAt, Date.now())) / 1000));
  const returnSnapshot = player.battlegroundReturnSnapshot || player.arenaReturnSnapshot || null;
  const returnSystemId = String(returnSnapshot?.system_id || 'cygnus-prime').trim() || 'cygnus-prime';
  const extractDelayMs = 1550;

  const commander = await loadCommanderDataRow(player.userId);
  const commanderName = String(commander?.commander_name || '').trim();
  if (payout > 0 && String(inst.rewardCurrency || 'credits').toLowerCase() === 'credits') {
    await changeCommanderCredits(player.userId, payout, {
      reason: 'battleground_extract',
      referenceType: 'battleground',
      referenceId: inst.battlegroundKey || inst.instanceId,
      metadata: { instanceId: inst.instanceId, wave: inst.currentWave || 0, rewardMode: inst.rewardMode || null }
    });
  }
  if (commanderName) {
    await insertBattlegroundLeaderboardRun({
      battlegroundKey: inst.battlegroundKey || inst.instanceId,
      playerId: player.userId,
      commanderName,
      highestWave,
      rewardSecured: payout,
      durationSeconds
    });
  } else {
    console.warn('[Battleground][Leaderboard] skipped insert: commander_name missing for', player.userId);
  }

  inst.bankedCredits = 0;
  inst.phase = 'extracting';
  inst.statusLabel = 'EXTRACTING';
  cleanupBattlegroundNpcState(inst);

  socket.send(JSON.stringify({
    type: 'BATTLEGROUND_EXTRACT_STARTED',
    instanceId: inst.instanceId,
    battlegroundKey: inst.battlegroundKey || null,
    currentWave: highestWave,
    securedCredits: payout,
    returnSystemId,
    transitionDelayMs: extractDelayMs,
    serverTime: Date.now()
  }));

  setTimeout(async () => {
    try {
      if (!players.has(socket)) return;
      const currentPlayer = players.get(socket);
      if (!currentPlayer?.battlegroundState?.inBattleground) return;
      await handleBattlegroundLeave(socket, { userId: currentPlayer.userId, _skipRewardReset: true, _reason: 'extract' });
    } catch (e) {
      console.warn('[Battleground] delayed extract leave failed:', e?.message || e);
    }
  }, extractDelayMs);
}

async function handleBattlegroundReady(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.battlegroundState?.inBattleground || !player.battlegroundState?.awaitingReady) return;
  const inst = battlegroundInstances.get(player.battlegroundState.instanceId);
  if (!inst) return;

  player.battlegroundState.awaitingReady = false;
  inst.readyRequestedAt = Date.now();

  if (!Array.isArray(inst.waveDefinitions) || inst.waveDefinitions.length <= 0) return;
  queueBattlegroundWave(inst, 1, Date.now());
}

async function handleBattlegroundContinue(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.battlegroundState?.inBattleground) return;
  const inst = battlegroundInstances.get(player.battlegroundState.instanceId);
  if (!inst) return;
  if (inst.phase !== 'awaiting_choice') return;
  const nextWaveNumber = finiteNum(inst.currentWave, 0) + 1;
  const nextWave = Array.isArray(inst.waveDefinitions) ? inst.waveDefinitions.find((row) => finiteNum(row?.wave_number, 0) === nextWaveNumber) : null;
  if (!nextWave) {
    broadcastToSystem(inst.system_id, {
      type: 'BATTLEGROUND_COMPLETED',
      instanceId: inst.instanceId,
      battlegroundKey: inst.battlegroundKey || null,
      bankedCredits: inst.bankedCredits,
      currentWave: inst.currentWave,
      canExtract: !!inst.config?.extractAfterWave,
      canContinue: false,
      serverTime: Date.now()
    });
    inst.phase = 'completed';
    sendBattlegroundState(inst, { statusLabel: 'ALL WAVES CLEARED', canExtract: !!inst.config?.extractAfterWave, canContinue: false, waveNumber: inst.currentWave });
    return;
  }
  queueBattlegroundWave(inst, nextWaveNumber, Date.now());
}

function tickBattlegrounds(now) {
  if ((battlegroundInstances?.size || 0) > 0) {
    if (!globalThis.__bgLastTickAliveLogAt || (now - globalThis.__bgLastTickAliveLogAt) >= 1000) {
      globalThis.__bgLastTickAliveLogAt = now;
      console.log(`[Battleground] tick alive: now=${now} instances=${battlegroundInstances.size}`);
    }
  }
  for (const [instanceId, inst] of battlegroundInstances) {
    if (!inst) continue;
    if ((inst.members?.size || 0) <= 0) {
      cleanupBattlegroundNpcState(inst);
      battlegroundInstances.delete(instanceId);
      continue;
    }
    if (inst.phase === 'countdown' && inst.countdownEndsAt) {
      if (!inst._lastCountdownLogAt || (now - inst._lastCountdownLogAt) >= 1000) {
        inst._lastCountdownLogAt = now;
        console.log(`[Battleground] countdown tick: instance=${inst.instanceId} wave=${inst.pendingWaveNumber || inst.currentWave || 0} remainingMs=${Math.max(0, finiteNum(inst.countdownEndsAt, 0) - now)}`);
      }
      if (now >= inst.countdownEndsAt) {
        const waveDef = Array.isArray(inst.waveDefinitions) ? inst.waveDefinitions.find((row) => finiteNum(row?.wave_number, 0) === finiteNum(inst.pendingWaveNumber, 0)) : null;
        console.log(`[Battleground] countdown met activation threshold: instance=${inst.instanceId} wave=${inst.pendingWaveNumber || 0} waveDef=${waveDef ? 'yes' : 'no'}`);
        inst.countdownEndsAt = 0;
        if (waveDef) activateBattlegroundWave(inst, waveDef, now);
      }
    }
    if (Array.isArray(inst.pendingNpcActivations) && inst.pendingNpcActivations.length > 0) {
      const remaining = [];
      const reg = getSystemRegistry(npcStatesBySystem, inst.system_id);
      for (const entry of inst.pendingNpcActivations) {
        if (!entry?.npcState?.id) continue;
        if (now >= finiteNum(entry.dueAt, 0)) {
          reg.set(entry.npcState.id, entry.npcState);
          console.log(`[Battleground] npc activated: instance=${inst.instanceId} npc=${entry.npcState.id} type=${entry.npcState.battlegroundNpcType || entry.npcState.classId || 'unknown'} wave=${entry.npcState.battlegroundWave || inst.currentWave || 0}`);
          broadcastToSystem(inst.system_id, {
            type: 'BATTLEGROUND_NPC_SPAWNED',
            ...entry.clientSpawn,
            instanceId: inst.instanceId,
            battlegroundKey: inst.battlegroundKey || null,
            serverTime: now
          });
        } else remaining.push(entry);
      }
      inst.pendingNpcActivations = remaining;
    }
  }
}

async function handleBattlegroundInspect(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId || player.docked) return;

  const systemId = String(data?.system_id || player.system_id || 'cygnus-prime');
  const structure = await resolveBattlegroundStructure(systemId, data?.structureId);
  if (!structure) {
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_INSPECT_FAILED', reason: 'battleground_structure_not_found', serverTime: Date.now() }));
    return;
  }

  const battlegroundKey = String(data?.battlegroundKey || structure?.config?.battlegroundKey || '').trim();
  const definition = await loadBattlegroundDefinitionByKey(battlegroundKey);
  if (!definition) {
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_INSPECT_FAILED', reason: 'battleground_definition_not_found', serverTime: Date.now() }));
    return;
  }

  socket.send(JSON.stringify({
    type: 'BATTLEGROUND_DEFINITION',
    structure,
    definition,
    serverTime: Date.now()
  }));
}

async function handleBattlegroundEnter(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId || player.docked) return;

  const systemId = String(data?.system_id || player.system_id || 'cygnus-prime');
  const structure = await resolveBattlegroundStructure(systemId, data?.structureId);
  if (!structure) {
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_ENTER_FAILED', reason: 'battleground_structure_not_found', serverTime: Date.now() }));
    return;
  }

  const battlegroundKey = String(data?.battlegroundKey || structure?.config?.battlegroundKey || '').trim();
  const definition = await loadBattlegroundDefinitionByKey(battlegroundKey);
  if (!definition) {
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_ENTER_FAILED', reason: 'battleground_definition_not_found', serverTime: Date.now() }));
    return;
  }

  const waveDefinitions = await loadBattlegroundWaveDefinitions(definition.id);
  if (!Array.isArray(waveDefinitions) || waveDefinitions.length <= 0) {
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_ENTER_FAILED', reason: 'battleground_wave_definitions_not_found', serverTime: Date.now() }));
    return;
  }

  const oldSystemId = player.system_id;
  const returnSnapshot = {
    system_id: player.system_id,
    x: finiteNum(player.x, 0),
    y: finiteNum(player.y, 0),
    rot: finiteNum(player.rot, 0),
    vx: finiteNum(player.vx, 0),
    vy: finiteNum(player.vy, 0),
    starport_id: player.starport_id || null,
    docked: false
  };

  try {
    await persistArenaReturnSnapshot(player.userId, returnSnapshot);
  } catch (e) {
    console.warn('[Battleground] snapshot persist failed:', player.userId, e?.message || e);
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_ENTER_FAILED', reason: String(e?.message || 'snapshot_persist_failed'), serverTime: Date.now() }));
    return;
  }

  removePlayerFromBattlegroundInstances(player.userId);
  const instance = createBattlegroundInstance(definition, structure);
  instance.waveDefinitions = waveDefinitions;
  instance.members.add(player.userId);

  player.battlegroundState = {
    inBattleground: true,
    instanceId: instance.instanceId,
    structureId: structure.id,
    definitionKey: definition.key
  };
  player.battlegroundReturnSnapshot = returnSnapshot;
  player.system_id = instance.system_id;
  player.docked = false;
  player.starport_id = null;
  player.x = 0;
  player.y = 0;
  player.rot = 0;
  player.vx = 0;
  player.vy = 0;
  player.lastSpaceTelemetry = { x: 0, y: 0, rot: 0, vx: 0, vy: 0 };
  clearValidatedLock(player);
  markPlayerDirty(player, ["ship", "telemetry"], { forceImmediatePersist: true });

  try {
    const { error } = await supabase
      .from("ship_states_v2")
      .upsert({
        player_id: player.userId,
        system_id: player.system_id,
        starport_id: null,
        telemetry: telemetrySnapshot(player),
        arena_return_snapshot: returnSnapshot,
        updated_at: nowIso()
      }, { onConflict: "player_id" });
    if (error) console.warn('[Battleground] enter persist failed:', player.userId, error.message);
  } catch (e) {
    console.warn('[Battleground] enter persist exception:', player.userId, e?.message || e);
  }

  if (oldSystemId && oldSystemId !== player.system_id) {
    for (const [otherSocket, otherPlayer] of players) {
      if (otherSocket !== socket && otherPlayer.system_id === oldSystemId && !otherPlayer.docked && otherSocket.readyState === WebSocket.OPEN) {
        otherSocket.send(JSON.stringify({ type: 'PLAYER_LEFT', userId: player.userId }));
      }
    }
  }

  socket.send(JSON.stringify({
    type: 'BATTLEGROUND_ENTERED',
    instanceId: instance.instanceId,
    system_id: player.system_id,
    battlegroundKey: definition.key,
    modeType: definition.mode_type,
    serverTime: Date.now()
  }));
  socket.send(JSON.stringify({
    type: 'WELCOME',
    system_id: player.system_id,
    x: player.x,
    y: player.y,
    rot: player.rot,
    vx: player.vx,
    vy: player.vy,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    armor: player.armor,
    resistances: player.resistances || {},
    combat_stats: player.combatStats || null,
    server_id: SERVER_ID
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);

  instance.phase = 'awaiting_ready';
  instance.statusLabel = 'AWAITING DEPLOYMENT';
  player.battlegroundState = {
    ...(player.battlegroundState || {}),
    inBattleground: true,
    instanceId: instance.instanceId,
    definitionKey: definition.key,
    awaitingReady: true
  };
  console.log(`[Battleground] enter ready: user=${player.userId} instance=${instance.instanceId} wave=1 waves=${instance.waveDefinitions.length}`);
  sendBattlegroundState(instance, { statusLabel: 'AWAITING DEPLOYMENT', waveNumber: 1 });
  socket.send(JSON.stringify({
    type: 'BATTLEGROUND_ENTER_READY',
    instanceId: instance.instanceId,
    system_id: player.system_id,
    battlegroundKey: definition.key,
    phase: 1,
    serverTime: Date.now()
  }));
}

async function handleBattlegroundLeave(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.battlegroundState?.inBattleground) return;

  const instanceId = player?.battlegroundState?.instanceId || null;
  const inst = instanceId ? battlegroundInstances.get(instanceId) : null;
  const skipRewardReset = !!data?._skipRewardReset;
  const leaveReason = String(data?._reason || data?.reason || data?.actionSource || 'leave').trim() || 'leave';
  console.log(`[Battleground] leave requested: user=${player.userId} instance=${instanceId || 'none'} reason=${leaveReason} phase=${inst?.phase || 'unknown'} skipRewardReset=${skipRewardReset}`);
  const returnSnapshot = player.battlegroundReturnSnapshot || player.arenaReturnSnapshot || null;
  if (!returnSnapshot || !returnSnapshot.system_id || isInstancedSystemId(returnSnapshot.system_id)) {
    socket.send(JSON.stringify({ type: 'BATTLEGROUND_ENTER_FAILED', reason: 'return_snapshot_missing', serverTime: Date.now() }));
    return;
  }

  const oldSystemId = player.system_id;
  if (inst && !skipRewardReset) {
    inst.bankedCredits = 0;
    inst.phase = 'leaving';
    inst.statusLabel = 'EXITING';
    cleanupBattlegroundNpcState(inst);
  }
  removePlayerFromBattlegroundInstances(player.userId);
  player.system_id = returnSnapshot.system_id;
  player.docked = false;
  player.starport_id = returnSnapshot.starport_id || null;
  player.x = finiteNum(returnSnapshot.x, 0);
  player.y = finiteNum(returnSnapshot.y, 0);
  player.rot = finiteNum(returnSnapshot.rot, 0);
  player.vx = finiteNum(returnSnapshot.vx, 0);
  player.vy = finiteNum(returnSnapshot.vy, 0);
  player.lastSpaceTelemetry = { x: player.x, y: player.y, rot: player.rot, vx: player.vx, vy: player.vy };
  player.battlegroundState = null;
  player.battlegroundReturnSnapshot = null;
  clearValidatedLock(player);
  markPlayerDirty(player, ["ship", "telemetry"], { forceImmediatePersist: true });

  try {
    await persistPlayerState(player, { reason: `battleground_leave:${leaveReason}` });
    await clearArenaReturnSnapshot(player.userId);
  } catch {}

  if (oldSystemId && oldSystemId !== player.system_id) {
    for (const [otherSocket, otherPlayer] of players) {
      if (otherSocket !== socket && otherPlayer.system_id === oldSystemId && !otherPlayer.docked && otherSocket.readyState === WebSocket.OPEN) {
        otherSocket.send(JSON.stringify({ type: 'PLAYER_LEFT', userId: player.userId }));
      }
    }
  }

  socket.send(JSON.stringify({
    type: 'BATTLEGROUND_LEFT',
    system_id: player.system_id,
    returnSystemId: player.system_id,
    serverTime: Date.now()
  }));
  socket.send(JSON.stringify({
    type: 'WELCOME',
    system_id: player.system_id,
    x: player.x,
    y: player.y,
    rot: player.rot,
    vx: player.vx,
    vy: player.vy,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    armor: player.armor,
    resistances: player.resistances || {},
    combat_stats: player.combatStats || null,
    server_id: SERVER_ID
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);
}

function getSystemRegistry(rootMap, systemId) {
  const sys = String(systemId || 'cygnus-prime');
  if (!rootMap.has(sys)) rootMap.set(sys, new Map());
  return rootMap.get(sys);
}

function finiteNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}



const FITTINGS_SLOT_SCHEMA = {
  rig1: null,
  active1: null,
  weapon1: null,
  weapon2: null,
  passive1: null,
  passive2: null,
  synapse1: null,
  synapse2: null,
  synapse3: null
};

function getAllowedFittingsSchemaForShip(shipType = null) {
  const ship = shipType ? getShipContentByAnyId(shipType) : null;
  const shipFittings = (ship?.fittings && typeof ship.fittings === 'object' && !Array.isArray(ship.fittings))
    ? ship.fittings
    : null;
  if (shipFittings) {
    const schema = {};
    for (const slotId of Object.keys(shipFittings)) schema[slotId] = null;
    return schema;
  }
  return { ...FITTINGS_SLOT_SCHEMA };
}

function sanitizeRuntimeFittings(value, shipType = null) {
  const source = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const allowedSchema = getAllowedFittingsSchemaForShip(shipType);
  const normalized = { ...allowedSchema };
  for (const slotId of Object.keys(allowedSchema)) {
    if (Object.prototype.hasOwnProperty.call(source, slotId)) {
      normalized[slotId] = source[slotId] ?? null;
    }
  }
  return normalized;
}

function normalizeFittingsSchema(fittings, shipType = null) {
  return sanitizeRuntimeFittings(fittings, shipType);
}

function enrichRuntimeFittingsWithModuleAuthority(value, shipType = null) {
  const fittings = normalizeFittingsSchema(value, shipType);
  const enriched = { ...getAllowedFittingsSchemaForShip(shipType) };
  for (const [slotId, rawItem] of Object.entries(fittings)) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      enriched[slotId] = rawItem ?? null;
      continue;
    }
    const nextItem = { ...rawItem };
    const candidates = [
      rawItem.canonical_output_id,
      rawItem.canonicalOutputId,
      rawItem.module_id,
      rawItem.moduleId,
      rawItem.item_id,
      rawItem.itemId,
      rawItem.id,
      rawItem.name,
      rawItem.display_name,
      rawItem.displayName
    ].map((v) => String(v || '').trim()).filter(Boolean);
    let moduleDef = null;
    let matchedCandidate = null;
    for (const candidate of candidates) {
      moduleDef = getModuleContentByAnyId(candidate);
      if (moduleDef) {
        matchedCandidate = candidate;
        break;
      }
    }
    console.log('[FITTING ENRICH] slot', {
      slotId,
      raw: rawItem,
      candidates,
      matchedCandidate,
      authoritativeFound: !!moduleDef,
      authoritativeModule: moduleDef ? {
        module_id: moduleDef.module_id || null,
        display_name: moduleDef.display_name || null,
        module_type: moduleDef.module_type || null,
        size: moduleDef.size || null,
        rarity: moduleDef.rarity || null,
        stats: moduleDef.stats || null
      } : null
    });
    if (moduleDef) {
      if (!nextItem.canonical_output_id) nextItem.canonical_output_id = moduleDef.module_id;
      if (!nextItem.canonicalOutputId) nextItem.canonicalOutputId = moduleDef.module_id;
      if (!nextItem.module_id) nextItem.module_id = moduleDef.module_id;
      if (!nextItem.moduleId) nextItem.moduleId = moduleDef.module_id;
      if (!nextItem.item_id) nextItem.item_id = moduleDef.module_id;
      if (!nextItem.itemId) nextItem.itemId = moduleDef.module_id;
      if (!nextItem.id) nextItem.id = moduleDef.module_id;
      if (!nextItem.name) nextItem.name = moduleDef.display_name || moduleDef.module_id;
      if (!nextItem.display_name) nextItem.display_name = moduleDef.display_name || moduleDef.module_id;
      if (!nextItem.displayName) nextItem.displayName = moduleDef.display_name || moduleDef.module_id;
      if (!nextItem.module_type) nextItem.module_type = moduleDef.module_type || null;
      if (!nextItem.moduleType) nextItem.moduleType = moduleDef.module_type || null;
      if (!nextItem.size) nextItem.size = moduleDef.size || null;
      if (!nextItem.rarity) nextItem.rarity = moduleDef.rarity || nextItem.rarity || null;
    }
    enriched[slotId] = nextItem;
  }
  return enriched;
}

function sanitizeRuntimeVisualConfig(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
}

function sanitizeRuntimeAnimationState(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampWorldDamage(v) {
  const n = finiteNum(v, 0);
  return Math.max(0, Math.min(WORLD_MAX_DAMAGE, n));
}

function distance2D(ax, ay, bx, by) {
  return Math.hypot((ax || 0) - (bx || 0), (ay || 0) - (by || 0));
}

function findPlayerSocketByUserId(userId) {
  for (const [socket, player] of players) {
    if (player?.userId === userId) return { socket, player };
  }
  return null;
}

async function loadPlayerActiveSyndicateId(userId) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return null;
  try {
    const { data, error } = await supabase
      .from('syndicate_members')
      .select('syndicate_id, role_key')
      .eq('user_id', safeUserId)
      .limit(10);
    if (error) {
      console.warn('[Syndicate] membership load failed:', safeUserId, error.message);
      return null;
    }
    const rows = Array.isArray(data) ? data : [];
    const active = rows.find((row) => String(row?.role_key || '').trim().toLowerCase() !== 'applicant');
    return String(active?.syndicate_id || '').trim() || null;
  } catch (e) {
    console.warn('[Syndicate] membership load exception:', safeUserId, e?.message || e);
    return null;
  }
}

function getSystemSecurityValue(systemId) {
  const safeSystemId = String(systemId || '').trim();
  if (!safeSystemId) return 0;
  if (isInstancedSystemId(safeSystemId)) return 0;
  return finiteNum(SYSTEM_SECURITY_VALUES[safeSystemId], 0);
}

function isSecureSpacePvpBlocked(systemId) {
  if (isInstancedSystemId(systemId)) return false;
  return getSystemSecurityValue(systemId) >= SECURE_SPACE_PVP_THRESHOLD;
}

function getFleetIdForUser(userId) {
  const safeUserId = String(userId || '').trim();
  return safeUserId ? (fleetIdByUserId.get(safeUserId) || null) : null;
}

function areFleetmates(playerA, playerB) {
  const aId = String(playerA?.userId || '').trim();
  const bId = String(playerB?.userId || '').trim();
  if (!aId || !bId || aId === bId) return false;
  const fleetIdA = getFleetIdForUser(aId);
  const fleetIdB = getFleetIdForUser(bId);
  return !!(fleetIdA && fleetIdB && fleetIdA === fleetIdB);
}

function areSameSyndicate(playerA, playerB) {
  const aSyn = String(playerA?.syndicate_id || '').trim();
  const bSyn = String(playerB?.syndicate_id || '').trim();
  return !!(aSyn && bSyn && aSyn === bSyn);
}

function getFriendlyLockRelationReason(sourcePlayer, targetPlayer) {
  if (!sourcePlayer || !targetPlayer) return 'target_missing';
  if (areFleetmates(sourcePlayer, targetPlayer)) return null;
  if (areSameSyndicate(sourcePlayer, targetPlayer)) return null;
  return 'friendly_lock_requires_alliance';
}

function getHostileLockBlockReason(sourcePlayer, targetPlayer, systemId = null) {
  if (!sourcePlayer || !targetPlayer) return 'target_missing';
  if (areFleetmates(sourcePlayer, targetPlayer)) return 'same_fleet';
  if (areSameSyndicate(sourcePlayer, targetPlayer)) return 'same_syndicate';
  if (isSecureSpacePvpBlocked(systemId || sourcePlayer.system_id || targetPlayer.system_id)) return 'secure_space_pvp_blocked';
  return null;
}

function getPlayerCombatBlockReason(attackerPlayer, targetPlayer, systemId = null) {
  if (!attackerPlayer || !targetPlayer) return null;
  if (attackerPlayer.userId === targetPlayer.userId) return null;
  if (areFleetmates(attackerPlayer, targetPlayer)) return 'same_fleet';
  if (areSameSyndicate(attackerPlayer, targetPlayer)) return 'same_syndicate';
  if (isSecureSpacePvpBlocked(systemId || attackerPlayer.system_id || targetPlayer.system_id)) return 'secure_space_pvp_blocked';
  return null;
}


function sendToPlayer(userId, msgObj) {
  const ref = findPlayerSocketByUserId(userId);
  if (!ref?.socket || ref.socket.readyState !== WebSocket.OPEN) return false;
  try {
    ref.socket.send(JSON.stringify(msgObj));
    return true;
  } catch {
    return false;
  }
}

function makeFleetId() {
  return `fleet-${crypto.randomUUID()}`;
}

function makeFleetInviteId() {
  return `fleet-invite-${crypto.randomUUID()}`;
}

function clearExpiredFleetInvites(now = Date.now()) {
  for (const [inviteId, invite] of pendingFleetInvites) {
    if (!invite || finiteNum(invite.expiresAt, 0) > now) continue;
    pendingFleetInvites.delete(inviteId);
    sendToPlayer(invite.inviterId, {
      type: 'FLEET_INVITE_RESULT',
      ok: false,
      action: 'invite',
      inviteId,
      targetUserId: invite.targetUserId,
      reason: 'expired',
      message: 'Fleet invite expired.',
      serverTime: now
    });
    sendToPlayer(invite.targetUserId, {
      type: 'FLEET_INVITE_RESULT',
      ok: false,
      action: 'invite',
      inviteId,
      targetUserId: invite.targetUserId,
      reason: 'expired',
      message: 'Fleet invite expired.',
      serverTime: now
    });
  }
}

function removePendingFleetInvitesForUser(userId) {
  if (!userId) return;
  for (const [inviteId, invite] of pendingFleetInvites) {
    if (!invite) continue;
    if (invite.targetUserId === userId || invite.inviterId === userId) {
      pendingFleetInvites.delete(inviteId);
    }
  }
}

function removePendingFleetInvitesForTarget(targetUserId, fleetId = null) {
  if (!targetUserId) return;
  for (const [inviteId, invite] of pendingFleetInvites) {
    if (!invite) continue;
    if (invite.targetUserId !== targetUserId) continue;
    if (fleetId && invite.fleetId !== fleetId) continue;
    pendingFleetInvites.delete(inviteId);
  }
}

function buildFleetMemberSnapshot(userId, fleet = null) {
  const ref = findPlayerSocketByUserId(userId);
  const player = ref?.player || null;
  const isLeader = !!fleet && fleet.leaderId === userId;
  const shipType = String(player?.ship_type || 'OMNI SCOUT').trim() || 'OMNI SCOUT';
  return {
    id: userId,
    userId,
    name: String(player?.commanderName || player?.commander_name || `CMDR_${String(userId).slice(0, 4)}`).trim() || `CMDR_${String(userId).slice(0, 4)}`,
    shipId: shipType,
    shipType,
    systemId: player?.system_id || null,
    hp: Math.max(0, finiteNum(player?.hp, 100)),
    maxHp: Math.max(1, finiteNum(player?.maxHp, 100)),
    shields: Math.max(0, finiteNum(player?.shields, 0)),
    maxShields: Math.max(0, finiteNum(player?.maxShields, 0)),
    energy: Math.max(0, finiteNum(player?.energy, 100)),
    maxEnergy: Math.max(1, finiteNum(player?.maxEnergy, 100)),
    docked: !!player?.docked,
    isOnline: !!ref?.socket && ref.socket.readyState === WebSocket.OPEN,
    isLeader
  };
}

function buildFleetStatePayload(fleet) {
  const now = Date.now();
  if (!fleet) {
    return {
      type: 'FLEET_STATE',
      fleetId: null,
      leaderId: null,
      members: [],
      maxMembers: FLEET_MAX_MEMBERS,
      serverTime: now
    };
  }
  const members = Array.from(fleet.memberIds || [])
    .filter(Boolean)
    .map((userId) => buildFleetMemberSnapshot(userId, fleet));

  return {
    type: 'FLEET_STATE',
    fleetId: fleet.fleetId,
    leaderId: fleet.leaderId,
    members,
    maxMembers: FLEET_MAX_MEMBERS,
    serverTime: now
  };
}

function sendFleetStateToMembers(fleet) {
  if (!fleet) return;
  const payload = buildFleetStatePayload(fleet);
  for (const userId of Array.from(fleet.memberIds || [])) {
    sendToPlayer(userId, payload);
  }
}

function sendEmptyFleetState(userId) {
  if (!userId) return;
  sendToPlayer(userId, {
    type: 'FLEET_STATE',
    fleetId: null,
    leaderId: null,
    members: [],
    maxMembers: FLEET_MAX_MEMBERS,
    serverTime: Date.now()
  });
}

function ensureFleetForLeader(userId) {
  const existingFleetId = fleetIdByUserId.get(userId);
  if (existingFleetId) {
    const existingFleet = fleetsById.get(existingFleetId);
    if (existingFleet) return existingFleet;
    fleetIdByUserId.delete(userId);
  }

  const now = Date.now();
  const fleet = {
    fleetId: makeFleetId(),
    leaderId: userId,
    memberIds: [userId],
    createdAt: now,
    updatedAt: now
  };
  fleetsById.set(fleet.fleetId, fleet);
  fleetIdByUserId.set(userId, fleet.fleetId);
  return fleet;
}

function removeFleetMembership(userId, options = {}) {
  const fleetId = fleetIdByUserId.get(userId);
  if (!fleetId) {
    sendEmptyFleetState(userId);
    return null;
  }

  const fleet = fleetsById.get(fleetId);
  if (!fleet) {
    fleetIdByUserId.delete(userId);
    sendEmptyFleetState(userId);
    return null;
  }

  fleet.memberIds = Array.from(fleet.memberIds || []).filter((id) => id !== userId);
  fleetIdByUserId.delete(userId);
  removePendingFleetInvitesForUser(userId);

  const remainingIds = Array.from(fleet.memberIds || []).filter(Boolean);
  if (remainingIds.length <= 0) {
    fleetsById.delete(fleetId);
    sendEmptyFleetState(userId);
    return null;
  }

  if (fleet.leaderId === userId) {
    fleet.leaderId = remainingIds[0];
  }

  fleet.updatedAt = Date.now();
  sendEmptyFleetState(userId);
  sendFleetStateToMembers(fleet);
  return fleet;
}

async function handleFleetInviteRequest(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;

  clearExpiredFleetInvites(Date.now());

  const targetUserId = String(data?.targetUserId || '').trim();
  if (!targetUserId || targetUserId === userId) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'invite',
      reason: 'invalid_target',
      message: 'Invalid fleet target.',
      serverTime: Date.now()
    }));
    return;
  }

  const targetRef = findPlayerSocketByUserId(targetUserId);
  if (!targetRef?.player || targetRef.socket.readyState !== WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'invite',
      reason: 'target_offline',
      message: 'Target commander is not online.',
      serverTime: Date.now()
    }));
    return;
  }

  if (fleetIdByUserId.get(targetUserId)) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'invite',
      reason: 'target_already_in_fleet',
      message: 'Target commander is already in a fleet.',
      serverTime: Date.now()
    }));
    return;
  }

  let fleet = null;
  const existingFleetId = fleetIdByUserId.get(userId);
  if (existingFleetId) {
    fleet = fleetsById.get(existingFleetId);
    if (!fleet) {
      fleetIdByUserId.delete(userId);
    }
  }
  if (!fleet) fleet = ensureFleetForLeader(userId);

  if (fleet.leaderId !== userId) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'invite',
      reason: 'not_leader',
      message: 'Only the fleet leader can send invites.',
      serverTime: Date.now()
    }));
    return;
  }

  if ((fleet.memberIds || []).length >= FLEET_MAX_MEMBERS) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'invite',
      reason: 'fleet_full',
      message: 'Fleet is already at maximum size.',
      serverTime: Date.now()
    }));
    return;
  }

  const lastInviteAt = player._lastFleetInviteAt || 0;
  const now = Date.now();
  if (lastInviteAt && (now - lastInviteAt) < FLEET_INVITE_COOLDOWN_MS) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'invite',
      reason: 'invite_cooldown',
      message: 'Fleet invite is on cooldown.',
      serverTime: now
    }));
    return;
  }

  for (const invite of pendingFleetInvites.values()) {
    if (!invite) continue;
    if (invite.targetUserId === targetUserId && invite.fleetId === fleet.fleetId) {
      socket.send(JSON.stringify({
        type: 'FLEET_ERROR',
        action: 'invite',
        reason: 'invite_pending',
        message: 'A fleet invite is already pending for that commander.',
        serverTime: now
      }));
      return;
    }
  }

  const inviteId = makeFleetInviteId();
  const invite = {
    inviteId,
    fleetId: fleet.fleetId,
    inviterId: userId,
    targetUserId,
    createdAt: now,
    expiresAt: now + FLEET_INVITE_EXPIRE_MS
  };
  pendingFleetInvites.set(inviteId, invite);
  player._lastFleetInviteAt = now;

  targetRef.socket.send(JSON.stringify({
    type: 'FLEET_INVITE_RECEIVED',
    inviteId,
    fleetId: fleet.fleetId,
    inviterId: userId,
    inviterName: String(player.commanderName || player.commander_name || `CMDR_${userId.slice(0, 4)}`).trim() || `CMDR_${userId.slice(0, 4)}`,
    targetUserId,
    expiresAt: invite.expiresAt,
    serverTime: now
  }));

  socket.send(JSON.stringify({
    type: 'FLEET_INVITE_RESULT',
    ok: true,
    action: 'invite',
    inviteId,
    targetUserId,
    message: 'Fleet invite sent.',
    serverTime: now
  }));

  sendFleetStateToMembers(fleet);
}

async function handleFleetInviteAccept(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;

  clearExpiredFleetInvites(Date.now());

  const inviteId = String(data?.inviteId || '').trim();
  const invite = pendingFleetInvites.get(inviteId);
  if (!invite) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'accept',
      reason: 'invite_missing',
      message: 'Fleet invite no longer exists.',
      serverTime: Date.now()
    }));
    return;
  }

  if (invite.targetUserId !== userId) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'accept',
      reason: 'invite_target_mismatch',
      message: 'That fleet invite is not for you.',
      serverTime: Date.now()
    }));
    return;
  }

  if (fleetIdByUserId.get(userId)) {
    pendingFleetInvites.delete(inviteId);
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'accept',
      reason: 'already_in_fleet',
      message: 'You are already in a fleet.',
      serverTime: Date.now()
    }));
    return;
  }

  const fleet = fleetsById.get(invite.fleetId);
  if (!fleet) {
    pendingFleetInvites.delete(inviteId);
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'accept',
      reason: 'fleet_missing',
      message: 'Fleet no longer exists.',
      serverTime: Date.now()
    }));
    return;
  }

  if ((fleet.memberIds || []).length >= FLEET_MAX_MEMBERS) {
    pendingFleetInvites.delete(inviteId);
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'accept',
      reason: 'fleet_full',
      message: 'Fleet is already full.',
      serverTime: Date.now()
    }));
    return;
  }

  if (!(fleet.memberIds || []).includes(userId)) {
    fleet.memberIds.push(userId);
  }
  fleet.updatedAt = Date.now();
  fleetIdByUserId.set(userId, fleet.fleetId);
  pendingFleetInvites.delete(inviteId);
  removePendingFleetInvitesForTarget(userId);

  sendToPlayer(invite.inviterId, {
    type: 'FLEET_INVITE_RESULT',
    ok: true,
    action: 'accepted',
    inviteId,
    targetUserId: userId,
    message: 'Fleet invite accepted.',
    serverTime: Date.now()
  });

  sendFleetStateToMembers(fleet);
}

async function handleFleetInviteDecline(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;

  clearExpiredFleetInvites(Date.now());

  const inviteId = String(data?.inviteId || '').trim();
  const invite = pendingFleetInvites.get(inviteId);
  if (!invite) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'decline',
      reason: 'invite_missing',
      message: 'Fleet invite no longer exists.',
      serverTime: Date.now()
    }));
    return;
  }

  if (invite.targetUserId !== userId) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'decline',
      reason: 'invite_target_mismatch',
      message: 'That fleet invite is not for you.',
      serverTime: Date.now()
    }));
    return;
  }

  pendingFleetInvites.delete(inviteId);
  sendToPlayer(invite.inviterId, {
    type: 'FLEET_INVITE_RESULT',
    ok: true,
    action: 'declined',
    inviteId,
    targetUserId: userId,
    message: 'Fleet invite declined.',
    serverTime: Date.now()
  });

  socket.send(JSON.stringify({
    type: 'FLEET_INVITE_RESULT',
    ok: true,
    action: 'decline',
    inviteId,
    targetUserId: userId,
    message: 'Fleet invite declined.',
    serverTime: Date.now()
  }));
}

async function handleFleetLeaveRequest(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  removeFleetMembership(userId);
}

async function handleFleetKickRequest(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;

  const fleetId = fleetIdByUserId.get(userId);
  const fleet = fleetId ? fleetsById.get(fleetId) : null;
  if (!fleet || fleet.leaderId !== userId) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'kick',
      reason: 'not_leader',
      message: 'Only the fleet leader can kick members.',
      serverTime: Date.now()
    }));
    return;
  }

  const targetUserId = String(data?.targetUserId || '').trim();
  if (!targetUserId || targetUserId === userId || !(fleet.memberIds || []).includes(targetUserId)) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'kick',
      reason: 'invalid_target',
      message: 'Invalid fleet member selected.',
      serverTime: Date.now()
    }));
    return;
  }

  fleet.memberIds = Array.from(fleet.memberIds || []).filter((id) => id !== targetUserId);
  fleetIdByUserId.delete(targetUserId);
  removePendingFleetInvitesForUser(targetUserId);
  fleet.updatedAt = Date.now();

  sendEmptyFleetState(targetUserId);
  sendFleetStateToMembers(fleet);
}

async function handleFleetPromoteRequest(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;

  const fleetId = fleetIdByUserId.get(userId);
  const fleet = fleetId ? fleetsById.get(fleetId) : null;
  if (!fleet || fleet.leaderId !== userId) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'promote',
      reason: 'not_leader',
      message: 'Only the fleet leader can promote members.',
      serverTime: Date.now()
    }));
    return;
  }

  const targetUserId = String(data?.targetUserId || '').trim();
  if (!targetUserId || targetUserId === userId || !(fleet.memberIds || []).includes(targetUserId)) {
    socket.send(JSON.stringify({
      type: 'FLEET_ERROR',
      action: 'promote',
      reason: 'invalid_target',
      message: 'Invalid fleet member selected.',
      serverTime: Date.now()
    }));
    return;
  }

  fleet.leaderId = targetUserId;
  fleet.updatedAt = Date.now();
  sendFleetStateToMembers(fleet);
}

function clearValidatedLock(player) {
  if (player) player.validatedLock = null;
}

function isArenaIntroProtected(player) {
  return !!(player?.arenaState?.inArena && player?.arenaState?.awaitingReady);
}

function makeCombatTargetKey(targetType, targetId) {
  return `${String(targetType || 'unknown')}:${String(targetId || '').trim()}`;
}

function pruneRecentDamageEntries(targetType, targetId, now = Date.now()) {
  const key = makeCombatTargetKey(targetType, targetId);
  const entries = recentDamageByTarget.get(key) || [];
  const filtered = entries.filter((entry) => entry && (now - finiteNum(entry.timestamp, now)) <= DAMAGE_CONTRIBUTION_WINDOW_MS);
  if (filtered.length > 0) recentDamageByTarget.set(key, filtered);
  else recentDamageByTarget.delete(key);
  return filtered;
}

function recordRecentDamage({
  targetType,
  targetId,
  attackerId = null,
  sourceType = 'player',
  sourceId = null,
  amount = 0,
  weapon_id = undefined,
  weapon_name = undefined,
  damageMode = undefined,
  timestamp = Date.now(),
} = {}) {
  const finalTargetId = String(targetId || '').trim();
  const finalAttackerId = String(attackerId || sourceId || '').trim();
  const applied = Math.max(0, finiteNum(amount, 0));
  if (!finalTargetId || !finalAttackerId || applied <= 0) return;
  const key = makeCombatTargetKey(targetType, finalTargetId);
  const entries = pruneRecentDamageEntries(targetType, finalTargetId, timestamp).slice();
  entries.push({
    attackerId: finalAttackerId,
    sourceType: String(sourceType || 'player'),
    sourceId: String(sourceId || finalAttackerId),
    amount: applied,
    weapon_id,
    weapon_name,
    damageMode,
    timestamp
  });
  recentDamageByTarget.set(key, entries);
}

function resolveKillCredit(targetType, targetId, now = Date.now()) {
  const entries = pruneRecentDamageEntries(targetType, targetId, now);
  if (!entries.length) {
    return {
      targetType,
      targetId,
      finalBlow: null,
      topDamage: null,
      assists: [],
      recentWindowMs: DAMAGE_CONTRIBUTION_WINDOW_MS
    };
  }

  const finalBlow = entries[entries.length - 1];
  const totals = new Map();

  for (const entry of entries) {
    const aggKey = `${entry.sourceType || 'player'}:${entry.sourceId || entry.attackerId}`;
    const current = totals.get(aggKey) || {
      attackerId: entry.attackerId,
      sourceType: entry.sourceType || 'player',
      sourceId: entry.sourceId || entry.attackerId,
      totalDamage: 0,
      lastHitAt: entry.timestamp
    };
    current.totalDamage += Math.max(0, finiteNum(entry.amount, 0));
    current.lastHitAt = Math.max(current.lastHitAt || 0, finiteNum(entry.timestamp, 0));
    totals.set(aggKey, current);
  }

  const ranked = Array.from(totals.values())
    .sort((a, b) => (b.totalDamage - a.totalDamage) || (b.lastHitAt - a.lastHitAt));

  const topDamage = ranked[0] || null;
  const assists = ranked
    .filter((entry) => !(topDamage && entry.sourceType === topDamage.sourceType && entry.sourceId === topDamage.sourceId))
    .map((entry) => ({
      attackerId: entry.attackerId,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      totalDamage: Number(entry.totalDamage.toFixed(2))
    }));

  return {
    targetType,
    targetId,
    finalBlow: finalBlow ? {
      attackerId: finalBlow.attackerId,
      sourceType: finalBlow.sourceType || 'player',
      sourceId: finalBlow.sourceId || finalBlow.attackerId,
      weapon_id: finalBlow.weapon_id,
      weapon_name: finalBlow.weapon_name,
      damageMode: finalBlow.damageMode,
      timestamp: finalBlow.timestamp
    } : null,
    topDamage: topDamage ? {
      attackerId: topDamage.attackerId,
      sourceType: topDamage.sourceType,
      sourceId: topDamage.sourceId,
      totalDamage: Number(topDamage.totalDamage.toFixed(2)),
      lastHitAt: topDamage.lastHitAt
    } : null,
    assists,
    recentWindowMs: DAMAGE_CONTRIBUTION_WINDOW_MS
  };
}

function clearKillCreditTracking(targetType, targetId) {
  recentDamageByTarget.delete(makeCombatTargetKey(targetType, targetId));
}

function buildLootOwnershipMeta(killCredit, createdAt = Date.now(), overrides = {}) {
  const ownerType = String(overrides.ownerType || killCredit?.topDamage?.sourceType || 'public');
  const ownerId = overrides.ownerId ?? killCredit?.topDamage?.sourceId ?? null;
  const assistIds = Array.isArray(killCredit?.assists)
    ? killCredit.assists.map((entry) => entry?.sourceId).filter(Boolean)
    : [];

  return {
    ownerType,
    ownerId,
    killCreditId: killCredit?.topDamage?.sourceId || null,
    killCreditType: killCredit?.topDamage?.sourceType || null,
    finalBlowId: killCredit?.finalBlow?.sourceId || null,
    finalBlowType: killCredit?.finalBlow?.sourceType || null,
    assistIds,
    assistTypes: Array.isArray(killCredit?.assists) ? killCredit.assists.map((entry) => entry?.sourceType || 'player') : [],
    createdAt,
    publicAt: Number.isFinite(overrides.publicAt) ? overrides.publicAt : (createdAt + LOOT_PUBLIC_TIMEOUT_MS),
    rightsVersion: 1
  };
}

function canCollectOwnedLoot(lootData = {}, playerId = null, now = Date.now()) {
  const ownership = lootData?.ownership || lootData?.lootOwnership || null;
  if (!ownership || typeof ownership !== 'object') return { ok: true, reason: null };

  const ownerType = String(ownership.ownerType || ownership.type || 'public');
  const ownerId = ownership.ownerId ?? null;
  const publicAt = finiteNum(ownership.publicAt, 0);

  if (ownerType === 'public') return { ok: true, reason: null };
  if (publicAt > 0 && now >= publicAt) return { ok: true, reason: null };
  if (playerId && ownerId != null && String(ownerId) === String(playerId)) return { ok: true, reason: null };

  return { ok: false, reason: 'not_owner', ownerType, ownerId, publicAt };
}

function sendTargetLockInvalidated(socket, player, { targetId = null, reason = "invalid", isFriendly = false } = {}) {
  if (player) clearValidatedLock(player);
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "TARGET_LOCK_INVALIDATED",
    targetId,
    reason,
    isFriendly: !!isFriendly,
    serverTime: Date.now()
  }));
}


function sanitizeNpcSnapshot(data = {}) {
  const maxHp = Math.max(1, finiteNum(data.target_maxHp ?? data.targetMaxHp ?? data.maxHp, 100));
  const maxShields = Math.max(0, finiteNum(data.target_maxShields ?? data.targetMaxShields ?? data.maxShields, 0));
  const hp = Math.max(0, Math.min(maxHp, finiteNum(data.target_hp ?? data.targetHp ?? data.hp, maxHp)));
  const shields = Math.max(0, Math.min(maxShields, finiteNum(data.target_shields ?? data.targetShields ?? data.shields, maxShields)));
  const cargo = Math.max(0, finiteNum(data.target_cargo ?? data.targetCargo ?? data.cargo, 0));
  const x = finiteNum(data.target_x ?? data.targetX ?? data.x, NaN);
  const y = finiteNum(data.target_y ?? data.targetY ?? data.y, NaN);
  const spawnXRaw = finiteNum(data.target_spawnX ?? data.targetSpawnX ?? data.spawnX, NaN);
  const spawnYRaw = finiteNum(data.target_spawnY ?? data.targetSpawnY ?? data.spawnY, NaN);
  const factionKey = String(data.target_faction ?? data.targetFaction ?? data.faction ?? data.shipType ?? data.type ?? 'NPC').trim() || 'NPC';
  return {
    id: String(data.target_id || data.targetId || data.id || '').trim(),
    type: String(data.target_type || data.targetType || data.type || 'NPC').trim() || 'NPC',
    shipType: String(data.target_shipType ?? data.targetShipType ?? data.shipType ?? '').trim() || undefined,
    creatureType: String(data.target_creatureType ?? data.targetCreatureType ?? data.creatureType ?? '').trim() || undefined,
    classId: String(data.target_classId ?? data.targetClassId ?? data.classId ?? '').trim() || undefined,
    isBio: !!(data.target_isBio ?? data.targetIsBio ?? data.isBio),
    cargo,
    cargoType: String(data.target_cargoType ?? data.targetCargoType ?? data.cargoType ?? '').trim() || undefined,
    cargoQL: finiteNum(data.target_cargoQL ?? data.targetCargoQL ?? data.cargoQL, 1),
    cargoQLBand: String(data.target_cargoQLBand ?? data.targetCargoQLBand ?? data.cargoQLBand ?? '').trim() || undefined,
    x,
    y,
    spawnX: Number.isFinite(spawnXRaw) ? spawnXRaw : x,
    spawnY: Number.isFinite(spawnYRaw) ? spawnYRaw : y,
    hp,
    maxHp,
    shields,
    maxShields,
    armor: Math.max(0, Math.min(0.95, finiteNum(data.target_armor ?? data.armor, 0.15))),
    kineticRes: Math.max(0, Math.min(0.95, finiteNum(data.target_kineticRes ?? data.kineticRes, 0))),
    thermalRes: Math.max(0, Math.min(0.95, finiteNum(data.target_thermalRes ?? data.thermalRes, 0))),
    blastRes: Math.max(0, Math.min(0.95, finiteNum(data.target_blastRes ?? data.blastRes, 0))),
    collisionRadius: Math.max(8, Math.min(120, finiteNum(data.target_collisionRadius ?? data.collisionRadius, 25))),
    detectionRadius: Math.max(150, Math.min(5000, finiteNum(data.target_detectionRadius ?? data.detectionRadius, NPC_DETECTION_RANGE_DEFAULT))),
    leashRadius: Math.max(300, Math.min(8000, finiteNum(data.target_leashRadius ?? data.leashRadius, NPC_LEASH_RADIUS_DEFAULT))),
    factionKey,
    threatTable: {},
    combatState: 'IDLE',
    targetId: null,
    targetType: 'player',
    destroyed: false,
    lastUpdatedAt: Date.now(),
    lastBroadcastAt: 0,
    _lastBroadcastState: '',
  };
}

function upsertNpcState(systemId, data = {}) {
  const snap = sanitizeNpcSnapshot(data);
  if (!snap.id || !Number.isFinite(snap.x) || !Number.isFinite(snap.y)) return null;
  const registry = getSystemRegistry(npcStatesBySystem, systemId);
  const existing = registry.get(snap.id);
  if (!existing) {
    registry.set(snap.id, snap);
    return snap;
  }
  existing.type = snap.type || existing.type;
  existing.shipType = snap.shipType || existing.shipType;
  existing.creatureType = snap.creatureType || existing.creatureType;
  existing.classId = snap.classId || existing.classId;
  existing.isBio = !!snap.isBio;
  existing.cargo = snap.cargo;
  existing.cargoType = snap.cargoType || existing.cargoType;
  existing.cargoQL = snap.cargoQL;
  existing.cargoQLBand = snap.cargoQLBand || existing.cargoQLBand;
  existing.x = snap.x;
  existing.y = snap.y;
  if (!Number.isFinite(existing.spawnX)) existing.spawnX = snap.spawnX;
  if (!Number.isFinite(existing.spawnY)) existing.spawnY = snap.spawnY;
  existing.maxHp = snap.maxHp;
  existing.hp = Math.max(0, Math.min(existing.maxHp, finiteNum(snap.hp, existing.hp)));
  existing.maxShields = snap.maxShields;
  existing.shields = Math.max(0, Math.min(existing.maxShields, finiteNum(snap.shields, existing.shields)));
  existing.armor = snap.armor;
  existing.kineticRes = snap.kineticRes;
  existing.thermalRes = snap.thermalRes;
  existing.blastRes = snap.blastRes;
  existing.collisionRadius = snap.collisionRadius;
  existing.detectionRadius = snap.detectionRadius;
  existing.leashRadius = snap.leashRadius;
  existing.factionKey = snap.factionKey || existing.factionKey || 'NPC';
  existing.lastUpdatedAt = Date.now();
  if (!existing.threatTable || typeof existing.threatTable !== 'object') existing.threatTable = {};
  return existing;
}

function setNpcThreat(npc, userId, delta, now = Date.now()) {
  if (!npc || !userId) return;
  const amount = Math.max(0, finiteNum(delta, 0));
  if (amount <= 0) return;
  npc.threatTable = npc.threatTable || {};
  const entry = npc.threatTable[userId] || { threat: 0, updatedAt: now };
  entry.threat = Math.max(0, finiteNum(entry.threat, 0) + amount);
  entry.updatedAt = now;
  npc.threatTable[userId] = entry;
}

function applyAllyThreat(systemId, sourceNpc, attackerId, delta, now = Date.now()) {
  if (!sourceNpc || !attackerId) return;
  const registry = getSystemRegistry(npcStatesBySystem, systemId);
  for (const [, npc] of registry) {
    if (!npc || npc.id === sourceNpc.id || npc.destroyed) continue;
    if ((npc.factionKey || '') !== (sourceNpc.factionKey || '')) continue;
    const dist = distance2D(npc.x, npc.y, sourceNpc.x, sourceNpc.y);
    if (dist > NPC_ALLY_ASSIST_RANGE) continue;
    setNpcThreat(npc, attackerId, delta, now);
  }
}

function broadcastNpcCombatState(systemId, npc, now = Date.now(), force = false) {
  if (!npc) return;
  const snapshot = JSON.stringify({
    combatState: npc.combatState || 'IDLE',
    targetId: npc.targetId || null,
    targetType: npc.targetType || 'player',
    leashing: !!npc.leashing
  });
  if (!force && snapshot === npc._lastBroadcastState && (now - (npc.lastBroadcastAt || 0)) < NPC_STATE_BROADCAST_MIN_MS) return;
  npc._lastBroadcastState = snapshot;
  npc.lastBroadcastAt = now;
  let topThreat = 0;
  if (npc.threatTable) {
    for (const key of Object.keys(npc.threatTable)) topThreat = Math.max(topThreat, finiteNum(npc.threatTable[key]?.threat, 0));
  }
  broadcastToSystem(systemId, {
    type: 'NPC_COMBAT_STATE',
    npcId: npc.id,
    combatState: npc.combatState || 'IDLE',
    targetId: npc.targetId || null,
    targetType: npc.targetType || 'player',
    threat: Number(topThreat.toFixed(2)),
    threatTableSize: npc.threatTable ? Object.keys(npc.threatTable).length : 0,
    leashing: !!npc.leashing,
    x: npc.x,
    y: npc.y,
    spawnX: npc.spawnX,
    spawnY: npc.spawnY,
    serverTime: now
  });
}

function tickNpcThreatAndCombat(now, dtMs = SERVER_TICK_MS) {
  const dtSeconds = Math.max(0, dtMs || SERVER_TICK_MS) / 1000;
  for (const [systemId, registry] of npcStatesBySystem) {
    for (const [, npc] of registry) {
      if (!npc || npc.destroyed || (npc.hp ?? 0) <= 0) continue;
      npc.threatTable = npc.threatTable || {};
      const prevState = `${npc.combatState}|${npc.targetId || ''}|${npc.leashing ? 1 : 0}`;
      npc.leashing = false;
      for (const [userId, entry] of Object.entries(npc.threatTable)) {
        const ref = findPlayerSocketByUserId(userId);
        const target = ref?.player;
        if (!target || target.docked || target.system_id !== systemId || (target.hp ?? 1) <= 0) {
          delete npc.threatTable[userId];
          continue;
        }
        entry.threat = Math.max(0, finiteNum(entry.threat, 0) - (NPC_THREAT_DECAY_PER_SEC * dtSeconds));
        if (entry.threat <= 0.01) delete npc.threatTable[userId];
      }
      if (shouldNpcUsePassiveThreatDetection(npc)) {
        for (const [, player] of players) {
          if (!player || player.docked || player.system_id !== systemId || (player.hp ?? 1) <= 0) continue;
          const dist = distance2D(npc.x, npc.y, player.x, player.y);
          if (dist <= (npc.detectionRadius || NPC_DETECTION_RANGE_DEFAULT)) {
            setNpcThreat(npc, player.userId, NPC_DETECTION_THREAT_PER_SEC * dtSeconds, now);
          }
        }
      }
      let bestTarget = null;
      let bestThreat = 0;
      for (const [userId, entry] of Object.entries(npc.threatTable)) {
        const ref = findPlayerSocketByUserId(userId);
        const target = ref?.player;
        if (!target || target.docked || target.system_id !== systemId || (target.hp ?? 1) <= 0) continue;
        if (shouldNpcUseWorldLeash(npc)) {
          const fromSpawn = distance2D(npc.spawnX, npc.spawnY, target.x, target.y);
          if (fromSpawn > (npc.leashRadius || NPC_LEASH_RADIUS_DEFAULT)) {
            npc.leashing = true;
            continue;
          }
        }
        const threat = finiteNum(entry.threat, 0);
        if (!bestTarget || threat > bestThreat) { bestTarget = target; bestThreat = threat; }
      }
      if (npc.leashing) {
        npc.threatTable = {};
        npc.targetId = null;
        npc.combatState = 'RETURNING';
      } else if (bestTarget) {
        npc.targetId = bestTarget.userId;
        npc.targetType = 'player';
        npc.combatState = 'ENGAGED';
      } else {
        npc.targetId = null;
        const distFromSpawn = distance2D(npc.x, npc.y, npc.spawnX, npc.spawnY);
        if (distFromSpawn > Math.max(80, (npc.collisionRadius || 25) * 2)) npc.combatState = 'RETURNING';
        else if (Object.keys(npc.threatTable).length > 0) npc.combatState = 'DISENGAGING';
        else npc.combatState = 'IDLE';
      }
      const nextState = `${npc.combatState}|${npc.targetId || ''}|${npc.leashing ? 1 : 0}`;
      if (prevState != nextState) broadcastNpcCombatState(systemId, npc, now, true);
      else if ((now - (npc.lastBroadcastAt || 0)) >= 1000) broadcastNpcCombatState(systemId, npc, now, false);
    }
  }
}

function getNpcExpReward(npc = {}) {
  if (npc.isBio || npc.type === 'BIO') {
    const creature = String(npc.creatureType || '').toLowerCase();
    if (creature.includes('broodmother')) return 500;
    if (creature.includes('larva')) return 1;
    return 10;
  }
  const type = String(npc.shipType || npc.type || '').toUpperCase();
  if (type.includes('GUNSHIP')) return 60;
  if (type.includes('SOVEREIGN') || type.includes('DESTROYER')) return 150;
  if (type.includes('INTERCEPTOR')) return 30;
  return 15;
}

function normalizeNpcRewardMode(npc = {}) {
  const explicit = String(npc?.rewardMode || npc?.reward_mode || '').trim().toLowerCase();
  if (explicit === NPC_REWARD_MODE_WORLD_LOOT) return NPC_REWARD_MODE_WORLD_LOOT;
  if (explicit === NPC_REWARD_MODE_ACTIVITY) return NPC_REWARD_MODE_ACTIVITY;
  if (explicit === NPC_REWARD_MODE_NONE) return NPC_REWARD_MODE_NONE;

  const dropPolicy = String(npc?.dropPolicy || npc?.drop_policy || '').trim().toLowerCase();
  if (dropPolicy === 'activity_reward' || dropPolicy === 'instance_reward') return NPC_REWARD_MODE_ACTIVITY;
  if (dropPolicy === 'none' || dropPolicy === 'disabled' || dropPolicy === 'no_drop') return NPC_REWARD_MODE_NONE;

  if (isBattlegroundNpc(npc)) return NPC_REWARD_MODE_ACTIVITY;

  if (npc?.suppressLoot === true) return NPC_REWARD_MODE_NONE;
  return NPC_REWARD_MODE_WORLD_LOOT;
}

function getNpcWorldLootClass(npc = {}) {
  const explicit = String(npc?.worldLootClass || npc?.world_loot_class || '').trim();
  if (explicit) return explicit;
  if (isBattlegroundNpc(npc)) return 'instance_activity';
  if (npc?.isBio || npc?.type === 'BIO') return 'bio_salvage';
  if ((npc?.cargo || 0) > 0 && npc?.cargoType) return 'cargo_salvage';
  return 'ship_salvage';
}

function shouldNpcSpawnWorldLoot(npc = {}) {
  return normalizeNpcRewardMode(npc) === NPC_REWARD_MODE_WORLD_LOOT;
}

function buildNpcDeathRewardSummary(npc = {}, killCredit = null) {
  return {
    rewardMode: normalizeNpcRewardMode(npc),
    worldLootClass: getNpcWorldLootClass(npc),
    ownerType: killCredit?.topDamage?.sourceType || 'public',
    ownerId: killCredit?.topDamage?.sourceId || null
  };
}

function buildNpcLootItems(npc = {}) {
  const items = [];

  if ((npc.cargo || 0) > 0 && npc.cargoType) {
    const safeCargoAmount = Number(Number(npc.cargo).toFixed(2));
    if (safeCargoAmount > 0) {
      items.push({
        name: `${npc.cargoType} Fragment`,
        oreType: npc.cargoType,
        ql: npc.cargoQL || 1,
        qlBand: npc.cargoQLBand || '1-25',
        type: 'resource',
        rarity: 'common',
        amount: safeCargoAmount,
        weight: Number((safeCargoAmount * 0.1).toFixed(2)),
        description: `Recovered ${npc.cargoType} from pirate salvage.`
      });
    }
  }

  if (npc.isBio || npc.type === 'BIO') {
    items.push({
      name: `${npc.creatureType || 'Biological'} Tissue`,
      type: 'bio-material',
      materialKey: 'bio_tissue',
      rarity: 'common',
      amount: 1,
      weight: 0.5,
      description: 'Organic residue recovered from a biological target.'
    });
  } else if (items.length === 0 && Math.random() < 0.35) {
    items.push({
      name: 'Salvaged Components',
      type: 'component',
      rarity: 'common',
      amount: 1,
      weight: 0.8,
      description: 'Recovered ship components from the wreck.'
    });
  }

  return items;
}

async function spawnNpcLootForDeath(systemId, npc, killCredit = null) {
  if (!shouldNpcSpawnWorldLoot(npc)) return [];
  const drops = buildNpcLootItems(npc);
  if (!Array.isArray(drops) || drops.length <= 0) return [];

  const createdAt = Date.now();
  const rewardSummary = buildNpcDeathRewardSummary(npc, killCredit);
  const ownershipMeta = buildLootOwnershipMeta(killCredit, createdAt, {
    ownerType: rewardSummary.ownerType,
    ownerId: rewardSummary.ownerId
  });
  const spawnedRows = [];

  for (const item of drops) {
    try {
      const row = await insertWorldObject({
        type: item.type || 'loot',
        data: {
          ...item,
          lootClass: rewardSummary.worldLootClass,
          rewardMode: rewardSummary.rewardMode
        },
        x: npc.x,
        y: npc.y,
        system_id: systemId,
        owner_id: ownershipMeta.ownerId || undefined,
        ownership_meta: ownershipMeta
      });
      spawnedRows.push(row);
      broadcastToSystem(systemId, {
        type: 'WORLD_OBJECT_SPAWNED',
        object: row,
        ownerType: ownershipMeta.ownerType,
        ownerId: ownershipMeta.ownerId,
        killCreditId: ownershipMeta.killCreditId,
        assistIds: ownershipMeta.assistIds,
        rewardMode: rewardSummary.rewardMode,
        worldLootClass: rewardSummary.worldLootClass,
        serverTime: Date.now()
      });
    } catch (e) {
      console.warn('[NPC LOOT SPAWN] failed', e?.message || e);
    }
  }

  return spawnedRows;
}

function sanitizeAsteroidSnapshot(data = {}) {
  const oreAmount = Math.max(0, finiteNum(data.target_oreAmount ?? data.targetOreAmount ?? data.oreAmount, 0));
  return {
    id: String(data.target_id || data.targetId || '').trim(),
    type: String(data.target_type || data.targetType || 'Asteroid').trim() || 'Asteroid',
    oreType: String(data.target_oreType ?? data.targetOreType ?? data.oreType ?? '').trim() || undefined,
    ql: finiteNum(data.target_ql ?? data.targetQl ?? data.ql, 1),
    qlBand: String(data.target_qlBand ?? data.targetQlBand ?? data.qlBand ?? '').trim() || undefined,
    x: finiteNum(data.target_x ?? data.targetX, NaN),
    y: finiteNum(data.target_y ?? data.targetY, NaN),
    oreAmount,
    collisionRadius: Math.max(10, Math.min(250, finiteNum(data.target_collisionRadius ?? data.collisionRadius, 40))),
    depleted: false,
    lastUpdatedAt: Date.now()
  };
}

function sanitizeMiningConfig(data = {}) {
  return {
    yieldPerCycle: Math.max(0.1, Math.min(MINING_YIELD_MAX, finiteNum(data.yieldPerCycle ?? data.amount ?? data.miningYield, 1))),
    cycleMs: Math.max(MINING_CYCLE_MS_MIN, Math.min(MINING_CYCLE_MS_MAX, finiteNum(data.cycleMs ?? data.cycle_ms ?? 700, 700))),
    range: Math.max(80, Math.min(ASTEROID_MAX_RANGE, finiteNum(data.range ?? data.maxRange, 650))),
    weaponId: String(data.weapon_id || data.weaponId || 'mining-laser').trim() || 'mining-laser'
  };
}

function buildMiningLootItem(asteroid, amount) {
  const oreType = asteroid.oreType || asteroid.type || 'Ore';
  const ql = finiteNum(asteroid.ql, 1);
  const qlBand = String(asteroid.qlBand || '').trim() || undefined;
  const qty = Number(Number(amount || 0).toFixed(2));
  return {
    name: `${oreType} Fragment`,
    oreType,
    ql,
    qlBand,
    type: 'resource',
    rarity: 'common',
    amount: qty,
    weight: Number((qty * 0.1).toFixed(2)),
    description: `Unrefined ${oreType} fragment.`
  };
}

// -----------------------------------------------------
// LOAD SHIP STATE FROM SUPABASE (v2)
// -----------------------------------------------------
async function loadShipState(userId) {
  const { data: state, error } = await supabase
    .from("ship_states_v2")
    .select("*")
    .eq("player_id", userId)
    .single();

  if (error || !state) {
    console.log("[Backend] No ship_states_v2 found for", userId, error?.message || error);
    return null;
  }
  return state;
}

// -----------------------------------------------------
// CREATE DEFAULT SHIP STATE (v2) — NEW PLAYER
// -----------------------------------------------------
async function ensureDefaultShipStateV2(userId) {
  const defaultStarport = normalizeStarportId("cygnus_prime_starport");
  const defaultSystem = "cygnus-prime";
  if (!gameContentCache.loadedAt || gameContentCache.shipsById.size <= 0) {
    await loadGameContent();
  }
  const defaultShip = getShipContentByAnyId('OMNI SCOUT');
  const canonicalHullId = normalizeCanonicalShipId(defaultShip?.ship_id || defaultShip?.display_name || 'ship_omni_scout') || 'ship_omni_scout';
  const baseMaxHp = Math.max(1, finiteNum(defaultShip?.hull_base, 100));
  const baseMaxShields = Math.max(0, finiteNum(defaultShip?.shields_base, 0));
  const baseMaxEnergy = Math.max(0, finiteNum(defaultShip?.energy_base, 100));

  const existingHangarRows = await loadHangarShipsForPlayer(userId);
  let activeShipInstanceId = String(existingHangarRows[0]?.ship_id || '').trim();
  if (!activeShipInstanceId) {
    const starterShip = buildCraftedShipItem(null, defaultShip, 1, Date.now());
    activeShipInstanceId = String(starterShip.id || `${canonicalHullId}-${Date.now()}`).trim();
    starterShip.id = activeShipInstanceId;
    const { error: hangarError } = await supabase
      .from('hangar_states')
      .upsert({
        player_id: userId,
        starport_id: defaultStarport,
        ship_id: activeShipInstanceId,
        hull_id: canonicalHullId,
        ship_config: starterShip,
        updated_at: nowIso()
      }, { onConflict: 'player_id,starport_id,ship_id' });
    if (hangarError) console.warn('[Backend] Failed to create default hangar_states row:', userId, hangarError.message);
  }

  const payload = {
    player_id: userId,
    system_id: defaultSystem,
    starport_id: defaultStarport,
    ship_type: canonicalHullId,
    hull: baseMaxHp,
    maxHp: baseMaxHp,
    shields: baseMaxShields,
    maxShields: baseMaxShields,
    energy: baseMaxEnergy,
    maxEnergy: baseMaxEnergy,
    telemetry: {},
    cargo: [],
    fittings: {},
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("ship_states_v2")
    .upsert(payload, { onConflict: "player_id" });

  if (error) console.warn("[Backend] Failed to create default ship_states_v2:", error.message);

  if (activeShipInstanceId) {
    try {
      await supabase
        .from('commander_data')
        .upsert({ id: userId, active_ship_id: activeShipInstanceId, updated_at: nowIso() }, { onConflict: 'id' });
    } catch (e) {
      console.warn('[Backend] Failed to seed commander active_ship_id from hangar_states:', userId, e?.message || e);
    }
  }

  return payload;
}


// -----------------------------------------------------
// STARPORT / MARKET HELPERS (CD4)
// -----------------------------------------------------
const NPC_MARKET_SELLER_ID = "00000000-0000-0000-0000-000000000001";
const NPC_MARKET_SELLER_NAME = "OMNI DIRECTORATE";
const CONTENT_VENDOR_ID = "vendor_omni_blueprints";
const VENDOR_LISTING_DEFAULT_QTY = 9999;
const VENDOR_MODULE_OFFER_COUNT = 12;
const VENDOR_SIZE_WEIGHTS = Object.freeze([
  { value: 's', weight: 70 },
  { value: 'm', weight: 20 },
  { value: 'l', weight: 10 }
]);
const VENDOR_RARITY_WEIGHTS = Object.freeze([
  { value: 'common', weight: 65 },
  { value: 'uncommon', weight: 20 },
  { value: 'rare', weight: 10 },
  { value: 'epic', weight: 5 }
]);
const LEGACY_BLUEPRINT_ALIASES = Object.freeze({
  bp_ship_omni_scout: ["omni-scout-chassis"],
  bp_module_weapon_flux_laser_s_common: ["blueprint-common-flux-laser-s", "common-flux-laser-s"],
  bp_module_weapon_pulse_cannon_s_common: ["blueprint-common-pulse-cannon-s"],
  bp_module_weapon_seeker_pod_s_common: ["common-seeker-pod-s"],
  bp_module_mining_laser_s_common: ["blueprint-common-mining-laser-s"],
  bp_module_thruster_ion_s_common: ["blueprint-common-ion-thruster-s"],
  bp_module_shield_standard_s_common: ["blueprint-common-shield-module-s"],
  bp_module_drone_combat_bay_s_common: ["common-combat-drone-s-bp"],
  bp_module_drone_mining_bay_s_common: ["common-mining-drone-s-bp"],
  bp_module_drone_repair_bay_s_common: ["common-repair-drone-s-bp"]
});

function getBlueprintLegacyIds(blueprintId) {
  return LEGACY_BLUEPRINT_ALIASES[String(blueprintId || '').trim()] || [];
}


const gameContentCache = {
  loadedAt: 0,
  shipsById: new Map(),
  modulesById: new Map(),
  blueprintsById: new Map(),
  recipesByBlueprintId: new Map(),
  vendorStock: []
};

const vendorOfferCache = new Map(); // starport_id -> { generatedAt, offers }

function toIntSafe(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function inferShipSizeCodeFromIdentity(shipId = '', displayName = '') {
  const haystack = `${String(shipId || '').trim().toLowerCase()} ${String(displayName || '').trim().toLowerCase()}`;
  if (!haystack) return 's';
  if (haystack.includes('sovereign') || haystack.includes('command')) return 'l';
  if (haystack.includes('gunship') || haystack.includes('hauler') || haystack.includes('mining')) return 'm';
  return 's';
}

function normalizeSizeCode(value, fallback = 's') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'l' || raw === 'large') return 'l';
  if (raw === 'm' || raw === 'medium') return 'm';
  if (raw === 's' || raw === 'small') return 's';
  return String(fallback || 's').trim().toLowerCase() || 's';
}

function sizeCodeToTier(value, fallback = 1) {
  const code = normalizeSizeCode(value, '');
  if (code === 'l') return 3;
  if (code === 'm') return 2;
  if (code === 's') return 1;
  return fallback;
}


function sanitizeShipFittingsSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [slotId, slotValue] of Object.entries(value)) {
    const key = String(slotId || '').trim();
    if (!key) continue;
    normalized[key] = slotValue ?? null;
  }
  return normalized;
}

function buildDefaultShipFittingsSchema(shipDef = null, existingFittings = null) {
  const rawDefaults = sanitizeShipFittingsSchema(
    shipDef?.fittings
    || shipDef?.slot_layout
    || shipDef?.slotLayout
    || shipDef?.stats?.fittings
    || shipDef?.stats?.slot_layout
    || shipDef?.stats?.slotLayout
    || null
  );
  const existing = sanitizeShipFittingsSchema(existingFittings);
  const normalized = { ...FITTINGS_SLOT_SCHEMA };

  const applySlots = (source = {}) => {
    for (const [slotId, value] of Object.entries(source)) {
      const key = String(slotId || '').trim();
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(FITTINGS_SLOT_SCHEMA, key)) continue;
      normalized[key] = value ?? null;
    }
  };

  applySlots(rawDefaults);
  applySlots(existing);

  return { ...normalized };
}

function normalizeContentShipRow(row = {}) {
  const resistances = (row.resistances && typeof row.resistances === 'object' && !Array.isArray(row.resistances)) ? row.resistances : {};
  const shipId = String(row.ship_id || '').trim();
  const displayName = String(row.display_name || row.ship_type_key || row.ship_id || '').trim();
  const stats = (row.stats && typeof row.stats === 'object' && !Array.isArray(row.stats)) ? row.stats : {};
  return {
    ship_id: shipId,
    display_name: displayName,
    rarity: String(row.rarity || 'common').trim().toLowerCase(),
    size: normalizeSizeCode(row.size ?? row.class_size ?? row.hull_size, inferShipSizeCodeFromIdentity(shipId, displayName)),
    hull_base: Math.max(1, finiteNum(row.hull_base ?? row.max_hp ?? row.maxHp, 100)),
    shields_base: Math.max(0, finiteNum(row.shields_base ?? row.max_shields ?? row.maxShields, 0)),
    energy_base: Math.max(0, finiteNum(row.energy_base ?? row.base_energy ?? row.max_energy ?? row.maxEnergy, 100)),
    cargo_base: Math.max(0, finiteNum(row.cargo_base ?? row.cargo ?? 0, 0)),
    armor_base: Math.max(0, finiteNum(row.armor_base ?? row.armor ?? 0, 0)),
    powergrid_base: Math.max(0, finiteNum(row.powergrid_base ?? row.powergrid ?? row.power_grid ?? 0, 0)),
    cpu_base: Math.max(0, finiteNum(row.cpu_base ?? row.cpu ?? 0, 0)),
    capacitor_recharge_base: Math.max(0, finiteNum(row.capacitor_recharge_base ?? row.capacitorRecharge ?? row.capacitor_recharge ?? 0, 0)),
    max_velocity_base: Math.max(0, finiteNum(row.max_velocity_base ?? row.maxVelocity ?? row.max_velocity ?? 0, 0)),
    thrust_impulse_base: Math.max(0, finiteNum(row.thrust_impulse_base ?? row.thrustImpulse ?? row.thrust_impulse ?? 0, 0)),
    angular_momentum_base: Math.max(0, finiteNum(row.angular_momentum_base ?? row.angularMomentum ?? row.angular_momentum ?? 0, 0)),
    scan_range_base: Math.max(0, finiteNum(row.scan_range_base ?? row.scanRange ?? row.scan_range ?? 0, 0)),
    lock_on_range_base: Math.max(0, finiteNum(row.lock_on_range_base ?? row.lockOnRange ?? row.lock_on_range ?? 0, 0)),
    signature_radius_base: Math.max(1, finiteNum(row.signature_radius_base ?? row.signatureRadius ?? row.signature_radius ?? 20, 20)),
    cargo_capacity_base: Math.max(0, finiteNum(row.cargo_capacity_base ?? row.cargoCapacity ?? row.cargo_capacity ?? row.cargo_base ?? row.cargo ?? 0, 0)),
    resistances,
    fittings: buildDefaultShipFittingsSchema({ ...row, stats }),
    stats,
    enabled: row.enabled !== false
  };
}

function normalizeContentModuleRow(row = {}) {
  return {
    module_id: String(row.module_id || '').trim(),
    module_type: String(row.module_type || '').trim(),
    subtype: String(row.subtype || '').trim(),
    size: String(row.size || '').trim().toLowerCase(),
    rarity: String(row.rarity || 'common').trim().toLowerCase(),
    display_name: String(row.display_name || row.module_id || '').trim(),
    stats: (row.stats && typeof row.stats === 'object' && !Array.isArray(row.stats)) ? row.stats : {},
    enabled: row.enabled !== false
  };
}

function normalizeContentBlueprintRow(row = {}) {
  const blueprintId = String(row.blueprint_id || '').trim();
  const legacyBlueprintIds = getBlueprintLegacyIds(blueprintId);
  return {
    blueprint_id: blueprintId,
    blueprint_kind: String(row.blueprint_kind || '').trim().toLowerCase(),
    display_name: String(row.display_name || blueprintId || '').trim(),
    output_type: String(row.output_type || '').trim().toLowerCase(),
    output_id: String(row.output_id || '').trim(),
    output_quantity: Math.max(1, toIntSafe(row.output_quantity, 1)),
    fabrication_time_ms: Math.max(0, toIntSafe(row.fabrication_time_ms, 0)),
    base_vendor_price_credits: Math.max(0, toIntSafe(row.base_vendor_price_credits, 0)),
    rarity: String(row.rarity || 'common').trim().toLowerCase(),
    size: row.size == null ? null : String(row.size).trim().toLowerCase(),
    enabled: row.enabled !== false,
    client_blueprint_id: blueprintId,
    legacy_blueprint_ids: legacyBlueprintIds
  };
}

function normalizeContentRecipeRow(row = {}) {
  return {
    blueprint_id: String(row.blueprint_id || '').trim(),
    input_item_type: String(row.input_item_type || '').trim().toLowerCase(),
    input_item_id: row.input_item_id == null ? null : String(row.input_item_id).trim(),
    quantity: Math.max(0, Number(row.quantity) || 0),
    consume: row.consume !== false,
    slot_index: Math.max(0, toIntSafe(row.slot_index, 0))
  };
}

function normalizeVendorStockRow(row = {}) {
  return {
    id: row.id || null,
    vendor_id: String(row.vendor_id || '').trim(),
    starport_id: row.starport_id == null ? null : normalizeStarportId(row.starport_id),
    faction_key: row.faction_key == null ? null : String(row.faction_key).trim(),
    item_type: String(row.item_type || '').trim().toLowerCase(),
    item_id: String(row.item_id || '').trim(),
    price_credits: Math.max(0, toIntSafe(row.price_credits, 0)),
    stock_mode: String(row.stock_mode || 'infinite').trim().toLowerCase(),
    stock_qty: row.stock_qty == null ? null : Math.max(0, toIntSafe(row.stock_qty, 0)),
    refresh_seconds: row.refresh_seconds == null ? null : Math.max(0, toIntSafe(row.refresh_seconds, 0)),
    enabled: row.enabled !== false
  };
}


const LEGACY_SHIP_ID_ALIASES = Object.freeze({
  ship_omni_scout_t1: 'ship_omni_scout',
  ship_omni_interceptor_t1: 'ship_omni_interceptor',
  ship_omni_gunship_t1: 'ship_omni_gunship',
  ship_omni_hauler_t1: 'ship_omni_hauler',
  ship_omni_mining_ship_t1: 'ship_omni_mining',
  ship_omni_command_t1: 'ship_omni_command',
  ship_omni_sovereign_t1: 'ship_omni_sovereign'
});

function normalizeCanonicalShipId(rawId) {
  const value = String(rawId || '').trim();
  if (!value) return '';
  const direct = LEGACY_SHIP_ID_ALIASES[value];
  if (direct) return direct;
  const lower = value.toLowerCase();
  for (const [legacyId, canonicalId] of Object.entries(LEGACY_SHIP_ID_ALIASES)) {
    if (legacyId.toLowerCase() == lower) return canonicalId;
  }
  return value;
}

function getShipContentByAnyId(rawId) {
  const normalizedRaw = normalizeCanonicalShipId(rawId);
  const needle = String(normalizedRaw || '').trim().toLowerCase();
  if (!needle) return null;
  for (const ship of gameContentCache.shipsById.values()) {
    if (!ship) continue;
    const ids = [
      ship.ship_id,
      ship.display_name,
      normalizeCanonicalShipId(ship.ship_id)
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (ids.includes(needle)) return ship;
  }
  return null;
}

function normalizeLooseContentLookupId(rawId) {
  return String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getModuleContentByAnyId(rawId) {
  const needle = String(rawId || '').trim().toLowerCase();
  const looseNeedle = normalizeLooseContentLookupId(rawId);
  if (!needle && !looseNeedle) return null;
  for (const mod of gameContentCache.modulesById.values()) {
    if (!mod) continue;
    const ids = [mod.module_id, mod.display_name]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    if (needle && ids.includes(needle)) return mod;
    if (looseNeedle) {
      const looseIds = ids.map((value) => normalizeLooseContentLookupId(value)).filter(Boolean);
      if (looseIds.includes(looseNeedle)) return mod;
    }
  }
  return null;
}

function getRuntimeFittedModuleStats(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return {};
  const finalStats = (item.final_stats && typeof item.final_stats === 'object' && !Array.isArray(item.final_stats)) ? item.final_stats : {};
  const baseStats = (item.base_stats && typeof item.base_stats === 'object' && !Array.isArray(item.base_stats)) ? item.base_stats : {};
  const merged = { ...baseStats, ...finalStats };
  const normalized = {};
  const type = String(item.module_type || item.moduleType || item.type || '').trim().toLowerCase();
  if (merged.capacity != null) normalized.shieldCapacity = merged.capacity;
  if (merged.baseCapacity != null && normalized.shieldCapacity == null) normalized.shieldCapacity = merged.baseCapacity;
  if (merged.regen != null) normalized.shieldRegen = merged.regen;
  if (merged.baseRegen != null && normalized.shieldRegen == null) normalized.shieldRegen = merged.baseRegen;
  if (merged.power != null) normalized.powergrid = merged.power;
  if (merged.basePG != null && normalized.powergrid == null) normalized.powergrid = merged.basePG;
  if (merged.cpu != null) normalized.cpu = merged.cpu;
  if (merged.baseCPU != null && normalized.cpu == null) normalized.cpu = merged.baseCPU;
  if (merged.hullBonus != null) normalized.hullBonus = merged.hullBonus;
  if (merged.energyBonus != null) normalized.energyBonus = merged.energyBonus;
  if (type === 'shield' || type === 'shield-generator') {
    if (normalized.shieldCapacity == null && merged.shields != null) normalized.shieldCapacity = merged.shields;
  }
  return normalized;
}

function clampResistance(value) {
  return clamp(finiteNum(value, 0), 0, 0.95);
}

function normalizeResistanceMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value.resist && typeof value.resist === 'object' && !Array.isArray(value.resist) ? value.resist : value;
  const result = {};
  for (const [key, raw] of Object.entries(source)) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!normalizedKey) continue;
    result[normalizedKey] = clampResistance(raw);
  }
  return result;
}

function mergeResistanceMaps(base = {}, extra = {}) {
  const merged = { ...normalizeResistanceMap(base) };
  for (const [key, value] of Object.entries(normalizeResistanceMap(extra))) {
    merged[key] = clampResistance((merged[key] || 0) + value);
  }
  return merged;
}

function computeFittingsSignature(fittings = {}) {
  if (!fittings || typeof fittings !== 'object') return '';
  const entries = Object.entries(fittings)
    .filter(([slotId, item]) => !!slotId && item && typeof item === 'object')
    .map(([slotId, item]) => {
      const identifier = String(item.canonical_output_id || item.canonicalOutputId || item.module_id || item.item_id || item.itemId || item.id || item.name || '').trim();
      const ql = Number(item.avgQL ?? item.quality ?? item.ql ?? 1);
      return `${slotId}:${identifier}:${Number.isFinite(ql) ? ql : 1}`;
    })
    .sort();
  return entries.join('|');
}

function getModuleQualityScalar(item = {}, moduleStats = {}) {
  const ql = clamp(parseItemQlValue(item), 1, 300);
  const scalePerPoint = finiteNum(moduleStats.qlScalePerPoint ?? moduleStats.ql_scale_per_point ?? moduleStats.qualityScalePerPoint, 0);
  const maxBonus = Math.max(0, finiteNum(moduleStats.qlMaxBonus ?? moduleStats.ql_max_bonus ?? moduleStats.qualityMaxBonus, 0));
  if (!(scalePerPoint > 0)) return 1;
  const rawBonus = Math.max(0, (ql - 1) * scalePerPoint);
  const appliedBonus = maxBonus > 0 ? Math.min(maxBonus, rawBonus) : rawBonus;
  return Math.max(0.1, 1 + appliedBonus);
}

function scaleModuleStat(rawValue, scalar) {
  const n = finiteNum(rawValue, 0);
  return Number((n * Math.max(0.1, finiteNum(scalar, 1))).toFixed(4));
}

function inferWeaponKind(moduleDef = {}, moduleStats = {}) {
  const explicit = String(moduleStats.kind || moduleStats.weaponKind || '').trim().toLowerCase();
  if (explicit) return explicit;
  const subtype = String(moduleDef.subtype || '').trim().toLowerCase();
  if (subtype === 'flux_laser') return 'beam';
  if (subtype === 'pulse_cannon') return 'projectile';
  if (subtype === 'seeker_pod') return 'missile';
  if (moduleDef.module_type === 'mining') return 'hitscan';
  return 'hitscan';
}

function buildHydratedWeaponStats(moduleDef = {}, fittedItem = {}) {
  const stats = (moduleDef.stats && typeof moduleDef.stats === 'object' && !Array.isArray(moduleDef.stats)) ? moduleDef.stats : {};
  const scalar = getModuleQualityScalar(fittedItem, stats);
  const cooldownFromRate = (() => {
    const fireRate = finiteNum(stats.fireRate ?? stats.fire_rate ?? stats.rateOfFire, 0);
    if (!(fireRate > 0)) return null;
    return 1000 / fireRate;
  })();
  return {
    kind: inferWeaponKind(moduleDef, stats),
    family: detectWeaponFamily({ weaponSubtype: moduleDef.subtype, weaponType: moduleDef.module_type, weaponName: moduleDef.display_name, weaponId: moduleDef.module_id }),
    size: String(moduleDef.size || fittedItem.weaponsize || 'S').trim().toUpperCase(),
    damage: clamp(scaleModuleStat(stats.damage ?? stats.baseDamage ?? stats.hullDamage, scalar), 0, 2000),
    range: clamp(scaleModuleStat(stats.range ?? stats.maxRange ?? stats.beamRange, scalar || 1), 50, 5000),
    energyCost: clamp(scaleModuleStat(stats.energyUse ?? stats.energyCost ?? stats.energy_cost, 1), 0, 500),
    cooldownMs: clamp(finiteNum(stats.cooldownMs ?? stats.cooldown_ms ?? cooldownFromRate, 160), 30, 10000),
    projectileSpeed: clamp(scaleModuleStat(stats.projectileSpeed ?? stats.projectile_speed ?? stats.speed, 1), 0, 50),
  };
}

function findFittedModuleDefinition(fittings = {}, meta = {}) {
  const candidates = [
    meta.instanceId,
    meta.weaponId,
    meta.itemId,
    meta.weaponName,
    meta.weaponSubtype,
    meta.weaponType
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);

  for (const [slotId, item] of Object.entries(fittings || {})) {
    if (!item || typeof item !== 'object') continue;
    const moduleDef = getModuleContentByAnyId(item.canonical_output_id || item.canonicalOutputId || item.module_id || item.item_id || item.itemId || item.id || item.name);
    if (!moduleDef) continue;
    const itemIds = [
      slotId,
      item.id,
      item.item_id,
      item.itemId,
      item.module_id,
      item.canonical_output_id,
      item.canonicalOutputId,
      item.name,
      moduleDef.module_id,
      moduleDef.display_name,
      moduleDef.subtype,
      moduleDef.module_type
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (candidates.some((candidate) => itemIds.includes(candidate))) {
      return { slotId, item, moduleDef };
    }
  }
  return null;
}

function getModuleStatBonus(moduleStats = {}, scalar, keys = []) {
  for (const key of keys) {
    const raw = moduleStats?.[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0, scaleModuleStat(raw, scalar));
    }
  }
  return 0;
}

function getShipSizeTier(shipDef = {}, sourceState = null, player = null) {
  const fallback = inferShipSizeCodeFromIdentity(
    shipDef?.ship_id || player?.ship_type || sourceState?.ship_type || '',
    shipDef?.display_name || player?.ship_type || sourceState?.shipType || ''
  );
  return sizeCodeToTier(shipDef?.size ?? sourceState?.size ?? sourceState?.ship_size, sizeCodeToTier(fallback, 1));
}

function getModuleSizeTier(moduleDef = {}, fittedItem = {}) {
  return sizeCodeToTier(fittedItem?.size || fittedItem?.weaponsize || moduleDef?.size, 1);
}

function getOversizeSignatureMultiplier(shipTier, moduleTier) {
  const delta = Math.max(0, finiteNum(moduleTier, 1) - finiteNum(shipTier, 1));
  if (delta <= 0) return 1;
  if (delta === 1) return 1.2;
  return 1.5;
}

function buildPlayerCombatStats(player, sourceState = null) {
  console.log('[BUILD COMBAT STATS] start', {
    userId: player?.userId || player?.id || null,
    shipId: player?.ship_type || sourceState?.ship_type || sourceState?.shipType || null,
    fittings: player?.fittings || {},
    sourceState: sourceState || null
  });
  const shipDef = getShipContentByAnyId(player?.ship_type || sourceState?.ship_type || sourceState?.shipType || 'OMNI SCOUT');
  const baseHull = Math.max(1, finiteNum(shipDef?.hull_base, finiteNum(sourceState?.maxHp, finiteNum(player?.maxHp, 100))));
  const baseShields = Math.max(0, finiteNum(shipDef?.shields_base, finiteNum(sourceState?.maxShields, finiteNum(player?.maxShields, 0))));
  const baseEnergy = Math.max(0, finiteNum(shipDef?.energy_base, finiteNum(sourceState?.maxEnergy, finiteNum(player?.maxEnergy, 100))));
  const baseArmor = Math.max(0, finiteNum(shipDef?.armor_base, 0));
  let maxHp = baseHull;
  let maxShields = baseShields;
  let maxEnergy = baseEnergy;
  let armor = baseArmor;
  let powergrid = Math.max(0, finiteNum(shipDef?.powergrid_base, finiteNum(sourceState?.powergrid, finiteNum(player?.combatStats?.powergrid, 0))));
  let cpu = Math.max(0, finiteNum(shipDef?.cpu_base, finiteNum(sourceState?.cpu, finiteNum(player?.combatStats?.cpu, 0))));
  let maxVelocity = Math.max(0, finiteNum(shipDef?.max_velocity_base, finiteNum(sourceState?.maxVelocity, finiteNum(player?.combatStats?.maxVelocity, 0))));
  let thrustImpulse = Math.max(0, finiteNum(shipDef?.thrust_impulse_base, finiteNum(sourceState?.thrustImpulse, finiteNum(player?.combatStats?.thrustImpulse, 0))));
  let angularMomentum = Math.max(0, finiteNum(shipDef?.angular_momentum_base, finiteNum(sourceState?.angularMomentum, finiteNum(player?.combatStats?.angularMomentum, 0))));
  let capacitorRecharge = Math.max(0, finiteNum(shipDef?.capacitor_recharge_base, finiteNum(sourceState?.capacitorRecharge, finiteNum(player?.combatStats?.capacitorRecharge, 0))));
  let scanRange = Math.max(0, finiteNum(shipDef?.scan_range_base, finiteNum(sourceState?.scanRange, finiteNum(player?.combatStats?.scanRange, 0))));
  let lockOnRange = Math.max(0, finiteNum(shipDef?.lock_on_range_base, finiteNum(sourceState?.lockOnRange, finiteNum(player?.combatStats?.lockOnRange, 0))));
  let signatureRadius = Math.max(1, finiteNum(shipDef?.signature_radius_base, finiteNum(sourceState?.signatureRadius, finiteNum(player?.combatStats?.signatureRadius, 20))));
  let cargoCapacity = Math.max(0, finiteNum(shipDef?.cargo_capacity_base, finiteNum(sourceState?.cargoCapacity, finiteNum(player?.combatStats?.cargoCapacity, finiteNum(shipDef?.cargo_base, 0)))));
  let resistances = normalizeResistanceMap(shipDef?.resistances || {});
  const weaponStats = {};
  const oversizePenalties = [];
  const shipSizeTier = getShipSizeTier(shipDef, sourceState, player);

  for (const [slotId, item] of Object.entries(player?.fittings || {})) {
    if (!item || typeof item !== 'object') continue;
    const moduleDef = getModuleContentByAnyId(item.canonical_output_id || item.canonicalOutputId || item.module_id || item.item_id || item.itemId || item.id || item.name);
    const authoritativeModuleStats = (moduleDef?.stats && typeof moduleDef.stats === 'object' && !Array.isArray(moduleDef.stats)) ? moduleDef.stats : {};
    const runtimeModuleStats = getRuntimeFittedModuleStats(item);
    const moduleStats = Object.keys(authoritativeModuleStats).length > 0 ? authoritativeModuleStats : runtimeModuleStats;
    if (!moduleDef && Object.keys(runtimeModuleStats).length > 0) {
      console.log('[BUILD COMBAT STATS] runtime fallback stats', {
        userId: player?.userId || player?.id || null,
        slotId,
        item,
        runtimeModuleStats
      });
    }
    if (!moduleDef && Object.keys(moduleStats).length <= 0) continue;
    const scalar = getModuleQualityScalar(item, moduleStats);
    maxHp += Math.max(0, scaleModuleStat(moduleStats.hullBonus ?? moduleStats.maxHpBonus ?? moduleStats.maxHullBonus, scalar));
    maxShields += Math.max(0, scaleModuleStat(moduleStats.shieldCapacity ?? moduleStats.maxShieldsBonus ?? moduleStats.shields, scalar));
    maxEnergy += Math.max(0, scaleModuleStat(moduleStats.energyBonus ?? moduleStats.maxEnergyBonus ?? moduleStats.energyCapacity, scalar));
    armor += Math.max(0, scaleModuleStat(moduleStats.armor ?? moduleStats.armorBonus, scalar));
    powergrid += getModuleStatBonus(moduleStats, scalar, ['powergrid', 'powergridBonus', 'powerGrid', 'powerGridBonus', 'pg', 'pgBonus']);
    cpu += getModuleStatBonus(moduleStats, scalar, ['cpu', 'cpuBonus']);
    maxVelocity += getModuleStatBonus(moduleStats, scalar, ['maxVelocity', 'max_velocity', 'speedBoost', 'speed', 'velocityBonus']);
    thrustImpulse += getModuleStatBonus(moduleStats, scalar, ['thrustImpulse', 'thrust_impulse', 'thrustBonus']);
    angularMomentum += getModuleStatBonus(moduleStats, scalar, ['angularMomentum', 'angular_momentum', 'turnRate', 'turnBonus']);
    capacitorRecharge += getModuleStatBonus(moduleStats, scalar, ['capacitorRecharge', 'capacitor_recharge', 'energyRecharge', 'energy_recharge']);
    scanRange += getModuleStatBonus(moduleStats, scalar, ['scanRange', 'scan_range']);
    lockOnRange += getModuleStatBonus(moduleStats, scalar, ['lockOnRange', 'lock_on_range']);
    cargoCapacity += getModuleStatBonus(moduleStats, scalar, ['cargoCapacity', 'cargo_capacity', 'cargo']);
    signatureRadius += Math.max(0, scaleModuleStat(moduleStats.signatureRadius ?? moduleStats.signatureBonus, scalar));
    resistances = mergeResistanceMaps(resistances, moduleStats.resistances || moduleStats.resist || {});

    const moduleTier = getModuleSizeTier(moduleDef, item);
    const oversizeMult = getOversizeSignatureMultiplier(shipSizeTier, moduleTier);
    if (oversizeMult > 1) {
      signatureRadius *= oversizeMult;
      oversizePenalties.push({
        slotId,
        moduleId: moduleDef?.module_id || item?.module_id || item?.item_id || item?.id || slotId,
        shipSizeTier,
        moduleSizeTier: moduleTier,
        multiplier: Number(oversizeMult.toFixed(2))
      });
    }

    const resolvedModuleType = String(moduleDef?.module_type || item?.module_type || item?.moduleType || item?.type || '').trim().toLowerCase();
    if (moduleDef && (resolvedModuleType === 'weapon' || resolvedModuleType === 'mining')) {
      const built = buildHydratedWeaponStats(moduleDef, item);
      const aliases = [slotId, item.id, item.item_id, item.itemId, item.module_id, item.canonical_output_id, item.canonicalOutputId, moduleDef.module_id, moduleDef.display_name]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      for (const alias of aliases) {
        weaponStats[alias] = built;
      }
    }
  }

  const builtCombatStats = {
    shipId: shipDef?.ship_id || null,
    shipDisplayName: shipDef?.display_name || player?.ship_type || null,
    maxHp: Math.max(1, Math.round(maxHp)),
    maxShields: Math.max(0, Math.round(maxShields)),
    maxEnergy: Math.max(0, Math.round(maxEnergy)),
    armor: Number(armor.toFixed(3)),
    resistances,
    powergrid: Number(powergrid.toFixed(3)),
    cpu: Number(cpu.toFixed(3)),
    maxVelocity: Number(maxVelocity.toFixed(4)),
    thrustImpulse: Number(thrustImpulse.toFixed(4)),
    angularMomentum: Number(angularMomentum.toFixed(6)),
    capacitorRecharge: Number(capacitorRecharge.toFixed(4)),
    scanRange: Number(scanRange.toFixed(3)),
    lockOnRange: Number(lockOnRange.toFixed(3)),
    signatureRadius: Number(signatureRadius.toFixed(3)),
    cargoCapacity: Number(cargoCapacity.toFixed(3)),
    oversizePenalties,
    weaponStats,
    source: 'supabase_hydrated'
  };
  console.log('[BUILD COMBAT STATS] result', {
    userId: player?.userId || player?.id || null,
    shipId: builtCombatStats.shipId,
    maxHp: builtCombatStats.maxHp,
    maxShields: builtCombatStats.maxShields,
    maxEnergy: builtCombatStats.maxEnergy,
    armor: builtCombatStats.armor,
    fittingsSeen: player?.fittings || {},
    oversizePenalties: builtCombatStats.oversizePenalties || []
  });
  return builtCombatStats;
}

function applyHydratedPlayerCombatStats(player, { sourceState = null, preserveCurrent = true } = {}) {
  if (!player) return null;
  console.log('[COMBAT APPLY] before enrich', {
    userId: player?.userId || player?.id || null,
    shipId: player?.ship_type || sourceState?.ship_type || sourceState?.shipType || null,
    fittings: player?.fittings || {},
    sourceState: sourceState || null,
    preserveCurrent
  });
  player.fittings = normalizeFittingsSchema(player.fittings, player?.ship_type || sourceState?.ship_type || sourceState?.shipType || null);
  player.fittings = enrichRuntimeFittingsWithModuleAuthority(player.fittings, player?.ship_type || sourceState?.ship_type || sourceState?.shipType || null);
  player.fittings = normalizeFittingsSchema(player.fittings, player?.ship_type || sourceState?.ship_type || sourceState?.shipType || null);
  console.log('[COMBAT APPLY] after enrich', {
    userId: player?.userId || player?.id || null,
    fittings: player?.fittings || {}
  });
  const combatStats = buildPlayerCombatStats(player, sourceState);
  console.log('[COMBAT APPLY] built combat stats', {
    userId: player?.userId || player?.id || null,
    combatStats
  });
  player.combatStats = combatStats;
  player.armor = combatStats.armor;
  player.resistances = combatStats.resistances;
  player.weaponStats = combatStats.weaponStats;
  player.maxHp = combatStats.maxHp;
  player.maxShields = combatStats.maxShields;
  player.maxEnergy = combatStats.maxEnergy;
  player.signatureRadius = combatStats.signatureRadius;
  player.oversizePenalties = Array.isArray(combatStats.oversizePenalties) ? combatStats.oversizePenalties : [];
  if (preserveCurrent) {
    player.hp = Math.max(0, Math.min(typeof player.hp === 'number' ? player.hp : combatStats.maxHp, combatStats.maxHp));
    player.shields = Math.max(0, Math.min(typeof player.shields === 'number' ? player.shields : combatStats.maxShields, combatStats.maxShields));
    player.energy = Math.max(0, Math.min(typeof player.energy === 'number' ? player.energy : combatStats.maxEnergy, combatStats.maxEnergy));
  } else {
    player.hp = combatStats.maxHp;
    player.shields = combatStats.maxShields;
    player.energy = combatStats.maxEnergy;
  }
  player._fittingsSignature = computeFittingsSignature(player.fittings);
  return combatStats;
}


async function hydratePlayerFromCommanderActiveShip(player, { fillVitals = false, persistState = false } = {}) {
  if (!player?.userId) return null;
  const commander = await loadCommanderDataRow(player.userId);
  const activeShipId = String(commander?.active_ship_id || '').trim();
  if (!activeShipId) return null;

  const previousRuntimeShipInstanceId = String(player?.active_ship_instance_id || player?.current_ship_instance_id || '').trim();
  let hangarShipRecord = await loadHangarShipRecordById(player.userId, activeShipId);
  if (!hangarShipRecord?.ship_config) {
    hangarShipRecord = await ensureHangarShipRecord(player, activeShipId);
  }
  const hangarShipConfig = hangarShipRecord?.ship_config && typeof hangarShipRecord.ship_config === 'object' ? hangarShipRecord.ship_config : null;
  if (!hangarShipConfig) return null;

  const selectedShipType = normalizeCanonicalShipId(
    hangarShipRecord?.hull_id || hangarShipConfig.hull_id || hangarShipConfig.ship_id || hangarShipConfig.type || hangarShipConfig.ship_type || player.ship_type || 'ship_omni_scout'
  ) || 'ship_omni_scout';

  player.ship_type = selectedShipType;
  player.active_ship_instance_id = activeShipId;
  player.current_ship_instance_id = activeShipId;
  player.fittings = sanitizeRuntimeFittings(hangarShipConfig.fittings, selectedShipType);
  if (hangarShipConfig.visual_config && typeof hangarShipConfig.visual_config === 'object' && !Array.isArray(hangarShipConfig.visual_config)) {
    player.visual_config = hangarShipConfig.visual_config;
  }

  const sourceState = {
    ship_type: selectedShipType,
    maxHp: finiteNum(hangarShipConfig.maxHp, finiteNum(hangarShipConfig.hp, 0)),
    maxShields: finiteNum(hangarShipConfig.maxShields, finiteNum(hangarShipConfig.shields, 0)),
    maxEnergy: finiteNum(hangarShipConfig.maxEnergy, finiteNum(hangarShipConfig.energy, 0)),
    size: hangarShipConfig.size || null,
    fittings: player.fittings
  };

  const preserveCurrentVitals = !fillVitals && previousRuntimeShipInstanceId === activeShipId;
  applyHydratedPlayerCombatStats(player, { sourceState, preserveCurrent: preserveCurrentVitals });

  const storedHp = Number.isFinite(Number(hangarShipConfig.hp)) ? Number(hangarShipConfig.hp) : null;
  const storedShields = Number.isFinite(Number(hangarShipConfig.shields)) ? Number(hangarShipConfig.shields) : null;
  const storedEnergy = Number.isFinite(Number(hangarShipConfig.energy)) ? Number(hangarShipConfig.energy) : null;

  if (fillVitals) {
    player.hp = Math.max(0, Math.min(finiteNum(storedHp, player.maxHp), player.maxHp));
    player.shields = Math.max(0, Math.min(finiteNum(storedShields, player.maxShields), player.maxShields));
    player.energy = Math.max(0, Math.min(finiteNum(storedEnergy, player.maxEnergy), player.maxEnergy));
  } else if (preserveCurrentVitals) {
    player.hp = Math.max(0, Math.min(finiteNum(player.hp, finiteNum(storedHp, player.maxHp)), player.maxHp));
    player.shields = Math.max(0, Math.min(finiteNum(player.shields, finiteNum(storedShields, player.maxShields)), player.maxShields));
    player.energy = Math.max(0, Math.min(finiteNum(player.energy, finiteNum(storedEnergy, player.maxEnergy)), player.maxEnergy));
  } else {
    player.hp = Math.max(0, Math.min(finiteNum(storedHp, player.maxHp), player.maxHp));
    player.shields = Math.max(0, Math.min(finiteNum(storedShields, player.maxShields), player.maxShields));
    player.energy = Math.max(0, Math.min(finiteNum(storedEnergy, player.maxEnergy), player.maxEnergy));
  }

  player.destroyed = false;

  if (persistState) {
    try {
      await supabase
        .from('ship_states_v2')
        .upsert({
          player_id: player.userId,
          system_id: player.system_id || 'cygnus-prime',
          starport_id: player.starport_id || null,
          ship_type: player.ship_type,
          hull: player.hp,
          maxHp: player.maxHp,
          shields: player.shields,
          maxShields: player.maxShields,
          energy: player.energy,
          maxEnergy: player.maxEnergy,
          fittings: player.fittings || {},
          telemetry: telemetrySnapshot(player),
          updated_at: nowIso()
        }, { onConflict: 'player_id' });
      await persistActiveShipToHangar(player);
    } catch (e) {
      console.warn('[Backend] Failed to persist active ship hydrate:', player.userId, e?.message || e);
    }
  }

  return hangarShipConfig;
}

function getHydratedWeaponStats(player, weaponId, snapshot, meta = {}) {
  const fitted = findFittedModuleDefinition(player?.fittings || {}, meta);
  if (fitted?.moduleDef) {
    return buildHydratedWeaponStats(fitted.moduleDef, fitted.item || {});
  }

  const lookupKeys = [weaponId, meta.instanceId, meta.itemId, meta.weaponName].map((value) => String(value || '').trim()).filter(Boolean);
  for (const key of lookupKeys) {
    const found = player?.weaponStats?.[key];
    if (found) return found;
  }

  return getWeaponStats(weaponId, snapshot, meta);
}

function getBlueprintContent(blueprintId) {
  const key = String(blueprintId || '').trim();
  if (!key) return null;
  return gameContentCache.blueprintsById.get(key) || null;
}

function getBlueprintRecipeInputs(blueprintId) {
  const key = String(blueprintId || '').trim();
  return gameContentCache.recipesByBlueprintId.get(key) || [];
}

function getBlueprintClientId(blueprintId) {
  const bp = getBlueprintContent(blueprintId);
  return bp?.blueprint_id || String(blueprintId || '').trim();
}

function getVendorStockRowsForStarport(starportId, vendorId = CONTENT_VENDOR_ID) {
  const normalizedStarportId = normalizeStarportId(starportId);
  return gameContentCache.vendorStock.filter((row) => {
    if (!row || row.enabled === false) return false;
    if (String(row.vendor_id || '') !== String(vendorId || '')) return false;
    const catalogType = String(row.item_type || '').trim().toLowerCase();
    const itemId = String(row.item_id || '').trim();
    if (!catalogType || !itemId) return false;

    if (catalogType === 'blueprint' && !gameContentCache.blueprintsById.has(itemId)) return false;
    if (catalogType === 'ship' && !gameContentCache.shipsById.has(itemId)) return false;
    if (catalogType === 'module' && !gameContentCache.modulesById.has(itemId)) return false;

    return !row.starport_id || row.starport_id === normalizedStarportId;
  });
}

function weightedRoll(entries = []) {
  const valid = Array.isArray(entries) ? entries.filter((entry) => entry && Number(entry.weight) > 0) : [];
  if (valid.length <= 0) return null;
  const total = valid.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
  if (!(total > 0)) return valid[0]?.value ?? null;
  let roll = Math.random() * total;
  for (const entry of valid) {
    roll -= Number(entry.weight || 0);
    if (roll <= 0) return entry.value;
  }
  return valid[valid.length - 1]?.value ?? null;
}

function pickRandomFromList(list = []) {
  if (!Array.isArray(list) || list.length <= 0) return null;
  return list[Math.floor(Math.random() * list.length)] || null;
}

function buildVendorOfferRow(catalogType, itemId, options = {}) {
  const normalizedCatalogType = String(catalogType || '').trim().toLowerCase();
  const normalizedItemId = String(itemId || '').trim();
  if (!normalizedCatalogType || !normalizedItemId) return null;

  let contentRow = null;
  let defaultPrice = 0;
  if (normalizedCatalogType === 'blueprint') {
    contentRow = getBlueprintContent(normalizedItemId);
    if (!contentRow) return null;
    defaultPrice = toIntSafe(contentRow.base_vendor_price_credits, 0);
  } else if (normalizedCatalogType === 'ship') {
    contentRow = gameContentCache.shipsById.get(normalizedItemId) || null;
    if (!contentRow) return null;
    defaultPrice = toIntSafe(options.priceCredits, 0);
  } else if (normalizedCatalogType === 'module') {
    contentRow = gameContentCache.modulesById.get(normalizedItemId) || null;
    if (!contentRow) return null;
    defaultPrice = toIntSafe(options.priceCredits, 0);
  }

  const quantity = Math.max(1, toIntSafe(options.quantity, VENDOR_LISTING_DEFAULT_QTY));
  const itemData = buildMarketItemSnapshot(normalizedItemId, quantity);
  itemData.catalogType = normalizedCatalogType;
  itemData.displayName = String(
    contentRow?.display_name
    || itemData.displayName
    || itemData.name
    || normalizedItemId
  ).trim();

  if (normalizedCatalogType === 'blueprint') {
    itemData.size = contentRow.output_type === 'ship'
      ? 'ship'
      : String(contentRow.size || options.size || itemData.size || '').trim().toLowerCase() || null;
    itemData.rarity = String(contentRow.rarity || options.rarity || itemData.rarity || 'common').trim().toLowerCase();
  } else if (normalizedCatalogType === 'ship') {
    itemData.size = 'ship';
    itemData.rarity = String(contentRow.rarity || options.rarity || itemData.rarity || 'common').trim().toLowerCase();
  } else if (normalizedCatalogType === 'module') {
    itemData.size = String(contentRow.size || options.size || itemData.size || '').trim().toLowerCase() || null;
    itemData.rarity = String(contentRow.rarity || options.rarity || itemData.rarity || 'common').trim().toLowerCase();
  }

  const resolvedPrice = Math.max(0, toIntSafe(options.priceCredits, defaultPrice));
  return {
    catalogType: normalizedCatalogType,
    blueprintId: normalizedCatalogType === 'blueprint' ? normalizedItemId : null,
    item_type: normalizedItemId,
    item_data: itemData,
    quantity,
    price_per_uni: resolvedPrice,
    stock_mode: String(options.stockMode || 'infinite').trim().toLowerCase(),
    refresh_seconds: options.refreshSeconds == null ? null : Math.max(0, toIntSafe(options.refreshSeconds, 0)),
    rarity: itemData.rarity,
    size: itemData.size || null,
    displayName: itemData.displayName || itemData.name || normalizedItemId
  };
}

function generateVendorOffersForStarport(starportId, vendorId = CONTENT_VENDOR_ID) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const vendorRows = getVendorStockRowsForStarport(normalizedStarportId, vendorId);
  if (!Array.isArray(vendorRows) || vendorRows.length <= 0) return [];

  const offers = [];
  for (const row of vendorRows) {
    const catalogType = String(row?.item_type || '').trim().toLowerCase();
    const itemId = String(row?.item_id || '').trim();
    if (!catalogType || !itemId) continue;

    const qty = String(row.stock_mode || '').trim().toLowerCase() === 'finite'
      ? Math.max(1, row.stock_qty || 1)
      : Math.max(1, row.stock_qty || VENDOR_LISTING_DEFAULT_QTY);

    const built = buildVendorOfferRow(catalogType, itemId, {
      quantity: qty,
      priceCredits: row.price_credits,
      stockMode: row.stock_mode,
      refreshSeconds: row.refresh_seconds
    });
    if (built) offers.push(built);
  }

  return offers;
}

function getOrCreateVendorOfferSet(starportId, vendorId = CONTENT_VENDOR_ID, { forceRefresh = false } = {}) {
  const normalizedStarportId = normalizeStarportId(starportId);
  if (!normalizedStarportId) return [];
  if (!forceRefresh) {
    const cached = vendorOfferCache.get(normalizedStarportId);
    if (cached && Array.isArray(cached.offers) && cached.offers.length > 0) return cached.offers;
  }
  const offers = generateVendorOffersForStarport(normalizedStarportId, vendorId);
  vendorOfferCache.set(normalizedStarportId, {
    generatedAt: Date.now(),
    vendorId: String(vendorId || CONTENT_VENDOR_ID),
    offers
  });
  return offers;
}

function validateLoadedGameContent() {
  const issues = [];
  const warnings = [];
  const moduleTypeCounts = new Map();

  for (const [shipId, ship] of gameContentCache.shipsById.entries()) {
    if (!ship || typeof ship !== 'object') {
      issues.push(`ship ${shipId} missing content row`);
      continue;
    }
    if (!ship.size) {
      issues.push(`ship ${shipId} missing size`);
    }
  }

  for (const [moduleId, mod] of gameContentCache.modulesById.entries()) {
    const moduleType = String(mod?.module_type || 'unknown').trim().toLowerCase() || 'unknown';
    moduleTypeCounts.set(moduleType, (moduleTypeCounts.get(moduleType) || 0) + 1);

    if (!mod || typeof mod !== 'object') {
      issues.push(`module ${moduleId} missing content row`);
      continue;
    }
    if (!String(mod?.display_name || '').trim()) warnings.push(`module ${moduleId} missing display name`);
    if (!String(mod?.size || '').trim()) warnings.push(`module ${moduleId} missing size`);
    if (!String(mod?.rarity || '').trim()) warnings.push(`module ${moduleId} missing rarity`);
    if (!mod.stats || typeof mod.stats !== 'object' || Array.isArray(mod.stats)) {
      issues.push(`module ${moduleId} missing stats object`);
    }
  }

  for (const [blueprintId, bp] of gameContentCache.blueprintsById.entries()) {
    if (bp.output_type === 'ship' && !gameContentCache.shipsById.has(bp.output_id)) {
      issues.push(`blueprint ${blueprintId} missing ship output ${bp.output_id}`);
    }
    if (bp.output_type === 'module' && !gameContentCache.modulesById.has(bp.output_id)) {
      issues.push(`blueprint ${blueprintId} missing module output ${bp.output_id}`);
    }
  }

  for (const row of gameContentCache.vendorStock) {
    const catalogType = String(row?.item_type || '').trim().toLowerCase();
    const itemId = String(row?.item_id || '').trim();
    if (catalogType === 'blueprint' && !gameContentCache.blueprintsById.has(itemId)) {
      issues.push(`vendor stock ${row.vendor_id}:${itemId} missing blueprint`);
    }
    if (catalogType === 'ship' && !gameContentCache.shipsById.has(itemId)) {
      issues.push(`vendor stock ${row.vendor_id}:${itemId} missing ship`);
    }
    if (catalogType === 'module' && !gameContentCache.modulesById.has(itemId)) {
      issues.push(`vendor stock ${row.vendor_id}:${itemId} missing module`);
    }
  }

  const moduleSummary = [...moduleTypeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, count]) => `${type}=${count}`).join(' ');
  if (moduleSummary) console.log(`[Content] module validation summary: ${moduleSummary}`);

  if (issues.length > 0) {
    console.warn('[Content] validation issues found:');
    issues.slice(0, 25).forEach((issue) => console.warn('[Content]', issue));
    if (issues.length > 25) console.warn(`[Content] ...and ${issues.length - 25} more issue(s)`);
  }
  if (warnings.length > 0) {
    console.warn('[Content] validation warnings found:');
    warnings.slice(0, 15).forEach((warning) => console.warn('[Content]', warning));
    if (warnings.length > 15) console.warn(`[Content] ...and ${warnings.length - 15} more warning(s)`);
  }
}

async function loadGameContent() {
  try {
    const [shipsRes, modulesRes, blueprintsRes, recipesRes, vendorStockRes] = await Promise.all([
      supabase.from('game_ships').select('*').eq('enabled', true).order('ship_id', { ascending: true }),
      supabase.from('game_modules').select('*').eq('enabled', true).order('module_id', { ascending: true }),
      supabase.from('game_blueprints').select('*').eq('enabled', true).order('blueprint_id', { ascending: true }),
      supabase.from('game_blueprint_recipe_inputs').select('*').order('blueprint_id', { ascending: true }).order('slot_index', { ascending: true }),
      supabase.from('game_vendor_stock').select('*').eq('enabled', true).order('vendor_id', { ascending: true })
    ]);

    for (const res of [shipsRes, modulesRes, blueprintsRes, recipesRes, vendorStockRes]) {
      if (res.error) throw res.error;
    }

    gameContentCache.shipsById = new Map((shipsRes.data || []).map((row) => {
      const ship = normalizeContentShipRow(row);
      return [ship.ship_id, ship];
    }).filter(([id]) => !!id));

    gameContentCache.modulesById = new Map((modulesRes.data || []).map((row) => {
      const mod = normalizeContentModuleRow(row);
      return [mod.module_id, mod];
    }).filter(([id]) => !!id));

    gameContentCache.blueprintsById = new Map((blueprintsRes.data || []).map((row) => {
      const bp = normalizeContentBlueprintRow(row);
      return [bp.blueprint_id, bp];
    }).filter(([id]) => !!id));

    const recipesMap = new Map();
    for (const row of (recipesRes.data || [])) {
      const recipe = normalizeContentRecipeRow(row);
      if (!recipe.blueprint_id) continue;
      const list = recipesMap.get(recipe.blueprint_id) || [];
      list.push(recipe);
      recipesMap.set(recipe.blueprint_id, list);
    }
    gameContentCache.recipesByBlueprintId = recipesMap;
    gameContentCache.vendorStock = (vendorStockRes.data || []).map(normalizeVendorStockRow).filter((row) => !!row.vendor_id && !!row.item_id);
    gameContentCache.loadedAt = Date.now();

    validateLoadedGameContent();
    console.log(`[Content] loaded ships=${gameContentCache.shipsById.size} modules=${gameContentCache.modulesById.size} blueprints=${gameContentCache.blueprintsById.size} recipes=${gameContentCache.recipesByBlueprintId.size} vendorRows=${gameContentCache.vendorStock.length}`);
    return true;
  } catch (err) {
    console.warn('[Content] failed to load game content:', err?.message || err);
    return false;
  }
}

function normalizeStarportId(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const upperRaw = raw.toUpperCase();

  const aliasMap = new Map([
    ["CYGNUS-PRIME", "cygnus_prime_starport"],
    ["STARPORT-CYGNUS-PRIME", "cygnus_prime_starport"],
    ["CYGNUS_PRIME_STARPORT", "cygnus_prime_starport"],

    ["IRON-REACH", "iron_reach_starport"],
    ["STARPORT-IRON-REACH", "iron_reach_starport"],
    ["IRON_REACH_STARPORT", "iron_reach_starport"],

    ["OBSIDIAN-FRINGE", "obsidian_fringe_starport"],
    ["STARPORT-OBSIDIAN-FRINGE", "obsidian_fringe_starport"],
    ["OBSIDIAN_FRINGE_STARPORT", "obsidian_fringe_starport"],

    ["AURORA-OUTPOST", "aurora_outpost_starport"],
    ["STARPORT-AURORA-OUTPOST", "aurora_outpost_starport"],
    ["AURORA_OUTPOST_STARPORT", "aurora_outpost_starport"],

    ["VANTA-EDGE", "vanta_edge_starport"],
    ["STARPORT-VANTA-EDGE", "vanta_edge_starport"],
    ["VANTA_EDGE_STARPORT", "vanta_edge_starport"],

    ["SOLACE-POINT", "solace_point_starport"],
    ["STARPORT-SOLACE-POINT", "solace_point_starport"],
    ["SOLACE_POINT_STARPORT", "solace_point_starport"],

    ["HELIOS-FRINGE", "helios_fringe_starport"],
    ["STARPORT-HELIOS-FRINGE", "helios_fringe_starport"],
    ["HELIOS_FRINGE_STARPORT", "helios_fringe_starport"],
  ]);
  if (aliasMap.has(upperRaw)) return aliasMap.get(upperRaw);

  let v = raw.toLowerCase().replace(/^starport-/, "").replace(/-/g, "_").trim();
  if (!v.endsWith("_starport")) v = `${v}_starport`;
  return v;
}

function marketTxId() {
  return `mtx-${crypto.randomUUID()}`;
}

function marketItemTypeToDisplayName(itemType) {
  const raw = String(itemType || "").trim();
  if (!raw) return "Unknown Item";

  const cachedBlueprint = getBlueprintContent(raw);
  if (cachedBlueprint) {
    return cachedBlueprint.display_name || cachedBlueprint.blueprint_id || raw;
  }

  if (raw.startsWith("blueprint-")) {
    const core = raw.replace(/^blueprint-/, "");
    const parts = core.split("-").filter(Boolean);
    let size = "";
    const last = parts[parts.length - 1];
    if (["s", "m", "l"].includes(last)) {
      size = ({ s: "Small", m: "Medium", l: "Large" })[last];
      parts.pop();
    }
    const words = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
    return `${size ? size + " " : ""}${words.join(" ")} Blueprint`.trim();
  }

  if (raw === "omni-scout-chassis") return "Omni Scout Chassis Blueprint";

  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\w/g, (m) => m.toUpperCase());
}

function buildMarketItemSnapshot(itemType, quantity = 1) {
  const raw = String(itemType || '').trim();
  const cachedBlueprint = getBlueprintContent(raw);
  const cachedShip = gameContentCache.shipsById.get(raw) || null;
  const cachedModule = gameContentCache.modulesById.get(raw) || null;
  const isBlueprint = !!cachedBlueprint || raw.startsWith('blueprint-') || raw === 'omni-scout-chassis' || raw.startsWith('bp_');
  const contentType = cachedBlueprint
    ? 'blueprint'
    : cachedShip
      ? 'ship'
      : cachedModule
        ? 'module'
        : raw;
  const name = cachedBlueprint?.display_name || cachedShip?.display_name || cachedModule?.display_name || marketItemTypeToDisplayName(raw);
  const rarity = cachedBlueprint?.rarity || cachedShip?.rarity || cachedModule?.rarity || (
    raw.includes('-mythic-') ? 'mythic' :
    raw.includes('-legendary-') ? 'legendary' :
    raw.includes('-epic-') ? 'epic' :
    raw.includes('-rare-') ? 'rare' :
    raw.includes('-uncommon-') ? 'uncommon' :
    'common'
  );

  const snapshot = {
    id: crypto.randomUUID(),
    item_id: raw,
    item_type: raw,
    type: isBlueprint ? 'blueprint' : raw,
    contentType,
    name,
    displayName: name,
    rarity,
    size: cachedBlueprint?.output_type === 'ship'
      ? 'ship'
      : (cachedShip ? 'ship' : (cachedModule?.size || cachedBlueprint?.size || null)),
    description: cachedBlueprint
      ? `Blueprint for ${cachedBlueprint.output_type || 'item'}: ${name}.`
      : cachedShip
        ? `Ship hull: ${name}.`
        : cachedModule
          ? `Module: ${name}.`
          : `Market item: ${name}.`
  };

  if (cachedBlueprint) {
    snapshot.blueprintId = raw;
    snapshot.canonicalBlueprintId = raw;
    if (Array.isArray(cachedBlueprint?.legacy_blueprint_ids) && cachedBlueprint.legacy_blueprint_ids.length > 0) {
      snapshot.legacyBlueprintId = cachedBlueprint.legacy_blueprint_ids[0];
    }
    snapshot.outputType = cachedBlueprint.output_type;
    snapshot.outputId = cachedBlueprint.output_id;
    snapshot.outputQuantity = cachedBlueprint.output_quantity;
    const recipeInputs = getBlueprintRecipeInputs(raw);
    if (recipeInputs.length > 0) {
      snapshot.requirements = recipeInputs.map((req) => ({
        resource: req.input_item_id || req.input_item_type,
        amount: req.quantity
      }));
    }
  } else if (cachedShip) {
    snapshot.shipId = raw;
    snapshot.ship_id = raw;
    snapshot.shipClass = cachedShip.class || null;
    snapshot.shipSize = cachedShip.size || null;
    snapshot.baseStats = {
      hp: toIntSafe(cachedShip.hull_base ?? cachedShip.hp, 0),
      energy: toIntSafe(cachedShip.energy_base ?? cachedShip.energy, 0),
      armor: toIntSafe(cachedShip.armor_base, 0)
    };
  } else if (cachedModule) {
    const moduleType = String(cachedModule.module_type || '').trim().toLowerCase();
    const subtype = String(cachedModule.subtype || '').trim().toLowerCase();
    let normalizedType = moduleType || 'module';
    let normalizedSubtype = subtype.replace(/_/g, '-');

    if (moduleType === 'shield') {
      normalizedType = 'shield';
      normalizedSubtype = normalizedSubtype || 'shield-generator';
    } else if (moduleType === 'thruster') {
      normalizedType = 'thruster';
      normalizedSubtype = normalizedSubtype || 'ion-thruster';
    } else if (moduleType === 'mining') {
      normalizedType = 'mining';
      normalizedSubtype = normalizedSubtype || 'mining-laser';
    } else if (moduleType === 'drone') {
      normalizedType = 'drone-module';
      normalizedSubtype = normalizedSubtype || 'drone-bay';
    } else if (moduleType === 'weapon') {
      normalizedType = 'weapon';
    }

    snapshot.type = normalizedType;
    snapshot.subtype = normalizedSubtype || null;
    snapshot.moduleId = raw;
    snapshot.module_id = raw;
    snapshot.moduleType = moduleType || null;
    snapshot.moduleSize = cachedModule.size || null;
    snapshot.size = cachedModule.size || null;
    snapshot.weaponsize = cachedModule.size || null;
    snapshot.stats = cachedModule.stats || {};
  } else if (snapshot.type === 'blueprint') {
    snapshot.blueprintId = raw;
  }
  snapshot.quantity = quantity;
  snapshot.amount = quantity;
  return snapshot;
}

function normalizeMarketFilter(filter) {
  const key = String(filter || "listings").trim().toLowerCase();
  if (key === "buy_orders") return "buy_orders";
  return "listings";
}

function cloneItems(items) {
  return Array.isArray(items) ? items.map((it) => (it && typeof it === "object" ? { ...it } : it)) : [];
}

function findMarketItemIndex(list, itemType) {
  const needle = String(itemType || "").trim().toLowerCase();
  return Array.isArray(list) ? list.findIndex((i) => {
    const vals = [
      i?.item_id,
      i?.type,
      i?.id,
      i?.blueprintId,
      i?.materialKey,
      i?.oreType,
      i?.name
    ].filter(Boolean).map((v) => String(v).trim().toLowerCase());
    return vals.includes(needle);
  }) : -1;
}

function getMarketItemQuantity(item) {
  if (!item || typeof item !== "object") return 0;
  if (Number.isFinite(item.quantity)) return Number(item.quantity);
  if (Number.isFinite(item.amount)) return Number(item.amount);
  return 0;
}

function setMarketItemQuantity(item, qty) {
  if (!item || typeof item !== "object") return item;
  const next = { ...item };
  if ("quantity" in next || !("amount" in next)) next.quantity = qty;
  if ("amount" in next) next.amount = qty;
  return next;
}

function cloneMarketItemWithQuantity(item, qty) {
  if (!item || typeof item !== "object") return null;
  return setMarketItemQuantity({ ...item }, qty);
}

function buildAuthoritativeMarketListingItemData(itemType, itemRecord, quantity) {
  const normalizedItemType = String(itemType || '').trim();
  const baseSnapshot = buildMarketItemSnapshot(normalizedItemType, quantity);
  const sourceRecord = itemRecord && typeof itemRecord === 'object' ? { ...itemRecord } : {};
  const merged = {
    ...baseSnapshot,
    ...sourceRecord
  };

  merged.item_id = normalizedItemType || String(merged.item_id || merged.item_type || '').trim() || baseSnapshot.item_id;
  merged.item_type = normalizedItemType || String(merged.item_type || merged.item_id || '').trim() || baseSnapshot.item_type;
  merged.id = String(merged.id || baseSnapshot.id || crypto.randomUUID()).trim();
  merged.contentType = baseSnapshot.contentType || merged.contentType || null;
  merged.catalogType = merged.catalogType || baseSnapshot.catalogType || merged.contentType || null;
  merged.name = String(merged.name || merged.displayName || baseSnapshot.name || normalizedItemType).trim();
  merged.displayName = String(merged.displayName || merged.name || baseSnapshot.displayName || normalizedItemType).trim();
  merged.quantity = quantity;
  merged.amount = quantity;

  return merged;
}

function buildStoredMarketItem(itemType, quantity = 1) {
  return {
    id: crypto.randomUUID(),
    item_id: itemType,
    type: itemType,
    quantity,
    rarity: "common"
  };
}

async function loadInventoryStateServer(playerId, starportId) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const { data, error } = await supabase
    .from("inventory_states")
    .select("player_id, starport_id, items")
    .eq("player_id", playerId)
    .eq("starport_id", normalizedStarportId)
    .maybeSingle();
  if (error) throw error;
  return {
    player_id: playerId,
    starport_id: normalizedStarportId,
    items: Array.isArray(data?.items) ? data.items : []
  };
}

async function saveInventoryStateServer(playerId, starportId, items = []) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const payload = {
    player_id: playerId,
    starport_id: normalizedStarportId,
    items: cloneItems(items)
  };
  const { data, error } = await supabase
    .from("inventory_states")
    .upsert(payload, { onConflict: "player_id,starport_id" })
    .select("player_id, starport_id, items")
    .single();
  if (error) throw error;
  return data || payload;
}


async function addFullItemToStorage(playerId, starportId, itemObj) {
  const inv = await loadInventoryStateServer(playerId, starportId);
  const items = cloneItems(inv.items);
  items.push(itemObj);
  return await saveInventoryStateServer(playerId, starportId, items);
}

async function loadHangarShipRecordById(playerId, shipInstanceId) {
  const normalizedShipId = String(shipInstanceId || '').trim();
  if (!playerId || !normalizedShipId) return null;
  const { data, error } = await supabase
    .from('hangar_states')
    .select('player_id, starport_id, ship_id, hull_id, ship_config, updated_at')
    .eq('player_id', playerId)
    .eq('ship_id', normalizedShipId)
    .maybeSingle();
  if (error) {
    console.warn('[Backend] Failed to load hangar ship record:', playerId, normalizedShipId, error.message);
    return null;
  }
  return data || null;
}

async function loadHangarShipsForPlayer(playerId) {
  if (!playerId) return [];
  const { data, error } = await supabase
    .from('hangar_states')
    .select('player_id, starport_id, ship_id, hull_id, ship_config, updated_at')
    .eq('player_id', playerId)
    .order('updated_at', { ascending: false });
  if (error) {
    console.warn('[Backend] Failed to load hangar ships for player:', playerId, error.message);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function buildOwnedShipEntryFromHangarRow(row) {
  if (!row || typeof row !== 'object') return null;
  const cfg = row.ship_config && typeof row.ship_config === 'object' ? row.ship_config : {};
  const canonicalHullId = normalizeCanonicalShipId(row.hull_id || cfg.hull_id || cfg.ship_id || cfg.ship_type || cfg.type || null);
  if (!canonicalHullId) return null;
  return {
    ...cfg,
    id: String(row.ship_id || cfg.id || '').trim() || null,
    ship_id: canonicalHullId,
    ship_type: canonicalHullId,
    type: canonicalHullId,
    hull_id: canonicalHullId,
    hullTemplateId: canonicalHullId,
    fittings: sanitizeRuntimeFittings(cfg.fittings || {}, canonicalHullId),
    hp: Math.max(0, finiteNum(cfg.hp, 0)),
    maxHp: Math.max(1, finiteNum(cfg.maxHp, cfg.hp ?? 1)),
    shields: Math.max(0, finiteNum(cfg.shields, 0)),
    maxShields: Math.max(0, finiteNum(cfg.maxShields, cfg.shields ?? 0)),
    energy: Math.max(0, finiteNum(cfg.energy, 0)),
    maxEnergy: Math.max(0, finiteNum(cfg.maxEnergy, cfg.energy ?? 0)),
    starport_id: row.starport_id || cfg.starport_id || null,
    updated_at: row.updated_at || cfg.updated_at || null
  };
}

async function ensureHangarShipRecord(player, shipInstanceId, vitalsOverride = null) {
  if (!player?.userId) return null;
  const normalizedShipInstanceId = String(shipInstanceId || '').trim();
  if (!normalizedShipInstanceId) return null;

  const existingRow = await loadHangarShipRecordById(player.userId, normalizedShipInstanceId);
  if (existingRow?.ship_config && typeof existingRow.ship_config === 'object') return existingRow;

  let persistedState = null;
  try {
    persistedState = await loadShipState(player.userId);
  } catch (e) {
    console.warn('[Backend] Failed to load ship state while ensuring hangar row:', player.userId, normalizedShipInstanceId, e?.message || e);
  }

  const runtimeShipType = normalizeCanonicalShipId(
    vitalsOverride?.hull_id
    || player.ship_type
    || persistedState?.ship_type
    || persistedState?.shipType
    || null
  );

  const contentShip = runtimeShipType ? getShipContentByAnyId(runtimeShipType) : null;
  const canonicalHullId = normalizeCanonicalShipId(
    runtimeShipType
    || contentShip?.ship_id
    || contentShip?.display_name
    || null
  );
  if (!canonicalHullId) {
    console.warn('[Backend] Cannot ensure hangar row without canonical hull id:', player.userId, normalizedShipInstanceId);
    return null;
  }

  const baseMaxHp = Math.max(1, finiteNum(contentShip?.hull_base, finiteNum(player.maxHp, finiteNum(persistedState?.maxHp, 1))));
  const baseMaxShields = Math.max(0, finiteNum(contentShip?.shields_base, finiteNum(player.maxShields, finiteNum(persistedState?.maxShields, 0))));
  const baseMaxEnergy = Math.max(0, finiteNum(contentShip?.energy_base, finiteNum(player.maxEnergy, finiteNum(persistedState?.maxEnergy, 0))));

  const nextHp = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'hp')
    ? vitalsOverride.hp
    : finiteNum(player.hp, finiteNum(persistedState?.hull, baseMaxHp));
  const nextMaxHp = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'maxHp')
    ? vitalsOverride.maxHp
    : finiteNum(player.maxHp, finiteNum(persistedState?.maxHp, baseMaxHp));
  const nextShields = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'shields')
    ? vitalsOverride.shields
    : finiteNum(player.shields, finiteNum(persistedState?.shields, baseMaxShields));
  const nextMaxShields = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'maxShields')
    ? vitalsOverride.maxShields
    : finiteNum(player.maxShields, finiteNum(persistedState?.maxShields, baseMaxShields));
  const nextEnergy = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'energy')
    ? vitalsOverride.energy
    : finiteNum(player.energy, finiteNum(persistedState?.energy, baseMaxEnergy));
  const nextMaxEnergy = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'maxEnergy')
    ? vitalsOverride.maxEnergy
    : finiteNum(player.maxEnergy, finiteNum(persistedState?.maxEnergy, baseMaxEnergy));
  const nextFittings = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'fittings')
    ? vitalsOverride.fittings
    : (player.fittings || persistedState?.fittings || {});

  const fallbackStarportId = normalizeStarportId(
    player.starport_id
    || persistedState?.starport_id
    || 'cygnus_prime_starport'
  );

  const shipConfig = {
    id: normalizedShipInstanceId,
    ship_id: canonicalHullId,
    ship_type: canonicalHullId,
    type: canonicalHullId,
    hull_id: canonicalHullId,
    hullTemplateId: canonicalHullId,
    hp: Math.max(0, Math.min(finiteNum(nextHp, nextMaxHp), Math.max(1, finiteNum(nextMaxHp, baseMaxHp)))),
    maxHp: Math.max(1, finiteNum(nextMaxHp, baseMaxHp)),
    shields: Math.max(0, Math.min(finiteNum(nextShields, nextMaxShields), Math.max(0, finiteNum(nextMaxShields, baseMaxShields)))),
    maxShields: Math.max(0, finiteNum(nextMaxShields, baseMaxShields)),
    energy: Math.max(0, Math.min(finiteNum(nextEnergy, nextMaxEnergy), Math.max(0, finiteNum(nextMaxEnergy, baseMaxEnergy)))),
    maxEnergy: Math.max(0, finiteNum(nextMaxEnergy, baseMaxEnergy)),
    fittings: sanitizeRuntimeFittings(nextFittings || {}, canonicalHullId)
  };

  if (player.visual_config && typeof player.visual_config === 'object' && !Array.isArray(player.visual_config)) {
    shipConfig.visual_config = player.visual_config;
  }

  const payload = {
    player_id: player.userId,
    starport_id: fallbackStarportId,
    ship_id: normalizedShipInstanceId,
    hull_id: canonicalHullId,
    ship_config: shipConfig,
    updated_at: nowIso()
  };

  const { error: insertError } = await supabase
    .from('hangar_states')
    .insert(payload);

  if (insertError) {
    console.warn('[Backend] Failed to create missing hangar_states row:', player.userId, normalizedShipInstanceId, insertError.message);
  } else {
    console.log('[Backend] Created missing hangar_states row for active ship:', {
      userId: player.userId,
      shipInstanceId: normalizedShipInstanceId,
      hullId: canonicalHullId,
      starportId: fallbackStarportId
    });
  }

  return await loadHangarShipRecordById(player.userId, normalizedShipInstanceId);
}

async function persistShipInstanceToHangar(player, shipInstanceId, vitalsOverride = null) {
  if (!player?.userId) return false;
  const normalizedShipInstanceId = String(shipInstanceId || '').trim();
  if (!normalizedShipInstanceId) return false;
  try {
    const hangarRow = await ensureHangarShipRecord(player, normalizedShipInstanceId, vitalsOverride);
    if (!hangarRow?.ship_config) return false;

    const nextHp = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'hp') ? vitalsOverride.hp : player.hp;
    const nextMaxHp = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'maxHp') ? vitalsOverride.maxHp : player.maxHp;
    const nextShields = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'shields') ? vitalsOverride.shields : player.shields;
    const nextMaxShields = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'maxShields') ? vitalsOverride.maxShields : player.maxShields;
    const nextEnergy = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'energy') ? vitalsOverride.energy : player.energy;
    const nextMaxEnergy = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'maxEnergy') ? vitalsOverride.maxEnergy : player.maxEnergy;
    const nextFittings = vitalsOverride && Object.prototype.hasOwnProperty.call(vitalsOverride, 'fittings') ? vitalsOverride.fittings : player.fittings;

    const canonicalHullId = normalizeCanonicalShipId(
      vitalsOverride?.hull_id || hangarRow?.hull_id || hangarRow?.ship_config?.hull_id || hangarRow?.ship_config?.ship_id || player.ship_type || null
    );
    if (!canonicalHullId) return false;

    const shipConfig = {
      ...(hangarRow.ship_config || {}),
      ship_id: canonicalHullId,
      ship_type: canonicalHullId,
      type: canonicalHullId,
      hull_id: canonicalHullId,
      hullTemplateId: canonicalHullId,
      hp: Math.max(0, finiteNum(nextHp, hangarRow?.ship_config?.hp ?? 0)),
      maxHp: Math.max(1, finiteNum(nextMaxHp, hangarRow?.ship_config?.maxHp ?? hangarRow?.ship_config?.hp ?? 1)),
      shields: Math.max(0, finiteNum(nextShields, hangarRow?.ship_config?.shields ?? 0)),
      maxShields: Math.max(0, finiteNum(nextMaxShields, hangarRow?.ship_config?.maxShields ?? hangarRow?.ship_config?.shields ?? 0)),
      energy: Math.max(0, finiteNum(nextEnergy, hangarRow?.ship_config?.energy ?? 0)),
      maxEnergy: Math.max(0, finiteNum(nextMaxEnergy, hangarRow?.ship_config?.maxEnergy ?? hangarRow?.ship_config?.energy ?? 0)),
      fittings: sanitizeRuntimeFittings(nextFittings || hangarRow?.ship_config?.fittings || {}, canonicalHullId)
    };

    const { error } = await supabase
      .from('hangar_states')
      .update({ ship_config: shipConfig, hull_id: canonicalHullId, updated_at: nowIso() })
      .eq('player_id', player.userId)
      .eq('ship_id', normalizedShipInstanceId);
    if (error) {
      console.warn('[Backend] Failed to persist ship instance into hangar_states:', player.userId, normalizedShipInstanceId, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Backend] persistShipInstanceToHangar exception:', player?.userId || 'unknown', normalizedShipInstanceId, e?.message || e);
    return false;
  }
}

async function persistActiveShipToHangar(player, vitalsOverride = null) {
  if (!player?.userId) return false;
  try {
    const runtimeShipInstanceId = String(player?.active_ship_instance_id || player?.current_ship_instance_id || '').trim();
    if (runtimeShipInstanceId) {
      return await persistShipInstanceToHangar(player, runtimeShipInstanceId, vitalsOverride);
    }

    const commander = await loadCommanderDataRow(player.userId);
    const activeShipId = String(commander?.active_ship_id || '').trim();
    if (!activeShipId) return false;
    return await persistShipInstanceToHangar(player, activeShipId, vitalsOverride);
  } catch (e) {
    console.warn('[Backend] persistActiveShipToHangar exception:', player?.userId || 'unknown', e?.message || e);
    return false;
  }
}

async function addShipToCommanderHangar(playerId, starportId, shipObj) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const resolvedShipId = normalizeCanonicalShipId(
    shipObj?.ship_id || shipObj?.shipId || shipObj?.item_id || shipObj?.itemId || shipObj?.type || shipObj?.ship_type || ''
  );
  const shipDef = gameContentCache.shipsById.get(resolvedShipId) || null;
  if (!shipDef) {
    throw new Error(`market_ship_definition_missing:${resolvedShipId || 'unknown'}`);
  }

  const shipConfig = buildCraftedShipItem(null, shipDef, 1, Date.now());
  shipConfig.id = shipConfig.id || `${String(shipDef.ship_id || 'market-ship')}-${Date.now()}`;
  shipConfig.craftedAt = shipConfig.craftedAt || Date.now();
  shipConfig.metadata = {
    ...(shipConfig.metadata || {}),
    source: 'vendor_market_purchase',
    purchasedFromListingItemId: shipObj?.item_id || shipObj?.itemId || resolvedShipId || null
  };

  const payload = {
    player_id: playerId,
    starport_id: normalizedStarportId,
    ship_id: shipConfig.id,
    hull_id: shipConfig.hull_id || shipConfig.ship_id,
    ship_config: shipConfig,
    updated_at: nowIso()
  };
  const { error } = await supabase
    .from('hangar_states')
    .upsert(payload, { onConflict: 'player_id,starport_id,ship_id' });
  if (error) throw error;
  return payload;
}

async function addItemToStorage(playerId, starportId, itemType, quantity) {
  const inv = await loadInventoryStateServer(playerId, starportId);
  const items = cloneItems(inv.items);
  const idx = findMarketItemIndex(items, itemType);
  if (idx >= 0) {
    const nextQty = getMarketItemQuantity(items[idx]) + quantity;
    items[idx] = setMarketItemQuantity(items[idx], nextQty);
  } else {
    items.push(buildStoredMarketItem(itemType, quantity));
  }
  return await saveInventoryStateServer(playerId, starportId, items);
}

async function removeItemsFromStorageOrCargo(playerId, starportId, itemType, quantity) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const requestedQty = Math.max(0, finiteNum(quantity, 0));
  let remaining = requestedQty;
  if (remaining <= 0) return { ok: true, removed: 0, removedItems: [], primaryItem: null };

  const inv = await loadInventoryStateServer(playerId, normalizedStarportId);
  const storageItems = cloneItems(inv.items);
  const storageIdx = findMarketItemIndex(storageItems, itemType);
  const storageItem = storageIdx >= 0 ? storageItems[storageIdx] : null;
  const storageQty = storageItem ? getMarketItemQuantity(storageItem) : 0;

  const ship = await loadShipState(playerId);
  const cargoItems = Array.isArray(ship?.cargo) ? cloneItems(ship.cargo) : [];
  const cargoIdx = findMarketItemIndex(cargoItems, itemType);
  const cargoItem = cargoIdx >= 0 ? cargoItems[cargoIdx] : null;
  const cargoQty = cargoItem ? getMarketItemQuantity(cargoItem) : 0;

  if ((storageQty + cargoQty) < requestedQty) {
    throw new Error("insufficient_inventory");
  }

  const removedItems = [];
  let storageChanged = false;
  let cargoChanged = false;

  if (storageIdx >= 0 && remaining > 0) {
    const take = Math.min(storageQty, remaining);
    if (take > 0) {
      remaining -= take;
      removedItems.push({ source: 'storage', item: cloneMarketItemWithQuantity(storageItem, take) });
      const nextQty = storageQty - take;
      if (nextQty > 0) storageItems[storageIdx] = setMarketItemQuantity(storageItem, nextQty);
      else storageItems.splice(storageIdx, 1);
      storageChanged = true;
    }
  }

  if (cargoIdx >= 0 && remaining > 0) {
    const take = Math.min(cargoQty, remaining);
    if (take > 0) {
      remaining -= take;
      removedItems.push({ source: 'cargo', item: cloneMarketItemWithQuantity(cargoItem, take) });
      const nextQty = cargoQty - take;
      if (nextQty > 0) cargoItems[cargoIdx] = setMarketItemQuantity(cargoItem, nextQty);
      else cargoItems.splice(cargoIdx, 1);
      cargoChanged = true;
    }
  }

  if (remaining > 0) {
    throw new Error("insufficient_inventory");
  }

  if (storageChanged) {
    await saveInventoryStateServer(playerId, normalizedStarportId, storageItems);
  }

  if (cargoChanged) {
    const { error } = await supabase
      .from("ship_states_v2")
      .update({ cargo: cargoItems, updated_at: nowIso() })
      .eq("player_id", playerId);
    if (error) throw error;
  }

  const primaryItem = removedItems[0]?.item || null;
  return {
    ok: true,
    removed: requestedQty,
    removedItems,
    primaryItem
  };
}

async function insertMarketTransaction({ buyerId = null, sellerId = null, itemType = null, qty = 0, price = 0, total = 0 } = {}) {
  const payload = {
    tx_id: marketTxId(),
    buyer_id: buyerId || null,
    seller_id: sellerId || null,
    item_id: itemType || null,
    qty: Math.max(0, Math.round(finiteNum(qty, 0))),
    price: Math.max(0, Math.round(finiteNum(price, 0))),
    total: Math.max(0, Math.round(finiteNum(total, 0))),
    created_at: nowIso()
  };
  console.log("[Market][Backend] insertMarketTransaction", {
    buyerId: payload.buyer_id,
    sellerId: payload.seller_id,
    itemId: payload.item_id,
    qty: payload.qty,
    price: payload.price,
    total: payload.total
  });
  const { error } = await supabase.from("market_transactions").insert(payload);
  if (error) throw error;
  return payload;
}

async function loadOpenSellListings(starportId) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const { data, error } = await supabase
    .from("market_listings")
    .select("listing_id, starport_id, seller_id, seller_name, item_type, item_data, quantity, price_per_uni, status, created_at")
    .eq("starport_id", normalizedStarportId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadOpenBuyOrders(starportId) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const { data, error } = await supabase
    .from("market_buy_orders")
    .select("order_id, starport_id, buyer_id, item_type, quantity, price_per_unit, status, created_at")
    .eq("starport_id", normalizedStarportId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({ ...row, price_per_uni: row.price_per_unit }));
}

async function ensureVendorListings(starportId) {
  const normalizedStarportId = normalizeStarportId(starportId);
  if (!gameContentCache.loadedAt || gameContentCache.blueprintsById.size <= 0 || gameContentCache.vendorStock.length <= 0) {
    await loadGameContent();
  }

  const catalogRows = getVendorStockRowsForStarport(normalizedStarportId, CONTENT_VENDOR_ID);
  if (!Array.isArray(catalogRows) || catalogRows.length <= 0) {
    throw new Error('vendor_stock_empty');
  }

  const offers = getOrCreateVendorOfferSet(normalizedStarportId, CONTENT_VENDOR_ID);
  if (!Array.isArray(offers) || offers.length <= 0) {
    throw new Error('vendor_offer_generation_failed');
  }

  const expectedIds = offers.map((entry) => String(entry?.item_type || entry?.blueprintId || '').trim()).filter(Boolean).sort();

  const { data: existing, error: existingError } = await supabase
    .from("market_listings")
    .select("listing_id, item_type, quantity, price_per_uni, seller_id, status")
    .eq("starport_id", normalizedStarportId)
    .eq("seller_id", NPC_MARKET_SELLER_ID)
    .eq("status", "open");
  if (existingError) throw existingError;

  const existingIds = (existing || []).map((row) => String(row?.item_type || '').trim()).filter(Boolean).sort();
  const isSameOfferSet = existingIds.length === expectedIds.length
    && existingIds.every((value, index) => value === expectedIds[index]);

  if (isSameOfferSet) {
    return { ok: true, seeded: false, count: existingIds.length, source: 'dynamic_vendor_roll_cache' };
  }

  await supabase
    .from("market_listings")
    .delete()
    .eq("starport_id", normalizedStarportId)
    .eq("seller_id", NPC_MARKET_SELLER_ID);

  const rows = offers.map((offer) => ({
    starport_id: normalizedStarportId,
    seller_id: NPC_MARKET_SELLER_ID,
    seller_name: NPC_MARKET_SELLER_NAME,
    item_type: offer.item_type,
    item_data: offer.item_data,
    quantity: Math.max(1, toIntSafe(offer.quantity, VENDOR_LISTING_DEFAULT_QTY)),
    price_per_uni: Math.max(0, toIntSafe(offer.price_per_uni, 0)),
    status: "open",
    created_at: nowIso()
  }));

  const { error } = await supabase.from("market_listings").insert(rows);
  if (error) throw error;

  console.log(`[Vendor Rolls] seeded starport=${normalizedStarportId} offers=${rows.length} ships=${rows.filter((row) => String(row.item_data?.size || '') === 'ship').length}`);
  return { ok: true, seeded: true, count: rows.length, source: 'dynamic_vendor_roll_cache' };
}

async function attemptMatchOpenOrders(starportId, itemType) {
  const normalizedStarportId = normalizeStarportId(starportId);
  const needle = String(itemType || "").trim();
  if (!needle) return { matched: 0 };

  const listings = (await loadOpenSellListings(normalizedStarportId))
    .filter((l) => String(l.item_type || "") === needle)
    .sort((a, b) => (finiteNum(a.price_per_uni, 0) - finiteNum(b.price_per_uni, 0)) || (Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0)));

  const buyOrders = (await loadOpenBuyOrders(normalizedStarportId))
    .filter((o) => String(o.item_type || "") === needle)
    .sort((a, b) => (finiteNum(b.price_per_unit, 0) - finiteNum(a.price_per_unit, 0)) || (Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0)));

  let matched = 0;
  for (const order of buyOrders) {
    let remainingOrder = Math.max(0, Math.round(finiteNum(order.quantity, 0)));
    if (remainingOrder <= 0) continue;

    for (const listing of listings) {
      let remainingListing = Math.max(0, Math.round(finiteNum(listing.quantity, 0)));
      if (remainingListing <= 0) continue;
      if (listing.seller_id === order.buyer_id) continue;
      const sellPrice = Math.max(0, finiteNum(listing.price_per_uni, 0));
      const buyPrice = Math.max(0, finiteNum(order.price_per_unit, 0));
      if (buyPrice < sellPrice) continue;

      const tradeQty = Math.min(remainingOrder, remainingListing);
      if (tradeQty <= 0) continue;

      if (listing.seller_id !== NPC_MARKET_SELLER_ID) {
        await changeCommanderCredits(listing.seller_id, tradeQty * sellPrice, {
          reason: "market_buy_order_fill",
          referenceType: "listing",
          referenceId: listing.listing_id,
          metadata: { buyerId: order.buyer_id, itemType: needle, quantity: tradeQty, starportId: normalizedStarportId }
        });
      }

      await addItemToStorage(order.buyer_id, normalizedStarportId, needle, tradeQty);
      await insertMarketTransaction({
        buyerId: order.buyer_id,
        sellerId: listing.seller_id,
        itemType: needle,
        qty: tradeQty,
        price: sellPrice,
        total: tradeQty * sellPrice
      });

      remainingOrder -= tradeQty;
      remainingListing -= tradeQty;
      matched += tradeQty;

      listing.quantity = remainingListing;
      order.quantity = remainingOrder;

      await supabase
        .from("market_listings")
        .update({
          quantity: remainingListing,
          status: remainingListing > 0 ? "open" : "filled"
        })
        .eq("listing_id", listing.listing_id);

      await supabase
        .from("market_buy_orders")
        .update({
          quantity: remainingOrder,
          status: remainingOrder > 0 ? "open" : "filled"
        })
        .eq("order_id", order.order_id);

      if (remainingOrder <= 0) break;
    }
  }
  return { matched };
}

async function getDockedMarketStarport(player, userId) {
  const runtimeStarport = normalizeStarportId(player?.starport_id);
  if (player?.docked && runtimeStarport) return runtimeStarport;
  const state = await loadShipState(userId);
  const dbStarport = normalizeStarportId(state?.starport_id);
  if (dbStarport) {
    if (player) {
      player.docked = true;
    player.arenaReturnSnapshot = null;
      player.starport_id = dbStarport;
    }
    return dbStarport;
  }
  return "";
}

function sendMarketActionResult(socket, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "MARKET_ACTION_RESULT",
    serverTime: Date.now(),
    ...payload
  }));
}

function sendMarketDataResult(socket, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "MARKET_DATA_RESULT",
    serverTime: Date.now(),
    ok: true,
    ...payload
  }));
}


function sendFabricationResult(socket, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "FABRICATION_RESULT",
    serverTime: Date.now(),
    ...payload
  }));
}

function sendRefineryResult(socket, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "REFINERY_RESULT",
    serverTime: Date.now(),
    ...payload
  }));
}

function getStackAmount(item) {
  if (!item || typeof item !== 'object') return 0;
  if (Number.isFinite(item.amount)) return Number(item.amount);
  if (Number.isFinite(item.quantity)) return Number(item.quantity);
  if (Number.isFinite(item.stack)) return Number(item.stack);
  return 0;
}

function setStackAmount(item, qty) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if ('amount' in next || !('quantity' in next)) next.amount = qty;
  if ('quantity' in next) next.quantity = qty;
  return next;
}

function parseItemQlValue(item) {
  if (!item || typeof item !== 'object') return 1;
  if (Array.isArray(item.qlList) && item.qlList.length > 0) {
    const sum = item.qlList.reduce((acc, entry) => acc + finiteNum(entry, 0), 0);
    if (sum > 0) return clamp(sum / item.qlList.length, 1, 300);
  }
  if (Number.isFinite(item.quality)) return clamp(Number(item.quality), 1, 300);
  if (Number.isFinite(item.avgQL)) return clamp(Number(item.avgQL), 1, 300);
  if (Number.isFinite(item.ql)) return clamp(Number(item.ql), 1, 300);
  if (Number.isFinite(item.qlBand)) return clamp(Number(item.qlBand), 1, 300);
  const rawBand = String(item.qlBand || '').trim();
  if (rawBand.includes('-')) {
    const [a, b] = rawBand.split('-').map((part) => Number(part.trim()));
    if (Number.isFinite(a) && Number.isFinite(b)) return clamp((a + b) / 2, 1, 300);
  }
  const rawName = String(item.name || '').trim();
  const nameMatch = rawName.match(/\bQL\s*(\d+(?:\.\d+)?)\b/i);
  if (nameMatch) return clamp(Number(nameMatch[1]), 1, 300);
  return 1;
}

function canonicalizeOreName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^refined\s+/, '')
    .replace(/\s+ore$/,'')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCanonicalResourceIdFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const directCandidates = [item.resourceId, item.materialKey, item.item_id, item.itemId, item.id]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  for (const candidate of directCandidates) {
    if (candidate.startsWith('resource_refined_')) return candidate;
  }
  const oreType = String(item.oreType || '').trim();
  if (oreType) return `resource_refined_${canonicalizeOreName(oreType)}`;
  const name = String(item.name || '').trim();
  if (/^Refined\s+/i.test(name)) {
    return `resource_refined_${canonicalizeOreName(name)}`;
  }
  return null;
}

function parseRawOreCanonicalResourceIdFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const directCandidates = [item.resourceId, item.materialKey, item.item_id, item.itemId]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  for (const candidate of directCandidates) {
    if (candidate.startsWith('resource_raw_')) return candidate;
  }
  const oreType = String(item.oreType || '').trim();
  if (oreType) return `resource_raw_${canonicalizeOreName(oreType)}`;
  const name = String(item.name || '').trim();
  if (/ore/i.test(name)) {
    return `resource_raw_${canonicalizeOreName(name)}`;
  }
  return null;
}

function resolveRefineryOreType(item) {
  const explicitOreType = String(item?.oreType || '').trim();
  if (explicitOreType) return explicitOreType;
  const rawId = parseRawOreCanonicalResourceIdFromItem(item);
  if (rawId && rawId.startsWith('resource_raw_')) {
    const key = rawId.replace(/^resource_raw_/, '');
    return key.split('_').map((part) => titleCaseWord(part)).join(' ');
  }
  return String(item?.name || '').split(' [')[0].replace(/ Ore/i, '').trim() || 'Unknown';
}

function buildRefinedResourceItem(rawItem, { oreType, refinedAmount, refinedQL, craftedAt = Date.now() }) {
  const refinedName = `Refined ${oreType}`;
  const canonicalOre = canonicalizeOreName(oreType);
  const rawWeight = parseFloat(rawItem?.weight);
  const fallbackWeight = Number(getStackAmount(rawItem) || 0) * 0.1;
  const weight = Number.isFinite(rawWeight) ? rawWeight : fallbackWeight;
  return {
    id: `${refinedName}-Refined-QL-${refinedQL}-${craftedAt}`,
    item_id: `resource_refined_${canonicalOre}`,
    canonical_output_id: `resource_refined_${canonicalOre}`,
    resourceId: `resource_refined_${canonicalOre}`,
    materialKey: `resource_refined_${canonicalOre}`,
    name: `${refinedName} [QL ${refinedQL}]`,
    oreType,
    type: 'resource',
    isRefined: true,
    amount: refinedAmount,
    weight: Number(weight.toFixed(1)),
    qlBand: refinedQL,
    quality: refinedQL,
    avgQL: refinedQL,
    rarity: rawItem?.rarity || 'common',
    description: `High-purity ${oreType}. Refined to an exact average quality of ${refinedQL} from ${Array.isArray(rawItem?.qlList) ? rawItem.qlList.length : 'legacy'} raw units.`
  };
}

function findBlueprintContentByAnyId(rawId) {
  const needle = String(rawId || '').trim();
  if (!needle) return null;
  const direct = gameContentCache.blueprintsById.get(needle);
  if (direct) return direct;
  for (const bp of gameContentCache.blueprintsById.values()) {
    if (!bp) continue;
    if (String(bp.client_blueprint_id || '') === needle) return bp;
    if (Array.isArray(bp.legacy_blueprint_ids) && bp.legacy_blueprint_ids.some((entry) => String(entry || '') === needle)) return bp;
  }
  return null;
}

function removeSingleItemById(list, itemId) {
  const idx = Array.isArray(list) ? list.findIndex((entry) => String(entry?.id || '') === String(itemId || '')) : -1;
  if (idx < 0) return false;
  const item = list[idx];
  const current = getStackAmount(item);
  if (current > 1) list[idx] = setStackAmount(item, current - 1);
  else list.splice(idx, 1);
  return true;
}

function removeAmountFromItemById(list, itemId, amount) {
  const idx = Array.isArray(list) ? list.findIndex((entry) => String(entry?.id || '') === String(itemId || '')) : -1;
  if (idx < 0) return false;
  const item = list[idx];
  const current = getStackAmount(item);
  const nextQty = current - Math.max(0, finiteNum(amount, 0));
  if (nextQty > 0) list[idx] = setStackAmount(item, nextQty);
  else list.splice(idx, 1);
  return true;
}

function titleCaseWord(value) {
  const raw = String(value || '').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}

function sizeToWord(size) {
  const safe = String(size || 'S').trim().toUpperCase();
  if (safe === 'M') return 'Medium';
  if (safe === 'L') return 'Large';
  return 'Small';
}

function rarityToWord(rarity) {
  const safe = String(rarity || 'common').trim().toLowerCase();
  return safe ? safe.charAt(0).toUpperCase() + safe.slice(1) : 'Common';
}

function buildCatalogItemId(moduleDef = {}) {
  const size = String(moduleDef.size || 's').trim().toLowerCase();
  const rarity = String(moduleDef.rarity || 'common').trim().toLowerCase();
  const prefix = size === 'm' ? 'medium' : (size === 'l' ? 'large' : 'small');
  const subtype = String(moduleDef.subtype || '').trim().toLowerCase();
  const moduleType = String(moduleDef.module_type || '').trim().toLowerCase();

  if (moduleType === 'weapon' && subtype === 'flux_laser') return `${prefix}-${rarity}-flux-laser`;
  if (moduleType === 'weapon' && subtype === 'pulse_cannon') return `${prefix}-${rarity}-pulse-cannon`;
  if (moduleType === 'weapon' && subtype === 'seeker_pod') return `${prefix}-${rarity}-seeker-pod`;
  if (moduleType === 'mining' || subtype === 'laser') return `${prefix}-${rarity}-mining-laser`;
  if (moduleType === 'shield') return `${prefix}-${rarity}-shield-array`;
  if (moduleType === 'thruster') return `${prefix}-${rarity}-ion-thruster`;
  if (moduleType === 'drone') {
    if (subtype === 'combat_bay') return `${prefix}-${rarity}-combat-drone-module`;
    if (subtype === 'mining_bay') return `${prefix}-${rarity}-mining-drone-module`;
    if (subtype === 'repair_bay') return `${prefix}-${rarity}-repair-drone-module`;
  }
  return moduleDef.module_id || null;
}

function buildCraftedModuleItem(blueprint, moduleDef, avgQL, craftedAt = Date.now()) {
  const size = String(moduleDef?.size || blueprint?.size || 's').trim().toUpperCase();
  const rarity = String(moduleDef?.rarity || blueprint?.rarity || 'common').trim().toLowerCase();
  const subtype = String(moduleDef?.subtype || '').trim().toLowerCase();
  const moduleType = String(moduleDef?.module_type || '').trim().toLowerCase();
  const displaySize = sizeToWord(size);
  const displayRarity = rarityToWord(rarity);
  let type = moduleType || 'module';
  let itemSubtype = subtype.replace(/_/g, '-');
  let name = String(moduleDef?.display_name || '').trim();
  if (!name) {
    if (moduleType === 'weapon' && subtype === 'flux_laser') name = `${displaySize} ${displayRarity} Flux Laser`;
    else if (moduleType === 'weapon' && subtype === 'pulse_cannon') name = `${displaySize} ${displayRarity} Pulse Cannon`;
    else if (moduleType === 'weapon' && subtype === 'seeker_pod') name = `${displaySize} ${displayRarity} Seeker Pod`;
    else if (moduleType === 'mining') name = `${displaySize} ${displayRarity} Mining Laser`;
    else if (moduleType === 'shield') name = `${displaySize} ${displayRarity} Shield Array`;
    else if (moduleType === 'thruster') name = `${displaySize} ${displayRarity} Ion Thruster`;
    else if (moduleType === 'drone' && subtype === 'combat_bay') name = `${displaySize} Combat Drone Module`;
    else if (moduleType === 'drone' && subtype === 'mining_bay') name = `${displaySize} Mining Drone Module`;
    else if (moduleType === 'drone' && subtype === 'repair_bay') name = `${displaySize} Repair Drone Module`;
    else name = moduleDef?.module_id || blueprint?.display_name || 'Fabricated Module';
  }
  if (moduleType === 'weapon') type = 'weapon';
  else if (moduleType === 'shield') {
    type = 'shield';
    itemSubtype = 'shield-generator';
  } else if (moduleType === 'thruster') {
    type = 'thruster';
    itemSubtype = 'ion-thruster';
  } else if (moduleType === 'mining') {
    type = 'mining';
    itemSubtype = 'mining-laser';
  } else if (moduleType === 'drone') {
    type = 'drone-module';
    itemSubtype = 'drone-bay';
  }
  const itemId = buildCatalogItemId(moduleDef);
  const weight = size === 'M' ? 4.0 : (size === 'L' ? 5.0 : 3.0);
  return {
    id: `${String(itemId || blueprint?.output_id || 'crafted-module')}-${craftedAt}`,
    item_id: itemId || moduleDef?.module_id || blueprint?.output_id,
    canonical_output_id: moduleDef?.module_id || blueprint?.output_id,
    canonical_blueprint_id: blueprint?.blueprint_id || null,
    blueprintId: getBlueprintClientId(blueprint?.blueprint_id || null),
    type,
    subtype: itemSubtype,
    name,
    rarity,
    size,
    weaponsize: size,
    quality: Math.round(clamp(avgQL, 1, 300)),
    avgQL: Number(clamp(avgQL, 1, 300).toFixed(1)),
    stack: 1,
    maxStack: 1,
    amount: 1,
    weight,
    volume: weight,
    metadata: {
      craftedAt,
      craftedFromBlueprintId: blueprint?.blueprint_id || null,
      craftedOutputId: blueprint?.output_id || null
    },
    description: `${name} fabricated at QL ${Math.round(clamp(avgQL, 1, 300))}.`
  };
}

function buildCraftedShipItem(blueprint, shipDef, avgQL, craftedAt = Date.now()) {
  const canonicalHullId = normalizeCanonicalShipId(shipDef?.ship_id || blueprint?.output_id || null) || 'ship_omni_scout';
  const shipName = String(shipDef?.display_name || blueprint?.output_id || 'OMNI SCOUT').trim().toUpperCase();
  return {
    id: `${String(canonicalHullId || 'crafted-ship')}-${craftedAt}`,
    ship_id: canonicalHullId,
    type: canonicalHullId,
    ship_type: canonicalHullId,
    hull_id: canonicalHullId,
    hullTemplateId: canonicalHullId,
    name: shipName,
    rarity: String(blueprint?.rarity || shipDef?.rarity || 'common').trim().toLowerCase(),
    isShip: true,
    fittings: buildDefaultShipFittingsSchema(shipDef),
    hp: Math.max(1, toIntSafe(shipDef?.hull_base, 100)),
    maxHp: Math.max(1, toIntSafe(shipDef?.hull_base, 100)),
    energy: Math.max(0, toIntSafe(shipDef?.energy_base, 100)),
    maxEnergy: Math.max(0, toIntSafe(shipDef?.energy_base, 100)),
    shields: Math.max(0, toIntSafe(shipDef?.shields_base, 0)),
    maxShields: Math.max(0, toIntSafe(shipDef?.shields_base, 0)),
    cargo: Math.max(0, toIntSafe(shipDef?.cargo_base, 0)),
    avgQL: Number(clamp(avgQL, 1, 300).toFixed(1)),
    quality: Math.round(clamp(avgQL, 1, 300)),
    craftedAt,
    metadata: {
      craftedFromBlueprintId: blueprint?.blueprint_id || null,
      craftedOutputId: blueprint?.output_id || null
    }
  };
}

async function handleFabricateBlueprint(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;

  try {
    if (!gameContentCache.loadedAt || gameContentCache.blueprintsById.size <= 0) {
      await loadGameContent();
    }

    const dockedStarport = await getDockedMarketStarport(player, userId);
    const requestedStarport = normalizeStarportId(data?.starport_id);
    if (!dockedStarport) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'not_docked' });
      return;
    }
    if (requestedStarport && requestedStarport !== dockedStarport) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'wrong_starport', expectedStarportId: dockedStarport, gotStarportId: requestedStarport });
      return;
    }

    const blueprintInstanceId = String(data?.blueprintInstanceId || data?.blueprint_instance_id || '').trim();
    if (!blueprintInstanceId) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'missing_blueprint_instance' });
      return;
    }

    const shipState = await loadShipState(userId);
    const cargo = cloneItems(Array.isArray(shipState?.cargo) ? shipState.cargo : []);
    const storageState = await loadInventoryStateServer(userId, dockedStarport);
    const storage = cloneItems(storageState.items || []);

    const blueprintFromCargo = cargo.find((entry) => String(entry?.id || '') === blueprintInstanceId) || null;
    const blueprintFromStorage = storage.find((entry) => String(entry?.id || '') === blueprintInstanceId) || null;
    const blueprintItem = blueprintFromCargo || blueprintFromStorage;
    if (!blueprintItem) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'blueprint_not_found' });
      return;
    }

    const blueprintCandidates = [
      data?.blueprintCanonicalId,
      data?.blueprintId,
      data?.blueprint_id,
      blueprintItem?.canonical_blueprint_id,
      blueprintItem?.canonicalBlueprintId,
      blueprintItem?.item_type,
      blueprintItem?.item_id,
      blueprintItem?.blueprintId,
      blueprintItem?.id
    ];
    let blueprint = null;
    for (const candidate of blueprintCandidates) {
      blueprint = findBlueprintContentByAnyId(candidate);
      if (blueprint) break;
    }
    if (!blueprint) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'blueprint_definition_missing' });
      return;
    }

    const recipeInputs = getBlueprintRecipeInputs(blueprint.blueprint_id);
    if (!Array.isArray(recipeInputs) || recipeInputs.length <= 0) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'blueprint_recipe_missing' });
      return;
    }

    const ingredientPayload = Array.isArray(data?.ingredients) ? data.ingredients : [];
    if (ingredientPayload.length <= 0) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'ingredients_missing' });
      return;
    }

    const aggregatedByResource = new Map();
    let totalQlWeighted = 0;
    let totalAmount = 0;
    const validatedSelections = [];

    for (const rawSelection of ingredientPayload) {
      const itemId = String(rawSelection?.itemId || rawSelection?.item_id || '').trim();
      const source = String(rawSelection?.source || '').trim().toLowerCase() === 'ship' ? 'ship' : 'storage';
      const amount = Math.max(0, Number(rawSelection?.amount) || 0);
      if (!itemId || amount <= 0) continue;
      const sourceList = source === 'ship' ? cargo : storage;
      const item = sourceList.find((entry) => String(entry?.id || '') === itemId);
      if (!item) {
        sendFabricationResult(socket, { requestId, ok: false, error: 'ingredient_not_found', itemId, source });
        return;
      }
      const availableAmount = getStackAmount(item);
      if (availableAmount < amount) {
        sendFabricationResult(socket, { requestId, ok: false, error: 'insufficient_ingredient_amount', itemId, source, requested: amount, available: availableAmount });
        return;
      }
      const resourceId = parseCanonicalResourceIdFromItem(item);
      if (!resourceId) {
        sendFabricationResult(socket, { requestId, ok: false, error: 'invalid_ingredient_type', itemId, source });
        return;
      }
      aggregatedByResource.set(resourceId, (aggregatedByResource.get(resourceId) || 0) + amount);
      const ql = parseItemQlValue(item);
      totalQlWeighted += ql * amount;
      totalAmount += amount;
      validatedSelections.push({ itemId, source, amount, resourceId });
    }

    for (const req of recipeInputs) {
      const requiredResourceId = String(req.input_item_id || '').trim();
      const selectedAmount = aggregatedByResource.get(requiredResourceId) || 0;
      if (selectedAmount + 1e-6 < Number(req.quantity || 0)) {
        sendFabricationResult(socket, {
          requestId,
          ok: false,
          error: 'recipe_not_satisfied',
          resourceId: requiredResourceId,
          required: Number(req.quantity || 0),
          selected: selectedAmount
        });
        return;
      }
    }

    const avgQL = totalAmount > 0 ? clamp(totalQlWeighted / totalAmount, 1, 300) : 1;
    const craftedAt = Date.now();

    const blueprintRemoved = blueprintFromCargo
      ? removeSingleItemById(cargo, blueprintInstanceId)
      : removeSingleItemById(storage, blueprintInstanceId);
    if (!blueprintRemoved) {
      sendFabricationResult(socket, { requestId, ok: false, error: 'blueprint_consume_failed' });
      return;
    }

    for (const entry of validatedSelections) {
      const targetList = entry.source === 'ship' ? cargo : storage;
      const ok = removeAmountFromItemById(targetList, entry.itemId, entry.amount);
      if (!ok) {
        sendFabricationResult(socket, { requestId, ok: false, error: 'ingredient_consume_failed', itemId: entry.itemId, source: entry.source });
        return;
      }
    }

    let craftedOutput = null;
    let ownedShips = null;

    if (blueprint.output_type === 'ship') {
      const shipDef = gameContentCache.shipsById.get(blueprint.output_id) || null;
      if (!shipDef) {
        sendFabricationResult(socket, { requestId, ok: false, error: 'ship_definition_missing' });
        return;
      }
      craftedOutput = buildCraftedShipItem(blueprint, shipDef, avgQL, craftedAt);
      const hangarPayload = {
        player_id: userId,
        starport_id: dockedStarport,
        ship_id: craftedOutput.id,
        hull_id: craftedOutput.hull_id || craftedOutput.ship_id,
        ship_config: craftedOutput,
        updated_at: nowIso()
      };
      const { error: commanderError } = await supabase
        .from('hangar_states')
        .upsert(hangarPayload, { onConflict: 'player_id,starport_id,ship_id' });
      if (commanderError) throw commanderError;
    } else {
      const moduleDef = gameContentCache.modulesById.get(blueprint.output_id) || null;
      if (!moduleDef) {
        sendFabricationResult(socket, { requestId, ok: false, error: 'module_definition_missing' });
        return;
      }
      craftedOutput = buildCraftedModuleItem(blueprint, moduleDef, avgQL, craftedAt);
      storage.push(craftedOutput);
      await saveInventoryStateServer(userId, dockedStarport, storage);
    }

    await saveInventoryStateServer(userId, dockedStarport, storage);

    const { error: cargoError } = await supabase
      .from('ship_states_v2')
      .update({ cargo, updated_at: nowIso() })
      .eq('player_id', userId);
    if (cargoError) throw cargoError;

    const commanderState = await ensureCommanderWallet(userId);
    sendFabricationResult(socket, {
      requestId,
      ok: true,
      action: 'FABRICATE_BLUEPRINT',
      starport_id: dockedStarport,
      blueprintId: blueprint.blueprint_id,
      clientBlueprintId: getBlueprintClientId(blueprint.blueprint_id),
      avgQL: Number(avgQL.toFixed(1)),
      output: craftedOutput,
      cargo,
      storage,
      ownedShips,
      commanderState: commanderState ? { credits: Number(commanderState.credits || 0) } : null
    });
  } catch (e) {
    console.warn('[Fabrication] failed:', e?.message || e);
    sendFabricationResult(socket, { requestId: data?.requestId || null, ok: false, error: e?.message || 'fabrication_failed' });
  }
}


async function handleRefineOre(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;

  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const requestedStarport = normalizeStarportId(data?.starport_id);
    if (!dockedStarport) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'not_docked' });
      return;
    }
    if (requestedStarport && requestedStarport !== dockedStarport) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'wrong_starport', expectedStarportId: dockedStarport, gotStarportId: requestedStarport });
      return;
    }

    const itemId = String(data?.itemId || data?.item_id || '').trim();
    const source = String(data?.source || '').trim().toLowerCase() === 'ship' ? 'ship' : 'storage';
    if (!itemId) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'missing_item' });
      return;
    }

    const shipState = await loadShipState(userId);
    const cargo = cloneItems(Array.isArray(shipState?.cargo) ? shipState.cargo : []);
    const storageState = await loadInventoryStateServer(userId, dockedStarport);
    const storage = cloneItems(storageState.items || []);
    const sourceList = source === 'ship' ? cargo : storage;
    const selectedItem = sourceList.find((entry) => String(entry?.id || '') === itemId) || null;
    if (!selectedItem) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'selected_item_not_found', itemId, source });
      return;
    }
    if (String(selectedItem?.type || '').trim().toLowerCase() !== 'resource' || selectedItem?.isRefined) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'invalid_resource', itemId, source });
      return;
    }

    const itemWeight = parseFloat(selectedItem?.weight) || (Number(getStackAmount(selectedItem) || 0) * 0.1);
    const currentStationWeight = storage.reduce((sum, cargoItem) => sum + (parseFloat(cargoItem?.weight) || 5), 0);
    if (currentStationWeight + itemWeight > 1000) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'storage_capacity', itemId, source });
      return;
    }

    const oreType = resolveRefineryOreType(selectedItem);
    const refinedName = `Refined ${oreType}`;
    const refinedQL = Number(parseItemQlValue(selectedItem).toFixed(1));
    const refinedAmount = Math.floor(Number(getStackAmount(selectedItem) || 0) * 0.75);
    if (!Number.isFinite(refinedAmount) || refinedAmount <= 0) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'invalid_refine_amount', itemId, source });
      return;
    }

    const removed = removeAmountFromItemById(sourceList, itemId, getStackAmount(selectedItem));
    if (!removed) {
      sendRefineryResult(socket, { requestId, ok: false, error: 'selected_item_not_found', itemId, source });
      return;
    }

    const existingInStorage = storage.find((storageItem) => (
      storageItem?.isRefined &&
      String(storageItem?.oreType || '') === oreType &&
      Number(storageItem?.qlBand) === refinedQL
    ));

    if (existingInStorage) {
      existingInStorage.amount = Number(getStackAmount(existingInStorage) || 0) + refinedAmount;
      const existingWeight = parseFloat(existingInStorage?.weight) || 0;
      existingInStorage.weight = Number((existingWeight + itemWeight).toFixed(1));
    } else {
      storage.push(buildRefinedResourceItem(selectedItem, { oreType, refinedAmount, refinedQL, craftedAt: Date.now() }));
    }

    try {
      await saveInventoryStateServer(userId, dockedStarport, storage);
      const { error: cargoError } = await supabase
        .from('ship_states_v2')
        .update({ cargo, updated_at: nowIso() })
        .eq('player_id', userId);
      if (cargoError) throw cargoError;
    } catch (persistError) {
      console.warn('[Refinery] persist failed:', persistError?.message || persistError);
      sendRefineryResult(socket, { requestId, ok: false, error: 'persist_failed' });
      return;
    }

    sendRefineryResult(socket, {
      requestId,
      ok: true,
      action: 'REFINE_ORE',
      starport_id: dockedStarport,
      source,
      sourceItemId: itemId,
      oreType,
      refinedName,
      refinedQL,
      refinedAmount,
      cargo,
      storage
    });
  } catch (e) {
    console.warn('[Refinery] failed:', e?.message || e);
    sendRefineryResult(socket, { requestId: data?.requestId || null, ok: false, error: e?.message || 'refinery_failed' });
  }
}

async function handleMarketFetchData(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  const requestedStarport = normalizeStarportId(data?.starport_id);
  const activeStarport = requestedStarport || normalizeStarportId(player?.starport_id) || normalizeStarportId((await loadShipState(userId))?.starport_id);
  if (!activeStarport) {
    sendMarketDataResult(socket, { requestId, ok: false, error: "not_at_starport" });
    return;
  }
  const filter = normalizeMarketFilter(data?.filter);
  try {
    if (filter === "listings") {
      const listings = await loadOpenSellListings(activeStarport);
      sendMarketDataResult(socket, { requestId, filter, starport_id: activeStarport, listings });
    } else {
      const buyOrders = await loadOpenBuyOrders(activeStarport);
      sendMarketDataResult(socket, { requestId, filter, starport_id: activeStarport, buyOrders });
    }
  } catch (e) {
    sendMarketDataResult(socket, { requestId, ok: false, error: e?.message || "market_fetch_failed" });
  }
}

async function handleMarketSeedVendor(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const requestedStarport = normalizeStarportId(data?.starport_id);
    if (!dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "not_docked" });
      return;
    }
    if (requestedStarport && requestedStarport !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport", expectedStarportId: dockedStarport, gotStarportId: requestedStarport });
      return;
    }
    const result = await ensureVendorListings(dockedStarport);
    sendMarketActionResult(socket, { requestId, ok: true, action: "MARKET_SEED_VENDOR", starport_id: dockedStarport, ...result });
  } catch (e) {
    sendMarketActionResult(socket, { requestId, ok: false, error: e?.message || "seed_failed" });
  }
}

async function handleMarketCreateSellOrder(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const requestedStarport = normalizeStarportId(data?.starport_id);
    if (!dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "not_docked" });
      return;
    }
    if (requestedStarport && requestedStarport !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport", expectedStarportId: dockedStarport, gotStarportId: requestedStarport });
      return;
    }

    const itemType = String(data?.item_type || "").trim();
    const quantity = Math.max(1, Math.round(finiteNum(data?.quantity, 0)));
    const pricePerUni = Math.max(1, Math.round(finiteNum(data?.price_per_uni, 0)));
    console.log("[Market][Backend] create sell payload", {
      userId,
      dockedStarport,
      itemType,
      quantity,
      pricePerUni,
      clientItemDataIgnored: true
    });

    if (!itemType || quantity <= 0 || pricePerUni <= 0) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "invalid_request" });
      return;
    }

    const removedResult = await removeItemsFromStorageOrCargo(userId, dockedStarport, itemType, quantity);
    const authoritativeItemData = buildAuthoritativeMarketListingItemData(itemType, removedResult?.primaryItem, quantity);

    console.log("[Market][Backend] authoritative sell item built", {
      userId,
      itemType,
      removed: removedResult?.removed || 0,
      source: removedResult?.removedItems?.[0]?.source || null,
      itemName: authoritativeItemData?.name || null,
      itemDisplayName: authoritativeItemData?.displayName || null,
      contentType: authoritativeItemData?.contentType || null,
      catalogType: authoritativeItemData?.catalogType || null
    });

    const commander = await loadCommanderDataRow(userId);
    const payload = {
      starport_id: dockedStarport,
      seller_id: userId,
      seller_name: commander?.commander_name || null,
      item_type: itemType,
      item_data: authoritativeItemData,
      quantity,
      price_per_uni: pricePerUni,
      status: "open",
      created_at: nowIso()
    };
    const { data: listing, error } = await supabase
      .from("market_listings")
      .insert(payload)
      .select("listing_id, starport_id, seller_id, seller_name, item_type, item_data, quantity, price_per_uni, status, created_at")
      .single();
    if (error) throw error;

    console.log("[Market][Backend] listing inserted", {
      listingId: listing?.listing_id || null,
      itemType: listing?.item_type || null,
      hasItemData: !!listing?.item_data,
      itemDataName: listing?.item_data?.name || null
    });

    const matchResult = await attemptMatchOpenOrders(dockedStarport, itemType);
    const commanderState = await ensureCommanderWallet(userId);
    sendMarketActionResult(socket, {
      requestId,
      ok: true,
      action: "MARKET_CREATE_SELL_ORDER",
      listing,
      matched: matchResult.matched,
      commanderState: { credits: Number(commanderState?.credits || 0) }
    });
  } catch (e) {
    sendMarketActionResult(socket, { requestId, ok: false, error: e?.message || "create_sell_failed" });
  }
}

async function handleMarketCreateBuyOrder(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const requestedStarport = normalizeStarportId(data?.starport_id);
    if (!dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "not_docked" });
      return;
    }
    if (requestedStarport && requestedStarport !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport", expectedStarportId: dockedStarport, gotStarportId: requestedStarport });
      return;
    }

    const itemType = String(data?.item_type || "").trim();
    const quantity = Math.max(1, Math.round(finiteNum(data?.quantity, 0)));
    const pricePerUnit = Math.max(1, Math.round(finiteNum(data?.price_per_uni ?? data?.price_per_unit, 0)));
    const totalEscrow = quantity * pricePerUnit;
    if (!itemType || quantity <= 0 || pricePerUnit <= 0) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "invalid_request" });
      return;
    }

    const walletResult = await changeCommanderCredits(userId, -totalEscrow, {
      reason: "market_buy_order_escrow",
      referenceType: "buy_order",
      metadata: { itemType, quantity, pricePerUnit, starportId: dockedStarport }
    });
    if (!walletResult.ok) {
      sendMarketActionResult(socket, { requestId, ok: false, error: walletResult.error || "insufficient_credits", commanderState: { credits: Number(walletResult?.credits || 0) } });
      return;
    }

    const payload = {
      starport_id: dockedStarport,
      buyer_id: userId,
      item_type: itemType,
      quantity,
      price_per_unit: pricePerUnit,
      status: "open",
      created_at: nowIso()
    };
    const { data: order, error } = await supabase
      .from("market_buy_orders")
      .insert(payload)
      .select("order_id, starport_id, buyer_id, item_type, quantity, price_per_unit, status, created_at")
      .single();
    if (error) throw error;

    const matchResult = await attemptMatchOpenOrders(dockedStarport, itemType);
    sendMarketActionResult(socket, {
      requestId,
      ok: true,
      action: "MARKET_CREATE_BUY_ORDER",
      order: { ...order, price_per_uni: order.price_per_unit },
      matched: matchResult.matched,
      commanderState: { credits: walletResult.credits }
    });
  } catch (e) {
    sendMarketActionResult(socket, { requestId, ok: false, error: e?.message || "create_buy_failed" });
  }
}

async function handleMarketBuyListing(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const requestedStarport = normalizeStarportId(data?.starport_id);
    if (!dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "not_docked" });
      return;
    }
    if (requestedStarport && requestedStarport !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport", expectedStarportId: dockedStarport, gotStarportId: requestedStarport });
      return;
    }

    const listingId = String(data?.listing_id || "").trim();
    const quantity = Math.max(1, Math.round(finiteNum(data?.quantity, 1)));
    if (!listingId) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "invalid_request" });
      return;
    }

    const { data: listing, error } = await supabase
      .from("market_listings")
      .select("listing_id, starport_id, seller_id, seller_name, item_type, item_data, quantity, price_per_uni, status, created_at")
      .eq("listing_id", listingId)
      .maybeSingle();
    if (error) throw error;
    console.log("[Market][Backend] selected listing row", {
      listingId,
      hasItemData: !!listing?.item_data,
      itemDataName: listing?.item_data?.name || null,
      itemType: listing?.item_type || null,
      sellerId: listing?.seller_id || null
    });
    if (!listing || listing.status !== "open" || finiteNum(listing.quantity, 0) <= 0) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "listing_not_found" });
      return;
    }

    const listingStarport = normalizeStarportId(listing.starport_id);
    if (listingStarport !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport", expectedStarportId: listingStarport, gotStarportId: dockedStarport });
      return;
    }
    if (listing.seller_id === userId) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "self_purchase_rejected" });
      return;
    }

    const tradeQty = Math.min(quantity, Math.max(0, Math.round(finiteNum(listing.quantity, 0))));
    const unitPrice = Math.max(1, Math.round(finiteNum(listing.price_per_uni, 0)));
    const totalPrice = tradeQty * unitPrice;
    const walletResult = await changeCommanderCredits(userId, -totalPrice, {
      reason: "market_buy_listing",
      referenceType: "listing",
      referenceId: listingId,
      metadata: { itemType: listing.item_type, quantity: tradeQty, starportId: dockedStarport }
    });
    if (!walletResult.ok) {
      sendMarketActionResult(socket, { requestId, ok: false, error: walletResult.error || "insufficient_credits", commanderState: { credits: Number(walletResult?.credits || 0) } });
      return;
    }

    if (listing.seller_id !== NPC_MARKET_SELLER_ID) {
      await changeCommanderCredits(listing.seller_id, totalPrice, {
        reason: "market_listing_sale",
        referenceType: "listing",
        referenceId: listingId,
        metadata: { buyerId: userId, itemType: listing.item_type, quantity: tradeQty, starportId: dockedStarport }
      });
    }

    if (listing.item_data && typeof listing.item_data === "object") {
      const rebuiltSnapshot = buildMarketItemSnapshot(listing.item_type, tradeQty);
      const purchased = {
        ...listing.item_data,
        ...rebuiltSnapshot,
        catalogType: listing.item_data?.catalogType || rebuiltSnapshot.catalogType || rebuiltSnapshot.contentType || null,
        contentType: rebuiltSnapshot.contentType || listing.item_data?.contentType || null
      };
      purchased.quantity = tradeQty;
      purchased.amount = tradeQty;

      const purchasedCatalogType = String(
        purchased.catalogType || purchased.contentType || listing.item_data?.catalogType || listing.item_data?.contentType || ""
      ).trim().toLowerCase();
      const isShipPurchase = purchasedCatalogType === "ship" || !!purchased.ship_id;

      if (isShipPurchase) {
        await addShipToCommanderHangar(userId, dockedStarport, purchased);
      } else {
        await addFullItemToStorage(userId, dockedStarport, purchased);
      }
    } else {
      const purchased = buildMarketItemSnapshot(listing.item_type, tradeQty);
      const purchasedCatalogType = String(purchased.contentType || '').trim().toLowerCase();
      if (purchasedCatalogType === 'ship' || !!purchased.ship_id) {
        await addShipToCommanderHangar(userId, dockedStarport, purchased);
      } else {
        await addFullItemToStorage(userId, dockedStarport, purchased);
      }
    }

    console.log("[Market][Backend] buy listing resolved item", {
      listingId,
      sellerId: listing.seller_id,
      isNpcSeed: listing.seller_id === NPC_MARKET_SELLER_ID,
      hasItemData: !!listing.item_data,
      itemDataName: listing.item_data?.name || null
    });

    const nextQty = Math.max(0, Math.round(finiteNum(listing.quantity, 0)) - tradeQty);
    const { error: updateErr } = await supabase
      .from("market_listings")
      .update({ quantity: nextQty, status: nextQty > 0 ? "open" : "filled" })
      .eq("listing_id", listingId);
    if (updateErr) throw updateErr;

    await insertMarketTransaction({
      buyerId: userId,
      sellerId: listing.seller_id === NPC_MARKET_SELLER_ID ? null : listing.seller_id,
      itemType: listing.item_type,
      qty: tradeQty,
      price: unitPrice,
      total: totalPrice
    });

    sendMarketActionResult(socket, {
      requestId,
      ok: true,
      action: "MARKET_BUY_LISTING",
      success: true,
      listingId,
      quantity: tradeQty,
      commanderState: { credits: walletResult.credits }
    });
  } catch (e) {
    sendMarketActionResult(socket, { requestId, ok: false, error: e?.message || "buy_listing_failed" });
  }
}

async function handleMarketCancelSellOrder(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const listingId = String(data?.listing_id || "").trim();
    if (!dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "not_docked" });
      return;
    }
    const { data: listing, error } = await supabase
      .from("market_listings")
      .select("listing_id, starport_id, seller_id, item_type, quantity, status, item_data")
      .eq("listing_id", listingId)
      .maybeSingle();
    if (error) throw error;
    if (!listing || listing.seller_id !== userId) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "unauthorized" });
      return;
    }
    if (normalizeStarportId(listing.starport_id) !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport" });
      return;
    }
    const remainingQty = Math.max(0, Math.round(finiteNum(listing.quantity, 0)));
    if (remainingQty > 0) {
      if (listing.item_data && typeof listing.item_data === "object") {
        const restored = { ...listing.item_data };
        if ("quantity" in restored) restored.quantity = remainingQty;
        if ("amount" in restored) restored.amount = remainingQty;
        await addFullItemToStorage(userId, dockedStarport, restored);
      } else {
        await addItemToStorage(userId, dockedStarport, listing.item_type, remainingQty);
      }
    }
    const { error: updateErr } = await supabase
      .from("market_listings")
      .update({ status: "cancelled" })
      .eq("listing_id", listingId);
    if (updateErr) throw updateErr;

    sendMarketActionResult(socket, { requestId, ok: true, action: "MARKET_CANCEL_SELL_ORDER", listingId });
  } catch (e) {
    sendMarketActionResult(socket, { requestId, ok: false, error: e?.message || "cancel_sell_failed" });
  }
}

async function handleMarketCancelBuyOrder(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  try {
    const dockedStarport = await getDockedMarketStarport(player, userId);
    const orderId = String(data?.order_id || "").trim();
    if (!dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "not_docked" });
      return;
    }
    const { data: order, error } = await supabase
      .from("market_buy_orders")
      .select("order_id, starport_id, buyer_id, item_type, quantity, price_per_unit, status")
      .eq("order_id", orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order || order.buyer_id !== userId) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "unauthorized" });
      return;
    }
    if (normalizeStarportId(order.starport_id) !== dockedStarport) {
      sendMarketActionResult(socket, { requestId, ok: false, error: "wrong_starport" });
      return;
    }
    const refund = Math.max(0, Math.round(finiteNum(order.quantity, 0))) * Math.max(0, Math.round(finiteNum(order.price_per_unit, 0)));
    const walletResult = await changeCommanderCredits(userId, refund, {
      reason: "market_buy_order_refund",
      referenceType: "buy_order",
      referenceId: orderId,
      metadata: { itemType: order.item_type, quantity: order.quantity, starportId: dockedStarport }
    });
    if (!walletResult.ok) throw new Error(walletResult.error || "refund_failed");

    const { error: updateErr } = await supabase
      .from("market_buy_orders")
      .update({ status: "cancelled" })
      .eq("order_id", orderId);
    if (updateErr) throw updateErr;

    sendMarketActionResult(socket, { requestId, ok: true, action: "MARKET_CANCEL_BUY_ORDER", orderId, commanderState: { credits: walletResult.credits } });
  } catch (e) {
    sendMarketActionResult(socket, { requestId, ok: false, error: e?.message || "cancel_buy_failed" });
  }
}

// -----------------------------------------------------
// COMMANDER WALLET AUTHORITY (CD2)
// - credits are now owned by EC2/backend, not by direct client writes
// - wallet bootstraps from commander_data.credits on first use
// - ledger rows are written for all successful mutations
// NOTE: for production, the server-side Supabase client should use the
// service role key so these writes bypass RLS safely.
// -----------------------------------------------------
async function loadCommanderDataRow(userId) {
  const { data, error } = await supabase
    .from("commander_data")
    .select("id, credits, commander_name, active_ship_id, level, experience")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[Backend] Failed to load commander_data:", userId, error.message);
    return null;
  }
  return data || null;
}

async function ensureCommanderWallet(userId) {
  const { data: existing, error: existingError } = await supabase
    .from("commander_wallets")
    .select("commander_id, credits, updated_at")
    .eq("commander_id", userId)
    .maybeSingle();

  if (existingError) {
    console.warn("[Backend] Failed to load commander_wallets:", userId, existingError.message);
    return null;
  }
  if (existing) {
    console.log(`[Commander][Wallet] loaded existing wallet user=${userId} credits=${existing.credits}`);
    return existing;
  }

  const commander = await loadCommanderDataRow(userId);
  const startingCredits = Math.max(0, finiteNum(commander?.credits, 1000));
  console.log(`[Commander][Wallet] bootstrap wallet user=${userId} commanderCredits=${commander?.credits ?? 'null'} startingCredits=${startingCredits}`);

  const insertPayload = {
    commander_id: userId,
    credits: startingCredits,
    updated_at: nowIso()
  };

  const { data: created, error: createError } = await supabase
    .from("commander_wallets")
    .upsert(insertPayload, { onConflict: "commander_id" })
    .select("commander_id, credits, updated_at")
    .single();

  if (createError) {
    console.warn("[Backend] Failed to initialize commander_wallets:", userId, createError.message);
    return null;
  }

  try {
    await supabase
      .from("commander_data")
      .upsert({ id: userId, credits: startingCredits, updated_at: nowIso() }, { onConflict: "id" });
  } catch {}

  console.log(`[Commander][Wallet] created wallet user=${userId} credits=${(created || insertPayload)?.credits}`);
  return created || insertPayload;
}

async function appendCommanderCreditLedger({ commanderId, delta = 0, balanceAfter = 0, reason = "unknown", referenceType = null, referenceId = null, metadata = null } = {}) {
  try {
    const payload = {
      commander_id: commanderId,
      delta: Number(Number(delta || 0).toFixed(2)),
      balance_after: Number(Number(balanceAfter || 0).toFixed(2)),
      reason: String(reason || "unknown"),
      reference_type: referenceType ? String(referenceType) : null,
      reference_id: referenceId ? String(referenceId) : null,
      metadata: metadata && typeof metadata === "object" ? metadata : null,
      created_at: nowIso()
    };
    const { error } = await supabase.from("commander_credit_ledger").insert(payload);
    if (error) console.warn("[Backend] Failed to write commander_credit_ledger:", commanderId, error.message);
  } catch (e) {
    console.warn("[Backend] commander_credit_ledger exception:", commanderId, e?.message || e);
  }
}

async function insertBattlegroundLeaderboardRun({ battlegroundKey = null, playerId = null, commanderName = null, highestWave = 0, rewardSecured = 0, durationSeconds = null } = {}) {
  const safeBattlegroundKey = String(battlegroundKey || '').trim();
  const safePlayerId = String(playerId || '').trim();
  const safeCommanderName = String(commanderName || '').trim();
  const safeHighestWave = Math.max(1, Math.round(finiteNum(highestWave, 0)));
  const safeRewardSecured = Math.max(0, Math.round(finiteNum(rewardSecured, 0)));
  const safeDurationSeconds = durationSeconds == null ? null : Math.max(0, Math.round(finiteNum(durationSeconds, 0)));
  if (!safeBattlegroundKey || !safePlayerId || !safeCommanderName || safeHighestWave <= 0) return { ok: false, error: 'invalid_leaderboard_payload' };

  const isCandidateBetter = (candidate, current) => {
    if (!current) return true;
    const candidateWave = Math.max(0, Math.round(finiteNum(candidate?.highest_wave, 0)));
    const currentWave = Math.max(0, Math.round(finiteNum(current?.highest_wave, 0)));
    if (candidateWave !== currentWave) return candidateWave > currentWave;
    const candidateReward = Math.max(0, Math.round(finiteNum(candidate?.reward_secured, 0)));
    const currentReward = Math.max(0, Math.round(finiteNum(current?.reward_secured, 0)));
    if (candidateReward !== currentReward) return candidateReward > currentReward;
    const candidateDuration = candidate?.duration_seconds == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.round(finiteNum(candidate?.duration_seconds, 0)));
    const currentDuration = current?.duration_seconds == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.round(finiteNum(current?.duration_seconds, 0)));
    return candidateDuration < currentDuration;
  };

  try {
    const payload = {
      battleground_key: safeBattlegroundKey,
      player_id: safePlayerId,
      commander_name: safeCommanderName,
      highest_wave: safeHighestWave,
      reward_secured: safeRewardSecured,
      duration_seconds: safeDurationSeconds,
      created_at: nowIso()
    };

    const { data: existingRow, error: existingError } = await supabase
      .from('battleground_leaderboard_runs')
      .select('id, battleground_key, player_id, commander_name, highest_wave, reward_secured, duration_seconds, created_at')
      .eq('battleground_key', safeBattlegroundKey)
      .eq('player_id', safePlayerId)
      .maybeSingle();

    if (existingError) {
      console.warn('[Battleground][Leaderboard] existing-row load failed:', safePlayerId, safeBattlegroundKey, existingError.message);
      return { ok: false, error: existingError.message || 'leaderboard_existing_load_failed' };
    }

    if (!isCandidateBetter(payload, existingRow)) {
      console.log(`[Battleground][Leaderboard] kept existing best user=${safePlayerId} key=${safeBattlegroundKey} wave=${existingRow?.highest_wave || 0} credits=${existingRow?.reward_secured || 0}`);
      return { ok: true, skipped: true };
    }

    const { error } = await supabase
      .from('battleground_leaderboard_runs')
      .upsert(payload, {
        onConflict: 'battleground_key,player_id'
      });

    if (error) {
      console.warn('[Battleground][Leaderboard] upsert failed:', safePlayerId, safeBattlegroundKey, error.message);
      return { ok: false, error: error.message || 'leaderboard_upsert_failed' };
    }

    console.log(`[Battleground][Leaderboard] recorded extract user=${safePlayerId} key=${safeBattlegroundKey} wave=${safeHighestWave} credits=${safeRewardSecured}`);
    return { ok: true };
  } catch (e) {
    console.warn('[Battleground][Leaderboard] upsert exception:', safePlayerId, safeBattlegroundKey, e?.message || e);
    return { ok: false, error: e?.message || 'leaderboard_upsert_failed' };
  }
}

async function changeCommanderCredits(userId, delta, { reason = "unknown", referenceType = null, referenceId = null, metadata = null } = {}) {
  const wallet = await ensureCommanderWallet(userId);
  if (!wallet) return { ok: false, error: "wallet_unavailable" };

  const appliedDelta = Number(Number(delta || 0).toFixed(2));
  if (!Number.isFinite(appliedDelta) || appliedDelta === 0) {
    return { ok: true, credits: Number(wallet.credits || 0), delta: 0 };
  }

  const currentCredits = Number(wallet.credits || 0);
  const nextCredits = Number((currentCredits + appliedDelta).toFixed(2));
  console.log(`[Commander][Wallet] change request user=${userId} current=${currentCredits} delta=${appliedDelta} next=${nextCredits} reason=${reason}`);
  if (nextCredits < 0) {
    return { ok: false, error: "insufficient_credits", credits: currentCredits };
  }

  const { data, error } = await supabase
    .from("commander_wallets")
    .update({ credits: nextCredits, updated_at: nowIso() })
    .eq("commander_id", userId)
    .select("commander_id, credits, updated_at")
    .single();

  if (error) {
    console.warn("[Backend] Failed to update commander_wallets:", userId, error.message);
    return { ok: false, error: error.message || "wallet_update_failed" };
  }

  try {
    await supabase
      .from("commander_data")
      .upsert({ id: userId, credits: nextCredits, updated_at: nowIso() }, { onConflict: "id" });
  } catch (e) {
    console.warn("[Backend] Failed to mirror credits into commander_data:", userId, e?.message || e);
  }

  await appendCommanderCreditLedger({
    commanderId: userId,
    delta: appliedDelta,
    balanceAfter: nextCredits,
    reason,
    referenceType,
    referenceId,
    metadata
  });

  console.log(`[Commander][Wallet] updated user=${userId} newCredits=${nextCredits} reason=${reason} referenceType=${referenceType || 'null'} referenceId=${referenceId || 'null'}`);
  return { ok: true, credits: nextCredits, delta: appliedDelta, wallet: data };
}

async function sendCommanderState(socket, userId, requestId = null) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !userId) return;
  const wallet = await ensureCommanderWallet(userId);
  const commander = await loadCommanderDataRow(userId);
  const credits = Number(wallet?.credits ?? commander?.credits ?? 0);
  const commanderName = commander?.commander_name || null;
  const runtimePlayerRef = findPlayerSocketByUserId(userId);
  if (runtimePlayerRef?.player) runtimePlayerRef.player.commanderName = commanderName || runtimePlayerRef.player.commanderName || null;

  const hangarRows = await loadHangarShipsForPlayer(userId);
  const ownedShips = hangarRows.map(buildOwnedShipEntryFromHangarRow).filter(Boolean);

  let activeShipStats = null;
  const runtimePlayer = runtimePlayerRef?.player || null;
  if (runtimePlayer) {
    const hydrated = applyHydratedPlayerCombatStats(runtimePlayer, { preserveCurrent: true });
    activeShipStats = {
      hp: runtimePlayer.hp,
      maxHp: hydrated?.maxHp,
      shields: runtimePlayer.shields,
      maxShields: hydrated?.maxShields,
      energy: runtimePlayer.energy,
      maxEnergy: hydrated?.maxEnergy,
      armor: hydrated?.armor,
      resistances: hydrated?.resistances || {},
      combatStats: hydrated || null,
      fittings: runtimePlayer.fittings || {}
    };
  }

  console.log(`[Commander][State] user=${userId} walletCredits=${wallet?.credits ?? 'null'} commanderCredits=${commander?.credits ?? 'null'} sentCredits=${credits} commanderName=${commanderName || 'null'} requestId=${requestId || 'null'}`);
  socket.send(JSON.stringify({
    type: "COMMANDER_STATE",
    requestId: requestId || undefined,
    credits,
    level: finiteNum(commander?.level, 1),
    experience: finiteNum(commander?.experience, 0),
    commander_name: commanderName,
    active_ship_id: commander?.active_ship_id || null,
    active_ship_stats: activeShipStats,
    owned_ships: ownedShips,
    serverTime: Date.now()
  }));
}

async function handleCommanderGetState(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || "").trim();
  if (!userId || !player || player.userId !== userId) return;
  console.log(`[Commander][GetState] user=${userId} requestId=${data?.requestId || 'null'}`);
  await sendCommanderState(socket, userId, data?.requestId || null);
}

async function handleCommanderActivateShip(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  const requestId = data?.requestId || null;
  const targetShipId = String(data?.shipId || data?.ship_id || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.docked) {
    socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: "not_docked", shipId: targetShipId || null, serverTime: Date.now() }));
    return;
  }
  if (!targetShipId) {
    socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: "invalid_request", shipId: null, serverTime: Date.now() }));
    return;
  }

  try {
    const commander = await loadCommanderDataRow(userId);
    const previousActiveShipId = String(commander?.active_ship_id || player?.active_ship_instance_id || player?.current_ship_instance_id || '').trim();

    if (previousActiveShipId && previousActiveShipId === targetShipId) {
      await ensureHangarShipRecord(player, targetShipId);
      await hydratePlayerFromCommanderActiveShip(player, { fillVitals: true, persistState: true });
      socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: true, shipId: targetShipId, previousShipId: previousActiveShipId || null, alreadyActive: true, serverTime: Date.now() }));
      await sendCommanderState(socket, userId, requestId);
      return;
    }

    if (previousActiveShipId) {
      const persistedOld = await persistActiveShipToHangar(player, {
        hp: player.hp,
        maxHp: player.maxHp,
        shields: player.shields,
        maxShields: player.maxShields,
        energy: player.energy,
        maxEnergy: player.maxEnergy,
        fittings: player.fittings,
        hull_id: player.ship_type
      });
      if (!persistedOld) {
        socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: "persist_old_ship_failed", shipId: targetShipId, previousShipId: previousActiveShipId, serverTime: Date.now() }));
        return;
      }
    }

    const targetRow = await loadHangarShipRecordById(userId, targetShipId);
    if (!targetRow?.ship_config) {
      socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: "target_ship_not_found", shipId: targetShipId, previousShipId: previousActiveShipId || null, serverTime: Date.now() }));
      return;
    }

    const { error: updateError } = await supabase
      .from('commander_data')
      .update({ active_ship_id: targetShipId, updated_at: nowIso() })
      .eq('id', userId);
    if (updateError) {
      console.warn('[Commander][Activate] Failed to update commander active_ship_id:', userId, targetShipId, updateError.message);
      socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: "activate_update_failed", shipId: targetShipId, previousShipId: previousActiveShipId || null, serverTime: Date.now() }));
      return;
    }

    const hydrated = await hydratePlayerFromCommanderActiveShip(player, { fillVitals: true, persistState: true });
    if (!hydrated) {
      socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: "hydrate_failed", shipId: targetShipId, previousShipId: previousActiveShipId || null, serverTime: Date.now() }));
      return;
    }

    socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: true, shipId: targetShipId, previousShipId: previousActiveShipId || null, serverTime: Date.now() }));
    await sendCommanderState(socket, userId, requestId);
  } catch (e) {
    console.warn('[Commander][Activate] exception:', userId, targetShipId, e?.message || e);
    socket.send(JSON.stringify({ type: "COMMANDER_ACTIVATE_RESULT", requestId, ok: false, error: e?.message || 'activate_failed', shipId: targetShipId || null, serverTime: Date.now() }));
  }
}

async function handleCommanderRepairShip(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || "").trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;
  if (!player.docked) {
    const state = await loadShipState(userId);
    console.log(`[Commander][Repair] dock-check user=${userId} runtimeDocked=${!!player.docked} runtimeStarport=${player.starport_id || 'null'} dbStarport=${state?.starport_id || 'null'}`);
    if (state?.starport_id) {
      player.docked = true;
      player.starport_id = normalizeStarportId(state.starport_id);
      console.log(`[Commander][Repair] reconciled dock state from DB for user=${userId} starport_id=${player.starport_id}`);
    } else {
      socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "not_docked", serverTime: Date.now() }));
      return;
    }
  }

  const shipId = String(data?.shipId || data?.ship_id || "").trim();
  const repairPercent = clamp(data?.repairPercent ?? data?.repair_progress ?? data?.repairProgress, 0, 100);
  if (!shipId || repairPercent <= 0) {
    socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "invalid_request", serverTime: Date.now() }));
    return;
  }

  const commander = await loadCommanderDataRow(userId);
  const activeShipId = String(commander?.active_ship_id || "").trim();
  const starportId = String(player.starport_id || "").trim();

  console.log(`[Commander][Repair] user=${userId} shipId=${shipId} active_ship_id=${activeShipId || 'null'} starport_id=${starportId || 'null'} runtimeShipType=${player.ship_type || 'null'}`);

  let shipRecord = null;
  let activeShipState = null;
  let isActiveShip = activeShipId && shipId === activeShipId;

  if (!isActiveShip && starportId) {
    const { data: hangarRow, error: hangarError } = await supabase
      .from("hangar_states")
      .select("player_id, starport_id, ship_id, hull_id, ship_config")
      .eq("player_id", userId)
      .eq("ship_id", shipId)
      .maybeSingle();

    if (hangarError) {
      console.warn("[Backend] Failed to load hangar ship for repair:", userId, shipId, hangarError.message);
    }
    if (hangarRow) {
      shipRecord = hangarRow;
    }
  }

  if (!isActiveShip && !shipRecord) {
    const { data: stateRow, error: stateError } = await supabase
      .from("ship_states_v2")
      .select("player_id, ship_type, hull, maxHp, starport_id, system_id")
      .eq("player_id", userId)
      .maybeSingle();

    if (stateError) {
      console.warn("[Backend] Failed to load active ship state for repair:", userId, shipId, stateError.message);
    } else if (stateRow && String(shipId || "").trim() === String(activeShipId || "").trim()) {
      activeShipState = stateRow;
      isActiveShip = true;
    }
  }

  if (isActiveShip && !activeShipState) {
    const { data: stateRow, error: stateError } = await supabase
      .from("ship_states_v2")
      .select("player_id, ship_type, hull, maxHp, starport_id, system_id")
      .eq("player_id", userId)
      .maybeSingle();

    if (stateError) {
      console.warn("[Backend] Failed to load authoritative active ship for repair:", userId, shipId, stateError.message);
    } else {
      activeShipState = stateRow || null;
    }
  }

  let currentHp = 0;
  let maxHp = 0;

  if (isActiveShip) {
    currentHp = Math.max(0, finiteNum(activeShipState?.hull, player.hp ?? 0));
    maxHp = Math.max(currentHp, finiteNum(activeShipState?.maxHp, player.maxHp ?? currentHp));
  } else if (shipRecord?.ship_config) {
    currentHp = Math.max(0, finiteNum(shipRecord.ship_config.hp, 0));
    maxHp = Math.max(currentHp, finiteNum(shipRecord.ship_config.maxHp ?? shipRecord.ship_config.hp, currentHp));
  }

  if (!isActiveShip && !shipRecord) {
    socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "ship_not_found", shipId, serverTime: Date.now() }));
    return;
  }

  if (maxHp <= 0) {
    socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "ship_state_unavailable", shipId, serverTime: Date.now() }));
    return;
  }

  if (currentHp >= maxHp) {
    socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "nothing_to_repair", shipId, serverTime: Date.now() }));
    return;
  }

  const missingHp = Math.max(0, maxHp - currentHp);
  const hpToRepair = Math.max(0, Math.min(missingHp, Number((missingHp * (repairPercent / 100)).toFixed(2))));
  const repairCost = Math.ceil(hpToRepair / 5);

  if (!(hpToRepair > 0) || repairCost <= 0) {
    socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "invalid_repair_amount", shipId, serverTime: Date.now() }));
    return;
  }

  const wallet = await ensureCommanderWallet(userId);
  const currentCredits = Number(wallet?.credits || 0);
  if (currentCredits < repairCost) {
    socket.send(JSON.stringify({
      type: "COMMANDER_REPAIR_RESULT",
      requestId,
      ok: false,
      error: "insufficient_credits",
      shipId,
      repairCost,
      credits: currentCredits,
      serverTime: Date.now()
    }));
    return;
  }

  const nextHp = Math.min(maxHp, Number((currentHp + hpToRepair).toFixed(2)));

  if (isActiveShip) {
    player.hp = nextHp;
    const { error } = await supabase
      .from("ship_states_v2")
      .update({ hull: nextHp, updated_at: nowIso() })
      .eq("player_id", userId);
    if (error) {
      console.warn("[Backend] Failed to persist active-ship repair:", userId, error.message);
      socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "persist_failed", shipId, serverTime: Date.now() }));
      return;
    }
    await persistActiveShipToHangar(player, {
      hp: nextHp,
      maxHp,
      shields: player.shields,
      maxShields: player.maxShields,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      fittings: player.fittings
    });
  } else {
    const updatedShipConfig = {
      ...(shipRecord?.ship_config || {}),
      ship_id: normalizeCanonicalShipId(shipRecord?.hull_id || shipRecord?.ship_config?.ship_id || shipRecord?.ship_config?.type || shipRecord?.ship_config?.ship_type || null),
      ship_type: normalizeCanonicalShipId(shipRecord?.hull_id || shipRecord?.ship_config?.ship_id || shipRecord?.ship_config?.type || shipRecord?.ship_config?.ship_type || null),
      type: normalizeCanonicalShipId(shipRecord?.hull_id || shipRecord?.ship_config?.ship_id || shipRecord?.ship_config?.type || shipRecord?.ship_config?.ship_type || null),
      hull_id: normalizeCanonicalShipId(shipRecord?.hull_id || shipRecord?.ship_config?.ship_id || shipRecord?.ship_config?.type || shipRecord?.ship_config?.ship_type || null),
      hullTemplateId: normalizeCanonicalShipId(shipRecord?.hull_id || shipRecord?.ship_config?.ship_id || shipRecord?.ship_config?.type || shipRecord?.ship_config?.ship_type || null),
      hp: nextHp,
      maxHp: maxHp,
      fittings: sanitizeRuntimeFittings(shipRecord?.ship_config?.fittings || {}, updatedShipConfig?.ship_id || updatedShipConfig?.type || shipRecord?.hull_id || null)
    };
    const { error } = await supabase
      .from("hangar_states")
      .update({ ship_config: updatedShipConfig, hull_id: updatedShipConfig.hull_id, updated_at: nowIso() })
      .eq("player_id", userId)
      .eq("ship_id", shipId);
    if (error) {
      console.warn("[Backend] Failed to persist hangar-ship repair:", userId, shipId, error.message);
      socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: "persist_failed", shipId, serverTime: Date.now() }));
      return;
    }
  }

  const walletResult = await changeCommanderCredits(userId, -repairCost, {
    reason: "ship_repair",
    referenceType: isActiveShip ? "active_ship" : "hangar_ship",
    referenceId: shipId,
    metadata: { shipId, repairPercent, repairedHp: hpToRepair, resultingHp: nextHp, starportId: starportId || null }
  });

  if (!walletResult.ok) {
    socket.send(JSON.stringify({ type: "COMMANDER_REPAIR_RESULT", requestId, ok: false, error: walletResult.error || "wallet_update_failed", shipId, serverTime: Date.now() }));
    return;
  }

  socket.send(JSON.stringify({
    type: "COMMANDER_REPAIR_RESULT",
    requestId,
    ok: true,
    shipId,
    isActiveShip,
    repairedHp: hpToRepair,
    repairCost,
    nextHp,
    maxHp,
    credits: walletResult.credits,
    serverTime: Date.now()
  }));
}

// -----------------------------------------------------
// UTIL
// -----------------------------------------------------
function pickNum(...vals) {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}


// -----------------------------------------------------
// COMBAT (Server-authoritative hitscan)
// -----------------------------------------------------
// NOTE: This is a first pass authority layer.
// - Flux lasers + pulse cannons are treated as hitscan.
// - Missiles/drones still broadcast WEAPON_FIRED only (no server hit sim yet).
// - Weapon stats can optionally be supplied by the client as a snapshot,
//   but are clamped to safe bounds to prevent obvious cheating.
//
// Weapon stat fields expected:
// { damage, range, energyCost, cooldownMs, kind } where kind: "hitscan"|"projectile"|"drone"
const WEAPON_DEFAULTS = {
  flux: {
    kind: "beam", damage: 8, range: 900, energyCost: 3, cooldownMs: 120,
  },
  mining: {
    kind: "hitscan", damage: 2, range: 650, energyCost: 1, cooldownMs: 200,
  },
  pulse: {
    kind: "projectile", damage: { S: 64, M: 82, L: 101 }, range: { S: 500, M: 600, L: 750 },
    projectileSpeed: { S: 9.6, M: 8.4, L: 7.2 }, energyCost: { S: 12, M: 25, L: 42 }, cooldownMs: { S: 250, M: 295, L: 333 },
  },
  missile: {
    kind: "missile", damage: { S: 180, M: 240, L: 330 }, range: { S: 700, M: 900, L: 1200 },
    projectileSpeed: { S: 9.0, M: 9.75, L: 10.5 }, energyCost: { S: 14, M: 32, L: 55 }, cooldownMs: { S: 3000, M: 3500, L: 4000 },
  },
  generic: {
    kind: "hitscan", damage: 6, range: 750, energyCost: 3, cooldownMs: 160,
  },
};

function firstText(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function detectWeaponFamily(meta = {}) {
  const blob = [meta.weaponId, meta.weaponName, meta.weaponType, meta.weaponSubtype, meta.itemId, meta.instanceId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (blob.includes("pulse cannon") || blob.includes("pulse_cannon") || blob.includes("pulse")) return "pulse";
  if (blob.includes("seeker pod") || blob.includes("missile")) return "missile";
  if (blob.includes("mining")) return "mining";
  if (blob.includes("flux")) return "flux";
  return "generic";
}

function getWeaponStats(weaponId, snapshot, meta = {}) {
  const family = detectWeaponFamily({ ...meta, weaponId });
  const size = String(meta.weaponsize || meta.weaponSize || "S").trim().toUpperCase() || "S";
  const base = WEAPON_DEFAULTS[family] || WEAPON_DEFAULTS.generic;

  const baseDamage = typeof base.damage === "object" ? (base.damage[size] ?? base.damage.S ?? 6) : base.damage;
  const baseRange = typeof base.range === "object" ? (base.range[size] ?? base.range.S ?? 750) : base.range;
  const baseEnergy = typeof base.energyCost === "object" ? (base.energyCost[size] ?? base.energyCost.S ?? 3) : base.energyCost;
  const baseCooldown = typeof base.cooldownMs === "object" ? (base.cooldownMs[size] ?? base.cooldownMs.S ?? 160) : base.cooldownMs;
  const baseProjectileSpeed = typeof base.projectileSpeed === "object" ? (base.projectileSpeed[size] ?? base.projectileSpeed.S ?? 0) : (base.projectileSpeed || 0);

  const s = (snapshot && typeof snapshot === "object") ? snapshot : null;
  const kind = (s?.kind === "hitscan" || s?.kind === "beam" || s?.kind === "projectile" || s?.kind === "missile" || s?.kind === "drone") ? s.kind : (base.kind || "hitscan");

  return {
    family,
    kind,
    size,
    damage: clamp(s?.damage ?? baseDamage, 0, 2000),
    range: clamp(s?.range ?? baseRange, 50, 5000),
    energyCost: clamp(s?.energyCost ?? baseEnergy, 0, 500),
    cooldownMs: clamp(s?.cooldownMs ?? baseCooldown, 30, 10000),
    projectileSpeed: clamp(s?.projectileSpeed ?? baseProjectileSpeed, 0, 50),
  };
}

function getValidatedLockTarget(player, preferredTargetId = null) {
  const preferred = firstText(preferredTargetId);
  const lock = player?.validatedLock;
  if (!player || !lock) return null;
  if (lock.system_id !== player.system_id) return null;
  if (preferred && lock.targetId && preferred !== lock.targetId) return null;
  const ref = findPlayerSocketByUserId(lock.targetId);
  const target = ref?.player;
  if (!target || target.docked) return null;
  if (target.system_id !== player.system_id) return null;
  if ((target.hp ?? 1) <= 0) return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  return target;
}

function resolveBeamHit(player, weaponStats, fireData = {}) {
  const x = finiteNum(fireData.x, player.x);
  const y = finiteNum(fireData.y, player.y);
  const aimXRaw = finiteNum(fireData.aimX ?? fireData.aim_x, NaN);
  const aimYRaw = finiteNum(fireData.aimY ?? fireData.aim_y, NaN);
  const fallbackRot = finiteNum(fireData.rot, player.rot);
  const preferredTargetId = firstText(fireData.targetId, fireData.target_id, fireData.lockTargetId, fireData.lock_target_id) || null;
  const lockTarget = getValidatedLockTarget(player, preferredTargetId);

  let targetX = lockTarget ? lockTarget.x : aimXRaw;
  let targetY = lockTarget ? lockTarget.y : aimYRaw;

  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    targetX = x + Math.cos(fallbackRot) * Math.max(50, weaponStats.range || 900);
    targetY = y + Math.sin(fallbackRot) * Math.max(50, weaponStats.range || 900);
  }

  const effectiveRange = Math.max(50, Math.min(5000, finiteNum(fireData.beamRange ?? fireData.range, weaponStats.range || 900)));
  let rot = Math.atan2(targetY - y, targetX - x);
  if (!Number.isFinite(rot)) rot = fallbackRot || 0;
  const dx = Math.cos(rot);
  const dy = Math.sin(rot);

  let bestT = null;
  let bestTarget = null;
  for (const [, other] of players) {
    if (!other || other.docked) continue;
    if (other.userId === player.userId) continue;
    if (other.system_id !== player.system_id) continue;
    if ((other.hp ?? 1) <= 0) continue;
    if (!Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;

    const r = getHitRadius(other);
    const t = rayCircleHit(x, y, dx, dy, other.x, other.y, r);
    if (t === null) continue;
    if (t > effectiveRange) continue;

    if (lockTarget) {
      if (other.userId !== lockTarget.userId) continue;
      bestT = t;
      bestTarget = other;
      break;
    }

    if (bestT === null || t < bestT) {
      bestT = t;
      bestTarget = other;
    }
  }

  const impactX = x + dx * (bestT ?? effectiveRange);
  const impactY = y + dy * (bestT ?? effectiveRange);

  return {
    x,
    y,
    rot,
    range: effectiveRange,
    dx,
    dy,
    hitTarget: bestTarget,
    impactX,
    impactY,
    lockTargetId: lockTarget?.userId || null,
  };
}

function applyBeamDamage(systemId, attacker, weaponMeta, beamState, weaponStats, now) {
  if (!beamState?.hitTarget) return false;
  const attackerId = attacker?.ownerId || attacker?.sourceId || null;
  applyAuthoritativePlayerDamage({
    systemId,
    target: beamState.hitTarget,
    attackerId,
    sourceType: attacker?.sourceType || 'player',
    sourceId: attacker?.sourceId || attackerId || null,
    weapon_id: firstText(weaponMeta.weaponId, weaponMeta.weaponName, weaponMeta.weaponSubtype, weaponMeta.weaponType, 'beam'),
    weapon_name: weaponMeta.weaponName,
    rawAmount: weaponStats.damage || 0,
    damageType: 'energy',
    damageMode: 'beam',
    source: 'weapon',
    reason: 'flux_beam',
    impactX: beamState.impactX,
    impactY: beamState.impactY,
    serverTime: now,
  });

  broadcastToSystem(systemId, {
    type: 'FX_EVENT',
    fx_type: 'beam_hit',
    attackerId,
    sourceType: attacker?.sourceType || 'player',
    sourceId: attacker?.sourceId || attackerId || null,
    targetId: beamState.hitTarget.userId,
    weapon_id: firstText(weaponMeta.weaponId, weaponMeta.weaponName, weaponMeta.weaponSubtype, weaponMeta.weaponType, 'beam'),
    weapon_name: weaponMeta.weaponName,
    x: beamState.impactX,
    y: beamState.impactY,
    serverTime: now
  });
  return true;
}

function createProjectileState(player, weaponMeta, weaponStats, fireData = {}) {
  const now = Date.now();
  const x = finiteNum(fireData.x, player.x);
  const y = finiteNum(fireData.y, player.y);
  const rot = finiteNum(fireData.rot, player.rot);
  const inheritedVx = finiteNum(fireData.vx, player.vx || 0);
  const inheritedVy = finiteNum(fireData.vy, player.vy || 0);
  const speed = Math.max(0.1, weaponStats.projectileSpeed || 0);
  const dirX = Math.cos(rot);
  const dirY = Math.sin(rot);
  const velX = dirX * speed + inheritedVx;
  const velY = dirY * speed + inheritedVy;
  const isMissile = weaponStats.kind === "missile";
  const aimX = finiteNum(fireData.aimX ?? fireData.aim_x, x + dirX * Math.max(200, weaponStats.range || 700));
  const aimY = finiteNum(fireData.aimY ?? fireData.aim_y, y + dirY * Math.max(200, weaponStats.range || 700));
  const targetId = firstText(fireData.targetId, fireData.target_id, fireData.lockTargetId, fireData.lock_target_id) || null;

  return {
    id: `proj-${crypto.randomUUID()}`,
    system_id: player.system_id,
    ownerId: player.userId,
    sourceType: player.sourceType || 'player',
    sourceId: player.sourceId || player.userId,
    x,
    y,
    prevX: x,
    prevY: y,
    rot,
    vx: velX,
    vy: velY,
    distanceTraveled: 0,
    maxRange: Math.max(50, weaponStats.range || 500),
    damage: Math.max(0, weaponStats.damage || 0),
    weapon_id: firstText(weaponMeta.weaponId, weaponMeta.weaponName, weaponMeta.weaponSubtype, weaponMeta.weaponType, 'projectile'),
    weapon_name: weaponMeta.weaponName,
    weapon_type: weaponMeta.weaponType,
    weapon_subtype: weaponMeta.weaponSubtype,
    weaponsize: weaponMeta.weaponsize,
    rarity: weaponMeta.rarity,
    projectileKind: weaponStats.kind,
    projectileSpeed: speed,
    aimX,
    aimY,
    targetId: isMissile ? targetId : null,
    aoeRadius: isMissile ? Math.max(30, Math.min(250, finiteNum(fireData.aoeRadius, MISSILE_AOE_RADIUS))) : 0,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

function resolveMissileTarget(proj) {
  if (!proj?.targetId) return null;
  const ref = findPlayerSocketByUserId(proj.targetId);
  const target = ref?.player;
  if (!target || target.docked) return null;
  if (target.system_id !== proj.system_id) return null;
  if ((target.hp ?? 1) <= 0) return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  return target;
}

function applyProjectileDamage(systemId, proj, hitTarget, now, impactX, impactY) {
  if (!hitTarget) return;
  applyAuthoritativePlayerDamage({
    systemId,
    target: hitTarget,
    attackerId: proj.ownerId,
    sourceType: proj.sourceType || 'player',
    sourceId: proj.sourceId || proj.ownerId,
    weapon_id: proj.weapon_id,
    weapon_name: proj.weapon_name,
    rawAmount: proj.damage || 0,
    damageType: proj.projectileKind === 'missile' ? 'blast' : 'kinetic',
    damageMode: 'projectile',
    source: 'weapon',
    reason: proj.projectileKind || 'projectile',
    impactX,
    impactY,
    serverTime: now,
  });

  if (proj.projectileKind === "missile") {
    const aoeRadius = Math.max(1, proj.aoeRadius || MISSILE_AOE_RADIUS);
    broadcastToSystem(systemId, {
      type: 'FX_EVENT',
      fx_type: 'missile_explosion',
      attackerId: proj.ownerId,
      x: impactX,
      y: impactY,
      radius: aoeRadius,
      weapon_id: proj.weapon_id,
      weapon_name: proj.weapon_name,
      serverTime: now
    });

    for (const [, other] of players) {
      if (!other || other.docked) continue;
      if (other.userId === proj.ownerId) continue;
      if (other.userId === hitTarget.userId) continue;
      if (other.system_id !== systemId) continue;
      if ((other.hp ?? 1) <= 0) continue;
      if (!Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;

      const dist = distance2D(impactX, impactY, other.x, other.y);
      const effectiveRadius = aoeRadius + getHitRadius(other);
      if (dist > effectiveRadius) continue;

      const falloff = Math.max(0.2, 1 - (dist / Math.max(1, effectiveRadius)));
      const splashDamage = Math.max(1, Math.round((proj.damage || 0) * 0.6 * falloff));
      applyAuthoritativePlayerDamage({
        systemId,
        target: other,
        attackerId: proj.ownerId,
        weapon_id: proj.weapon_id,
        weapon_name: proj.weapon_name,
        rawAmount: splashDamage,
        damageType: 'blast',
        damageMode: 'aoe',
        source: 'weapon',
        reason: 'missile_aoe',
        impactX,
        impactY,
        serverTime: now,
      });
    }
  }

}

function tickProjectiles(now, dtMs) {
  const dtSeconds = Math.max(1, dtMs || SERVER_TICK_MS) / 1000;

  for (const [systemId, reg] of projectileStatesBySystem) {
    for (const [projectileId, proj] of reg) {
      if (!proj) {
        reg.delete(projectileId);
        continue;
      }
      if ((now - (proj.createdAt || now)) > PROJECTILE_STATE_TTL_MS) {
        reg.delete(projectileId);
        continue;
      }

      if (proj.projectileKind === 'missile') {
        const target = resolveMissileTarget(proj);
        const desiredRot = target
          ? Math.atan2(target.y - proj.y, target.x - proj.x)
          : Math.atan2((proj.aimY ?? proj.y) - proj.y, (proj.aimX ?? proj.x) - proj.x);
        let delta = desiredRot - (proj.rot || 0);
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const maxTurn = MISSILE_TURN_RATE_RAD * Math.max(1, dtMs || SERVER_TICK_MS) / 50;
        proj.rot = (proj.rot || 0) + Math.max(-maxTurn, Math.min(maxTurn, delta));
        const inheritedScale = 0.15;
        const ownerRef = findPlayerSocketByUserId(proj.ownerId);
        const owner = ownerRef?.player;
        const inheritedVx = Number.isFinite(owner?.vx) ? owner.vx * inheritedScale : 0;
        const inheritedVy = Number.isFinite(owner?.vy) ? owner.vy * inheritedScale : 0;
        proj.vx = Math.cos(proj.rot) * (proj.projectileSpeed || 0) + inheritedVx;
        proj.vy = Math.sin(proj.rot) * (proj.projectileSpeed || 0) + inheritedVy;
      }

      const nextX = proj.x + (proj.vx || 0) * dtSeconds * 60;
      const nextY = proj.y + (proj.vy || 0) * dtSeconds * 60;
      const stepDist = Math.hypot(nextX - proj.x, nextY - proj.y);

      let hitTarget = null;
      let hitFrac = null;
      for (const [, other] of players) {
        if (!other || other.docked) continue;
        if (other.userId === proj.ownerId) continue;
        if (other.system_id !== systemId) continue;
        if ((other.hp ?? 1) <= 0) continue;
        if (!Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;

        const r = getHitRadius(other);
        const frac = segmentCircleHitFraction(proj.x, proj.y, nextX, nextY, other.x, other.y, r);
        if (frac == null) continue;
        if (hitFrac == null || frac < hitFrac) {
          hitFrac = frac;
          hitTarget = other;
        }
      }

      const impactX = hitTarget && hitFrac != null ? proj.x + (nextX - proj.x) * hitFrac : nextX;
      const impactY = hitTarget && hitFrac != null ? proj.y + (nextY - proj.y) * hitFrac : nextY;

      proj.prevX = proj.x;
      proj.prevY = proj.y;
      proj.x = nextX;
      proj.y = nextY;
      proj.distanceTraveled = (proj.distanceTraveled || 0) + stepDist;
      proj.lastUpdatedAt = now;

      if (hitTarget) {
        applyProjectileDamage(systemId, proj, hitTarget, now, impactX, impactY);
        reg.delete(projectileId);
        continue;
      }

      if (proj.distanceTraveled >= proj.maxRange) {
        if (proj.projectileKind === 'missile') {
          broadcastToSystem(systemId, {
            type: 'FX_EVENT',
            fx_type: 'missile_explosion',
            attackerId: proj.ownerId,
            x: proj.x,
            y: proj.y,
            radius: Math.max(1, proj.aoeRadius || MISSILE_AOE_RADIUS),
            weapon_id: proj.weapon_id,
            weapon_name: proj.weapon_name,
            serverTime: now
          });
        }
        reg.delete(projectileId);
      }
    }

    if (reg.size === 0) projectileStatesBySystem.delete(systemId);
  }
}

function getHitRadius(p) {
  // Prefer per-ship radius if you later add it; fallback keeps hits playable.
  const r = pickNum(p.collisionRadius, p.sigRadius, 25);
  return (typeof r === "number" && Number.isFinite(r)) ? r : 25;
}

// Ray-circle intersection; returns distance t along ray, or null
function rayCircleHit(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx;
  const fy = oy - cy;

  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = (fx * fx + fy * fy) - r * r;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);

  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}

function segmentCircleHitFraction(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  if (a <= 1e-9) return null;

  const b = 2 * (fx * dx + fy * dy);
  const c = (fx * fx + fy * fy) - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);

  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

function broadcastToSystem(systemId, msgObj) {
  const raw = JSON.stringify(msgObj);
  for (const [otherSocket, otherPlayer] of players) {
    if (
      otherPlayer.system_id === systemId &&
      !otherPlayer.docked &&
      otherSocket.readyState === WebSocket.OPEN
    ) {
      otherSocket.send(raw);
    }
  }
}

function resolvePlayerDamage(target, amount) {
  if (!target) return null;
  const dmg = finiteNum(amount, 0);
  if (dmg <= 0) return null;

  const shieldsNow = Math.max(0, finiteNum(target.shields, 0));
  const hpNow = Math.max(0, finiteNum(target.hp, 0));
  const shieldDamage = Math.min(shieldsNow, dmg);
  const hullDamage = Math.max(0, dmg - shieldDamage);

  return {
    rawAmount: dmg,
    appliedAmount: shieldDamage + hullDamage,
    shieldDamage,
    hullDamage,
    beforeShields: shieldsNow,
    afterShields: Math.max(0, shieldsNow - shieldDamage),
    beforeHp: hpNow,
    afterHp: Math.max(0, hpNow - hullDamage),
  };
}

function applyResolvedPlayerDamage(target, resolved) {
  if (!target || !resolved) return resolved || null;
  target.shields = resolved.afterShields;
  target.hp = resolved.afterHp;
  return resolved;
}

function resolveAppliedPlayerDamage(target, shieldDamage, hullDamage) {
  if (!target) return null;
  const sDmg = Math.max(0, finiteNum(shieldDamage, 0));
  const hDmg = Math.max(0, finiteNum(hullDamage, 0));
  if (sDmg <= 0 && hDmg <= 0) return null;

  const shieldsNow = Math.max(0, finiteNum(target.shields, 0));
  const hpNow = Math.max(0, finiteNum(target.hp, 0));
  const appliedShield = Math.min(shieldsNow, sDmg);
  const appliedHull = Math.min(hpNow, hDmg);

  return {
    rawAmount: appliedShield + appliedHull,
    appliedAmount: appliedShield + appliedHull,
    shieldDamage: appliedShield,
    hullDamage: appliedHull,
    beforeShields: shieldsNow,
    afterShields: Math.max(0, shieldsNow - appliedShield),
    beforeHp: hpNow,
    afterHp: Math.max(0, hpNow - appliedHull),
  };
}

function emitShipDestroyed(systemId, attackerId, targetId, now, extra = {}) {
  const killCredit = extra?.killCredit || null;
  broadcastToSystem(systemId, {
    type: "SHIP_DESTROYED",
    attackerId,
    targetId,
    finalBlow: killCredit?.finalBlow || null,
    topDamage: killCredit?.topDamage || null,
    assists: killCredit?.assists || [],
    killCreditId: killCredit?.topDamage?.sourceId || null,
    killCreditType: killCredit?.topDamage?.sourceType || null,
    finalBlowId: killCredit?.finalBlow?.sourceId || null,
    finalBlowType: killCredit?.finalBlow?.sourceType || null,
    serverTime: now,
    ...extra,
  });
}

function buildPlayerPresenceUpdate(player) {
  if (!player?.userId) return null;
  return {
    type: "PLAYER_UPDATE",
    userId: player.userId,
    x: finiteNum(player.x, 0),
    y: finiteNum(player.y, 0),
    rot: finiteNum(player.rot, 0),
    vx: finiteNum(player.vx, 0),
    vy: finiteNum(player.vy, 0),
    hp: typeof player.hp === "number" ? player.hp : 100,
    maxHp: typeof player.maxHp === "number" ? player.maxHp : 100,
    shields: typeof player.shields === "number" ? player.shields : 0,
    maxShields: typeof player.maxShields === "number" ? player.maxShields : 0,
    energy: typeof player.energy === "number" ? player.energy : 100,
    maxEnergy: typeof player.maxEnergy === "number" ? player.maxEnergy : 100,
    fittings: player.fittings || {},
    visual_config: player.visual_config || null,
    animation_state: player.animation_state || null,
    armor: player.armor,
    resistances: player.resistances || {},
    combat_stats: player.combatStats || null
  };
}

function broadcastPlayerLeftForSystem(systemId, userId, excludeSocket = null) {
  if (!systemId || !userId) return;
  for (const [otherSocket, otherPlayer] of players) {
    if (
      otherSocket !== excludeSocket &&
      otherPlayer.system_id === systemId &&
      !otherPlayer.docked &&
      otherSocket.readyState === WebSocket.OPEN
    ) {
      otherSocket.send(JSON.stringify({ type: "PLAYER_LEFT", userId }));
    }
  }
}

function broadcastPlayerPresenceUpdate(player, excludeSocket = null) {
  if (!player?.system_id || player?.docked || player?.destroyed) return;
  const update = buildPlayerPresenceUpdate(player);
  if (!update) return;
  for (const [otherSocket, otherPlayer] of players) {
    if (
      otherSocket !== excludeSocket &&
      otherPlayer.system_id === player.system_id &&
      !otherPlayer.docked &&
      otherSocket.readyState === WebSocket.OPEN
    ) {
      otherSocket.send(JSON.stringify(update));
    }
  }
}

function broadcastPlayerDamageResult(systemId, result) {
  if (!systemId || !result) return;
  broadcastToSystem(systemId, {
    type: "DAMAGE_EVENT",
    attackerId: result.attackerId,
    sourceType: result.sourceType,
    sourceId: result.sourceId,
    targetId: result.targetId,
    weapon_id: result.weapon_id,
    weapon_name: result.weapon_name,
    amount: result.amount,
    shieldDamage: result.shieldDamage,
    hullDamage: result.hullDamage,
    hull: result.hull,
    maxHp: result.maxHp,
    shields: result.shields,
    maxShields: result.maxShields,
    damageType: result.damageType,
    damageMode: result.damageMode,
    source: result.source,
    reason: result.reason,
    impactX: result.impactX,
    impactY: result.impactY,
    serverTime: result.serverTime,
  });
}

function applyAuthoritativePlayerDamage({
  systemId,
  target,
  attackerId,
  sourceType = 'player',
  sourceId = null,
  weapon_id,
  weapon_name,
  rawAmount = null,
  shieldDamage = null,
  hullDamage = null,
  damageType = 'kinetic',
  damageMode = 'direct',
  source = 'weapon',
  reason = 'combat',
  impactX,
  impactY,
  serverTime = Date.now(),
}) {
  if (!target) return null;
  if (isArenaIntroProtected(target)) return null;

  const attackerRef = String(sourceType || 'player') === 'player'
    ? findPlayerSocketByUserId(String(sourceId || attackerId || '').trim())
    : null;
  const attackerPlayer = attackerRef?.player || null;
  const combatBlockReason = (String(sourceType || 'player') === 'player' && attackerPlayer)
    ? getPlayerCombatBlockReason(attackerPlayer, target, systemId)
    : null;
  if (combatBlockReason) {
    return null;
  }

  const resolved = (shieldDamage != null || hullDamage != null)
    ? resolveAppliedPlayerDamage(target, shieldDamage, hullDamage)
    : resolvePlayerDamage(target, rawAmount);
  if (!resolved || resolved.appliedAmount <= 0) return null;

  applyResolvedPlayerDamage(target, resolved);
  markPlayerDirty(target, ["ship"]);

  const resolvedSourceId = String(sourceId || attackerId || '').trim() || null;
  const result = {
    attackerId,
    sourceType: String(sourceType || 'player'),
    sourceId: resolvedSourceId,
    targetId: target.userId,
    weapon_id,
    weapon_name,
    amount: resolved.appliedAmount,
    shieldDamage: resolved.shieldDamage,
    hullDamage: resolved.hullDamage,
    hull: target.hp ?? 0,
    maxHp: target.maxHp ?? undefined,
    shields: target.shields ?? undefined,
    maxShields: target.maxShields ?? undefined,
    damageType,
    damageMode,
    source,
    reason,
    impactX: Number.isFinite(impactX) ? impactX : undefined,
    impactY: Number.isFinite(impactY) ? impactY : undefined,
    serverTime,
    destroyed: (target.hp ?? 0) <= 0 && resolved.beforeHp > 0,
  };

  recordRecentDamage({
    targetType: 'player',
    targetId: target.userId,
    attackerId,
    sourceType: result.sourceType,
    sourceId: resolvedSourceId,
    amount: resolved.appliedAmount,
    weapon_id,
    weapon_name,
    damageMode,
    timestamp: serverTime
  });

  broadcastPlayerDamageResult(systemId, result);
  if (result.destroyed) {
    const killCredit = resolveKillCredit('player', target.userId, serverTime);
    if (isArenaSystemId(systemId) && target?.arenaState?.inArena) {
      const targetRef = findPlayerSocketByUserId(target.userId);
      queueArenaRespawn(target, targetRef?.socket || null, attackerId, serverTime);
    } else if (isBattlegroundSystemId(systemId) && target?.battlegroundState?.inBattleground) {
      finalizeBattlegroundFailure(target, 'destroyed').catch((e) => {
        console.warn('[Battleground] failure finalize failed:', e?.message || e);
      });
      emitShipDestroyed(systemId, attackerId, target.userId, serverTime, {
        killCredit,
        sourceType: result.sourceType,
        sourceId: resolvedSourceId,
        battlegroundFailure: true
      });
    } else {
      target.destroyed = true;
      target.vx = 0;
      target.vy = 0;
      target.lastSpaceTelemetry = telemetrySnapshot(target);
      clearValidatedLock(target);
      markPlayerDirty(target, ["ship", "telemetry"], { forceImmediatePersist: true });
      emitShipDestroyed(systemId, attackerId, target.userId, serverTime, {
        killCredit,
        sourceType: result.sourceType,
        sourceId: resolvedSourceId
      });
      broadcastPlayerLeftForSystem(systemId, target.userId);
    }
    clearKillCreditTracking('player', target.userId);
  }
  return result;
}


function nowIso() {
  return new Date().toISOString();
}

function telemetrySnapshot(p) {
  return { x: p.x, y: p.y, rot: p.rot, vx: p.vx, vy: p.vy, system_id: p.system_id || null };
}

async function persistArenaReturnSnapshot(userId, snapshot) {
  const safeSnapshot = (snapshot && typeof snapshot === "object") ? {
    system_id: String(snapshot.system_id || "").trim() || "cygnus-prime",
    x: finiteNum(snapshot.x, 0),
    y: finiteNum(snapshot.y, 0),
    rot: finiteNum(snapshot.rot, 0),
    vx: finiteNum(snapshot.vx, 0),
    vy: finiteNum(snapshot.vy, 0),
    starport_id: snapshot.starport_id || null,
    docked: false
  } : null;

  const payload = {
    player_id: userId,
    arena_return_snapshot: safeSnapshot,
    updated_at: nowIso()
  };

  const { error: writeError } = await supabase
    .from("ship_states_v2")
    .upsert(payload, { onConflict: "player_id" });

  if (writeError) throw writeError;

  const { data: verifyRow, error: verifyError } = await supabase
    .from("ship_states_v2")
    .select("player_id, system_id, arena_return_snapshot")
    .eq("player_id", userId)
    .maybeSingle();

  if (verifyError) throw verifyError;

  const verified = verifyRow?.arena_return_snapshot;
  const verifiedSystemId = String(verified?.system_id || "").trim();
  if (!verified || typeof verified !== "object" || !verifiedSystemId || isArenaSystemId(verifiedSystemId)) {
    throw new Error("arena_return_snapshot_verify_failed");
  }

  console.log("[Arena] snapshot verified:", {
    userId,
    currentSystemId: verifyRow?.system_id || null,
    returnSystemId: verifiedSystemId
  });

  return verified;
}

async function clearArenaReturnSnapshot(userId) {
  const { error } = await supabase
    .from("ship_states_v2")
    .upsert({
      player_id: userId,
      arena_return_snapshot: null,
      updated_at: nowIso()
    }, { onConflict: "player_id" });

  if (error) throw error;
}

async function recoverArenaPlayerIfNeeded(userId, state) {
  const currentSystemId = String(state?.system_id || "").trim();
  const snapshot = state?.arena_return_snapshot;
  if (!isArenaSystemId(currentSystemId)) return state;
  if (!snapshot || typeof snapshot !== "object") return state;
  const returnSystemId = String(snapshot.system_id || "").trim();
  if (!returnSystemId || isArenaSystemId(returnSystemId)) return state;

  const repairedTelemetry = {
    x: finiteNum(snapshot.x, 0),
    y: finiteNum(snapshot.y, 0),
    rot: finiteNum(snapshot.rot, 0),
    vx: finiteNum(snapshot.vx, 0),
    vy: finiteNum(snapshot.vy, 0)
  };

  const payload = {
    player_id: userId,
    system_id: returnSystemId,
    starport_id: snapshot.starport_id || null,
    telemetry: repairedTelemetry,
    arena_return_snapshot: null,
    updated_at: nowIso()
  };

  const { error } = await supabase
    .from("ship_states_v2")
    .upsert(payload, { onConflict: "player_id" });

  if (error) {
    console.warn("[Arena] reconnect recovery persist failed:", userId, error.message);
    return state;
  }

  console.log("[Arena] reconnect recovery applied:", userId, currentSystemId, "->", returnSystemId);

  return {
    ...state,
    system_id: returnSystemId,
    starport_id: snapshot.starport_id || null,
    telemetry: repairedTelemetry,
    arena_return_snapshot: null
  };
}


function safeObjectData(data) {
  if (!data || typeof data !== "object") return {};
  const out = { ...data };
  delete out.id;
  delete out.object_id;
  delete out.networkSpawned;
  return out;
}


function normalizeCargoItem(raw) {
  const base = (raw && typeof raw === "object") ? raw : { value: raw };
  const item = (base.itemData && typeof base.itemData === "object") ? base.itemData
    : (base.item && typeof base.item === "object") ? base.item
    : (base.payload && typeof base.payload === "object") ? base.payload
    : (base.data_json && typeof base.data_json === "object") ? base.data_json
    : base;

  const out = { ...item };
  delete out.systemId;
  delete out.ownerId;
  delete out.networkSpawned;
  if (!out.id && typeof base.object_id === 'string') out.id = base.object_id;
  if (!Number.isFinite(out.amount)) out.amount = Number.isFinite(base.amount) ? Number(base.amount) : 1;
  return out;
}

function sameLootKey(a, b) {
  if (!a || !b) return false;
  if (a.itemId && b.itemId) return a.itemId === b.itemId;
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.oreType === b.oreType &&
    a.qlBand === b.qlBand &&
    a.rarity === b.rarity
  );
}

function mergeCargoItems(cargo = [], cargoItem = null) {
  if (!cargoItem) return Array.isArray(cargo) ? cargo : [];

  const next = Array.isArray(cargo) ? cargo.map((it) => ({ ...it })) : [];
  const amountToAdd = Number.isFinite(cargoItem.amount) ? Number(cargoItem.amount) : 1;
  const maxStack = Number.isFinite(cargoItem.maxStack) ? Number(cargoItem.maxStack) : 999;

  let remaining = amountToAdd;
  for (let i = 0; i < next.length && remaining > 0; i++) {
    const it = next[i];
    if (!sameLootKey(it, cargoItem)) continue;
    const cur = Number.isFinite(it.amount) ? Number(it.amount) : 1;
    const space = Math.max(0, maxStack - cur);
    if (space <= 0) continue;
    const add = Math.min(space, remaining);
    next[i] = { ...it, amount: cur + add };
    remaining -= add;
  }

  if (remaining > 0) next.push({ ...cargoItem, amount: remaining });
  return next;
}

async function insertWorldObject({ type = "loot", data = {}, x = 0, y = 0, system_id = null, owner_id = null, ownership_meta = null } = {}) {
  const payload = {
    object_id: `wo-${crypto.randomUUID()}`,
    type: String(type || "loot"),
    x: Number.isFinite(x) ? Number(Number(x).toFixed(2)) : 0,
    y: Number.isFinite(y) ? Number(Number(y).toFixed(2)) : 0,
    rot: 0,
    hp: 1,
    respawn_at: null,
    updated_at: nowIso(),
    data: {
      ...safeObjectData(data),
      ...(system_id ? { systemId: system_id } : {}),
      ...(owner_id ? { ownerId: owner_id } : {}),
      ...((ownership_meta && typeof ownership_meta === 'object') ? { ownership: ownership_meta } : {})
    }
  };

  const { data: row, error } = await supabase
    .from("world_objects")
    .insert(payload)
    .select("object_id, type, x, y, rot, data, updated_at, respawn_at, hp")
    .single();

  if (error) throw error;
  return row || payload;
}

async function collectWorldObjectToCargoServer({ objectId, playerId }) {
  const { data: wo, error: fetchErr } = await supabase
    .from("world_objects")
    .select("object_id, type, x, y, data")
    .eq("object_id", objectId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!wo) return null;

  const cargoItem = normalizeCargoItem(wo.data);
  if (!cargoItem) return null;

  const { data: shipRow, error: shipErr } = await supabase
    .from("ship_states_v2")
    .select("cargo")
    .eq("player_id", playerId)
    .maybeSingle();

  if (shipErr) throw shipErr;

  const cargo = mergeCargoItems(Array.isArray(shipRow?.cargo) ? shipRow.cargo : [], cargoItem);

  const { error: delErr } = await supabase
    .from("world_objects")
    .delete()
    .eq("object_id", objectId);
  if (delErr) throw delErr;

  const { error: upErr } = await supabase
    .from("ship_states_v2")
    .upsert({ player_id: playerId, cargo, updated_at: nowIso() }, { onConflict: "player_id" });
  if (upErr) throw upErr;

  return { cargo, object: wo };
}

function shouldMarkDirty(p, incoming) {
  // if no previous, dirty
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;

  const dx = Math.abs(incoming.x - p.x);
  const dy = Math.abs(incoming.y - p.y);
  const dr = Math.abs((incoming.rot ?? p.rot) - p.rot);

  if (dx > MOVE_EPS || dy > MOVE_EPS || dr > ROT_EPS) return true;

  // vitals deltas (optional)
  if (typeof incoming.hp === "number" && typeof p.hp === "number" && Math.abs(incoming.hp - p.hp) > VITALS_EPS.hp) return true;
  if (typeof incoming.shields === "number" && typeof p.shields === "number" && Math.abs(incoming.shields - p.shields) > VITALS_EPS.shields) return true;
  if (typeof incoming.energy === "number" && typeof p.energy === "number" && Math.abs(incoming.energy - p.energy) > VITALS_EPS.energy) return true;

  return false;
}

async function persistPlayerState(p, { reason = "periodic" } = {}) {
  if (!p || p.docked) return;

  ensureDirtySections(p);

  const now = Date.now();
  p._lastPersistAt = p._lastPersistAt || 0;
  if (now - p._lastPersistAt < DIRTY_MIN_INTERVAL_MS && reason === "periodic") return;

  p._lastPersistAt = now;

  try {
    const payload = {
      player_id: p.userId,
      starport_id: null,
      ship_type: p.ship_type || "OMNI SCOUT",
      system_id: p.system_id,
      starport_id: null,
      telemetry: telemetrySnapshot(p),
      hull: typeof p.hp === "number" ? p.hp : undefined,
      maxHp: typeof p.maxHp === "number" ? p.maxHp : undefined,
      shields: typeof p.shields === "number" ? p.shields : undefined,
      maxShields: typeof p.maxShields === "number" ? p.maxShields : undefined,
      energy: typeof p.energy === "number" ? p.energy : undefined,
      maxEnergy: typeof p.maxEnergy === "number" ? p.maxEnergy : undefined,
      cargo: Array.isArray(p.cargo) ? p.cargo : undefined,
      arena_return_snapshot: isArenaSystemId(p.system_id)
        ? (p.arenaReturnSnapshot || p.arenaState?.returnSnapshot || undefined)
        : null,
      updated_at: nowIso()
    };

    // remove undefined keys (prevents overwriting good DB values with nulls)
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const { error } = await supabase
      .from("ship_states_v2")
      .upsert(payload, { onConflict: "player_id" });

    if (error) console.warn("[Backend] Persist failed:", p.userId, reason, error.message);
    else {
      await persistActiveShipToHangar(p);
      clearDirtySections(p, ["telemetry", "ship"]);
      if (reason !== "periodic") console.log("[Backend] Persist OK:", p.userId, reason);
    }
  } catch (e) {
    console.warn("[Backend] Persist exception:", p.userId, reason, e?.message || e);
  }
}


async function handleArenaLeave(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.arenaState?.inArena) return;

  const returnSnapshot = player.arenaState?.returnSnapshot || null;
  if (!returnSnapshot || !returnSnapshot.system_id || isArenaSystemId(returnSnapshot.system_id)) {
    socket.send(JSON.stringify({
      type: 'ARENA_JOIN_FAILED',
      reason: 'return_snapshot_missing',
      serverTime: Date.now()
    }));
    return;
  }

  const oldSystemId = player.system_id;
  removePlayerFromArenaInstances(player.userId);
  player.system_id = returnSnapshot.system_id;
  player.docked = false;
  player.starport_id = returnSnapshot.starport_id || null;
  player.x = finiteNum(returnSnapshot.x, 0);
  player.y = finiteNum(returnSnapshot.y, 0);
  player.rot = finiteNum(returnSnapshot.rot, 0);
  player.vx = finiteNum(returnSnapshot.vx, 0);
  player.vy = finiteNum(returnSnapshot.vy, 0);
  player.lastSpaceTelemetry = { x: player.x, y: player.y, rot: player.rot, vx: player.vx, vy: player.vy };
  clearValidatedLock(player);
  if (player.arenaState) {
    player.arenaState.inArena = false;
    player.arenaState.instanceId = null;
    player.arenaState.snapshot = null;
    player.arenaState.awaitingReady = false;
  }
  markPlayerDirty(player, ["ship", "telemetry"], { forceImmediatePersist: true });
  player.arenaReturnSnapshot = null;
  try {
    await persistPlayerState(player, { reason: 'arena_leave' });
    await clearArenaReturnSnapshot(player.userId);
  } catch {}

  if (oldSystemId && oldSystemId !== player.system_id) {
    for (const [otherSocket, otherPlayer] of players) {
      if (otherSocket !== socket && otherPlayer.system_id === oldSystemId && !otherPlayer.docked && otherSocket.readyState === WebSocket.OPEN) {
        otherSocket.send(JSON.stringify({ type: 'PLAYER_LEFT', userId: player.userId }));
      }
    }
  }

  socket.send(JSON.stringify({
    type: 'ARENA_LEFT',
    system_id: player.system_id,
    returnSystemId: player.system_id,
    serverTime: Date.now()
  }));
  socket.send(JSON.stringify({
    type: 'WELCOME',
    system_id: player.system_id,
    x: player.x,
    y: player.y,
    rot: player.rot,
    vx: player.vx,
    vy: player.vy,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    server_id: SERVER_ID
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);
}

async function handleArenaReady(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId) return;
  if (!player.arenaState?.inArena) return;

  player.arenaState.awaitingReady = false;
  player.vx = 0;
  player.vy = 0;
  player.lastSpaceTelemetry = { x: player.x, y: player.y, rot: player.rot, vx: 0, vy: 0 };
  markPlayerDirty(player, ["telemetry"]);

  socket.send(JSON.stringify({
    type: 'ARENA_READY_ACK',
    instanceId: player?.arenaState?.instanceId || null,
    system_id: player.system_id,
    serverTime: Date.now()
  }));
}

async function handleArenaEnter(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  if (!player || !userId || player.userId !== userId || player.docked) return;

  const oldSystemId = player.system_id;
  const returnSnapshot = {
    system_id: player.system_id,
    x: finiteNum(player.x, 0),
    y: finiteNum(player.y, 0),
    rot: finiteNum(player.rot, 0),
    vx: finiteNum(player.vx, 0),
    vy: finiteNum(player.vy, 0),
    starport_id: player.starport_id || null,
    docked: false
  };

  try {
    await persistArenaReturnSnapshot(player.userId, returnSnapshot);
  } catch (e) {
    console.warn('[Arena] snapshot persist failed:', player.userId, e?.message || e);
    socket.send(JSON.stringify({
      type: 'ARENA_JOIN_FAILED',
      reason: String(e?.message || 'snapshot_persist_failed'),
      serverTime: Date.now()
    }));
    return;
  }

  const instance = getOrCreateArenaInstance();
  const spawn = movePlayerToArenaInstance(player, instance);
  player.arenaReturnSnapshot = returnSnapshot;
  if (player.arenaState) player.arenaState.returnSnapshot = returnSnapshot;
  markPlayerDirty(player, ["ship", "telemetry"]);

  try {
    const { error: enterErr } = await supabase
      .from("ship_states_v2")
      .upsert({
        player_id: player.userId,
        system_id: player.system_id,
        starport_id: null,
        telemetry: telemetrySnapshot(player),
        arena_return_snapshot: returnSnapshot,
        updated_at: nowIso()
      }, { onConflict: "player_id" });

    if (enterErr) {
      console.warn("[Arena] arena enter persist failed:", player.userId, enterErr.message);
    } else {
      const { data: postEnterRow, error: postEnterErr } = await supabase
        .from("ship_states_v2")
        .select("player_id, system_id, arena_return_snapshot, updated_at")
        .eq("player_id", player.userId)
        .maybeSingle();

      if (postEnterErr) {
        console.warn("[Arena] post-enter verify failed:", player.userId, postEnterErr.message);
      } else {
        console.log("[Arena] post-enter row:", postEnterRow);
      }
    }
  } catch (e) {
    console.warn("[Arena] arena enter persist exception:", player.userId, e?.message || e);
  }

  if (oldSystemId && oldSystemId !== player.system_id) {
    for (const [otherSocket, otherPlayer] of players) {
      if (otherSocket !== socket && otherPlayer.system_id === oldSystemId && !otherPlayer.docked && otherSocket.readyState === WebSocket.OPEN) {
        otherSocket.send(JSON.stringify({ type: 'PLAYER_LEFT', userId: player.userId }));
      }
    }
  }

  socket.send(JSON.stringify({
    type: 'ARENA_JOINED',
    instanceId: instance.instanceId,
    system_id: player.system_id,
    spawn,
    serverTime: Date.now()
  }));
  socket.send(JSON.stringify({
    type: 'WELCOME',
    system_id: player.system_id,
    x: player.x,
    y: player.y,
    rot: player.rot,
    vx: player.vx,
    vy: player.vy,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    server_id: SERVER_ID
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);
}

// -----------------------------------------------------
// HELLO HANDLER — DOCKED VS SPACE (SINGLE SOURCE OF TRUTH)
// -----------------------------------------------------
async function handleHello(socket, data) {
  console.log("Client handshake:", data);

  const userId = data.userId;
  if (!userId) {
    console.log("HELLO missing userId");
    return;
  }

  const defaultStarport = normalizeStarportId("cygnus_prime_starport");
  const defaultSystem = "cygnus-prime";
  const activeSyndicateId = await loadPlayerActiveSyndicateId(userId);

  let state = await loadShipState(userId);
  state = await recoverArenaPlayerIfNeeded(userId, state);

  // New player
  if (!state) {
    await ensureDefaultShipStateV2(userId);

    players.set(socket, {
      userId,
      ship_type: "OMNI SCOUT",
      system_id: defaultSystem,
      docked: true,
      x: 0,
      y: 0,
      rot: 0,
      vx: 0,
      vy: 0,
      lastSpaceTelemetry: null,
      starport_id: defaultStarport,
      destroyed: false,
      syndicate_id: activeSyndicateId,

      hp: 100, maxHp: 100,
      shields: 0, maxShields: 0,
      energy: 100, maxEnergy: 100,
      fittings: sanitizeRuntimeFittings(state?.fittings, state?.ship_type || state?.shipType || 'ship_omni_scout'),
      visual_config: sanitizeRuntimeVisualConfig(state?.visual_config),
      animation_state: sanitizeRuntimeAnimationState(state?.telemetry?.animation_state),

      _dirty: false,
      _dirtySections: createDirtySections(),
      _lastPersistAt: 0,
      _lastBroadcastAt: 0,
      validatedLocks: { hostile: null, friendly: null },
      validatedLock: null
    });

    applyHydratedPlayerCombatStats(players.get(socket), { preserveCurrent: true });

    console.log(`[Backend] ${userId} default-spawn docked at ${defaultSystem}`);

    socket.send(JSON.stringify({
      type: "DOCKED",
      starport_id: defaultStarport,
      hp: players.get(socket)?.hp,
      maxHp: players.get(socket)?.maxHp,
      shields: players.get(socket)?.shields,
      maxShields: players.get(socket)?.maxShields,
      energy: players.get(socket)?.energy,
      maxEnergy: players.get(socket)?.maxEnergy,
      armor: players.get(socket)?.armor,
      resistances: players.get(socket)?.resistances || {},
      combat_stats: players.get(socket)?.combatStats || null,
      fittings: players.get(socket)?.fittings || {}
    }));
    await sendCommanderState(socket, userId);
    return;
  }

  console.log("[HELLO STATE]", {
    userId,
    system_id: state.system_id,
    starport_id: state.starport_id,
    telemetry: state.telemetry,
    hull: state.hull,
    shields: state.shields,
    energy: state.energy,
    fittings: state.fittings || {},
    max_hp: state.max_hp ?? state.maxHp ?? null,
    max_shields: state.max_shields ?? state.maxShields ?? null,
    max_energy: state.max_energy ?? state.maxEnergy ?? null,
    ship_type: state.ship_type || state.shipType || null,
    updated_at: state.updated_at
  });

  const sys = state.system_id || defaultSystem;
  const persistedStarportId = normalizeStarportId(state.starport_id);
  const persistedHull = Number(state.hull);
  const shouldForceDestroyedDock = !persistedStarportId && persistedHull <= 0 && !isArenaSystemId(sys) && !isBattlegroundSystemId(sys);

  if (shouldForceDestroyedDock) {
    players.set(socket, {
      userId,
      ship_type: normalizeCanonicalShipId(state?.ship_type || state?.shipType || 'ship_omni_scout') || 'ship_omni_scout',
      system_id: defaultSystem,
      docked: true,
      x: 0,
      y: 0,
      rot: 0,
      vx: 0,
      vy: 0,
      lastSpaceTelemetry: (state.telemetry && typeof state.telemetry === "object") ? state.telemetry : null,
      starport_id: defaultStarport,
      destroyed: true,
      syndicate_id: activeSyndicateId,

      hp: state.hull ?? 0,
      maxHp: state.maxHp ?? 100,
      shields: state.shields ?? 0,
      maxShields: state.maxShields ?? 0,
      energy: state.energy ?? 100,
      maxEnergy: state.maxEnergy ?? 100,
      fittings: sanitizeRuntimeFittings(state?.fittings, state?.ship_type || state?.shipType || 'ship_omni_scout'),
      visual_config: sanitizeRuntimeVisualConfig(state?.visual_config),
      animation_state: sanitizeRuntimeAnimationState(state?.telemetry?.animation_state),

      _dirty: false,
      _dirtySections: createDirtySections(),
      _lastPersistAt: 0,
      _lastBroadcastAt: 0,
      validatedLocks: { hostile: null, friendly: null },
      validatedLock: null
    });

    const respawnResult = await finalizeHomeStarportRespawn(players.get(socket), defaultStarport);

    console.log(`[Backend] ${userId} recovered from destroyed normal-space state -> docked at ${respawnResult?.starport_id || defaultStarport}`);

    socket.send(JSON.stringify({
      type: "DOCKED",
      system_id: respawnResult?.system_id || defaultSystem,
      starport_id: respawnResult?.starport_id || defaultStarport,
      hp: players.get(socket)?.hp,
      maxHp: players.get(socket)?.maxHp,
      shields: players.get(socket)?.shields,
      maxShields: players.get(socket)?.maxShields,
      energy: players.get(socket)?.energy,
      maxEnergy: players.get(socket)?.maxEnergy,
      armor: players.get(socket)?.armor,
      resistances: players.get(socket)?.resistances || {},
      combat_stats: players.get(socket)?.combatStats || null,
      fittings: players.get(socket)?.fittings || {}
    }));
    await sendCommanderState(socket, userId);
    return;
  }

  // If DB says docked, respect that.
  if (persistedStarportId) {
    players.set(socket, {
      userId,
      ship_type: normalizeCanonicalShipId(state?.ship_type || state?.shipType || 'ship_omni_scout') || 'ship_omni_scout',
      system_id: sys,
      docked: true,
      x: 0,
      y: 0,
      rot: 0,
      vx: 0,
      vy: 0,
      lastSpaceTelemetry: (state.telemetry && typeof state.telemetry === "object") ? state.telemetry : null,
      starport_id: persistedStarportId,
      destroyed: false,
      syndicate_id: activeSyndicateId,

      // keep vitals in memory too
      hp: state.hull ?? 100,
      maxHp: state.maxHp ?? 100,
      shields: state.shields ?? 0,
      maxShields: state.maxShields ?? 0,
      energy: state.energy ?? 100,
      maxEnergy: state.maxEnergy ?? 100,
      fittings: sanitizeRuntimeFittings(state?.fittings, state?.ship_type || state?.shipType || 'ship_omni_scout'),
      visual_config: sanitizeRuntimeVisualConfig(state?.visual_config),
      animation_state: sanitizeRuntimeAnimationState(state?.telemetry?.animation_state),

      _dirty: false,
      _dirtySections: createDirtySections(),
      _lastPersistAt: 0,
      _lastBroadcastAt: 0,
      validatedLocks: { hostile: null, friendly: null },
      validatedLock: null
    });

    await hydratePlayerFromCommanderActiveShip(players.get(socket), { fillVitals: true, persistState: false });

    console.log(`[Backend] ${userId} is docked at ${persistedStarportId}`);

    socket.send(JSON.stringify({
      type: "DOCKED",
      starport_id: persistedStarportId,
      hp: players.get(socket)?.hp,
      maxHp: players.get(socket)?.maxHp,
      shields: players.get(socket)?.shields,
      maxShields: players.get(socket)?.maxShields,
      energy: players.get(socket)?.energy,
      maxEnergy: players.get(socket)?.maxEnergy,
      armor: players.get(socket)?.armor,
      resistances: players.get(socket)?.resistances || {},
      combat_stats: players.get(socket)?.combatStats || null,
      fittings: players.get(socket)?.fittings || {}
    }));
    await sendCommanderState(socket, userId);
    return;
  }

  // Otherwise try to resume in space if telemetry has coords.
  const tx = Number(state.telemetry?.x);
  const ty = Number(state.telemetry?.y);
  const trot = Number(state.telemetry?.rot ?? 0);
  const tvx = Number(state.telemetry?.vx ?? 0);
  const tvy = Number(state.telemetry?.vy ?? 0);

  const hasTelemetry = Number.isFinite(tx) && Number.isFinite(ty);

  if (hasTelemetry) {
    const snap = {
      x: tx,
      y: ty,
      rot: Number.isFinite(trot) ? trot : 0,
      vx: Number.isFinite(tvx) ? tvx : 0,
      vy: Number.isFinite(tvy) ? tvy : 0
    };

    players.set(socket, {
      userId,
      ship_type: normalizeCanonicalShipId(state?.ship_type || state?.shipType || 'ship_omni_scout') || 'ship_omni_scout',
      system_id: sys,
      docked: false,
      x: snap.x,
      y: snap.y,
      rot: snap.rot,
      vx: snap.vx,
      vy: snap.vy,
      lastSpaceTelemetry: snap,
      destroyed: false,
      syndicate_id: activeSyndicateId,

      // runtime vitals
      hp: state.hull ?? 100,
      maxHp: state.maxHp ?? 100,
      shields: state.shields ?? 0,
      maxShields: state.maxShields ?? 0,
      energy: state.energy ?? 100,
      maxEnergy: state.maxEnergy ?? 100,
      fittings: sanitizeRuntimeFittings(state?.fittings, state?.ship_type || state?.shipType || 'ship_omni_scout'),
      visual_config: sanitizeRuntimeVisualConfig(state?.visual_config),
      animation_state: sanitizeRuntimeAnimationState(state?.telemetry?.animation_state),

      _dirty: false,
      _dirtySections: createDirtySections(),
      _lastPersistAt: 0,
      _lastBroadcastAt: 0,
      validatedLocks: { hostile: null, friendly: null },
      validatedLock: null
    });

    const resumedPlayer = players.get(socket);
    const runtimeFittings = resumedPlayer?.fittings && typeof resumedPlayer.fittings === 'object' ? resumedPlayer.fittings : {};
    if (resumedPlayer && Object.keys(runtimeFittings).filter((slotId) => runtimeFittings[slotId]).length <= 0) {
      const preservedHp = resumedPlayer.hp;
      const preservedShields = resumedPlayer.shields;
      const preservedEnergy = resumedPlayer.energy;
      await hydratePlayerFromCommanderActiveShip(resumedPlayer, { fillVitals: false, persistState: false });
      resumedPlayer.hp = Math.max(0, Math.min(finiteNum(preservedHp, resumedPlayer.hp), resumedPlayer.maxHp || preservedHp || 0));
      resumedPlayer.shields = Math.max(0, Math.min(finiteNum(preservedShields, resumedPlayer.shields), resumedPlayer.maxShields || preservedShields || 0));
      resumedPlayer.energy = Math.max(0, Math.min(finiteNum(preservedEnergy, resumedPlayer.energy), resumedPlayer.maxEnergy || preservedEnergy || 0));
    }

    applyHydratedPlayerCombatStats(players.get(socket), { sourceState: state, preserveCurrent: true });

    console.log(`[Backend] ${userId} resumed in space @ (${tx}, ${ty}) sys=${sys}`);

    // ✅ Include vitals in welcome so client doesn't default to full on reconnect
    socket.send(JSON.stringify({
      type: "WELCOME",
      system_id: sys,
      x: snap.x,
      y: snap.y,
      rot: snap.rot,
      vx: snap.vx,
      vy: snap.vy,

      hp: players.get(socket)?.hp ?? state.hull ?? 100,
      maxHp: players.get(socket)?.maxHp ?? state.maxHp ?? 100,
      shields: players.get(socket)?.shields ?? state.shields ?? 0,
      maxShields: players.get(socket)?.maxShields ?? state.maxShields ?? 0,
      energy: players.get(socket)?.energy ?? state.energy ?? 100,
      maxEnergy: players.get(socket)?.maxEnergy ?? state.maxEnergy ?? 100,
      armor: players.get(socket)?.armor,
      resistances: players.get(socket)?.resistances || {},
      combat_stats: players.get(socket)?.combatStats || null,
      fittings: players.get(socket)?.fittings || {},

      server_id: SERVER_ID
    }));
    await sendCommanderState(socket, userId);
    return;
  }

  // Fallback: if no telemetry and not docked, still dock rather than WELCOME 0,0
  players.set(socket, {
    userId,
    system_id: defaultSystem,
    docked: true,
    x: 0, y: 0, rot: 0, vx: 0, vy: 0,
    lastSpaceTelemetry: null,
    starport_id: defaultStarport,
    destroyed: false,
    syndicate_id: activeSyndicateId,

    hp: state.hull ?? 100,
    maxHp: state.maxHp ?? 100,
    shields: state.shields ?? 0,
    maxShields: state.maxShields ?? 0,
    energy: state.energy ?? 100,
    maxEnergy: state.maxEnergy ?? 100,

    _dirty: false,
    _dirtySections: createDirtySections(),
    _lastPersistAt: 0,
    _lastBroadcastAt: 0,
    validatedLocks: { hostile: null, friendly: null },
    validatedLock: null
  });

  applyHydratedPlayerCombatStats(players.get(socket), { sourceState: state, preserveCurrent: true });

  console.log(`[Backend] ${userId} missing telemetry; fallback docked at ${defaultSystem}`);

  socket.send(JSON.stringify({
    type: "DOCKED",
    starport_id: defaultStarport,
    hp: players.get(socket)?.hp,
    maxHp: players.get(socket)?.maxHp,
    shields: players.get(socket)?.shields,
    maxShields: players.get(socket)?.maxShields,
    energy: players.get(socket)?.energy,
    maxEnergy: players.get(socket)?.maxEnergy,
    armor: players.get(socket)?.armor,
    resistances: players.get(socket)?.resistances || {},
    combat_stats: players.get(socket)?.combatStats || null
  }));
  await sendCommanderState(socket, userId);
}

// -----------------------------------------------------
// DOCK — mark player docked + save last space snapshot + persist vitals
// IMPORTANT: DO NOT hard-fail if Supabase is down.
// -----------------------------------------------------

async function handleRespawnHomeStarport(socket, data) {
  const player = players.get(socket);
  const userId = String(data?.userId || player?.userId || '').trim();
  const requestId = data?.requestId || null;
  if (!player || !userId || player.userId !== userId) return;

  const commander = await loadCommanderDataRow(userId);
  const requestedStarportId = normalizeStarportId(data?.starport_id || commander?.home_starport || player.starport_id || 'cygnus_prime_starport');
  const respawnResult = await finalizeHomeStarportRespawn(player, requestedStarportId);

  socket.send(JSON.stringify({
    type: 'DOCKED',
    system_id: respawnResult?.system_id || resolveSystemIdForStarport(requestedStarportId),
    starport_id: respawnResult?.starport_id || requestedStarportId,
    hp: player?.hp,
    maxHp: player?.maxHp,
    shields: player?.shields,
    maxShields: player?.maxShields,
    energy: player?.energy,
    maxEnergy: player?.maxEnergy,
    armor: player?.armor,
    resistances: player?.resistances || {},
    combat_stats: player?.combatStats || null,
    fittings: player?.fittings || {}
  }));

  socket.send(JSON.stringify({
    type: 'RESPAWN_HOME_RESULT',
    requestId,
    ok: !!respawnResult?.ok,
    error: respawnResult?.ok ? null : (respawnResult?.error || 'respawn_failed'),
    system_id: respawnResult?.system_id || resolveSystemIdForStarport(requestedStarportId),
    starport_id: respawnResult?.starport_id || requestedStarportId,
    serverTime: Date.now()
  }));

  await sendCommanderState(socket, userId, requestId);
}

async function handleDock(socket, data) {
  const player = players.get(socket);
  if (!player) return;

  const starport_id = normalizeStarportId(data.starport_id);
  if (!starport_id) return;

  const currentSystemId = player.system_id || "cygnus-prime";

  // Capture the best available pre-dock in-space snapshot.
  // Prefer the server runtime state, then server memory snapshot, then client payload.
  const nx = Number(data.x);
  const ny = Number(data.y);
  const nr = Number(data.rot);
  const nvx = Number(data.vx);
  const nvy = Number(data.vy);

  const snapshot = {
    system_id: currentSystemId,
    x: Number.isFinite(player.x) ? player.x : undefined,
    y: Number.isFinite(player.y) ? player.y : undefined,
    rot: Number.isFinite(player.rot) ? player.rot : undefined,
    vx: Number.isFinite(player.vx) ? player.vx : undefined,
    vy: Number.isFinite(player.vy) ? player.vy : undefined
  };

  if (!Number.isFinite(snapshot.x) || !Number.isFinite(snapshot.y)) {
    const memory = player.lastSpaceTelemetry || {};
    if (Number.isFinite(memory.x) && Number.isFinite(memory.y)) {
      snapshot.x = memory.x;
      snapshot.y = memory.y;
      snapshot.rot = Number.isFinite(memory.rot) ? memory.rot : snapshot.rot;
      snapshot.vx = Number.isFinite(memory.vx) ? memory.vx : snapshot.vx;
      snapshot.vy = Number.isFinite(memory.vy) ? memory.vy : snapshot.vy;
      snapshot.system_id = memory.system_id || snapshot.system_id;
    }
  }

  if (!Number.isFinite(snapshot.x) || !Number.isFinite(snapshot.y)) {
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      snapshot.x = nx;
      snapshot.y = ny;
      snapshot.rot = Number.isFinite(nr) ? nr : (snapshot.rot ?? 0);
      snapshot.vx = Number.isFinite(nvx) ? nvx : (snapshot.vx ?? 0);
      snapshot.vy = Number.isFinite(nvy) ? nvy : (snapshot.vy ?? 0);
    }
  }

  const snapshotSystemId = snapshot.system_id || currentSystemId;
  const snapshotIsInstanced = isInstancedSystemId(snapshotSystemId);

  if (Number.isFinite(snapshot.x) && Number.isFinite(snapshot.y) && !snapshotIsInstanced) {
    player.lastSpaceTelemetry = {
      system_id: snapshotSystemId,
      x: snapshot.x,
      y: snapshot.y,
      rot: Number.isFinite(snapshot.rot) ? snapshot.rot : 0,
      vx: Number.isFinite(snapshot.vx) ? snapshot.vx : 0,
      vy: Number.isFinite(snapshot.vy) ? snapshot.vy : 0
    };

    console.log('[DOCK] saving snapshot', player.lastSpaceTelemetry);
  } else if (snapshotIsInstanced) {
    console.log('[DOCK] skipping snapshot (instance system)', {
      userId: player.userId,
      system_id: snapshotSystemId,
      x: snapshot.x,
      y: snapshot.y
    });
  } else {
    console.warn('[DOCK] saving snapshot skipped: no valid in-space snapshot', {
      userId: player.userId,
      system_id: currentSystemId,
      playerX: player.x,
      playerY: player.y,
      clientX: nx,
      clientY: ny
    });
  }

  // Vitals are authoritative on the server (EC2). Do not trust client vitals on DOCK.

  const oldSystemId = player.system_id;
  player.docked = true;
  player.destroyed = false;
  player.starport_id = starport_id;
  console.log(`[Commander][Dock] user=${player.userId} docked=true starport_id=${player.starport_id}`);
  clearValidatedLock(player);

  // Persist starport_id; keep telemetry as "last space position"
  try {
    const memoryDockSnapshot = (player.lastSpaceTelemetry && Number.isFinite(player.lastSpaceTelemetry.x) && Number.isFinite(player.lastSpaceTelemetry.y) && !isInstancedSystemId(player.lastSpaceTelemetry.system_id))
      ? player.lastSpaceTelemetry
      : null;
    const liveDockSnapshot = !isInstancedSystemId(player.system_id)
      ? telemetrySnapshot(player)
      : null;
    const dockSnapshot = memoryDockSnapshot || liveDockSnapshot || null;
    const payload = {
      player_id: player.userId,
      ship_type: player.ship_type || "OMNI SCOUT",
      system_id: dockSnapshot?.system_id || player.system_id || "cygnus-prime",
      starport_id,
      telemetry: dockSnapshot || undefined,
      hull: typeof player.hp === "number" ? player.hp : undefined,
      maxHp: typeof player.maxHp === "number" ? player.maxHp : undefined,
      shields: typeof player.shields === "number" ? player.shields : undefined,
      maxShields: typeof player.maxShields === "number" ? player.maxShields : undefined,
      energy: typeof player.energy === "number" ? player.energy : undefined,
      maxEnergy: typeof player.maxEnergy === "number" ? player.maxEnergy : undefined,
      updated_at: nowIso()
    };
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const { error } = await supabase
      .from("ship_states_v2")
      .upsert({ ...payload, arena_return_snapshot: null }, { onConflict: "player_id" });

    if (error) console.warn("[Backend] Persist DOCK failed:", error.message);
    else {
      await persistActiveShipToHangar(player);
      console.log(`[Backend] ${player.userId} docked at ${starport_id} (saved last space snapshot)`);
    }
  } catch (e) {
    console.warn("[Backend] Persist DOCK exception:", e?.message || e);
  }

  if (oldSystemId) {
    broadcastPlayerLeftForSystem(oldSystemId, player.userId, socket);
  }

  socket.send(JSON.stringify({
    type: "DOCKED",
    starport_id,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    armor: player.armor,
    resistances: player.resistances || {},
    combat_stats: player.combatStats || null
  }));
  await sendCommanderState(socket, player.userId);
}

// -----------------------------------------------------
// UNDOCK — flips the player to space authoritative mode
// Uses: client coords > server memory snapshot > DB telemetry > fallback
// -----------------------------------------------------
async function handleUndock(socket, data) {
  const player = players.get(socket);
  if (!player) return;

  const nx = Number(data.x);
  const ny = Number(data.y);
  const nr = Number(data.rot);

  let state = null;
  let snapshot = null;
  let x, y, rot, vx, vy;
  let system_id = player.system_id || data.system_id || "cygnus-prime";

  console.log('[UNDOCK] before', {
    userId: player.userId,
    docked: !!player.docked,
    playerSystemId: player.system_id || null,
    requestedSystemId: data.system_id || null,
    memorySnapshot: player.lastSpaceTelemetry || null,
    hp: player.hp,
    shields: player.shields,
    energy: player.energy,
    fittings: player.fittings || null
  });

  // 1) Prefer server memory snapshot (works even if Supabase is down)
  const memory = player.lastSpaceTelemetry;
  if (memory && Number.isFinite(memory.x) && Number.isFinite(memory.y)) {
    if (isInstancedSystemId(memory.system_id)) {
      console.warn('[UNDOCK WARNING] ignoring instanced memory snapshot', {
        userId: player.userId,
        snapshotSystemId: memory.system_id
      });
    } else {
      snapshot = memory;
      system_id = memory.system_id || system_id;
      x = memory.x;
      y = memory.y;
      rot = Number.isFinite(memory.rot) ? memory.rot : 0;
      vx = Number.isFinite(memory.vx) ? memory.vx : 0;
      vy = Number.isFinite(memory.vy) ? memory.vy : 0;
    }
  }

  // 2) Otherwise load from DB telemetry
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    state = await loadShipState(player.userId);
    const dbTelemetry = state?.telemetry;
    const tx = Number(dbTelemetry?.x);
    const ty = Number(dbTelemetry?.y);
    const trot = Number(dbTelemetry?.rot ?? 0);
    const tvx = Number(dbTelemetry?.vx ?? 0);
    const tvy = Number(dbTelemetry?.vy ?? 0);

    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      const dbSystemId = dbTelemetry?.system_id || state?.system_id || system_id;
      if (isInstancedSystemId(dbSystemId)) {
        console.warn('[UNDOCK WARNING] ignoring instanced DB snapshot', {
          userId: player.userId,
          snapshotSystemId: dbSystemId
        });
      } else {
        snapshot = dbTelemetry;
        system_id = dbSystemId;
        x = tx;
        y = ty;
        rot = Number.isFinite(trot) ? trot : 0;
        vx = Number.isFinite(tvx) ? tvx : 0;
        vy = Number.isFinite(tvy) ? tvy : 0;
      }
    }
  }

  // 3) Final client/fallback path only if no saved snapshot exists
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      x = nx;
      y = ny;
      rot = Number.isFinite(nr) ? nr : 0;
      vx = 0;
      vy = 0;
      system_id = data.system_id || system_id;
      console.warn('[UNDOCK WARNING] snapshot missing; using client undock coords', {
        userId: player.userId,
        requestedSystemId: data.system_id || null
      });
    } else {
      x = 150;
      y = 150;
      rot = 0;
      vx = 0;
      vy = 0;
      console.warn('[UNDOCK WARNING] snapshot missing; using fallback spawn', {
        userId: player.userId,
        requestedSystemId: data.system_id || null
      });
    }
  }

  const preservedFittings = sanitizeRuntimeFittings(player.fittings || state?.fittings || {}, player.ship_type || state?.ship_type || state?.shipType || 'ship_omni_scout');

  player.docked = false;
  player.destroyed = false;
  player.starport_id = null;
  console.log(`[Commander][Undock] user=${player.userId} docked=false starport_id=${player.starport_id}`);
  player.system_id = system_id;
  player.x = x;
  player.y = y;
  player.rot = rot;
  player.vx = Number.isFinite(vx) ? vx : 0;
  player.vy = Number.isFinite(vy) ? vy : 0;
  player.fittings = preservedFittings;

  // Sync the currently selected docked ship's live vitals into its hangar record before
  // hydrate/undock reloads from hangar state. This prevents stale ship_config HP from
  // overriding freshly repaired or recently changed docked vitals on undock.
  await persistActiveShipToHangar(player, {
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    fittings: player.fittings
  });

  // Rebuild fittings/combat stats and vitals from the selected active ship instance.
  await hydratePlayerFromCommanderActiveShip(player, { fillVitals: false, persistState: false });

  player.fittings = sanitizeRuntimeFittings(player.fittings || preservedFittings || {}, player.ship_type || state?.ship_type || state?.shipType || 'ship_omni_scout');

  const hydratedHp = finiteNum(player.hp, finiteNum(player.maxHp, 0));
  const hydratedShields = finiteNum(player.shields, finiteNum(player.maxShields, 0));
  const hydratedEnergy = finiteNum(player.energy, finiteNum(player.maxEnergy, 0));
  const hydratedStateWasDestroyed = Number.isFinite(hydratedHp) && hydratedHp <= 0;
  if (hydratedStateWasDestroyed) {
    player.hp = Math.max(0, finiteNum(player.maxHp, 0));
    player.shields = Math.max(0, finiteNum(player.maxShields, 0));
    player.energy = Math.max(0, finiteNum(player.maxEnergy, 0));
    console.log('[UNDOCK] restored vitals from destroyed hydrated ship state', {
      userId: player.userId,
      hydratedHp,
      restoredHp: player.hp,
      restoredShields: player.shields,
      restoredEnergy: player.energy
    });
  } else {
    player.hp = Math.max(0, Math.min(hydratedHp, finiteNum(player.maxHp, hydratedHp)));
    player.shields = Math.max(0, Math.min(hydratedShields, finiteNum(player.maxShields, hydratedShields)));
    player.energy = Math.max(0, Math.min(hydratedEnergy, finiteNum(player.maxEnergy, hydratedEnergy)));
  }

  console.log('[UNDOCK] afterCombatStats', {
    userId: player.userId,
    system_id: player.system_id,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    fittings: player.fittings || null,
    combat_stats: player.combatStats || null
  });

  // update in-memory snapshot too
  player.lastSpaceTelemetry = { system_id, x, y, rot, vx: player.vx, vy: player.vy };
  clearValidatedLock(player);

  // Persist undock snapshot + clear dock marker (best-effort)
  try {
    const { error } = await supabase
      .from("ship_states_v2")
      .upsert(
        {
          player_id: player.userId,
          system_id,
          starport_id: null,
          telemetry: { system_id, x, y, rot, vx: player.vx, vy: player.vy },
          hull: typeof player.hp === 'number' ? player.hp : undefined,
          maxHp: typeof player.maxHp === 'number' ? player.maxHp : undefined,
          shields: typeof player.shields === 'number' ? player.shields : undefined,
          maxShields: typeof player.maxShields === 'number' ? player.maxShields : undefined,
          energy: typeof player.energy === 'number' ? player.energy : undefined,
          maxEnergy: typeof player.maxEnergy === 'number' ? player.maxEnergy : undefined,
          fittings: player.fittings || {},
          arena_return_snapshot: null,
          updated_at: nowIso()
        },
        { onConflict: "player_id" }
      );

    if (error) console.warn("[Backend] Failed to persist UNDOCK:", error.message);
    else await persistActiveShipToHangar(player);
  } catch (e) {
    console.warn("[Backend] Persist UNDOCK exception:", e?.message || e);
  }

  socket.send(JSON.stringify({
    type: "WELCOME",
    system_id,
    x,
    y,
    rot,
    vx: player.vx,
    vy: player.vy,

    // ✅ include current vitals
    hp: typeof player.hp === "number" ? player.hp : 100,
    maxHp: typeof player.maxHp === "number" ? player.maxHp : 100,
    shields: typeof player.shields === "number" ? player.shields : 0,
    maxShields: typeof player.maxShields === "number" ? player.maxShields : 0,
    energy: typeof player.energy === "number" ? player.energy : 100,
    maxEnergy: typeof player.maxEnergy === "number" ? player.maxEnergy : 100,
    armor: player.armor,
    resistances: player.resistances || {},
    combat_stats: player.combatStats || null,
    fittings: player.fittings || {},

    server_id: SERVER_ID
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);

  const others = [];
  for (const [otherSocket, otherPlayer] of players) {
    if (
      otherSocket !== socket &&
      otherPlayer.system_id === player.system_id &&
      !otherPlayer.docked
    ) {
      others.push({
        userId: otherPlayer.userId,
        x: otherPlayer.x,
        y: otherPlayer.y,
        rot: otherPlayer.rot,
        vx: otherPlayer.vx,
        vy: otherPlayer.vy,
        hp: otherPlayer.hp,
        maxHp: otherPlayer.maxHp,
        shields: otherPlayer.shields,
        maxShields: otherPlayer.maxShields,
        energy: otherPlayer.energy,
        maxEnergy: otherPlayer.maxEnergy,
        fittings: otherPlayer.fittings || {},
        visual_config: otherPlayer.visual_config || null,
        animation_state: otherPlayer.animation_state || null,
        armor: otherPlayer.armor,
        resistances: otherPlayer.resistances || {},
        combat_stats: otherPlayer.combatStats || null
      });
    }
  }

  socket.send(JSON.stringify({
    type: "INITIAL_PLAYERS",
    players: others
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);
  const npcRegistry = npcStatesBySystem.get(player.system_id);
  const npcs = npcRegistry ? Array.from(npcRegistry.values()).map((npc) => ({
    id: npc.id,
    x: npc.x,
    y: npc.y,
    rot: finiteNum(npc.rot, 0),
    hp: npc.hp,
    maxHp: npc.maxHp,
    shields: npc.shields,
    maxShields: npc.maxShields,
    classId: npc.classId || null,
    loadoutId: npc.classId || null,
    shipType: npc.shipType || null,
    instanceId: npc.battlegroundInstanceId || null,
    waveNumber: npc.battlegroundWave || 0,
    npcType: npc.battlegroundNpcType || null,
    runtimeContext: npc.runtimeContext || null
  })) : [];
  socket.send(JSON.stringify({ type: 'INITIAL_NPCS', system_id: player.system_id, npcs, serverTime: Date.now() }));
  await sendSystemStructures(socket, player.system_id);
  const battlegroundInst = findBattlegroundInstanceBySystemId(player.system_id);
  if (battlegroundInst) sendBattlegroundState(battlegroundInst, { statusLabel: battlegroundInst.statusLabel, waveNumber: battlegroundInst.phase === 'countdown' ? battlegroundInst.pendingWaveNumber : battlegroundInst.currentWave, countdownRemaining: battlegroundInst.countdownEndsAt ? Math.max(0, (battlegroundInst.countdownEndsAt - Date.now()) / 1000) : undefined });

  broadcastPlayerPresenceUpdate(player, socket);
  console.log('[UNDOCK] finalState', {
    userId: player.userId,
    system_id: player.system_id,
    x: player.x,
    y: player.y,
    rot: player.rot,
    vx: player.vx,
    vy: player.vy,
    hp: player.hp,
    maxHp: player.maxHp,
    shields: player.shields,
    maxShields: player.maxShields,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    fittings: player.fittings || null,
    combat_stats: player.combatStats || null
  });
  console.log(`[Backend] ${player.userId} undocked into ${system_id} @ (${x}, ${y})`);
}

// -----------------------------------------------------
// JOIN SYSTEM
// -----------------------------------------------------
async function handleJoinSystem(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked) return;
  if (!data.system_id) return;

  player.system_id = data.system_id;
  if (!isArenaSystemId(player.system_id)) {
    removePlayerFromArenaInstances(player.userId);
    if (player.arenaState) player.arenaState.inArena = false;
  }
  console.log(`Player ${player.userId} joined system ${player.system_id}`);

  const others = [];
  for (const [otherSocket, otherPlayer] of players) {
    if (
      otherSocket !== socket &&
      otherPlayer.system_id === player.system_id &&
      !otherPlayer.docked
    ) {
      others.push({
        userId: otherPlayer.userId,
        x: otherPlayer.x,
        y: otherPlayer.y,
        rot: otherPlayer.rot,
        vx: otherPlayer.vx,
        vy: otherPlayer.vy,
        hp: otherPlayer.hp,
        maxHp: otherPlayer.maxHp,
        shields: otherPlayer.shields,
        maxShields: otherPlayer.maxShields,
        energy: otherPlayer.energy,
        maxEnergy: otherPlayer.maxEnergy,
        fittings: otherPlayer.fittings || {},
        visual_config: otherPlayer.visual_config || null,
        animation_state: otherPlayer.animation_state || null,
        armor: otherPlayer.armor,
        resistances: otherPlayer.resistances || {},
        combat_stats: otherPlayer.combatStats || null
      });
    }
  }

  socket.send(JSON.stringify({
    type: "INITIAL_PLAYERS",
    players: others
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);
  broadcastPlayerPresenceUpdate(player, socket);
  const npcRegistry = npcStatesBySystem.get(player.system_id);
  const npcs = npcRegistry ? Array.from(npcRegistry.values()).map((npc) => ({
    id: npc.id,
    x: npc.x,
    y: npc.y,
    rot: finiteNum(npc.rot, 0),
    hp: npc.hp,
    maxHp: npc.maxHp,
    shields: npc.shields,
    maxShields: npc.maxShields,
    classId: npc.classId || null,
    loadoutId: npc.classId || null,
    shipType: npc.shipType || null,
    instanceId: npc.battlegroundInstanceId || null,
    waveNumber: npc.battlegroundWave || 0,
    npcType: npc.battlegroundNpcType || null,
    runtimeContext: npc.runtimeContext || null
  })) : [];
  socket.send(JSON.stringify({ type: 'INITIAL_NPCS', system_id: player.system_id, npcs, serverTime: Date.now() }));
  await sendSystemStructures(socket, player.system_id);
  const battlegroundInst = findBattlegroundInstanceBySystemId(player.system_id);
  if (battlegroundInst) sendBattlegroundState(battlegroundInst, { statusLabel: battlegroundInst.statusLabel, waveNumber: battlegroundInst.phase === 'countdown' ? battlegroundInst.pendingWaveNumber : battlegroundInst.currentWave, countdownRemaining: battlegroundInst.countdownEndsAt ? Math.max(0, (battlegroundInst.countdownEndsAt - Date.now()) / 1000) : undefined });
}

// -----------------------------------------------------
// JUMP SYSTEM (cross-system travel)
// - updates player.system_id even if socket already connected
// - sends WELCOME so client clears awaitingSpawn and shows ship
// - sends INITIAL_PLAYERS for the new system
// -----------------------------------------------------
async function handleJumpSystem(socket, data) {
  const player = players.get(socket);
  if (!player) return;

  const newSystemId = String(data.system_id || "").trim();
  if (!newSystemId) return;

  const oldSystemId = player.system_id;

  // Optional arrival snapshot
  const nx = Number(data.x);
  const ny = Number(data.y);
  const nr = Number(data.rot ?? player.rot ?? 0);
  const nvx = Number(data.vx ?? 0);
  const nvy = Number(data.vy ?? 0);

  if (Number.isFinite(nx) && Number.isFinite(ny)) {
    player.x = nx;
    player.y = ny;
  }
  player.rot = Number.isFinite(nr) ? nr : (player.rot ?? 0);
  player.vx = Number.isFinite(nvx) ? nvx : 0;
  player.vy = Number.isFinite(nvy) ? nvy : 0;

  // Ensure we are in space
  player.docked = false;
  player.system_id = newSystemId;
  clearValidatedLock(player);
  applyHydratedPlayerCombatStats(player, { preserveCurrent: true });

  // Force an immediate persist so refresh resumes in the correct system.
  // Preserve arena_return_snapshot when jumping into arena:* so the jump write
  // cannot wipe the snapshot that arena entry already verified.
  markPlayerDirty(player, ["ship", "telemetry"], { forceImmediatePersist: true });
  try {
    const jumpPayload = {
      player_id: player.userId,
      starport_id: null,
      ship_type: player.ship_type || "OMNI SCOUT",
      system_id: player.system_id,
      telemetry: telemetrySnapshot(player),
      hull: typeof player.hp === "number" ? player.hp : undefined,
      maxHp: typeof player.maxHp === "number" ? player.maxHp : undefined,
      shields: typeof player.shields === "number" ? player.shields : undefined,
      maxShields: typeof player.maxShields === "number" ? player.maxShields : undefined,
      energy: typeof player.energy === "number" ? player.energy : undefined,
      maxEnergy: typeof player.maxEnergy === "number" ? player.maxEnergy : undefined,
      cargo: Array.isArray(player.cargo) ? player.cargo : undefined,
      arena_return_snapshot: isArenaSystemId(player.system_id)
        ? (player.arenaReturnSnapshot || player.arenaState?.returnSnapshot || null)
        : null,
      updated_at: nowIso()
    };

    Object.keys(jumpPayload).forEach((k) => jumpPayload[k] === undefined && delete jumpPayload[k]);

    const { error } = await supabase
      .from("ship_states_v2")
      .upsert(jumpPayload, { onConflict: "player_id" });

    if (error) {
      console.warn("[Backend] Persist failed:", player.userId, "jump", error.message);
    } else {
      console.log("[Backend] Persist OK:", player.userId, "jump", "snapshot=", !!jumpPayload.arena_return_snapshot);
    }
  } catch (e) {
    console.warn("[Backend] Persist exception:", player.userId, "jump", e?.message || e);
  }


  // Tell old system we left (so other clients despawn us)
  if (oldSystemId && oldSystemId !== newSystemId) {
    for (const [otherSocket, otherPlayer] of players) {
      if (
        otherSocket !== socket &&
        otherPlayer.system_id === oldSystemId &&
        !otherPlayer.docked &&
        otherSocket.readyState === WebSocket.OPEN
      ) {
        otherSocket.send(JSON.stringify({ type: "PLAYER_LEFT", userId: player.userId }));
      }
    }
  }

  // Best-effort persist arrival + clear dock marker
  try {
    const payload = {
      player_id: player.userId,
      ship_type: player.ship_type || "OMNI SCOUT",
      system_id: newSystemId,
      starport_id: null,
      arena_return_snapshot: null,
      telemetry: telemetrySnapshot(player),
      hull: typeof player.hp === "number" ? player.hp : undefined,
      maxHp: typeof player.maxHp === "number" ? player.maxHp : undefined,
      shields: typeof player.shields === "number" ? player.shields : undefined,
      maxShields: typeof player.maxShields === "number" ? player.maxShields : undefined,
      energy: typeof player.energy === "number" ? player.energy : undefined,
      maxEnergy: typeof player.maxEnergy === "number" ? player.maxEnergy : undefined,
      updated_at: nowIso()
    };
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const { error } = await supabase
      .from("ship_states_v2")
      .upsert(payload, { onConflict: "player_id" });

    if (error) console.warn("[Backend] Persist JUMP_SYSTEM failed:", error.message);
  } catch (e) {
    console.warn("[Backend] Persist JUMP_SYSTEM exception:", e?.message || e);
  }

  // Send WELCOME (authoritative spawn)
  socket.send(JSON.stringify({
    type: "WELCOME",
    system_id: newSystemId,
    x: player.x,
    y: player.y,
    rot: player.rot,
    vx: player.vx,
    vy: player.vy,
    hp: typeof player.hp === "number" ? player.hp : 100,
    maxHp: typeof player.maxHp === "number" ? player.maxHp : 100,
    shields: typeof player.shields === "number" ? player.shields : 0,
    maxShields: typeof player.maxShields === "number" ? player.maxShields : 0,
    energy: typeof player.energy === "number" ? player.energy : 100,
    maxEnergy: typeof player.maxEnergy === "number" ? player.maxEnergy : 100,
    armor: player.armor,
    resistances: player.resistances || {},
    combat_stats: player.combatStats || null,
    server_id: SERVER_ID
  }));
  sendInstanceBoundaryConfig(socket, player.system_id);

  // Provide initial players for the new system
  console.log(`[Backend] ${player.userId} jumped systems: ${oldSystemId} -> ${newSystemId}`);
}


// -----------------------------------------------------
// PING / PONG
// -----------------------------------------------------
function handlePing(socket) {
  socket.send(JSON.stringify({
    type: "PONG",
    time: Date.now()
  }));
}

// -----------------------------------------------------
// TELEMETRY (SPACE ONLY)
// - update in memory every packet
// - mark dirty if meaningful changes
// - persist is done by global batch loop (see below)
// - broadcast throttled
// -----------------------------------------------------
function handleTelemetry(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked) return;
  if (player.destroyed && !isArenaSystemId(player.system_id) && !isBattlegroundSystemId(player.system_id)) {
    socket.send(JSON.stringify({
      type: "TELEMETRY_ACK",
      seq: data.seq ?? 0,
      clientTime: data.clientTime ?? 0,
      serverReceiveTime: Date.now()
    }));
    return;
  }
  if (isArenaIntroProtected(player)) {
    socket.send(JSON.stringify({
      type: "TELEMETRY_ACK",
      seq: data.seq ?? 0,
      clientTime: data.clientTime ?? 0,
      serverReceiveTime: Date.now()
    }));
    return;
  }

  // Minimum required to accept packet (coords)
  const x = Number(data.x);
  const y = Number(data.y);
  const rot = Number(data.rot ?? 0);
  const vx = Number(data.vx ?? 0);
  const vy = Number(data.vy ?? 0);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const incoming = {
    x, y, rot: Number.isFinite(rot) ? rot : 0,
    vx: Number.isFinite(vx) ? vx : 0,
    vy: Number.isFinite(vy) ? vy : 0,
    hp: pickNum(data.hp, data.hull),
    maxHp: pickNum(data.maxHp),
    shields: pickNum(data.shields),
    maxShields: pickNum(data.maxShields),
    energy: pickNum(data.energy),
    maxEnergy: pickNum(data.maxEnergy)
  };

  const anim = sanitizeRuntimeAnimationState(data.animation_state);
  const fittings = sanitizeRuntimeFittings(data.fittings, player.ship_type || 'ship_omni_scout');
  const visual_config = sanitizeRuntimeVisualConfig(data.visual_config);
  if (anim) player.animation_state = anim;
  let fittingsChanged = false;
  if (Object.keys(fittings).length > 0) {
    const nextSignature = computeFittingsSignature(fittings);
    if (nextSignature && nextSignature !== (player._fittingsSignature || '')) {
      player.fittings = fittings;
      fittingsChanged = true;
    }
  }
  if (visual_config) player.visual_config = visual_config;
  if (fittingsChanged) {
    applyHydratedPlayerCombatStats(player, { preserveCurrent: true });
  }


  const dirty = shouldMarkDirty(player, incoming);

  let boundaryState = null;
  if (isInstancedSystemId(player.system_id)) {
    boundaryState = getBoundaryZoneState(player.system_id, incoming.x, incoming.y);
  }
  player.x = incoming.x;
  player.y = incoming.y;
  player.rot = incoming.rot;
  player.vx = boundaryState ? (incoming.vx * boundaryState.speedMultiplier) : incoming.vx;
  player.vy = boundaryState ? (incoming.vy * boundaryState.speedMultiplier) : incoming.vy;

  if (typeof incoming.hp === "number") player.hp = Math.max(0, Math.min(incoming.hp, player.maxHp ?? incoming.hp));
  if (typeof incoming.shields === "number") player.shields = Math.max(0, Math.min(incoming.shields, player.maxShields ?? incoming.shields));

  if (typeof incoming.energy === "number") player.energy = Math.max(0, Math.min(incoming.energy, player.maxEnergy ?? incoming.energy));

  // keep live snapshot always current
  player.lastSpaceTelemetry = telemetrySnapshot(player);

  // mark dirty for batch persister
  if (dirty) markPlayerDirty(player, ["telemetry", "ship"]);

  // ACK first (keep it cheap)
  socket.send(JSON.stringify({
    type: "TELEMETRY_ACK",
    seq: data.seq ?? 0,
    clientTime: data.clientTime ?? 0,
    serverReceiveTime: Date.now()
  }));

  // Debug (throttled by count)
  player._telemetryLogN = (player._telemetryLogN || 0) + 1;
  if (player._telemetryLogN % 60 === 0) {
    console.log(
      "[TELEMETRY OK]",
      player.userId,
      "sys=",
      player.system_id,
      "x=",
      player.x.toFixed(1),
      "y=",
      player.y.toFixed(1),
      "rot=",
      player.rot.toFixed(2),
      "seq=",
      data.seq
    );
  }

  // Broadcast to other players in the same system (throttled)
  const now = Date.now();
  player._lastBroadcastAt = player._lastBroadcastAt || 0;
  if (!player.destroyed && now - player._lastBroadcastAt >= BROADCAST_INTERVAL_MS && player.system_id) {
    player._lastBroadcastAt = now;

    const update = {
      type: "PLAYER_UPDATE",
      userId: player.userId,
      x: player.x,
      y: player.y,
      rot: player.rot,
      vx: player.vx,
      vy: player.vy,
      hp: player.hp,
      maxHp: player.maxHp,
      shields: player.shields,
      maxShields: player.maxShields,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      fittings: player.fittings || {},
      visual_config: player.visual_config || null,
      animation_state: player.animation_state || null,
      armor: player.armor,
      resistances: player.resistances || {},
      combat_stats: player.combatStats || null
    };

    for (const [otherSocket, otherPlayer] of players) {
      if (
        otherSocket !== socket &&
        otherPlayer.system_id === player.system_id &&
        !otherPlayer.docked &&
        otherSocket.readyState === WebSocket.OPEN
      ) {
        otherSocket.send(JSON.stringify(update));
      }
    }
  }
}

// -----------------------------------------------------
// FIRE WEAPON (SPACE ONLY)
// -----------------------------------------------------

function handleFireWeapon(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked) return;
  if (isArenaIntroProtected(player)) return;

  // Basic packet validation
  const weapon_id = String(data.weapon_id || "").trim();
  if (!weapon_id) return;

  const x = Number(data.x);
  const y = Number(data.y);

  // Prefer aim point if provided (world coords), otherwise fall back to rot
  const aimX = Number(data.aimX ?? data.aim_x);
  const aimY = Number(data.aimY ?? data.aim_y);

  let rot = Number(data.rot ?? 0);
  if (Number.isFinite(aimX) && Number.isFinite(aimY)) {
    rot = Math.atan2(aimY - y, aimX - x);
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rot)) return;

  const vx = Number(data.vx ?? 0);
  const vy = Number(data.vy ?? 0);
  const t = Number(data.t ?? data.clientTime ?? Date.now());
  const beamRange = Number(data.beamRange ?? data.range ?? NaN);

  // Debug log even if you’re alone
  player._fireLogN = (player._fireLogN || 0) + 1;
  if (player._fireLogN % 10 === 0) {
    console.log(
      "[FIRE]",
      player.userId,
      "sys=",
      player.system_id,
      "weapon=",
      weapon_id,
      "x=",
      x.toFixed(1),
      "y=",
      y.toFixed(1),
      "rot=",
      rot.toFixed(2)
    );
  }

  // --- Rate of fire / energy validation (authoritative) ---
  const weaponMeta = {
    weaponId: weapon_id,
    itemId: data.item_id,
    instanceId: data.instance_id,
    weaponName: data.weapon_name,
    weaponType: data.weapon_type,
    weaponSubtype: data.weapon_subtype,
    weaponsize: data.weaponsize,
    rarity: data.rarity,
  };
  const snapshot = data.weapon_stats || data.weaponStats || null;
  const w = getHydratedWeaponStats(player, weapon_id, snapshot, weaponMeta);

  const isBeam = (w.kind === "beam");
  const isHitscan = (w.kind === "hitscan");
  const isProjectile = (w.kind === "projectile" || w.kind === "missile");

  let beamState = null;
  if (isBeam) {
    beamState = resolveBeamHit(player, w, { x, y, rot, aimX, aimY, beamRange, targetId: player.validatedLock?.targetId || null });
    rot = beamState.rot;
  }

  // Cooldown check
  player.weaponCooldowns = player.weaponCooldowns || {};
  const lastFire = player.weaponCooldowns[weapon_id] || 0;
  const now = Date.now();
  if (now - lastFire < w.cooldownMs) {
    // ignore spam (optionally send a reject message later)
    return;
  }
  player.weaponCooldowns[weapon_id] = now;

  // Energy check (if energy is tracked)
  if (typeof player.energy === "number") {
    const cost = w.energyCost || 0;
    if (player.energy < cost) {
      return; // insufficient energy
    }
    player.energy = Math.max(0, player.energy - cost);
    markPlayerDirty(player, ["ship"]);
  }

  // Broadcast WEAPON_FIRED for visuals (everyone in system)
  broadcastToSystem(player.system_id, {
    type: "WEAPON_FIRED",
    userId: player.userId,
    weapon_id,
    weapon_name: weaponMeta.weaponName,
    weapon_type: weaponMeta.weaponType,
    weapon_subtype: weaponMeta.weaponSubtype,
    weaponsize: weaponMeta.weaponsize,
    rarity: weaponMeta.rarity,
    projectileSpeed: w.projectileSpeed,
    x: isBeam && beamState ? beamState.x : x,
    y: isBeam && beamState ? beamState.y : y,
    rot,
    aimX: (isBeam && beamState) ? beamState.impactX : (Number.isFinite(aimX) ? aimX : undefined),
    aimY: (isBeam && beamState) ? beamState.impactY : (Number.isFinite(aimY) ? aimY : undefined),
    vx: (Number.isFinite(vx) ? vx : undefined),
    vy: (Number.isFinite(vy) ? vy : undefined),
    t: (Number.isFinite(t) ? t : now),
    beamRange: (isBeam && beamState) ? beamState.range : (Number.isFinite(beamRange) ? beamRange : undefined),
    lockTargetId: (isBeam && beamState && beamState.lockTargetId) ? beamState.lockTargetId : undefined,
    serverTime: now
  });

  if (isProjectile) {
    const reg = getSystemRegistry(projectileStatesBySystem, player.system_id);
    const lockTargetId = player.validatedLock?.system_id === player.system_id ? player.validatedLock?.targetId : null;
    const proj = createProjectileState(player, weaponMeta, w, { x, y, rot, vx, vy, aimX, aimY, targetId: lockTargetId });
    reg.set(proj.id, proj);
    return;
  }

  if (isBeam) {
    applyBeamDamage(player.system_id, player, weaponMeta, beamState, w, now);
    return;
  }

  // Non-hitscan weapons are still visual-only for now (drones later)
  if (!isHitscan) return;

  // --- Hitscan: compute nearest target hit ---
  const dx = Math.cos(rot);
  const dy = Math.sin(rot);

  let bestT = null;
  let bestTarget = null;

  for (const [, other] of players) {
    if (!other || other.docked) continue;
    if (other.userId === player.userId) continue;
    if (other.system_id !== player.system_id) continue;

    if (!Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;

    const r = getHitRadius(other);
    const t = rayCircleHit(x, y, dx, dy, other.x, other.y, r);
    if (t === null) continue;

    // out of range
    if (t > w.range) continue;

    if (bestT === null || t < bestT) {
      bestT = t;
      bestTarget = other;
    }
  }

  if (!bestTarget) {
    // optional: broadcast miss for effects; not required
    return;
  }

  applyAuthoritativePlayerDamage({
    systemId: player.system_id,
    target: bestTarget,
    attackerId: player.userId,
    sourceType: 'player',
    sourceId: player.userId,
    weapon_id,
    weapon_name: weaponMeta.weaponName,
    rawAmount: w.damage,
    damageType: 'thermal',
    damageMode: 'hitscan',
    source: 'weapon',
    reason: w.family || w.kind || 'hitscan',
    impactX: x + dx * bestT,
    impactY: y + dy * bestT,
    serverTime: now,
  });
}

// -----------------------------------------------------
// SELF / ENVIRONMENT DAMAGE (SPACE ONLY)
// - Used for collisions, NPC hits (while NPCs are client-simulated), hazards, etc.
// - Client may report *applied* deltas (hullDamage/shieldDamage) to avoid mismatched resist math.
// - Server clamps and applies to its authoritative vitals, then broadcasts + persists.
// -----------------------------------------------------

// -----------------------------------------------------
// FX EVENT (SPACE ONLY)
// Discrete visuals: shield impacts, explosions, muzzle flashes, etc.
// -----------------------------------------------------
function handleFxEvent(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked) return;
  if (!player.system_id) return;

  const fx_type = String(data.fx_type || "").trim();
  if (!fx_type) return;

  const x = Number(data.x);
  const y = Number(data.y);
  const angle = Number(data.angle ?? 0);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const now = Date.now();

  const msg = JSON.stringify({
    type: "FX_EVENT",
    userId: player.userId,
    fx_type,
    x,
    y,
    angle: (Number.isFinite(angle) ? angle : 0),
    serverTime: now
  });

  // Broadcast to others in the same system (exclude sender socket)
  for (const [otherSocket, otherPlayer] of players) {
    if (
      otherSocket !== socket &&
      otherPlayer.system_id === player.system_id &&
      !otherPlayer.docked &&
      otherSocket.readyState === WebSocket.OPEN
    ) {
      otherSocket.send(msg);
    }
  }
}

function handleSelfDamage(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked) return;
  if (isArenaIntroProtected(player)) return;

  const now = Date.now();

  // Basic rate limit window (prevents spoof spam)
  player._selfDmgWindowStart = player._selfDmgWindowStart || now;
  player._selfDmgWindowTotal = player._selfDmgWindowTotal || 0;

  if (now - player._selfDmgWindowStart > 1000) {
    player._selfDmgWindowStart = now;
    player._selfDmgWindowTotal = 0;
  }

  const sourceStr = String(data?.source || data?.reason || "environment").toLowerCase();
  const isCollision = /collision|impact|ram|bump|station|dock/.test(sourceStr);
  const undockGrace = !!(player._lastUndockAt && (now - player._lastUndockAt) < 2000);

  // Collision can spike massively (esp. around undock). Treat it as a bug-safety clamp.
  const perEventCap = undockGrace ? 8 : (isCollision ? 20 : 500);
  const perSecondCap = undockGrace ? 24 : (isCollision ? 60 : 600);

  const mode = String(data?.mode || "applied");

  let shieldDamage = 0;
  let hullDamage = 0;

  if (mode === "applied") {
    shieldDamage = Number(data?.shieldDamage ?? 0);
    hullDamage = Number(data?.hullDamage ?? 0);

    if (!Number.isFinite(shieldDamage) || shieldDamage < 0) shieldDamage = 0;
    if (!Number.isFinite(hullDamage) || hullDamage < 0) hullDamage = 0;
  } else {
    // fallback: single amount (treated like generic damage; shields first)
    const amount = Number(data?.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) return;
    hullDamage = amount;
  }

  // Clamp per-event (sane upper bounds)
  shieldDamage = Math.min(perEventCap, shieldDamage);
  hullDamage = Math.min(perEventCap, hullDamage);

  const total = shieldDamage + hullDamage;
  if (total <= 0) return;

  // Max perSecondCap damage/sec from self-reported sources
  if (player._selfDmgWindowTotal + total > perSecondCap) return;
  player._selfDmgWindowTotal += total;

  applyAuthoritativePlayerDamage({
    systemId: player.system_id,
    target: player,
    attackerId: player.userId,
    weapon_id: "environment",
    weapon_name: "Environment",
    shieldDamage,
    hullDamage,
    damageType: String(data?.damageType || data?.damage_type || 'kinetic'),
    damageMode: 'self_reported',
    source: String(data?.source || "environment"),
    reason: String(data?.reason || "self_damage"),
    impactX: Number.isFinite(player.x) ? player.x : undefined,
    impactY: Number.isFinite(player.y) ? player.y : undefined,
    serverTime: now,
  });

  // Mark dirty + persist immediately so refresh can't heal
  markPlayerDirty(player, ["ship"], { forceImmediatePersist: true });
  persistPlayerState(player, { reason: "self_damage" }).catch(() => {});
}


async function handleSpawnWorldObject(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked || !player.system_id) return;

  const requestId = String(data?.requestId || "").trim() || undefined;
  const type = String(data?.object_type || data?.type || "loot").trim() || "loot";
  const x = Number(data?.x);
  const y = Number(data?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  try {
    const row = await insertWorldObject({
      type,
      data: safeObjectData(data?.data),
      x,
      y,
      system_id: player.system_id,
      owner_id: player.userId
    });

    broadcastToSystem(player.system_id, {
      type: "WORLD_OBJECT_SPAWNED",
      object: row,
      serverTime: Date.now()
    });

    socket.send(JSON.stringify({
      type: "SPAWN_WORLD_OBJECT_RESULT",
      ok: true,
      requestId,
      object: row,
      serverTime: Date.now()
    }));
  } catch (e) {
    socket.send(JSON.stringify({
      type: "SPAWN_WORLD_OBJECT_RESULT",
      ok: false,
      requestId,
      error: e?.message || String(e),
      serverTime: Date.now()
    }));
  }
}

async function handleCollectWorldObject(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked || !player.system_id) return;

  const requestId = String(data?.requestId || "").trim() || undefined;
  const objectId = String(data?.object_id || data?.objectId || "").trim();
  if (!objectId) return;

  try {
    const { data: obj, error: fetchErr } = await supabase
      .from("world_objects")
      .select("object_id, x, y, data")
      .eq("object_id", objectId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!obj) {
      socket.send(JSON.stringify({ type: "COLLECT_WORLD_OBJECT_RESULT", ok: false, requestId, object_id: objectId, reason: "not_found", serverTime: Date.now() }));
      return;
    }

    const objSystem = String(obj?.data?.systemId || player.system_id);
    if (objSystem !== player.system_id) {
      socket.send(JSON.stringify({ type: "COLLECT_WORLD_OBJECT_RESULT", ok: false, requestId, object_id: objectId, reason: "wrong_system", serverTime: Date.now() }));
      return;
    }

    const ownershipCheck = canCollectOwnedLoot(obj?.data || {}, player.userId, Date.now());
    if (!ownershipCheck.ok) {
      socket.send(JSON.stringify({
        type: "COLLECT_WORLD_OBJECT_RESULT",
        ok: false,
        requestId,
        object_id: objectId,
        reason: ownershipCheck.reason || "not_owner",
        ownerType: ownershipCheck.ownerType,
        ownerId: ownershipCheck.ownerId,
        publicAt: ownershipCheck.publicAt,
        serverTime: Date.now()
      }));
      return;
    }

    const px = Number(player.x);
    const py = Number(player.y);
    const ox = Number(obj.x);
    const oy = Number(obj.y);
    const clientX = Number(data?.x);
    const clientY = Number(data?.y);
    let authoritativeDist = null;
    let clientHintDist = null;
    if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(ox) && Number.isFinite(oy)) {
      authoritativeDist = Math.hypot(px - ox, py - oy);
    }
    if (Number.isFinite(clientX) && Number.isFinite(clientY) && Number.isFinite(ox) && Number.isFinite(oy)) {
      clientHintDist = Math.hypot(clientX - ox, clientY - oy);
    }

    const allowByAuthoritative = authoritativeDist == null || authoritativeDist <= COLLECT_RANGE_AUTHORITATIVE;
    const allowByClientHint = authoritativeDist != null
      && authoritativeDist <= COLLECT_SERVER_SNAPSHOT_GRACE
      && clientHintDist != null
      && clientHintDist <= COLLECT_RANGE_CLIENT_HINT;

    console.log("[COLLECT CHECK]", {
      playerId: player.userId,
      objectId,
      system_id: player.system_id,
      playerX: px,
      playerY: py,
      clientX,
      clientY,
      objectX: ox,
      objectY: oy,
      authoritativeDist,
      clientHintDist,
      allowByAuthoritative,
      allowByClientHint
    });

    if (!allowByAuthoritative && !allowByClientHint) {
      socket.send(JSON.stringify({
        type: "COLLECT_WORLD_OBJECT_RESULT",
        ok: false,
        requestId,
        object_id: objectId,
        reason: "too_far",
        dist: authoritativeDist,
        clientDist: clientHintDist,
        serverTime: Date.now()
      }));
      return;
    }

    const result = await collectWorldObjectToCargoServer({ objectId, playerId: player.userId });
    if (!result) {
      socket.send(JSON.stringify({ type: "COLLECT_WORLD_OBJECT_RESULT", ok: false, requestId, object_id: objectId, reason: "not_found", serverTime: Date.now() }));
      return;
    }

    // Keep runtime memory aligned too (useful for later persistence / reconnects)
    player.cargo = Array.isArray(result.cargo) ? result.cargo : [];

    socket.send(JSON.stringify({
      type: "CARGO_SYNC",
      requestId,
      cargo: result.cargo,
      inventory: result.cargo,
      object_id: objectId,
      serverTime: Date.now()
    }));

    socket.send(JSON.stringify({
      type: "COLLECT_WORLD_OBJECT_RESULT",
      ok: true,
      requestId,
      object_id: objectId,
      cargo: result.cargo,
      serverTime: Date.now()
    }));

    broadcastToSystem(player.system_id, {
      type: "WORLD_OBJECT_REMOVED",
      object_id: objectId,
      collectedBy: player.userId,
      serverTime: Date.now()
    });
  } catch (e) {
    socket.send(JSON.stringify({
      type: "COLLECT_WORLD_OBJECT_RESULT",
      ok: false,
      requestId,
      object_id: objectId,
      reason: e?.message || String(e),
      serverTime: Date.now()
    }));
  }
}



function getNpcRes(npc, type) {
  if (type === 'kinetic') return npc.kineticRes || 0;
  if (type === 'blast') return npc.blastRes || 0;
  if (type === 'thermal' || type === 'energy') return npc.thermalRes || 0;
  return 0;
}

async function handleNpcHitRequest(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked || !player.system_id) return;

  const targetId = String(data.target_id || data.targetId || '').trim();
  if (!targetId) return;

  let npc = upsertNpcState(player.system_id, data);
  if (!npc) return;

  if (npc.destroyed || (npc.hp ?? 0) <= 0) {
    broadcastToSystem(player.system_id, {
      type: 'NPC_DESTROYED',
      attackerId: player.userId,
      targetId: npc.id,
      serverTime: Date.now()
    });
    return;
  }

  const targetX = Number.isFinite(finiteNum(data.target_x ?? data.targetX, NaN)) ? finiteNum(data.target_x ?? data.targetX, NaN) : npc.x;
  const targetY = Number.isFinite(finiteNum(data.target_y ?? data.targetY, NaN)) ? finiteNum(data.target_y ?? data.targetY, NaN) : npc.y;
  const dist = distance2D(player.x, player.y, targetX, targetY);
  const claimedRange = Math.max(0, Math.min(NPC_MAX_RANGE, finiteNum(data.range ?? data.maxRange, NPC_MAX_RANGE)));
  if (dist > Math.max(300, claimedRange + 175)) return;

  const damageType = String(data.damageType || data.damage_type || 'kinetic').toLowerCase();
  let amount = clampWorldDamage(data.amount ?? data.damage);
  if (amount <= 0) return;

  npc.x = targetX;
  npc.y = targetY;

  let shieldDamage = 0;
  let hullDamage = 0;

  if ((npc.shields ?? 0) > 0) {
    const res = getNpcRes(npc, damageType);
    const reduced = amount * (1 - res);
    shieldDamage = Math.min(npc.shields, reduced);
    npc.shields = Math.max(0, npc.shields - shieldDamage);
    const baseUsed = (1 - res) > 0 ? (shieldDamage / (1 - res)) : shieldDamage;
    amount = Math.max(0, amount - baseUsed);
  }

  if (amount > 0) {
    hullDamage = amount * (1 - (npc.armor || 0.15));
    npc.hp = Math.max(0, (npc.hp ?? 0) - hullDamage);
  }

  npc.lastUpdatedAt = Date.now();
  setNpcThreat(npc, player.userId, (shieldDamage + hullDamage) * NPC_DIRECT_DAMAGE_THREAT_MULT + 10, npc.lastUpdatedAt);
  if (shouldNpcUseAllyAssist(npc)) {
    applyAllyThreat(player.system_id, npc, player.userId, (shieldDamage + hullDamage) * NPC_ALLY_DAMAGE_THREAT_MULT + 4, npc.lastUpdatedAt);
  }

  broadcastToSystem(player.system_id, {
    type: 'NPC_DAMAGE_EVENT',
    attackerId: player.userId,
    targetId: npc.id,
    targetType: npc.type,
    weapon_id: String(data.weapon_id || data.weaponId || ''),
    damageType,
    shieldDamage,
    hullDamage,
    hull: npc.hp,
    maxHp: npc.maxHp,
    shields: npc.shields,
    maxShields: npc.maxShields,
    x: npc.x,
    y: npc.y,
    serverTime: npc.lastUpdatedAt
  });

  if ((npc.hp ?? 0) <= 0) {
    npc.destroyed = true;
    const expReward = getNpcExpReward(npc);
    const killCredit = resolveKillCredit('npc', npc.id, npc.lastUpdatedAt);
    const rewardSummary = buildNpcDeathRewardSummary(npc, killCredit);
    broadcastToSystem(player.system_id, {
      type: 'NPC_DESTROYED',
      attackerId: player.userId,
      targetId: npc.id,
      targetType: npc.type,
      x: npc.x,
      y: npc.y,
      expReward,
      lootAuthority: 'server',
      rewardMode: rewardSummary.rewardMode,
      worldLootClass: rewardSummary.worldLootClass,
      finalBlow: killCredit.finalBlow,
      topDamage: killCredit.topDamage,
      assists: killCredit.assists,
      killCreditId: killCredit.topDamage?.sourceId || null,
      killCreditType: killCredit.topDamage?.sourceType || null,
      finalBlowId: killCredit.finalBlow?.sourceId || null,
      finalBlowType: killCredit.finalBlow?.sourceType || null,
      serverTime: npc.lastUpdatedAt
    });
    const battlegroundInst = npc?.battlegroundInstanceId ? battlegroundInstances.get(npc.battlegroundInstanceId) : null;
    if (battlegroundInst) onBattlegroundNpcDestroyed(battlegroundInst, npc.id, npc.lastUpdatedAt);
    if (rewardSummary.rewardMode === NPC_REWARD_MODE_WORLD_LOOT) {
      await spawnNpcLootForDeath(player.system_id, npc, killCredit);
    }
    clearKillCreditTracking('npc', npc.id);
  }
}

function handleAsteroidHitRequest(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked || !player.system_id) return;

  const targetId = String(data.target_id || data.targetId || '').trim();
  if (!targetId) return;

  const registry = getSystemRegistry(asteroidStatesBySystem, player.system_id);
  let asteroid = registry.get(targetId);
  if (!asteroid) {
    const snap = sanitizeAsteroidSnapshot(data);
    if (!snap.id || !Number.isFinite(snap.x) || !Number.isFinite(snap.y)) return;
    asteroid = snap;
    registry.set(targetId, asteroid);
  }

  if (asteroid.depleted || (asteroid.oreAmount ?? 0) <= 0) {
    broadcastToSystem(player.system_id, {
      type: 'ASTEROID_DEPLETED',
      attackerId: player.userId,
      targetId: asteroid.id,
      oreAmount: 0,
      serverTime: Date.now()
    });
    return;
  }

  const targetX = Number.isFinite(finiteNum(data.target_x ?? data.targetX, NaN)) ? finiteNum(data.target_x ?? data.targetX, NaN) : asteroid.x;
  const targetY = Number.isFinite(finiteNum(data.target_y ?? data.targetY, NaN)) ? finiteNum(data.target_y ?? data.targetY, NaN) : asteroid.y;
  const dist = distance2D(player.x, player.y, targetX, targetY);
  const claimedRange = Math.max(0, Math.min(ASTEROID_MAX_RANGE, finiteNum(data.range ?? data.maxRange, ASTEROID_MAX_RANGE)));
  if (dist > Math.max(250, claimedRange + 150)) return;

  const amount = clampWorldDamage(data.amount ?? data.damage);
  if (amount <= 0) return;

  asteroid.x = targetX;
  asteroid.y = targetY;
  const before = asteroid.oreAmount ?? 0;
  asteroid.oreAmount = Math.max(0, before - amount);
  const applied = before - asteroid.oreAmount;
  asteroid.lastUpdatedAt = Date.now();

  broadcastToSystem(player.system_id, {
    type: 'ASTEROID_DAMAGE_EVENT',
    attackerId: player.userId,
    targetId: asteroid.id,
    targetType: asteroid.type,
    oreType: asteroid.oreType,
    ql: asteroid.ql,
    qlBand: asteroid.qlBand,
    amount: applied,
    oreAmount: asteroid.oreAmount,
    x: asteroid.x,
    y: asteroid.y,
    mode: String(data.mode || 'weapon'),
    serverTime: asteroid.lastUpdatedAt
  });

  if ((asteroid.oreAmount ?? 0) <= 0) {
    asteroid.depleted = true;
    broadcastToSystem(player.system_id, {
      type: 'ASTEROID_DEPLETED',
      attackerId: player.userId,
      targetId: asteroid.id,
      targetType: asteroid.type,
      oreType: asteroid.oreType,
      ql: asteroid.ql,
      qlBand: asteroid.qlBand,
      oreAmount: 0,
      x: asteroid.x,
      y: asteroid.y,
      serverTime: asteroid.lastUpdatedAt
    });
  }
}

function handleStartMining(socket, data) {
  const player = players.get(socket);
  if (!player || player.docked || !player.system_id) return;

  const targetId = String(data.target_id || data.targetId || '').trim();
  if (!targetId) return;

  const registry = getSystemRegistry(asteroidStatesBySystem, player.system_id);
  let asteroid = registry.get(targetId);
  if (!asteroid) {
    const snap = sanitizeAsteroidSnapshot(data);
    if (!snap.id || !Number.isFinite(snap.x) || !Number.isFinite(snap.y)) return;
    asteroid = snap;
    registry.set(targetId, asteroid);
  }

  const now = Date.now();
  const nextConfig = sanitizeMiningConfig(data);
  const wasMiningSameTarget = player.activeMiningTargetId && player.activeMiningTargetId === targetId && !!player.activeMiningConfig;

  player.activeMiningTargetId = targetId;
  player.activeMiningConfig = nextConfig;
  player.activeMiningSnapshot = {
    target_id: targetId,
    target_type: asteroid.type,
    target_x: asteroid.x,
    target_y: asteroid.y,
    target_oreAmount: asteroid.oreAmount,
    target_oreType: asteroid.oreType,
    target_ql: asteroid.ql,
    target_qlBand: asteroid.qlBand,
    target_collisionRadius: asteroid.collisionRadius
  };
  player.lastMiningRefreshAt = now;
  if (!wasMiningSameTarget || !Number.isFinite(player.nextMiningTickAt) || player.nextMiningTickAt <= 0) {
    player.nextMiningTickAt = now + Math.min(120, Math.max(50, nextConfig.cycleMs || 120));
    broadcastToSystem(player.system_id, {
      type: 'MINING_STATE',
      userId: player.userId,
      state: 'start',
      targetId,
      weapon_id: nextConfig.weaponId,
      serverTime: now
    });
  }
}

function handleStopMining(socket, data) {
  const player = players.get(socket);
  if (!player || !player.system_id) return;
  const targetId = String(data.target_id || data.targetId || player.activeMiningTargetId || '').trim() || null;
  player.activeMiningTargetId = null;
  player.activeMiningConfig = null;
  player.activeMiningSnapshot = null;
  player.lastMiningRefreshAt = 0;
  player.nextMiningTickAt = 0;
  broadcastToSystem(player.system_id, {
    type: 'MINING_STATE',
    userId: player.userId,
    state: 'stop',
    targetId,
    serverTime: Date.now()
  });
}

function handleLockTargetState(socket, data) {
  const player = players.get(socket);
  if (!player) return;
  if (isArenaIntroProtected(player)) {
    clearValidatedLock(player);
    return;
  }

  const state = String(data?.state || data?.action || '').toLowerCase();
  if (state === 'clear' || state === 'cancel' || state === 'broken' || state === 'idle') {
    clearValidatedLock(player);
    return;
  }

  const targetId = String(data?.target_id || data?.targetId || '').trim();
  if (!targetId || targetId === player.userId) {
    clearValidatedLock(player);
    return;
  }

  const targetRef = findPlayerSocketByUserId(targetId);
  if (!targetRef || !targetRef.player || targetRef.player.docked) {
    clearValidatedLock(player);
    return;
  }

  if (targetRef.player.system_id !== player.system_id) {
    clearValidatedLock(player);
    return;
  }

  player.validatedLock = {
    targetId,
    isFriendly: !!data?.isFriendly,
    lockRange: Math.max(100, Math.min(PLAYER_LOCK_MAX_RANGE, finiteNum(data?.lockRange ?? data?.range, 2200))),
    targetType: String(data?.targetType || '').trim() || undefined,
    system_id: player.system_id,
    lastUpdatedAt: Date.now()
  };
}

// -----------------------------------------------------
// PHASE 3A UNIFIED SERVER TICK
// -----------------------------------------------------
async function tickMining(now) {
  for (const [socket, player] of players) {
    try {
      if (!player || player.docked || !player.system_id) continue;
      if (!player.activeMiningTargetId || !player.activeMiningConfig) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;

      if (!player.lastMiningRefreshAt || (now - player.lastMiningRefreshAt) > MINING_REFRESH_TIMEOUT_MS) {
        const staleTargetId = player.activeMiningTargetId;
        player.activeMiningTargetId = null;
        player.activeMiningConfig = null;
        player.activeMiningSnapshot = null;
        player.lastMiningRefreshAt = 0;
        player.nextMiningTickAt = 0;
        broadcastToSystem(player.system_id, {
          type: 'MINING_STATE',
          userId: player.userId,
          state: 'stop',
          targetId: staleTargetId,
          reason: 'timeout',
          serverTime: now
        });
        continue;
      }

      if (player.nextMiningTickAt && now < player.nextMiningTickAt) continue;

      const registry = getSystemRegistry(asteroidStatesBySystem, player.system_id);
      let asteroid = registry.get(player.activeMiningTargetId);
      if (!asteroid && player.activeMiningSnapshot) {
        asteroid = sanitizeAsteroidSnapshot(player.activeMiningSnapshot);
        if (asteroid?.id) registry.set(asteroid.id, asteroid);
      }
      if (!asteroid) {
        player.activeMiningTargetId = null;
        player.activeMiningConfig = null;
        player.activeMiningSnapshot = null;
        player.lastMiningRefreshAt = 0;
        player.nextMiningTickAt = 0;
        continue;
      }

      const dist = distance2D(player.x, player.y, asteroid.x, asteroid.y);
      if (dist > Math.max(220, (player.activeMiningConfig.range || 650) + 160)) {
        const targetId = player.activeMiningTargetId;
        player.activeMiningTargetId = null;
        player.activeMiningConfig = null;
        player.activeMiningSnapshot = null;
        player.lastMiningRefreshAt = 0;
        player.nextMiningTickAt = 0;
        broadcastToSystem(player.system_id, {
          type: 'MINING_STATE',
          userId: player.userId,
          state: 'stop',
          targetId,
          reason: 'out_of_range',
          serverTime: now
        });
        continue;
      }

      player.nextMiningTickAt = now + player.activeMiningConfig.cycleMs;

      if (asteroid.depleted || (asteroid.oreAmount ?? 0) <= 0) {
        asteroid.depleted = true;
        const targetId = asteroid.id;
        player.activeMiningTargetId = null;
        player.activeMiningConfig = null;
        player.activeMiningSnapshot = null;
        player.lastMiningRefreshAt = 0;
        player.nextMiningTickAt = 0;
        broadcastToSystem(player.system_id, {
          type: 'ASTEROID_DEPLETED',
          attackerId: player.userId,
          targetId,
          targetType: asteroid.type,
          oreType: asteroid.oreType,
          ql: asteroid.ql,
          qlBand: asteroid.qlBand,
          oreAmount: 0,
          x: asteroid.x,
          y: asteroid.y,
          serverTime: now
        });
        broadcastToSystem(player.system_id, {
          type: 'MINING_STATE',
          userId: player.userId,
          state: 'stop',
          targetId,
          reason: 'depleted',
          serverTime: now
        });
        continue;
      }

      const before = asteroid.oreAmount ?? 0;
      const applied = Math.min(before, player.activeMiningConfig.yieldPerCycle || 1);
      if (applied <= 0) continue;

      asteroid.oreAmount = Math.max(0, before - applied);
      asteroid.lastUpdatedAt = now;

      broadcastToSystem(player.system_id, {
        type: 'ASTEROID_DAMAGE_EVENT',
        attackerId: player.userId,
        targetId: asteroid.id,
        targetType: asteroid.type,
        oreType: asteroid.oreType,
        ql: asteroid.ql,
        qlBand: asteroid.qlBand,
        amount: applied,
        oreAmount: asteroid.oreAmount,
        x: asteroid.x,
        y: asteroid.y,
        mode: 'mining',
        weapon_id: player.activeMiningConfig.weaponId,
        serverTime: now
      });

      const row = await insertWorldObject({
        type: 'resource',
        data: buildMiningLootItem(asteroid, applied),
        x: asteroid.x,
        y: asteroid.y,
        system_id: player.system_id,
        owner_id: player.userId
      });
      broadcastToSystem(player.system_id, {
        type: 'WORLD_OBJECT_SPAWNED',
        object: row,
        serverTime: Date.now()
      });

      if ((asteroid.oreAmount ?? 0) <= 0) {
        asteroid.depleted = true;
        const targetId = asteroid.id;
        player.activeMiningTargetId = null;
        player.activeMiningConfig = null;
        player.activeMiningSnapshot = null;
        player.lastMiningRefreshAt = 0;
        player.nextMiningTickAt = 0;
        broadcastToSystem(player.system_id, {
          type: 'ASTEROID_DEPLETED',
          attackerId: player.userId,
          targetId,
          targetType: asteroid.type,
          oreType: asteroid.oreType,
          ql: asteroid.ql,
          qlBand: asteroid.qlBand,
          oreAmount: 0,
          x: asteroid.x,
          y: asteroid.y,
          serverTime: Date.now()
        });
        broadcastToSystem(player.system_id, {
          type: 'MINING_STATE',
          userId: player.userId,
          state: 'stop',
          targetId,
          reason: 'depleted',
          serverTime: Date.now()
        });
      }
    } catch (err) {
      console.warn('[MINING LOOP] tick failed', err?.message || err);
    }
  }
}

async function tickPersistPlayers(now) {
  const dirtyPlayers = [];
  for (const [, p] of players) {
    if (!p || p.docked) continue;
    if (!p._dirty && !hasDirtySections(p)) continue;
    if (p._lastPersistAt && now - p._lastPersistAt < PERSIST_INTERVAL_MS) continue;
    dirtyPlayers.push(p);
  }

  for (const p of dirtyPlayers) {
    await persistPlayerState(p, { reason: 'periodic' });
  }
}

function tickCleanupWorldState(now) {
  for (const [systemId, reg] of npcStatesBySystem) {
    for (const [id, npc] of reg) {
      const staleFor = now - (npc?.lastUpdatedAt || 0);
      if ((npc?.destroyed && staleFor > 10000) || staleFor > NPC_STATE_TTL_MS) {
        reg.delete(id);
      }
    }
    if (reg.size === 0) npcStatesBySystem.delete(systemId);
  }

  for (const [systemId, reg] of asteroidStatesBySystem) {
    for (const [id, asteroid] of reg) {
      const staleFor = now - (asteroid?.lastUpdatedAt || 0);
      if (staleFor > ASTEROID_STATE_TTL_MS) {
        reg.delete(id);
      }
    }
    if (reg.size === 0) asteroidStatesBySystem.delete(systemId);
  }

  for (const [systemId, reg] of projectileStatesBySystem) {
    for (const [id, projectile] of reg) {
      const staleFor = now - (projectile?.lastUpdatedAt || projectile?.createdAt || 0);
      if (staleFor > PROJECTILE_STATE_TTL_MS) {
        reg.delete(id);
      }
    }
    if (reg.size === 0) projectileStatesBySystem.delete(systemId);
  }
}

function tickValidatePlayerLocks(now) {
  for (const [socket, player] of players) {
    const lock = player?.validatedLock;
    if (!player || !lock) continue;

    if (player.docked || !player.system_id || (player.hp ?? 1) <= 0) {
      sendTargetLockInvalidated(socket, player, {
        targetId: lock.targetId,
        reason: player.docked ? 'docked' : 'source_unavailable',
        isFriendly: !!lock.isFriendly
      });
      continue;
    }

    const targetRef = findPlayerSocketByUserId(lock.targetId);
    if (!targetRef || !targetRef.player) {
      sendTargetLockInvalidated(socket, player, {
        targetId: lock.targetId,
        reason: 'target_missing',
        isFriendly: !!lock.isFriendly
      });
      continue;
    }

    const target = targetRef.player;
    if (target.docked || (target.hp ?? 1) <= 0) {
      sendTargetLockInvalidated(socket, player, {
        targetId: lock.targetId,
        reason: target.docked ? 'target_docked' : 'target_destroyed',
        isFriendly: !!lock.isFriendly
      });
      continue;
    }

    if (target.system_id !== player.system_id || (lock.system_id && lock.system_id !== player.system_id)) {
      sendTargetLockInvalidated(socket, player, {
        targetId: lock.targetId,
        reason: 'system_mismatch',
        isFriendly: !!lock.isFriendly
      });
      continue;
    }

    const dist = distance2D(player.x, player.y, target.x, target.y);
    const allowedRange = Math.max(100, Math.min(PLAYER_LOCK_MAX_RANGE, finiteNum(lock.lockRange, 2200))) + 75;
    if (dist > allowedRange) {
      sendTargetLockInvalidated(socket, player, {
        targetId: lock.targetId,
        reason: 'out_of_range',
        isFriendly: !!lock.isFriendly
      });
    }
  }
}

let _tickRunning = false;
let _lastCleanupAt = 0;
setInterval(async () => {
  if (_tickRunning) return;
  _tickRunning = true;
  const now = Date.now();
  try {
    tickNpcThreatAndCombat(now, SERVER_TICK_MS);
    tickProjectiles(now, SERVER_TICK_MS);
    tickBattlegrounds(now);
    tickInstanceBoundaries(now, SERVER_TICK_MS);
    await tickMining(now);
    await tickPersistPlayers(now);
    tickValidatePlayerLocks(now);
    if (!_lastCleanupAt || now - _lastCleanupAt >= WORLD_CLEANUP_INTERVAL_MS) {
      _lastCleanupAt = now;
      tickCleanupWorldState(now);
    }
  } catch (err) {
    console.warn('[SERVER TICK] failed', err?.message || err);
  } finally {
    _tickRunning = false;
  }
}, SERVER_TICK_MS);

await loadNpcModifiers();
await loadGameContent();

// -----------------------------------------------------
// WEBSOCKET SERVER
// -----------------------------------------------------
const wss = new WebSocketServer({ port: 2096 });
console.log("Sectorfall backend running on port 2096");

wss.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    switch (data.type) {
      case "HELLO":
        return await handleHello(socket, data);
      case "DOCK":
        return await handleDock(socket, data);
      case "RESPAWN_HOME":
        return await handleRespawnHomeStarport(socket, data);
      case "UNDOCK":
        return await handleUndock(socket, data);
      case "JOIN_SYSTEM":
        return await handleJoinSystem(socket, data);
      case "ARENA_ENTER":
        return await handleArenaEnter(socket, data);
      case "ARENA_LEAVE":
        return await handleArenaLeave(socket, data);
      case "ARENA_READY":
        return await handleArenaReady(socket, data);
      case "BATTLEGROUND_INSPECT":
        return await handleBattlegroundInspect(socket, data);
      case "BATTLEGROUND_ENTER":
        return await handleBattlegroundEnter(socket, data);
      case "BATTLEGROUND_READY":
        return await handleBattlegroundReady(socket, data);
      case "BATTLEGROUND_LEAVE":
        return await handleBattlegroundLeave(socket, data);
      case "BATTLEGROUND_EXTRACT":
        return await handleBattlegroundExtract(socket, data);
      case "BATTLEGROUND_CONTINUE":
        return await handleBattlegroundContinue(socket, data);
      case "JUMP_SYSTEM":
        return await handleJumpSystem(socket, data);
      case "PING":
        return handlePing(socket);
      case "TELEMETRY":
        return handleTelemetry(socket, data);
      case "FIRE_WEAPON":
        return handleFireWeapon(socket, data);
      case "FX_EVENT":
        return handleFxEvent(socket, data);
      case "SELF_DAMAGE":
        return handleSelfDamage(socket, data);
      case "SPAWN_WORLD_OBJECT":
        return await handleSpawnWorldObject(socket, data);
      case "COLLECT_WORLD_OBJECT":
        return await handleCollectWorldObject(socket, data);
      case "LOCK_TARGET_STATE":
        return handleLockTargetState(socket, data);
      case "NPC_STATE_SYNC":
        return handleNpcStateSync(socket, data);
      case "NPC_FIRE_WEAPON":
        return handleNpcFireWeapon(socket, data);
      case "NPC_HIT_REQUEST":
        return await handleNpcHitRequest(socket, data);
      case "ASTEROID_HIT_REQUEST":
        return handleAsteroidHitRequest(socket, data);
      case "START_MINING":
        return handleStartMining(socket, data);
      case "STOP_MINING":
        return handleStopMining(socket, data);
      case "FLEET_INVITE_REQUEST":
        return await handleFleetInviteRequest(socket, data);
      case "FLEET_INVITE_ACCEPT":
        return await handleFleetInviteAccept(socket, data);
      case "FLEET_INVITE_DECLINE":
        return await handleFleetInviteDecline(socket, data);
      case "FLEET_LEAVE_REQUEST":
        return await handleFleetLeaveRequest(socket, data);
      case "FLEET_KICK_REQUEST":
        return await handleFleetKickRequest(socket, data);
      case "FLEET_PROMOTE_REQUEST":
        return await handleFleetPromoteRequest(socket, data);
      case "COMMANDER_GET_STATE":
        return await handleCommanderGetState(socket, data);
      case "COMMANDER_ACTIVATE_SHIP":
        return await handleCommanderActivateShip(socket, data);
      case "COMMANDER_REPAIR_SHIP":
        return await handleCommanderRepairShip(socket, data);
      case "FABRICATE_BLUEPRINT_REQUEST":
        return await handleFabricateBlueprint(socket, data);
      case "REFINE_ORE_REQUEST":
        return await handleRefineOre(socket, data);
      case "MARKET_FETCH_DATA":
        return await handleMarketFetchData(socket, data);
      case "MARKET_SEED_VENDOR":
        return await handleMarketSeedVendor(socket, data);
      case "MARKET_CREATE_SELL_ORDER":
        return await handleMarketCreateSellOrder(socket, data);
      case "MARKET_CREATE_BUY_ORDER":
        return await handleMarketCreateBuyOrder(socket, data);
      case "MARKET_BUY_LISTING":
        return await handleMarketBuyListing(socket, data);
      case "MARKET_CANCEL_SELL_ORDER":
        return await handleMarketCancelSellOrder(socket, data);
      case "MARKET_CANCEL_BUY_ORDER":
        return await handleMarketCancelBuyOrder(socket, data);
    }
  });

  socket.on("close", async () => {
    const player = players.get(socket);

    if (player) {
      // Best-effort: if in space and dirty, persist once on disconnect
      if (!player.docked && (player._dirty || hasDirtySections(player))) {
        await persistPlayerState(player, { reason: "disconnect" });
      }

      broadcastPlayerLeftForSystem(player.system_id, player.userId, socket);
    }

    if (player?.userId) {
      removeFleetMembership(player.userId);
      removePendingFleetInvitesForUser(player.userId);
      removePlayerFromArenaInstances(player.userId);
    }
    players.delete(socket);
  });
})

const STARPORT_SYSTEM_ID_MAP = Object.freeze({
  cygnus_prime_starport: 'cygnus-prime',
  iron_reach_starport: 'iron-reach',
  obsidian_fringe_starport: 'obsidian-fringe',
  aurora_outpost_starport: 'aurora-outpost',
  vanta_edge_starport: 'vanta-edge'
});

function resolveSystemIdForStarport(starportId) {
  const normalizedStarportId = normalizeStarportId(starportId);
  return STARPORT_SYSTEM_ID_MAP[normalizedStarportId] || 'cygnus-prime';
}

function buildDockedRespawnTelemetry(starportId) {
  const system_id = resolveSystemIdForStarport(starportId);
  return { system_id, x: 150, y: 150, rot: 0, vx: 0, vy: 0 };
}

async function finalizeHomeStarportRespawn(player, requestedStarportId) {
  if (!player?.userId) return { ok: false, error: 'invalid_player' };

  const starport_id = normalizeStarportId(requestedStarportId) || normalizeStarportId('cygnus_prime_starport');
  const system_id = resolveSystemIdForStarport(starport_id);
  const telemetry = buildDockedRespawnTelemetry(starport_id);

  player.system_id = system_id;
  player.docked = true;
  player.destroyed = false;
  player.starport_id = starport_id;
  player.x = telemetry.x;
  player.y = telemetry.y;
  player.rot = telemetry.rot;
  player.vx = telemetry.vx;
  player.vy = telemetry.vy;
  player.lastSpaceTelemetry = telemetry;
  clearValidatedLock(player);

  await hydratePlayerFromCommanderActiveShip(player, { fillVitals: true, persistState: false });

  const payload = {
    player_id: player.userId,
    ship_type: player.ship_type || 'ship_omni_scout',
    system_id,
    starport_id,
    telemetry,
    hull: typeof player.hp === 'number' ? player.hp : undefined,
    maxHp: typeof player.maxHp === 'number' ? player.maxHp : undefined,
    shields: typeof player.shields === 'number' ? player.shields : undefined,
    maxShields: typeof player.maxShields === 'number' ? player.maxShields : undefined,
    energy: typeof player.energy === 'number' ? player.energy : undefined,
    maxEnergy: typeof player.maxEnergy === 'number' ? player.maxEnergy : undefined,
    fittings: player.fittings || {},
    updated_at: nowIso()
  };

  const { error } = await supabase
    .from('ship_states_v2')
    .upsert(payload, { onConflict: 'player_id' });

  if (error) {
    console.warn('[Respawn] Failed to persist home-starport dock state:', player.userId, error.message);
    return { ok: false, error: 'persist_failed', starport_id, system_id, telemetry };
  }

  return { ok: true, starport_id, system_id, telemetry };
}

;