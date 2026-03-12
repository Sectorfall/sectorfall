import * as THREE from 'three';
import { Joystick } from './Joystick.js';
import * as Tone from 'tone';
import { audioManager } from './AudioManager.js';
import { NPCAI } from './NPCAI.js';
import { cloudService } from './CloudService.js';
import { WorldObjectsService } from './WorldObjectsService.js';
import { applyAuthoritativeInventory, broadcastLootRemoval, queueLootToast } from './InventoryService.js';
const DEBUG_VITALS = false;
const DEBUG_SPAWN = false;

import { 
    SHIP_REGISTRY, 
    OMNI_INTERCEPTOR_URL, OMNI_MINING_SHIP_URL, OMNI_COMMAND_URL, OMNI_GUNSHIP_URL, 
    SOVEREIGN_URL, OMNI_SCOUT_URL, OMNI_HAULER_URL 
} from './shipRegistry.js';
import { createNpcShipProfile } from './data/ships/loadouts.js';
import { resolveShipId, resolveShipRegistryKey } from './data/ships/catalog.js';
import { STARPORT_URL, STRUCTURE_URLS } from './data/assets.js';
import { SpaceSquid } from './SpaceSquid.js';
import { uuid } from './utils.js';
import { switchSystem, broadcastObjectRemoval, broadcastFxEvent } from './multiplayer.js';
import { remotePlayers } from "./websocket.js";
import { backendSocket } from "./websocket.js";
import { SYSTEMS_REGISTRY, STARPORT_TO_SYSTEM, SYSTEM_TO_STARPORT } from './data/systemsRegistry.js';
import { FLUX_LASER_CONFIGS, FLUX_RARITY_MODS, PULSE_CANNON_CONFIGS, PULSE_RARITY_MODS, MISSILE_CONFIGS, MISSILE_RARITY_MODS, MINING_LASER_CONFIGS, MINING_RARITY_MODS, DRONE_MODULE_CONFIGS, DRONE_STATS } from './data/weaponConfigs.js';
import { BLUEPRINT_REGISTRY } from './data/blueprints.js';

// --- Data registries (split out of GameManager) ---
import { TRADE_CONFIG } from './data/tradeConfig.js';
import { LOOT_TABLES } from './data/lootTables.js';
import { LORE_REGISTRY } from './data/loreRegistry.js';
import { BIO_MATERIAL_REGISTRY } from './data/bioMaterials.js';
import { LEVEL_REQUIREMENTS, SECURITY_MODIFIERS, TIER_CONFIGS } from './data/progression.js';
import { ASTEROID_TYPES } from './data/asteroids.js';
import { MINOR_MODIFIER_POOL, MAJOR_MODIFIER_POOL, PERK_POOL, MODIFIER_LIMITS } from './data/modifiers.js';
import { FLUX_CATALYSTS, CATALYST_DROP_TABLES } from './data/catalysts.js';
import { ION_THRUSTER_CONFIGS, SHIELD_MODULE_CONFIGS } from './data/modules.js';
import { IMPLANT_REGISTRY } from './data/implants.js';
import { BIO_CREATURE_REGISTRY } from './data/bioCreatures.js';
import { ASSETS, AUDIO_URLS, SUN_URL, ANOMALY_URL, ASTEROID_URL, NEBULA_URLS, WEAPON_ASSETS, PLANET_URLS, FLARE_URLS, WARP_GATE_URL } from "./data/assets.js";
import { ANOMALY_VERTEX_SHADER, ANOMALY_FRAGMENT_SHADER, SHIP_VERTEX_SHADER, SHIP_FRAGMENT_SHADER, FLUX_BEAM_VERTEX_SHADER, FLUX_BEAM_FRAGMENT_SHADER } from './data/shaders.js';
const ARENA_BEACON_URL = STRUCTURE_URLS.arenaBeacon;
const BATTLEGROUND_BEACON_URL = STRUCTURE_URLS.battlegroundBeacon || STRUCTURE_URLS.arenaBeacon;
const DEFAULT_BATTLEGROUND_BOUNDARY_TEXTURE_URL = 'https://rosebud.ai/assets/nebula-radiation-green-plain-cloud-v1.webp?gkLX';

function getSyntheticSystem(systemId) {
    if (typeof systemId === 'string' && systemId.startsWith('bg:pve:')) {
        return {
            id: systemId,
            name: 'Battleground',
            cluster: 'instance',
            sector: 'BATTLEGROUND',
            security: 'Controlled Combat Space',
            securityValue: 0.0,
            tier: 1,
            nebulaTypes: [],
            nebulaCount: 0,
            hasStarport: false,
            hasWarpGate: false,
            controlledBy: 'OMNI DIRECTORATE TACTICAL COMMAND',
            coords: { x: 0, y: 0 },
            sun: null,
            planet: null,
            belts: []
        };
    }
    if (typeof systemId !== 'string' || !systemId.startsWith('arena:')) return null;
    return {
        id: systemId,
        name: 'Arena',
        cluster: 'instance',
        sector: 'ARENA',
        security: 'Open Conflict (0.0)',
        securityValue: 0.0,
        tier: 1,
        nebulaTypes: ['blue', 'purple'],
        nebulaCount: 90,
        hasStarport: false,
        hasWarpGate: false,
        controlledBy: 'OMNI DIRECTORATE COMBAT NETWORK',
        coords: { x: 0, y: 0 },
        sun: { pos: { x: 900, y: -900 }, size: 220 },
        planet: { pos: { x: -1200, y: 700 }, size: 110 },
        belts: []
    };
}

function resolveSystemDefinition(systemId) {
    return SYSTEMS_REGISTRY[systemId] || getSyntheticSystem(systemId) || null;
}
export { SYSTEMS_REGISTRY, STARPORT_TO_SYSTEM, SYSTEM_TO_STARPORT, FLUX_LASER_CONFIGS, FLUX_RARITY_MODS, PULSE_CANNON_CONFIGS, PULSE_RARITY_MODS, MISSILE_CONFIGS, MISSILE_RARITY_MODS, MINING_LASER_CONFIGS, MINING_RARITY_MODS, DRONE_MODULE_CONFIGS, DRONE_STATS, BLUEPRINT_REGISTRY, TRADE_CONFIG, LOOT_TABLES, LORE_REGISTRY, BIO_MATERIAL_REGISTRY, LEVEL_REQUIREMENTS, SECURITY_MODIFIERS, TIER_CONFIGS, ASTEROID_TYPES, MINOR_MODIFIER_POOL, MAJOR_MODIFIER_POOL, PERK_POOL, MODIFIER_LIMITS, FLUX_CATALYSTS, CATALYST_DROP_TABLES, ION_THRUSTER_CONFIGS, SHIELD_MODULE_CONFIGS, IMPLANT_REGISTRY, BIO_CREATURE_REGISTRY
  , WEAPON_ASSETS
};

function normalizeShipTypeKey(shipType) {
    const shipId = resolveShipId(shipType) || shipType;
    const registryKey = resolveShipRegistryKey(shipId) || resolveShipRegistryKey(shipType) || shipId || 'OMNI SCOUT';
    return registryKey;
}
// -----------------------------------------------------
// REMOTE PLAYER UPDATE SYSTEM
// -----------------------------------------------------
export function updateRemotePlayers(dt) {
    for (const p of remotePlayers.values()) {
        if (!p.sprite) continue;

        // Smooth interpolation toward target state
        p.x += (p.targetX - p.x) * 0.15;
        p.y += (p.targetY - p.y) * 0.15;
        p.rot += (p.targetRot - p.rot) * 0.15;

        // Apply to sprite
        p.sprite.x = p.x;
        p.sprite.y = p.y;
        p.sprite.rotation = p.rot;
    }
}


















export const getRequiredExp = (level) => {
    // Level is 1-indexed, array is 0-indexed
    return LEVEL_REQUIREMENTS[Math.min(level - 1, LEVEL_REQUIREMENTS.length - 1)] || 1000;
};














































export const getQLBand = (ql) => {
    if (ql <= 25) return '1-25';
    if (ql <= 50) return '26-50';
    if (ql <= 100) return '51-100';
    if (ql <= 150) return '101-150';
    if (ql <= 250) return '151-250';
    return '251-300';
};

const RARITY_ACCENT_COLORS = {
    common: 0xffffff,
    rare: 0x00ccff,
    epic: 0xa335ee,
    legendary: 0xffcc00,
    mythic: 0xffcc00
};

// Seeded Random for Multiplayer Determinism
class SeededRandom {
    constructor(seed = 42) {
        this.seed = seed;
    }
    next() {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
}

// Signature and Size Logic Utilities
const SIZE_TIER_MAP = { "S": 1, "M": 2, "L": 3 };
export const getSizeTier = (size) => SIZE_TIER_MAP[size] || 1;

export const getOversizeInfo = (shipConfig, weapon) => {
    const size = weapon?.size || weapon?.weaponsize;
    if (!weapon || !size || !shipConfig.recommendedWeaponSizes) {
        return { oversized: false, tierDiff: 0 };
    }

    // If weapon size is in recommended list, it's fine
    if (shipConfig.recommendedWeaponSizes.includes(size)) {
        return { oversized: false, tierDiff: 0 };
    }

    const weaponTier = getSizeTier(size);
    const recommendedTiers = shipConfig.recommendedWeaponSizes.map(s => getSizeTier(s));
    const minRecTier = Math.min(...recommendedTiers);

    // Undersized check: if weapon tier is less than all recommended tiers, no penalty
    if (weaponTier < minRecTier) {
        return { oversized: false, tierDiff: 0 };
    }

    // Otherwise it's oversized
    const maxRecTier = Math.max(...recommendedTiers);
    const diff = Math.max(0, weaponTier - maxRecTier);
    
    return { 
        oversized: diff > 0, 
        tierDiff: diff 
    };
};







export const getShieldModuleStats = (module) => {
    if (!module) return null;
    const { finalStats } = getEffectiveModuleStats(module);
    if (Object.keys(finalStats).length <= 0) return null;
    return {
        capacity: Number(finalStats.capacity ?? finalStats.shieldCapacity ?? 0),
        regen: Number(finalStats.regen ?? finalStats.shieldRegen ?? 0),
        power: Number(finalStats.power ?? module.power ?? 0),
        cpu: Number(finalStats.cpu ?? module.cpu ?? 0)
    };
};

export const getIonThrusterStats = (module) => {
    if (!module) return null;
    const { finalStats } = getEffectiveModuleStats(module);
    if (Object.keys(finalStats).length > 0) {
        return {
            speedBoost: Number(finalStats.speedBoost ?? finalStats.maxVelocity ?? 0),
            sigPenalty: Number(finalStats.sigPenalty ?? finalStats.signaturePenalty ?? 0),
            energyDrain: Number(finalStats.energyDrain ?? finalStats.energyUse ?? 0),
            power: Number(finalStats.power ?? module.power ?? 0),
            cpu: Number(finalStats.cpu ?? module.cpu ?? 0)
        };
    }
    const base = ION_THRUSTER_CONFIGS[module.size || module.weaponsize || 'S'];
    if (!base) return null;
    
    const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    const tier = rarityTiers.indexOf((module.rarity || 'common').toLowerCase());
    
    const requirements = getItemResourceRequirements(module);
    
    return {
        speedBoost: base.baseSpeedBoostPercent + (tier * 2),
        sigPenalty: base.baseSignaturePenalty,
        energyDrain: Math.max(1, base.baseEnergyDrain - tier),
        power: requirements.power,
        cpu: requirements.cpu
    };
};

/**
 * Calculates the required commander stat for an implant based on its QL.
 * Formula: floor((QL * 0.28) + 3)
 */
export const calculateImplantRequirement = (ql) => {
    return Math.floor((ql * 0.28) + 3);
};






export const calculateQLModifier = (avgQL) => {
    if (avgQL <= 120) {
        // Linear between 1 (-10%) and 120 (0%)
        // slope = (0 - (-0.1)) / (120 - 1) = 0.1 / 119
        return -0.10 + (0.10 / 119) * (avgQL - 1);
    } else {
        // Linear between 120 (0%) and 300 (20%)
        // slope = (0.2 - 0) / (300 - 120) = 0.2 / 180
        return 0 + (0.20 / 180) * (avgQL - 120);
    }
};

/**
 * Hydrates an item by loading its base stats and applying quality modifiers.
 * Authoritative quality is read from item.quality.
 * Returns a new item object with base_stats and final_stats populated.
 */
export const hydrateItem = (item) => {
    if (!item) return null;
    const authoritativeHydrated = buildHydratedStatsFromAuthoritativeModule(item);
    if (authoritativeHydrated) return authoritativeHydrated;
    
    // Authoritative properties
    const size = (item.weaponsize || item.size || 'S').toUpperCase();
    const type = (item.type || '').toLowerCase();
    const name = (item.name || '').toLowerCase();
    const rarity = (item.rarity || 'common').toLowerCase();
    const quality = item.quality || 120; // 120 is the zero-point for base stats

    let base_stats = null;
    let category = '';

    if (name.includes('flux')) {
        base_stats = FLUX_LASER_CONFIGS[size];
        category = 'flux';
    } else if (name.includes('mining') || type === 'mining') {
        base_stats = MINING_LASER_CONFIGS[size];
        category = 'mining';
    } else if (name.includes('pulse')) {
        base_stats = PULSE_CANNON_CONFIGS[size];
        category = 'pulse';
    } else if (name.includes('seeker') || name.includes('missile')) {
        base_stats = MISSILE_CONFIGS[size];
        category = 'missile';
    } else if (type === 'thruster') {
        base_stats = ION_THRUSTER_CONFIGS[size];
        category = 'thruster';
    } else if (type === 'shield') {
        base_stats = SHIELD_MODULE_CONFIGS[size];
        category = 'shield';
    } else if (type === 'drone-module') {
        const droneConfig = BLUEPRINT_REGISTRY[item.blueprintId] || item;
        const droneName = droneConfig.outputId || droneConfig.name || "";
        base_stats = DRONE_MODULE_CONFIGS[droneName];
        category = 'drone-module';
    }

    if (!base_stats) base_stats = {};

    // 1. Calculate Multipliers
    const qlMod = calculateQLModifier(quality);
    
    // Rarity Multiplier Lookup
    let rModData = { dmg: 1.0, range: 1.0, reload: 1.0, extraction: 1.0, fireRate: 1.0, acc: 0, speed: 1.0, cap: 1.0, regen: 1.0 };
    if (category === 'flux') {
        const rData = FLUX_RARITY_MODS[rarity];
        if (rData) rModData = { ...rModData, dmg: rData.dmg, range: rData.range };
    } else if (category === 'mining') {
        const rData = MINING_RARITY_MODS[rarity];
        if (rData) rModData = { ...rModData, extraction: rData.extraction, fireRate: rData.fireRate, range: rData.range };
    } else if (category === 'pulse') {
        const rData = PULSE_RARITY_MODS[rarity];
        if (rData) rModData = { ...rModData, dmg: rData.dmg, acc: rData.acc, reload: rData.reload };
    } else if (category === 'missile') {
        const rData = MISSILE_RARITY_MODS[rarity];
        if (rData) rModData = { ...rModData, dmg: rData.dmg, speed: rData.speed, reload: rData.reload, tracking: rData.tracking };
    } else if (category === 'shield') {
        const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
        const tierIdx = rarityTiers.indexOf(rarity);
        if (tierIdx !== -1) {
            rModData = { ...rModData, cap: 1 + (tierIdx * 0.1), regen: 1 + (tierIdx * 0.2) }; // Approximation based on existing functions
        }
    } else if (category === 'thruster') {
        const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
        const tierIdx = rarityTiers.indexOf(rarity);
        if (tierIdx !== -1) {
            rModData = { ...rModData, speed: 1 + (tierIdx * 0.05) };
        }
    }

    // Catalyst/Modifier lookup helper
    const getCatMod = (tag) => (item.modifiers?.filter(m => m.tag === tag).reduce((s, m) => s + (m.currentRoll / 100), 0) || 0);

    // 2. Final Stat Computation and Difference Tracking
    const final_stats = { ...base_stats };
    const modifiedStats = {};

    const apply = (statId, baseVal, multipliers = [], additions = []) => {
        if (baseVal === undefined) return;
        let finalVal = baseVal;
        multipliers.forEach(m => {
            if (m !== undefined) finalVal *= m;
        });
        additions.forEach(a => {
            if (a !== undefined) finalVal += a;
        });
        final_stats[statId] = finalVal;
        
        // Calculate total percentage diff for UI color coding
        const percent = ((finalVal / baseVal) - 1) * 100;
        modifiedStats[statId] = { percent };
    };

    // Generic stat mapping for the QL multiplier
    const commonStats = ['damage', 'damagePerTick', 'baseExtraction', 'optimalRange', 'falloffRange', 'capacity', 'regen', 'speedBoost', 'missileSpeed', 'projectileSpeed', 'tracking', 'baseAccuracy'];
    
    // Apply type-specific scaling logic
    if (category === 'flux') {
        apply('damagePerTick', base_stats.damagePerTick, [1 + qlMod, rModData.dmg, 1 + getCatMod('damage')]);
        apply('fireRate', base_stats.fireRate, [1 + qlMod]); // Quality affects Hz
        apply('optimalRange', base_stats.optimalRange, [1 + qlMod, rModData.range, 1 + getCatMod('range')]);
        apply('falloffRange', base_stats.falloffRange, [1 + qlMod, rModData.range, 1 + getCatMod('range')]);
        apply('tracking', base_stats.tracking, [1 + qlMod, 1 + getCatMod('tracking')]);
        apply('baseAccuracy', base_stats.baseAccuracy, [1 + qlMod, 1 + getCatMod('accuracy')], [rModData.acc]);
    } else if (category === 'pulse') {
        apply('damage', base_stats.damage, [1 + qlMod, rModData.dmg, 1 + getCatMod('damage')]);
        apply('reload', base_stats.reload, [rModData.reload, 1 - getCatMod('reload'), 1 - qlMod]); // Higher QL = Faster Reload
        apply('fireRate', base_stats.fireRate, [1 + qlMod]);
        apply('magazine', base_stats.magazine, [1 + (qlMod > 0 ? qlMod * 0.5 : 0)]); // Quality slightly increases mag size
        apply('optimalRange', base_stats.optimalRange, [1 + qlMod, 1 + getCatMod('range')]);
        apply('baseAccuracy', base_stats.baseAccuracy, [1 + qlMod, 1 + getCatMod('accuracy')], [rModData.acc]);
        apply('tracking', base_stats.tracking, [1 + qlMod, 1 + getCatMod('tracking')]);
        apply('projectileSpeed', base_stats.projectileSpeed, [1 + qlMod, 1 + getCatMod('projectile_speed')]);
    } else if (category === 'mining') {
        apply('baseExtraction', base_stats.baseExtraction, [1 + qlMod, rModData.extraction, 1 + getCatMod('mining_yield')]);
        apply('fireRate', base_stats.fireRate, [rModData.fireRate, 1 - qlMod]); // Quality makes cycle faster
        apply('falloffRange', base_stats.falloffRange, [1 + qlMod, rModData.range, 1 + getCatMod('range')]);
        
        // Terminology Alignment for Industrial-Chic Systems
        final_stats.mining_yield = final_stats.baseExtraction;
        final_stats.cycle_time = final_stats.fireRate;
    } else if (category === 'missile') {
        apply('damage', base_stats.damage, [1 + qlMod, rModData.dmg, 1 + getCatMod('damage')]);
        apply('missileSpeed', base_stats.missileSpeed, [1 + qlMod, rModData.speed, 1 + getCatMod('projectile_speed')]);
        apply('reload', base_stats.reload, [rModData.reload, 1 - getCatMod('reload'), 1 - qlMod]);
        apply('tracking', base_stats.tracking, [1 + qlMod, rModData.tracking || 1.0, 1 + getCatMod('tracking')]);
        apply('optimalRange', base_stats.optimalRange, [1 + qlMod, 1 + getCatMod('range')]);
    } else if (category === 'shield') {
        apply('capacity', base_stats.baseCapacity || base_stats.capacity, [1 + qlMod, rModData.cap]);
        apply('regen', base_stats.baseRegen || base_stats.regen, [1 + qlMod, rModData.regen, 1 + getCatMod('shield_regen')]);
    } else if (category === 'thruster') {
        apply('speedBoost', base_stats.baseSpeedBoostPercent || base_stats.speedBoost, [1 + qlMod, rModData.speed, 1 + getCatMod('speed')]);
    } else if (category === 'drone-module') {
        const config = DRONE_MODULE_CONFIGS[base_stats.name || name] || base_stats;
        apply('controlRange', config.controlRange, [1 + qlMod, 1 + getCatMod('range')]);
        apply('energyDrain', config.energyDrain, [1 - getCatMod('energy_regen')]); // Energy drain reduction
        
        // Hydrate individual drone units within the module
        if (config.drones) {
            const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
            const tierIdx = rarityTiers.indexOf(rarity);
            
            final_stats.hydratedDrones = config.drones.map(dRef => {
                const dBase = DRONE_STATS[dRef.type];
                if (!dBase) return { ...dRef };

                // Apply Rarity Bonuses (Centralized here)
                let hullBonus = 1;
                let speedBonus = 1;
                if (tierIdx === 1) hullBonus = 1.1; // Uncommon
                else if (tierIdx === 2) { hullBonus = 1.2; speedBonus = 1.25; } // Rare
                else if (tierIdx === 3) { hullBonus = 1.3; speedBonus = 1.25; } // Epic
                else if (tierIdx === 4) { hullBonus = 1.4; speedBonus = 1.25; } // Legendary

                return {
                    ...dRef,
                    stats: {
                        hull: dBase.hull * hullBonus * (1 + qlMod),
                        shield: (dBase.shield || 0) * (1 + qlMod),
                        speed: dBase.speed * speedBonus * (1 + qlMod),
                        damagePerTick: (dBase.damagePerTick || 0) * (1 + qlMod),
                        miningRate: (dBase.miningRate || 0) * (1 + qlMod),
                        repairRate: (dBase.repairRate || 0) * (1 + qlMod),
                        accuracy: dBase.accuracy
                    }
                };
            });
        }
    } else {
        // Fallback for generic items
        commonStats.forEach(stat => {
            if (base_stats[stat] !== undefined) {
                apply(stat, base_stats[stat], [1 + qlMod]);
            }
        });
    }
    if (final_stats.baseAccuracy !== undefined) {
        final_stats.accuracy = final_stats.baseAccuracy;
        modifiedStats.accuracy = modifiedStats.baseAccuracy;
    }

    // 3. Populate Power/CPU Requirements correctly based on item properties
    const requirements = getItemResourceRequirements(item);
    final_stats.power = requirements.power;
    final_stats.cpu = requirements.cpu;

    return {
        ...item,
        base_stats,
        final_stats,
        modifiedStats,
        quality
    };
};

/**
 * Returns the color code for a given modification percentage.
 * Positive modifiers: green (+1-6%), blue (+7-14%), purple (+14-19%), gold (+20%).
 * Negative/0: white.
 */
export const getModColor = (modPercent) => {
    if (modPercent >= 20) return '#ffcc00'; // Gold (+20%)
    if (modPercent >= 14) return '#a335ee'; // Purple (+14-19%)
    if (modPercent >= 7) return '#00ccff';  // Blue (+7-14%)
    if (modPercent >= 1) return '#00ff00';  // Green (+1-6%)
    return '#ffffff'; // White/Default (Negative/Zero)
};


const resolveAuthoritativeModuleResourceUsage = (item) => {
    if (!item || typeof item !== 'object') return null;
    const finalStats = (item.final_stats && typeof item.final_stats === 'object') ? item.final_stats : null;
    const moduleStats = (item.authoritative_module_stats && typeof item.authoritative_module_stats === 'object')
        ? item.authoritative_module_stats
        : ((item.module_stats && typeof item.module_stats === 'object') ? item.module_stats : null);
    const power = Number(
        finalStats?.power ?? item.power ?? moduleStats?.power ?? moduleStats?.powergridUse ?? moduleStats?.powergrid_use ?? moduleStats?.pgUse ?? moduleStats?.pg ?? moduleStats?.basePG
    );
    const cpu = Number(
        finalStats?.cpu ?? item.cpu ?? moduleStats?.cpu ?? moduleStats?.cpuUse ?? moduleStats?.cpu_use ?? moduleStats?.baseCPU
    );
    if (Number.isFinite(power) || Number.isFinite(cpu)) {
        return { power: Number.isFinite(power) ? power : 0, cpu: Number.isFinite(cpu) ? cpu : 0 };
    }
    return null;
};

const buildHydratedStatsFromAuthoritativeModule = (item) => {
    if (!item || typeof item !== 'object') return null;
    const moduleStats = (item.authoritative_module_stats && typeof item.authoritative_module_stats === 'object')
        ? item.authoritative_module_stats
        : ((item.module_stats && typeof item.module_stats === 'object') ? item.module_stats : null);
    if (!moduleStats) return null;
    const base_stats = { ...moduleStats };
    const final_stats = { ...(item.final_stats && typeof item.final_stats === 'object' ? item.final_stats : moduleStats) };
    const requirements = resolveAuthoritativeModuleResourceUsage(item) || { power: 0, cpu: 0 };
    final_stats.power = requirements.power;
    final_stats.cpu = requirements.cpu;
    return {
        ...item,
        base_stats,
        final_stats,
        quality: item.quality || item.avgQL || 120
    };
};


const getEffectiveModuleStats = (module) => {
    if (!module) return { item: null, finalStats: {}, baseStats: {} };
    const effectiveItem = buildHydratedStatsFromAuthoritativeModule(module) || module;
    const finalStats = (effectiveItem?.final_stats && typeof effectiveItem.final_stats === 'object') ? effectiveItem.final_stats : {};
    const baseStats = (effectiveItem?.base_stats && typeof effectiveItem.base_stats === 'object') ? effectiveItem.base_stats : {};
    return { item: effectiveItem || module, finalStats, baseStats };
};

const getAuthoritativeDroneModuleProfile = (module) => {
    const { item: effectiveModule, finalStats } = getEffectiveModuleStats(module);
    const hydratedDrones = Array.isArray(finalStats?.hydratedDrones) ? finalStats.hydratedDrones : [];
    return {
        module: effectiveModule || module,
        finalStats,
        hydratedDrones,
        controlRange: Number(finalStats?.controlRange ?? 0),
        energyDrain: Number(finalStats?.energyDrain ?? 0)
    };
};

export const getItemResourceRequirements = (item) => {
    if (!item) return { power: 0, cpu: 0 };
    const authoritative = resolveAuthoritativeModuleResourceUsage(item);
    if (authoritative) return authoritative;
    
    const isBlueprint = item.type === 'blueprint';
    const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    const tier = rarityTiers.indexOf((item.rarity || 'common').toLowerCase());
    const size = item.size || item.weaponsize || 'S';
    const type = (isBlueprint ? (item.outputType || '') : (item.type || '')).toLowerCase();
    const name = (item.name || '').toLowerCase();

    let basePG = 0;
    let baseCPU = 0;
    let increment = 2; // Default increment

    if (type === 'weapon' || type === 'mining' || name.includes('flux') || name.includes('pulse') || name.includes('seeker')) {
        if (name.includes('flux')) {
            const config = FLUX_LASER_CONFIGS[size];
            if (config) {
                basePG = config.power;
                baseCPU = config.cpu;
                increment = 3;
            }
        } else if (name.includes('pulse')) {
            const config = PULSE_CANNON_CONFIGS[size];
            if (config) {
                basePG = config.power;
                baseCPU = config.cpu;
                increment = 3;
            }
        } else if (name.includes('mining') || type === 'mining') {
            const config = MINING_LASER_CONFIGS[size];
            if (config) {
                basePG = config.power;
                baseCPU = config.cpu;
                increment = 3;
            }
        } else if (name.includes('seeker')) {
            const config = MISSILE_CONFIGS[size];
            if (config) {
                basePG = config.power;
                baseCPU = config.cpu;
                increment = 4;
            }
        }
    } else if (type === 'shield' || name.includes('shield')) {
        const config = SHIELD_MODULE_CONFIGS[size];
        if (config) {
            basePG = config.basePG;
            baseCPU = config.baseCPU;
            increment = 4;
        }
    } else if (type === 'thruster' || name.includes('thruster')) {
        const config = ION_THRUSTER_CONFIGS[size];
        if (config) {
            basePG = config.basePG;
            baseCPU = config.baseCPU;
            increment = 2;
        }
    } else if (type === 'drone-module' || name.includes('drone')) {
        const config = DRONE_MODULE_CONFIGS[item.outputId || item.name];
        if (config) {
            basePG = config.pg;
            baseCPU = config.cpu;
            increment = 3;
        }
    } else {
        // Fallback for unknown items
        return { power: item.power || 0, cpu: item.cpu || 0 };
    }

    // Deterministic random for PG/CPU based on module ID
    const id = item.id || 'default';
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash) + id.charCodeAt(i);
        hash |= 0;
    }
    const rng = new SeededRandom(Math.abs(hash));

    let pg = basePG;
    let cpu = baseCPU;

    for (let i = 0; i < tier; i++) {
        if (rng.next() > 0.5) pg += increment; else cpu += increment;
    }

    return { power: pg, cpu: cpu };
};

export const applyCraftingModifications = (item, avgQL, allowedStats) => {
    if (!allowedStats || allowedStats.length === 0) return item;
    
    const modifier = calculateQLModifier(avgQL);
    const modItem = { ...item, modifiedStats: {}, avgQL, modifiers: [], perks: [] };
    
    // Determine min stats based on item type
    let minStats = 2;
    if (item.type === 'shield') minStats = 1;
    
    // Pick between min and all stats
    const count = Math.max(minStats, Math.floor(Math.random() * (allowedStats.length - minStats + 1)) + minStats);
    
    // Shuffle and pick
    const shuffled = [...allowedStats].sort(() => 0.5 - Math.random());
    const selectedStats = shuffled.slice(0, count);
    
    // Set initial PG/CPU based on rarity
    const requirements = getItemResourceRequirements(modItem);
    modItem.power = requirements.power;
    modItem.cpu = requirements.cpu;
    
    selectedStats.forEach(stat => {
        const baseValue = item[stat] || 0;
        // Apply modifier: new = base * (1 + modifier)
        const newValue = baseValue * (1 + modifier);
        modItem[stat] = newValue;
        modItem.modifiedStats[stat] = {
            base: baseValue,
            modifier: modifier,
            percent: Math.round(modifier * 100)
        };
    });
    
    // Generate initial modifiers based on rarity
    const limits = MODIFIER_LIMITS[item.rarity || 'common'];
    if (limits) {
        for (let i = 0; i < limits.minor; i++) {
            modItem.modifiers.push(generateRandomModifier('minor', modItem.modifiers));
        }
        for (let i = 0; i < limits.major; i++) {
            modItem.modifiers.push(generateRandomModifier('major', modItem.modifiers));
        }
    }
    
    return modItem;
};

export const generateRandomModifier = (type, existingModifiers = []) => {
    const pool = type === 'minor' ? MINOR_MODIFIER_POOL : MAJOR_MODIFIER_POOL;
    const existingTags = existingModifiers.map(m => m.tag);
    const available = pool.filter(m => !existingTags.includes(m.tag));
    const selected = (available.length > 0 ? available : pool)[Math.floor(Math.random() * (available.length > 0 ? available.length : pool.length))];
    
    const roll = selected.minRoll + Math.random() * (selected.maxRoll - selected.minRoll);
    
    return {
        name: selected.name,
        type: type,
        tag: selected.tag,
        minRoll: selected.minRoll,
        maxRoll: selected.maxRoll,
        currentRoll: Number(roll.toFixed(1))
    };
};

export const applyCatalystToItem = (item, catalystId) => {
    if (!item) return null;
    const newItem = JSON.parse(JSON.stringify(item)); // Deep clone to be safe
    if (!newItem.modifiers) newItem.modifiers = [];
    if (!newItem.perks) newItem.perks = [];
    
    // Normalize catalystId and item rarity
    const catId = (catalystId || '').toLowerCase();
    newItem.rarity = (newItem.rarity || 'common').toLowerCase();
    
    const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
    const currentRarityIdx = rarityTiers.indexOf(newItem.rarity);
    
    const limits = MODIFIER_LIMITS[newItem.rarity] || MODIFIER_LIMITS.common;
    const minorCount = newItem.modifiers.filter(m => m.type === 'minor').length;
    const majorCount = newItem.modifiers.filter(m => m.type === 'major').length;

    let modified = false;

    switch (catId) {
        case 'catalyst-quantum-uplifter':
            if (newItem.rarity === 'common') {
                newItem.rarity = 'uncommon';
                modified = true;
            }
            // Add minor modifier if slot is free (now uses new rarity limit)
            const upLimits = MODIFIER_LIMITS[newItem.rarity];
            if (newItem.modifiers.filter(m => m.type === 'minor').length < upLimits.minor) {
                newItem.modifiers.push(generateRandomModifier('minor', newItem.modifiers));
                modified = true;
            }
            break;

        case 'catalyst-nano-infusion-chip':
            if (limits && minorCount < limits.minor) {
                newItem.modifiers.push(generateRandomModifier('minor', newItem.modifiers));
                modified = true;
            }
            break;

        case 'catalyst-pattern-rewriter':
            if (newItem.modifiers.some(m => m.type === 'minor')) {
                newItem.modifiers = newItem.modifiers.map(m => {
                    if (m.type === 'minor') {
                        const roll = m.minRoll + Math.random() * (m.maxRoll - m.minRoll);
                        return { ...m, currentRoll: Number(roll.toFixed(1)) };
                    }
                    return m;
                });
                modified = true;
            }
            break;

        case 'catalyst-singularity-catalyst':
            if (currentRarityIdx < rarityTiers.length - 1) {
                newItem.rarity = rarityTiers[currentRarityIdx + 1];
                const nextLimits = MODIFIER_LIMITS[newItem.rarity];
                newItem.modifiers = [];
                if (nextLimits) {
                    for (let i = 0; i < nextLimits.minor; i++) {
                        newItem.modifiers.push(generateRandomModifier('minor', newItem.modifiers));
                    }
                    for (let i = 0; i < nextLimits.major; i++) {
                        newItem.modifiers.push(generateRandomModifier('major', newItem.modifiers));
                    }
                }
                modified = true;
            }
            break;

        case 'catalyst-entropy-reconstructor':
            if (newItem.modifiers.length > 0) {
                newItem.modifiers = newItem.modifiers.map(m => {
                    const roll = m.minRoll + Math.random() * (m.maxRoll - m.minRoll);
                    return { ...m, currentRoll: Number(roll.toFixed(1)) };
                });
                modified = true;
            }
            break;

        case 'catalyst-reality-recalibrator':
            if (newItem.modifiers.length > 0) {
                newItem.modifiers = newItem.modifiers.map(m => {
                    const distanceToMax = m.maxRoll - m.currentRoll;
                    if (distanceToMax <= 0) return m;
                    const boostPercent = 0.10 + Math.random() * 0.10; // 10-20%
                    const boost = distanceToMax * boostPercent;
                    modified = true;
                    return {
                        ...m,
                        currentRoll: Number(Math.min(m.maxRoll, m.currentRoll + boost).toFixed(1))
                    };
                });
            }
            break;

        case 'catalyst-molecular-purge-cell':
            if (newItem.modifiers.length > 0) {
                newItem.modifiers = [];
                modified = true;
            }
            break;

        case 'catalyst-fault-line-scrubber':
            if (newItem.modifiers.length > 0) {
                const idx = Math.floor(Math.random() * newItem.modifiers.length);
                newItem.modifiers = newItem.modifiers.filter((_, i) => i !== idx);
                modified = true;
            }
            break;

        case 'catalyst-imperial-charge-core':
            if (limits && majorCount < limits.major) {
                newItem.modifiers.push(generateRandomModifier('major', newItem.modifiers));
                modified = true;
            }
            break;

        case 'catalyst-ascendant-modulator':
            if (newItem.perks.length === 0) {
                const perk = PERK_POOL[Math.floor(Math.random() * PERK_POOL.length)];
                newItem.perks.push(perk);
                modified = true;
            }
            break;
    }

    if (!modified) return null;

    // After rarity change or catalyst application, recalculate PG/CPU requirements
    const requirements = getItemResourceRequirements(newItem);
    newItem.power = requirements.power;
    newItem.cpu = requirements.cpu;

    return newItem;
};

const TRIDRONE_URL = 'https://rosebud.ai/assets/tridrone.png?S2gk';

class Drone {
    constructor(scene, manager, dData, slotId, owner) {
        this.scene = scene;
        this.manager = manager;
        this.dData = dData;
        this.type = dData.type || dData;
        this.slotId = slotId;
        this.owner = owner;
        this.id = `drone-${Math.random().toString(36).substr(2, 9)}`;
        
        // Resolve module data once for base stats
        const module = this.manager.fittings[this.slotId];
        const baseStats = DRONE_STATS[this.type];
        
        // If we have hydrated stats from the module, use them, otherwise fallback to defaults
        const stats = dData.stats || baseStats;

        this.maxHull = stats.hull || baseStats.hull;
        this.hull = this.maxHull;
        this.maxShield = stats.shield || baseStats.shield || 0;
        this.shield = this.maxShield;
        this.speed = stats.speed || baseStats.speed;
        this.signature = stats.signature || baseStats.signature;
        this.rebuildTime = (stats.rebuildTime || baseStats.rebuildTime) * 1000; // ms
        
        this.state = 'Launching'; // Launching, Orbiting, Active, Returning, Rebuilding, Despawning
        this.rebuildTimer = 0;
        
        // Sprite Setup
        const texture = new THREE.TextureLoader().load(TRIDRONE_URL);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        this.sprite = new THREE.Sprite(material);
        
        // Calculate dynamic scale based on type and module size
        let baseScale = 22; 
        if (this.type.includes('Heavy')) baseScale *= 1.2;
        if (this.type.includes('Mining')) baseScale *= 1.1;
        
        // Module size bonus
        if (module?.size === 'M') baseScale *= 1.1;
        if (module?.size === 'L') baseScale *= 1.2;

        this.sprite.scale.set(baseScale, baseScale, 1);
        
        // Add random spawn offset to prevent stacking
        const offset = new THREE.Vector3(
            (Math.random() - 0.5) * 40,
            (Math.random() - 0.5) * 40,
            0
        );
        this.sprite.position.copy(owner.sprite.position).add(offset);
        this.sprite.renderOrder = 25;
        this.scene.add(this.sprite);
        
        this.velocity = new THREE.Vector3();
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.idleOrbitDistance = 230 + Math.random() * 40; // Aiming for ~250m with some swarm variance
        this.cargo = 0;
        this.lastActionTime = 0;
        this.target = null;
        this.accuracy = stats.accuracy || baseStats.accuracy;
        this.damagePerTick = stats.damagePerTick || baseStats.damagePerTick;
        this.miningRate = stats.miningRate || baseStats.miningRate;
        this.repairRate = stats.repairRate || baseStats.repairRate;
        this.capacity = stats.capacity || baseStats.capacity;
        this.range = stats.range || baseStats.range;
        this.optimalRange = stats.optimalRange || baseStats.optimalRange;
        this.ticksPerSecond = stats.ticksPerSecond || baseStats.ticksPerSecond || 12;
    }

    update(dt, currentTime) {
        // Apply spinning effect to the drone sprite
        if (this.sprite && this.sprite.material) {
            this.sprite.material.rotation += dt * 4.0; // Smooth rapid spin
        }

        if (this.state === 'Rebuilding') {
            this.rebuildTimer -= dt * 1000;
            if (this.rebuildTimer <= 0) {
                this.respawn();
            }
            return;
        }

        if (this.state === 'Despawning') {
            this.scene.remove(this.sprite);
            return;
        }

        // Module State Check - Use Slot ID for stability across UI refreshes
        const module = this.manager.fittings[this.slotId];
        const isActive = module && this.manager.activeWeapons && this.manager.activeWeapons[this.slotId];
        
        if (!isActive && this.state !== 'Returning') {
            this.state = 'Returning';
        }

        const distToOwner = this.sprite.position.distanceTo(this.owner.sprite.position);
        const droneProfile = getAuthoritativeDroneModuleProfile(module);
        const controlRange = Number(droneProfile.controlRange || 0);

        // TETHER LOGIC WITH HYSTERESIS
        // If we are returning, we don't stop until we are close (200m)
        if (this.state === 'Returning') {
            if (distToOwner < 200) {
                if (isActive) {
                    this.state = 'Orbiting';
                } else if (distToOwner < 50) {
                    this.state = 'Despawning';
                    this.sprite.visible = false;
                    return;
                }
            }
            this.moveTo(this.owner.sprite.position, dt);
            return;
        }

        // Logic based on type
        if (this.type.includes('Combat')) {
            this.updateCombat(dt, currentTime);
        } else if (this.type === 'Mining') {
            this.updateMining(dt, currentTime);
        } else if (this.type === 'Repair') {
            this.updateRepair(dt, currentTime);
        }

        // If we drift too far, force return (Outer limit + buffer)
        if (distToOwner > controlRange + 100) {
            this.state = 'Returning';
        }
    }

    moveTo(targetPos, dt) {
        const dir = new THREE.Vector3().subVectors(targetPos, this.sprite.position).normalize();
        // Drones move faster when returning or catching up
        const moveSpeed = (this.state === 'Returning' || this.sprite.position.distanceTo(targetPos) > 300) ? this.speed * 1.5 : this.speed;
        const moveStep = moveSpeed * (dt || 0.016);
        this.sprite.position.add(dir.multiplyScalar(moveStep));
    }

    updateCombat(dt, currentTime) {
        // Use player's locked target if it's hostile, otherwise fall back to manager's hostileTarget
        let hostile = null;
        const isLocked = this.manager.locking && this.manager.locking.state === 'Locked' && this.manager.target;
        const isFriendly = isLocked && this.manager.locking.isFriendlyLock;
        const isAsteroid = isLocked && ASTEROID_TYPES.some(t => t.name === this.manager.target.type);

        if (isLocked && !isFriendly && !isAsteroid) {
            hostile = this.manager.target;
        } else {
            hostile = this.manager.hostileTarget;
        }

        const module = this.manager.fittings[this.slotId];
        const droneProfile = getAuthoritativeDroneModuleProfile(module);
        const controlRange = Number(droneProfile.controlRange || 0);
        
        // Only engage if target is within control range of the OWNER ship
        if (hostile && hostile.sprite && this.owner.sprite.position.distanceTo(hostile.sprite.position) < controlRange) {
            this.state = 'Active';
            const distToTarget = this.sprite.position.distanceTo(hostile.sprite.position);
            
            // Orbit hostile while attacking - use 200m as requested
            this.orbit(hostile.sprite.position, 200, dt);

            // Attack
            if (distToTarget < this.optimalRange) {
                const interval = 1000 / this.ticksPerSecond;
                if (currentTime - this.lastActionTime > interval) {
                    this.lastActionTime = currentTime;
                    this.manager.droneAttack(this, hostile);
                }
            }
        } else {
            this.state = 'Orbiting';
            this.orbit(this.owner.sprite.position, this.idleOrbitDistance, dt);
        }
    }

    updateMining(dt, currentTime) {
        const module = this.manager.fittings[this.slotId];
        const droneProfile = getAuthoritativeDroneModuleProfile(module);
        const controlRange = Number(droneProfile.controlRange || 0);

        // Use player's locked target if it's an asteroid
        let miningTarget = null;
        const isLocked = this.manager.locking && this.manager.locking.state === 'Locked' && this.manager.target;
        const isAsteroid = isLocked && ASTEROID_TYPES.some(t => t.name === this.manager.target.type);

        if (isAsteroid) {
            miningTarget = this.manager.target;
        } else {
            // Find nearest node if no current target or target depleted
            if (!this.target || this.target.oreAmount <= 0) {
                this.target = this.manager.findNearestAsteroid(this.sprite.position);
            }
            miningTarget = this.target;
        }

        if (this.cargo >= this.capacity) {
            // Return to ship to unload
            const dist = this.sprite.position.distanceTo(this.owner.sprite.position);
            if (dist < 50) {
                this.manager.addOreToInventory({ type: 'resource', name: 'Drone Ore', weight: this.cargo });
                this.cargo = 0;
                // If it was a generic target, clear it to search for new nearest
                if (!isAsteroid) this.target = null;
            } else {
                this.moveTo(this.owner.sprite.position, dt);
            }
        } else {
            // Only engage if target is within control range of the OWNER ship
            if (miningTarget && miningTarget.sprite && this.owner.sprite.position.distanceTo(miningTarget.sprite.position) < controlRange) {
                const distToTarget = this.sprite.position.distanceTo(miningTarget.sprite.position);
                
                // Orbit at 200m as requested
                this.orbit(miningTarget.sprite.position, 200, dt);

                // Extraction range is usually closer than orbit, check for extraction
                if (distToTarget < 250) { // Mining beam range check
                    // Mine
                    if (currentTime - this.lastActionTime > 1000) {
                        this.lastActionTime = currentTime;
                        const amount = Math.min(this.miningRate, this.capacity - this.cargo, miningTarget.oreAmount);
                        this.cargo += amount;
                        miningTarget.oreAmount -= amount;
                        this.manager.showMiningBeam(this.sprite.position, miningTarget.sprite.position, 0x00ff00);
                        if (miningTarget.oreAmount <= 0) {
                            this.manager.destroyTarget(miningTarget);
                            if (!isAsteroid) this.target = null;
                        }
                    }
                }
            } else {
                this.state = 'Orbiting';
                this.orbit(this.owner.sprite.position, this.idleOrbitDistance, dt);
            }
        }
    }

    updateRepair(dt, currentTime) {
        // Use player's locked target if it's friendly, otherwise default to self/fleet
        let repairTarget = null;
        const isLocked = this.manager.locking && this.manager.locking.state === 'Locked' && this.manager.target;
        const isFriendly = isLocked && this.manager.locking.isFriendlyLock;

        if (isFriendly) {
            repairTarget = this.manager.target;
        } else {
            repairTarget = this.manager.friendlyTarget || (this.manager.stats.hp < this.manager.stats.maxHp ? this.owner : null);
        }

        const module = this.manager.fittings[this.slotId];
        const droneProfile = getAuthoritativeDroneModuleProfile(module);
        const controlRange = Number(droneProfile.controlRange || 0);

        if (repairTarget && repairTarget.sprite && this.owner.sprite.position.distanceTo(repairTarget.sprite.position) < controlRange) {
            const distToTarget = this.sprite.position.distanceTo(repairTarget.sprite.position);
            
            // Orbit at optimal range for repair or 200m (whichever is smaller)
            const orbitDist = Math.min(200, this.range * 0.8);
            this.orbit(repairTarget.sprite.position, orbitDist, dt);

            if (distToTarget < this.range) {
                if (currentTime - this.lastActionTime > 1000) {
                    this.lastActionTime = currentTime;
                    if (repairTarget === this.owner) {
                        this.manager.stats.hp = Math.min(this.manager.stats.maxHp, this.manager.stats.hp + this.repairRate);
                    } else {
                        repairTarget.hp = Math.min(repairTarget.maxHp || 1000, (repairTarget.hp || 0) + this.repairRate);
                    }
                    this.manager.showRepairBeam(this.sprite.position, repairTarget.sprite.position);
                }
            }
        } else {
            this.state = 'Orbiting';
            this.orbit(this.owner.sprite.position, this.idleOrbitDistance, dt);
        }
    }

    orbit(centerPos, radius, dt) {
        this.orbitAngle += dt * (this.speed / radius) * 0.8;
        const targetX = centerPos.x + Math.cos(this.orbitAngle) * radius;
        const targetY = centerPos.y + Math.sin(this.orbitAngle) * radius;
        const targetPos = new THREE.Vector3(targetX, targetY, 0);

        const distToTarget = this.sprite.position.distanceTo(targetPos);
        if (distToTarget > 2) {
            const dir = new THREE.Vector3().subVectors(targetPos, this.sprite.position).normalize();
            // Higher catch-up factor for orbital tracking
            const moveStep = this.speed * 1.5 * dt;
            this.sprite.position.add(dir.multiplyScalar(Math.min(moveStep, distToTarget)));
        }
    }

    takeDamage(amount) {
        this.hull -= amount;
        if (this.hull <= 0) {
            this.die();
        }
    }

    die() {
        this.state = 'Rebuilding';
        this.rebuildTimer = this.rebuildTime;
        this.sprite.visible = false;
    }

    respawn() {
        this.hull = this.maxHull;
        this.shield = this.maxShield;
        
        // Add random respawn offset to prevent stacking
        const offset = new THREE.Vector3(
            (Math.random() - 0.5) * 40,
            (Math.random() - 0.5) * 40,
            0
        );
        this.sprite.position.copy(this.owner.sprite.position).add(offset);
        this.sprite.visible = true;
        this.state = 'Orbiting';
    }

    destroy() {
        this.scene.remove(this.sprite);
    }
}

class DroneManager {
    constructor(manager) {
        this.manager = manager;
        this.drones = []; // Active/Living drones
        this.slotDrones = new Map(); // slotId -> Drone[]
    }

    update(dt, currentTime) {
        // Sync drones with slot states
        Object.entries(this.manager.fittings).forEach(([slotId, module]) => {
            const droneProfile = getAuthoritativeDroneModuleProfile(module);
            if (!module || !Array.isArray(droneProfile.hydratedDrones) || droneProfile.hydratedDrones.length <= 0) {
                // Cleanup drones if module was removed
                if (this.slotDrones.has(slotId)) {
                    const drones = this.slotDrones.get(slotId);
                    drones.forEach(d => {
                        const idx = this.drones.indexOf(d);
                        if (idx > -1) this.drones.splice(idx, 1);
                        d.destroy();
                    });
                    this.slotDrones.delete(slotId);
                }
                return;
            }
            
            const isActive = this.manager.activeWeapons[slotId];
            let drones = this.slotDrones.get(slotId);
            
            if (isActive && !drones) {
                // Spawn drones
                drones = [];
                // Use hydrated drones from final_stats if available, else fallback to raw config
                const droneRefs = droneProfile.hydratedDrones;

                droneRefs.forEach(dData => {
                    for (let i = 0; i < dData.count; i++) {
                        const drone = new Drone(this.manager.scene, this.manager, dData, slotId, this.manager.ship);
                        drones.push(drone);
                        this.drones.push(drone);
                    }
                });
                this.slotDrones.set(slotId, drones);
            } else if (!isActive && drones) {
                // Drones should return and despawn
                drones.forEach(d => {
                    if (d.state !== 'Returning' && d.state !== 'Despawning') {
                        d.state = 'Returning';
                    }
                });
                
                if (drones.every(d => d.state === 'Despawning')) {
                    drones.forEach(d => {
                        const idx = this.drones.indexOf(d);
                        if (idx > -1) this.drones.splice(idx, 1);
                        d.destroy();
                    });
                    this.slotDrones.delete(slotId);
                }
            }
        });

        this.drones.forEach(drone => drone.update(dt, currentTime));
    }

    destroyAll() {
        this.drones.forEach(d => d.destroy());
        this.drones = [];
        this.slotDrones.clear();
    }
}

class PulseProjectile {
    constructor(scene, slotId, module, startPos, velocity, damage, hitChance, manager, muzzleSpeed) {
        this.scene = scene;
        this.slotId = slotId;
        this.module = module;
        this.damage = damage;
        this.hitChance = hitChance;
        this.manager = manager;
        this.expired = false;
        this.startTime = Date.now();
        this.maxFlightTime = 4000; 
        this.velocity = velocity;
        this.startPos = startPos.clone();
        this.muzzleSpeed = muzzleSpeed || velocity.length();
        this.relativeDistanceTraveled = 0;
        this.lastTrailSpawn = 0;

        const { item: effectiveModule, finalStats } = getEffectiveModuleStats(module);
        module = effectiveModule || module;
        const size = (module.weaponsize || module.size || 'S').toUpperCase();
        const baseConfig = PULSE_CANNON_CONFIGS[size] || PULSE_CANNON_CONFIGS['S'];
        this.optimalRange = Number(finalStats.optimalRange ?? module.optimalRange ?? baseConfig.optimalRange ?? 0);
        this.falloffRange = Number(finalStats.falloffRange ?? module.falloffRange ?? (this.optimalRange + 100));

        // Visuals: ARC-style elongated rarity-colored bolts
        const rarity = (module.rarity || 'common').toLowerCase();
        const colorObj = new THREE.Color(
            rarity === 'legendary' ? 0xffcc00 : 
            (rarity === 'epic' ? 0xa335ee : 
            (rarity === 'rare' ? 0x00ccff : 
            (rarity === 'uncommon' ? 0x00ff00 : 0xffffff)))
        );
        this.rarityColor = colorObj;
        const rgb = `${Math.floor(colorObj.r * 255)}, ${Math.floor(colorObj.g * 255)}, ${Math.floor(colorObj.b * 255)}`;

        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        
        // Create a sharp elongated bolt gradient
        const grad = ctx.createLinearGradient(0, 0, 128, 0);
        grad.addColorStop(0, `rgba(${rgb}, 0)`);
        grad.addColorStop(0.1, `rgba(${rgb}, 0.5)`);
        grad.addColorStop(0.5, 'rgba(255, 255, 255, 1)'); // Bright white core
        grad.addColorStop(0.9, `rgba(${rgb}, 0.5)`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);
        
        // Add a vertical glow effect to the horizontal line
        ctx.fillStyle = grad;
        // Draw the main streak with a slight vertical fade-in/out
        for(let i=0; i<32; i++) {
            const alpha = 1.0 - Math.abs(i - 16) / 16;
            ctx.globalAlpha = Math.pow(alpha, 2.5); // Balanced falloff for sleek but visible line
            ctx.fillRect(0, i, 128, 1);
        }
        ctx.globalAlpha = 1.0;
        
        const projTexture = new THREE.CanvasTexture(canvas);
        const material = new THREE.MeshBasicMaterial({ 
            map: projTexture, 
            transparent: true, 
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthTest: false
        });
        
        // Use PlaneGeometry for precise rotation along velocity vector - balanced size
        const geometry = new THREE.PlaneGeometry(80, 6.5);
        this.sprite = new THREE.Mesh(geometry, material); 
        this.sprite.position.copy(startPos);
        
        // Calculate rotation from velocity
        const angle = Math.atan2(velocity.y, velocity.x);
        this.sprite.rotation.z = angle;
        
        this.sprite.renderOrder = 35;
        this.scene.add(this.sprite);
    }

    update(dt, currentTime) {
        if (this.expired) return;

        if (currentTime - this.startTime > this.maxFlightTime) {
            this.expired = true;
            return;
        }

        const dtFactor = dt * 60;
        const moveStep = this.velocity.clone().multiplyScalar(dtFactor);
        this.sprite.position.add(moveStep);

        // Distance Fade Logic
        this.relativeDistanceTraveled += this.muzzleSpeed * dtFactor;
        
        if (this.relativeDistanceTraveled >= this.falloffRange) {
            this.expired = true;
            return;
        } else if (this.relativeDistanceTraveled > this.optimalRange) {
            const fadeFactor = 1 - (this.relativeDistanceTraveled - this.optimalRange) / (this.falloffRange - this.optimalRange);
            this.sprite.material.opacity = Math.max(0, fadeFactor);
        }

        // Spawn trail particles
        if (currentTime - this.lastTrailSpawn > 25) {
            this.spawnTrailParticle(currentTime);
            this.lastTrailSpawn = currentTime;
        }

        // Remote projectiles are visual-only, but we still run collision tests so they stop on impact.

        // Impact Check
        if (this.isPlayerTarget && this.manager.ship && this.manager.ship.sprite) {
            const dist = this.sprite.position.distanceTo(this.manager.ship.sprite.position);
            const targetRadius = this.manager.ship.collisionRadius || 25; 
            if (dist < targetRadius) {
                this.impact(this.manager.ship);
                return;
            }
        }

        for (const entity of this.manager.entities) {
            if (entity.id === 'player-ship' || !entity.sprite || entity.static) continue;
            
            const dist = this.sprite.position.distanceTo(entity.sprite.position);
            const targetRadius = entity.radius || 20;
            
            if (dist < targetRadius) {
                // --- Detailed Collision Pass (Spine Collision) ---
                if (entity.collisionCircles && entity.collisionCircles.length > 0) {
                    const hit = entity.collisionCircles.some(circle => {
                        const circlePos = new THREE.Vector2(circle.x, circle.y);
                        const projPos = new THREE.Vector2(this.sprite.position.x, this.sprite.position.y);
                        return projPos.distanceTo(circlePos) < circle.radius;
                    });
                    if (!hit) continue; // Missed the sub-circles
                }

                this.impact(entity);
                return;
            }
        }
    }

    impact(entity) {
        if (this.expired) return;
        this.expired = true;

        // Remote visuals: stop on impact but do not apply damage locally
        if (this.isRemote) {
            return;
        }

        const isMiss = Math.random() > this.hitChance;
        const finalDamage = isMiss ? 0 : this.damage;

        if (finalDamage > 0) {
            if (this.isPlayerTarget) {
                // Special handling for player target
                const result = this.manager.takeDamage(finalDamage, 'kinetic');
                if (result.shieldDamage > 0) this.manager.showDamageNumber(entity, result.shieldDamage, false, false, 'shield', 'player-ship');
                if (result.hullDamage > 0) this.manager.showDamageNumber(entity, result.hullDamage, false, false, 'hull', 'player-ship');
            } else if (entity.type === 'NPC' || entity.type === 'BIO') {
                const result = this.manager.applyDamageToNpc(entity, finalDamage, 'kinetic');
                if (result.shieldDamage > 0) this.manager.showDamageNumber(entity, result.shieldDamage, false, false, 'shield', entity.id);
                if (result.hullDamage > 0) this.manager.showDamageNumber(entity, result.hullDamage, false, false, 'hull', entity.id);
            } else if (entity.type === 'Asteroid' || !entity.type) {
                entity.oreAmount = Math.max(0, (entity.oreAmount || 0) - finalDamage);
                this.manager.showDamageNumber(entity, finalDamage, false, false, 'hull', entity.id);
                if (entity.oreAmount <= 0) this.manager.destroyTarget(entity);
            }
        } else {
            this.manager.showDamageNumber(entity, 0, false, true, 'standard', this.isPlayerTarget ? 'player-ship' : entity.id);
        }

        // Visual flash on impact
        if (entity.sprite && entity.sprite.material && entity.sprite.material.color && finalDamage > 0) {
            const originalColor = entity.sprite.material.color.clone();
            entity.sprite.material.color.set(0xffffff);
            setTimeout(() => { if (entity.sprite && entity.sprite.material && entity.sprite.material.color) entity.sprite.material.color.copy(originalColor); }, 50);
        }
    }

    spawnTrailParticle(currentTime) {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
        const rgb = `${Math.floor(this.rarityColor.r * 255)}, ${Math.floor(this.rarityColor.g * 255)}, ${Math.floor(this.rarityColor.b * 255)}`;
        grad.addColorStop(0, `rgba(${rgb}, 0.8)`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 16, 16);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const p = new THREE.Sprite(material);
        p.position.copy(this.sprite.position);
        p.scale.set(9, 9, 1);
        p.renderOrder = 34;
        this.scene.add(p);
        
        const duration = 250; // Faster fade
        const start = currentTime;
        
        const animate = () => {
            const now = Date.now();
            const t = (now - start) / duration;
            if (t >= 1) {
                this.scene.remove(p);
                texture.dispose();
                material.dispose();
                return;
            }
            p.material.opacity = (1 - t) * 0.65; // Balanced opacity
            const s = 9 * (1 - t); // Balanced trail size
            p.scale.set(s, s, 1);
            requestAnimationFrame(animate);
        };
        animate();
    }

    destroy() {
        this.scene.remove(this.sprite);
        if (this.sprite.geometry) this.sprite.geometry.dispose();
        if (this.sprite.material.map) this.sprite.material.map.dispose();
        this.sprite.material.dispose();
    }
}

class MissileProjectile {
    constructor(scene, slotId, module, startPos, target, tracking, speed, flightTime, damage, aoeRadius, hitChance, manager, texture, aimPoint = null) {
        this.scene = scene;
        this.slotId = slotId;
        this.module = module;
        this.target = target;
        this.aimPoint = aimPoint;
        this.tracking = tracking;
        this.speed = speed;
        this.maxFlightTime = flightTime * 1000; // to ms
        this.startTime = Date.now();
        this.damage = damage;
        this.aoeRadius = aoeRadius;
        this.hitChance = hitChance;
        this.isMiss = Math.random() > hitChance;
        this.expired = false;
        this.manager = manager;
        this.distanceTraveled = 0;
        
        // Falloff config
        const { item: effectiveModule, finalStats } = getEffectiveModuleStats(module);
        module = effectiveModule || module;
        const config = MISSILE_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || MISSILE_CONFIGS['S'];
        this.maxFalloff = Number(finalStats.falloffRange ?? module.falloffRange ?? ((finalStats.optimalRange ?? module.optimalRange ?? config.optimalRange) * 1.2));

        // Visuals
        const rarity = (module.rarity || 'common').toLowerCase();
        const colorObj = new THREE.Color(
            rarity === 'legendary' ? 0xffcc00 : 
            (rarity === 'epic' ? 0xa335ee : 
            (rarity === 'rare' ? 0x00ccff : 
            (rarity === 'uncommon' ? 0x00ff00 : 0xffffff)))
        );
        this.rarityColor = colorObj;

        const material = new THREE.SpriteMaterial({ 
            map: texture, 
            transparent: true, 
            blending: THREE.AdditiveBlending,
            color: colorObj
        });
        this.sprite = new THREE.Sprite(material);
        
        const jitter = new THREE.Vector3((Math.random()-0.5)*10, (Math.random()-0.5)*10, 0);
        this.sprite.position.copy(startPos).add(jitter);
        
        this.sprite.scale.set(20, 20, 1);
        this.sprite.renderOrder = 35;
        this.scene.add(this.sprite);

        // Movement
        // Apply spread based on lock status
        const isLocked = this.manager.locking.state === 'Locked' && this.manager.target === this.target;
        const baseSpread = isLocked ? 0.02 : 0.15; // 0.02 rad if locked, 0.15 rad if not
        const spreadAngle = (Math.random() - 0.5) * Math.PI * baseSpread; 
        
        const shipRotation = this.manager.ship.rotation;
        
        // If we have an aimPoint, calculate initial direction toward it
        let initialDir = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), shipRotation);
        if (this.aimPoint) {
            initialDir.subVectors(this.aimPoint, startPos).normalize();
        }

        this.velocity = initialDir.applyAxisAngle(new THREE.Vector3(0, 0, 1), spreadAngle).multiplyScalar(this.speed);
        
        this.trail = [];
        this.lastTrailSpawn = 0;
        this.isFading = false;
        this.fadeTime = 0;
    }

    update(dt, currentTime) {
        if (this.expired) return;

        const elapsed = currentTime - this.startTime;
        if (elapsed > this.maxFlightTime) {
            this.explode();
            return;
        }

        // Homing logic: only if locked on a real target
        if (this.target && this.target.sprite) {
            let targetPos = this.target.sprite.position.clone();
            
            if (this.isMiss) {
                const offset = new THREE.Vector3(50, 50, 0); 
                targetPos.add(offset);
            }

            const distToTarget = this.sprite.position.distanceTo(targetPos);
            
            if (distToTarget > 20) {
                const toTarget = new THREE.Vector3().subVectors(targetPos, this.sprite.position).normalize();
                const isLocked = this.manager.locking.state === 'Locked' && this.manager.target === this.target;
                const finalTracking = isLocked ? this.tracking * 1.5 : this.tracking;
                const trackingFactor = (finalTracking / 100) * (dt * 60); 
                this.velocity.lerp(toTarget.multiplyScalar(this.speed), trackingFactor);
            }
        }

        const moveStep = this.velocity.clone();
        this.sprite.position.add(moveStep);
        this.distanceTraveled += moveStep.length();

        // Trail particles
        if (currentTime - this.lastTrailSpawn > 30) {
            this.spawnTrailParticle(currentTime);
            this.lastTrailSpawn = currentTime;
        }

        // Remote missiles are visual-only, but we still run collision tests so they stop on impact.
        if (this.isRemote) {
            // Proximity fuse vs entities (visual stop)
            const proximityFuse = this.speed * 1.5;
            for (const entity of this.manager.entities) {
                if (!entity?.sprite || entity.static) continue;
                const dist = this.sprite.position.distanceTo(entity.sprite.position);
                const targetRadius = entity.radius || 20;
                if (dist < Math.max(targetRadius, proximityFuse)) {
                    this.explode(entity);
                    return;
                }
            }

            // Also allow impact on the local player ship (not in entities)
            if (this.manager.ship && this.manager.ship.sprite) {
                const dist = this.sprite.position.distanceTo(this.manager.ship.sprite.position);
                const targetRadius = this.manager.ship.collisionRadius || 25;
                if (dist < Math.max(targetRadius, proximityFuse)) {
                    this.explode(this.manager.ship);
                    return;
                }
            }

            // Max range despawn
            if (this.distanceTraveled > this.maxFalloff) {
                this.explode();
            }
            return;
        }

        // Impact Check (Collision with ANY entity)
        const proximityFuse = this.speed * 1.5;
        for (const entity of this.manager.entities) {
            if (entity.id === 'player-ship' || !entity.sprite || entity.static) continue;
            
            const dist = this.sprite.position.distanceTo(entity.sprite.position);
            const targetRadius = entity.radius || 20;
            
            // Check for proximity trigger
            if (dist < Math.max(targetRadius, proximityFuse)) {
                this.explode(entity);
                return;
            }
        }
    }

    explode(hitEntity = null) {
        if (this.expired) return;
        this.expired = true;

        const explosionPos = this.sprite.position.clone();

        // 1. Trigger Visual Explosion
        this.manager.createExplosionEffect(explosionPos, this.aoeRadius);

        // Remote visuals: do not apply damage locally
        if (this.isRemote) return;

        // 2. Damage Application (Direct + AoE)
        this.manager.entities.forEach(entity => {
            if (entity.static || !entity.sprite) return;
            
            const dist = entity.sprite.position.distanceTo(explosionPos);
            const entityRadius = entity.radius || 20;
            
            // If the explosion center is inside the entity or within AoE radius
            if (dist < this.aoeRadius + entityRadius) {
                let finalDamage = 0;
                let isDirectHit = false;

                // Check for direct collision (either with hitEntity or current iteration entity)
                if ((hitEntity && entity === hitEntity) || (entity === this.target && dist < entityRadius)) {
                    isDirectHit = true;
                    // Apply direct hit damage (misses deal 50%)
                    finalDamage = this.isMiss ? this.damage * 0.5 : this.damage;
                } else if (this.aoeRadius > 0) {
                    // AoE falloff calculation for non-direct hits or other entities
                    const effectiveDist = Math.max(0, dist - entityRadius);
                    const falloff = 1.0 - (effectiveDist / this.aoeRadius);
                    if (falloff > 0) {
                        finalDamage = this.damage * falloff;
                    }
                }

                if (finalDamage > 0) {
                    this.manager.applyMissileDamageToEntity(entity, finalDamage, isDirectHit && this.isMiss, explosionPos);
                }
            }
        });

        // Audio
        if (this.manager.synth) {
            try {
                this.manager.synth.triggerAttackRelease("G1", "4n", Tone.now());
            } catch (e) {}
        }
    }

    spawnTrailParticle(currentTime) {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
        const rgb = `${Math.floor(this.rarityColor.r * 255)}, ${Math.floor(this.rarityColor.g * 255)}, ${Math.floor(this.rarityColor.b * 255)}`;
        grad.addColorStop(0, `rgba(${rgb}, 0.8)`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 16, 16);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const p = new THREE.Sprite(material);
        p.position.copy(this.sprite.position);
        p.scale.set(10, 10, 1);
        p.renderOrder = 34;
        this.scene.add(p);
        
        const duration = 500;
        const start = currentTime;
        
        const animate = () => {
            const now = Date.now();
            const t = (now - start) / duration;
            if (t >= 1) {
                this.scene.remove(p);
                texture.dispose();
                material.dispose();
                return;
            }
            p.material.opacity = 1 - t;
            p.scale.set(10 * (1 - t), 10 * (1 - t), 1);
            requestAnimationFrame(animate);
        };
        animate();
    }

    destroy() {
        this.scene.remove(this.sprite);
        // Sprite material shared texture is NOT disposed here as it's shared
        this.sprite.material.dispose();
    }
}


export class GameManager {
    get player() {
        if (!this.ship || !this.ship.sprite) return null;
        return {
            x: this.ship.sprite.position.x,
            y: this.ship.sprite.position.y,
            rot: this.ship.rotation
        };
    }

    updateRemoteShip(state) {
        let player = this.remotePlayers.get(state.id);
        if (!player) return;

        // Smooth physics update
        player.targetPos.set(state.x, state.y, 0);
        player.targetRot = state.rot;
        
        // Handle ship model or shield presence changes
        const oldShieldFittings = Object.values(player.stats?.fittings || {}).some(m => m?.type === 'shield' || (m?.name && m.name.toLowerCase().includes('shield')));
        
        // Store telemetry for HUD/Tactical displays
        player.stats = {
            hp: state.hp,
            maxHp: state.maxHp,
            shields: state.shields,
            maxShields: state.maxShields,
            energy: state.energy,
            maxEnergy: state.maxEnergy,
            velocity: new THREE.Vector2(state.vx, state.vy),
            fittings: state.fittings,
            animation_state: state.animation_state || {},
            visual_config: state.visual_config || {}
        };

        // Cache visuals for applyRemoteVisualState
        player.animation_state = state.animation_state || {};
        player.visual_config = state.visual_config || {};

        const newShieldFittings = Object.values(state.fittings || {}).some(m => m?.type === 'shield' || (m?.name && m.name.toLowerCase().includes('shield')));
        
        if ((state.ship_type && state.ship_type !== player.shipType) || oldShieldFittings !== newShieldFittings) {
            this.updateRemotePlayerSprite(player, state.ship_type || player.shipType);
        }

        // Apply visual state toggles
        this.applyRemoteVisualState(player);

        player.lastUpdate = Date.now();
    }

    getAnimationState() {
        if (!this.ship) return {};
        const fittings = this.gameState?.fittings || {};
        const modules = {};
        
        let miningTargetPos = null;

        const isFluxFiring = Object.entries(this.activeWeapons || {}).some(([slot, active]) => {
            if (!active) return false;
            const item = fittings[slot];
            if (!item) return false;
            const nameLower = (item.name || '').toLowerCase();
            const idLower = (item.id || '').toLowerCase();
            return nameLower.includes('flux') || idLower.includes('flux');
        });

        const isMiningFiring = Object.entries(this.activeWeapons || {}).some(([slot, active]) => {
            if (!active) return false;
            const item = fittings[slot];
            const firing = item && item.type === 'mining';
            if (firing && this.target) {
                miningTargetPos = { x: this.target.sprite.position.x, y: this.target.sprite.position.y };
            }
            return firing;
        });

        Object.entries(fittings).forEach(([slot, item]) => {
            if (item && item.id) {
                const isActive = this.activeWeapons && this.activeWeapons[slot];
                modules[item.id] = { on: !!isActive };
            }
        });

        // Net animation hints for other clients (visual-only)
        const net = this._netAnim || {};

        return {
            shieldsOn: (this.stats?.shields > 0),
            miningActive: isMiningFiring,
            miningTargetPos: miningTargetPos,
            fluxActive: isFluxFiring,
            tractorBeamActive: false,
            braking: this.ship.isBraking || false,
            ionThrusterActive: (this.ship.thrustPower > 0.1) || !!(this.activeWeapons && Object.entries(this.activeWeapons).some(([slot, on]) => on && slot.startsWith('engine'))),
            // Provide enough data to drive thruster flare direction/intensity on remote clients.
            thrustPower: typeof net.thrustPower === 'number' ? net.thrustPower : (this.ship.thrustPower || 0),
            accelX: typeof net.accelX === 'number' ? net.accelX : 0,
            accelY: typeof net.accelY === 'number' ? net.accelY : 0,
            joyX: typeof net.joyX === 'number' ? net.joyX : 0,
            joyY: typeof net.joyY === 'number' ? net.joyY : 0,
            modules: modules,
            v: 1
        };
    }

    getVisualConfig() {
        if (!this.ship) return {};
        const shipConfig = SHIP_REGISTRY[this.ship.type] || {};
        return {
            model: this.ship.type,
            primary_color: '#33ffcc', // Default local color
            secondary_color: '#ffffff',
            emissive_color: '#00ccff',
            lights_on: true,
            thruster_color: '#00ccff'
        };
    }

    triggerRemoteBeam(player, item, slotId, targetPos, opts = {}) {
        const isMining = item?.type === 'mining';
        const isFlux = (item?.id || item?.name || '').toLowerCase().includes('flux');
        const beamColor = isMining ? 0xccffff : (isFlux ? 0x00ccff : 0xff4444);

        // --- Start position (world) ---
        // Prefer authoritative muzzle coords from the event, otherwise compute from hardpoints, otherwise ship center.
        let startPos = null;

        if (Number.isFinite(opts.muzzleX) && Number.isFinite(opts.muzzleY)) {
            startPos = new THREE.Vector3(opts.muzzleX, opts.muzzleY, 0);
        } else if (opts.startPos && typeof opts.startPos.x === 'number' && typeof opts.startPos.y === 'number') {
            startPos = opts.startPos.clone ? opts.startPos.clone() : new THREE.Vector3(opts.startPos.x, opts.startPos.y, 0);
        } else {
            const shipPos = player.sprite.position.clone();
            const shipRot = (typeof player.currentRot === 'number') ? player.currentRot : (player.sprite.rotation || 0);

            const shipCfg = (typeof SHIP_REGISTRY !== 'undefined' && SHIP_REGISTRY[player.shipType]) ? SHIP_REGISTRY[player.shipType] : null;
            const hps = shipCfg?.hardpoints || shipCfg?.hardpointPositions || {};
            const slotKey = String(slotId || '').trim();

            // Try exact slot match first, then common fallbacks
            const hp = (slotKey && hps[slotKey]) ? hps[slotKey]
                : (hps.weapon1 || hps.weapon_1 || hps.gun1 || hps.gun_1 || null);

            startPos = shipPos;
            if (hp && typeof hp.x === 'number' && typeof hp.y === 'number') {
                const ox = hp.x / 64;
                const oy = hp.y / 64;
                const cos = Math.cos(shipRot);
                const sin = Math.sin(shipRot);
                startPos = new THREE.Vector3(
                    shipPos.x + ox * cos - oy * sin,
                    shipPos.y + ox * sin + oy * cos,
                    shipPos.z
                );
            }
        }

        // --- Beam range clamp (world units) ---
        // For now we clamp visuals to falloffRange (user preference).
        const beamRange = Number.isFinite(opts.beamRange) ? opts.beamRange : Infinity;

        const beamId = `remote-beam-${player.id}-${slotId}`;

        if (this.activeBeams[beamId]) {
            this.activeBeams[beamId].lastFired = Date.now();
            this.activeBeams[beamId].aimPoint = targetPos;
            // refresh authoritative origin/motion if provided
            if (Number.isFinite(opts.muzzleX) && Number.isFinite(opts.muzzleY)) {
                this.activeBeams[beamId].muzzleX = opts.muzzleX;
                this.activeBeams[beamId].muzzleY = opts.muzzleY;
            }
            if (Number.isFinite(opts.vx) && Number.isFinite(opts.vy)) {
                this.activeBeams[beamId].vx = opts.vx;
                this.activeBeams[beamId].vy = opts.vy;
            }
            if (Number.isFinite(opts.t)) this.activeBeams[beamId].t = opts.t;
            if (Number.isFinite(opts.beamRange)) this.activeBeams[beamId].beamRange = opts.beamRange;
            return;
        }

        let laser;
        if (isFlux || isMining) {
            const fluxMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    uTime: { value: 0 },
                    uOpacity: { value: 1.0 },
                    uColor: { value: new THREE.Color(beamColor) },
                    uFluxJitter: { value: 0.1 }
                },
                vertexShader: FLUX_BEAM_VERTEX_SHADER,
                fragmentShader: FLUX_BEAM_FRAGMENT_SHADER,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            laser = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fluxMaterial);
        } else {
            const laserGeom = new THREE.BufferGeometry().setFromPoints([startPos, targetPos]);
            const laserMat = new THREE.LineBasicMaterial({ color: beamColor, transparent: true, opacity: 1 });
            laser = new THREE.Line(laserGeom, laserMat);
        }

        laser.renderOrder = 30;
        this.scene.add(laser);

        this.activeBeams[beamId] = {
            laser,
            lastFired: Date.now(),
            slotId,
            aimPoint: targetPos,
            type: item?.type,
            // store authoritative origin + motion (for moving ships)
            muzzleX: startPos.x,
            muzzleY: startPos.y,
            vx: Number.isFinite(opts.vx) ? opts.vx : 0,
            vy: Number.isFinite(opts.vy) ? opts.vy : 0,
            t: Number.isFinite(opts.t) ? opts.t : Date.now(),
            beamRange: beamRange
        };

        let opacity = 1.0;
        const fadeStep = 1.0 / 15;

        const fade = () => {
            const active = this.activeBeams[beamId];
            if (!active || Date.now() - active.lastFired > 100) opacity -= fadeStep;
            else opacity = 1.0;

            if (isFlux || isMining) {
                laser.material.uniforms.uOpacity.value = opacity;
                laser.material.uniforms.uTime.value += 0.016;
            } else {
                laser.material.opacity = opacity;
            }

            if (opacity > 0) {
                // Compute current muzzle from event-time muzzle + shooter velocity (simple latency compensation)
                const now = Date.now();
                const dt = (active && Number.isFinite(active.t)) ? Math.max(0, (now - active.t) / 1000) : 0;
                const currentStart = new THREE.Vector3(
                    (active?.muzzleX ?? startPos.x) + (active?.vx ?? 0) * dt,
                    (active?.muzzleY ?? startPos.y) + (active?.vy ?? 0) * dt,
                    0
                );

                const rawEnd = active?.aimPoint || targetPos;
                const diff = new THREE.Vector3().subVectors(rawEnd, currentStart);
                const rawLen = diff.length();

                // Clamp beam visuals to falloffRange AND stop at first impact (visual only)
                let currentEnd = rawEnd;

                if (rawLen > 0) {
                    const dir = diff.clone().normalize();

                    // Candidate end point (range-clamped)
                    let maxLen = rawLen;
                    if (Number.isFinite(active?.beamRange) && active.beamRange > 0) {
                        maxLen = Math.min(rawLen, active.beamRange);
                    }
                    const endCandidate = currentStart.clone().add(dir.multiplyScalar(maxLen));

                    // Stop on first hit along the segment (asteroids/NPCs/local ship, etc.)
                    const impact = this.checkBeamImpact(currentStart, endCandidate, item, `remote-${player.id}`);
                    currentEnd = impact?.point || endCandidate;
// Optional impact spark (visual-only). Rate limited to avoid spam on continuous beams.
if (impact?.point) {
    const nowFx = Date.now();
    if (!active.lastImpactFxAt || (nowFx - active.lastImpactFxAt) > 90) {
        active.lastImpactFxAt = nowFx;
        this.createBeamImpactSparkFx(impact.point, { size: isMining ? 14 : 16 });
    }
}
                } else {
                    currentEnd = currentStart.clone();
                }

                const diff2 = new THREE.Vector3().subVectors(currentEnd, currentStart);
                const length = diff2.length();

                if (isFlux || isMining) {
                    const angle = Math.atan2(diff2.y, diff2.x);
                    laser.position.copy(currentStart).add(diff2.multiplyScalar(0.5));
                    laser.rotation.z = angle;
                    laser.scale.set(length, isMining ? 24 : 32, 1);
                } else {
                    laser.geometry.setFromPoints([currentStart, currentEnd]);
                }
            }

            if (opacity > 0) requestAnimationFrame(fade);
            else {
                delete this.activeBeams[beamId];
                this.scene.remove(laser);
                laser.geometry?.dispose();
                laser.material?.dispose();
            }
        };
        fade();
    }

    onRemoteFireItem(payload) {
        const player = this.remotePlayers.get(payload.player_id);
        if (!player || !player.sprite) return;
        
        // Trigger firing visual for remote player
        this.triggerRemoteFireFx(player, payload);
    }

    onRemoteFxTrigger(payload) {
    const player = this.remotePlayers.get(payload.player_id);
    if (!player || !player.sprite) return;

    // Handle specific FX triggers
    if (payload.fx_type === 'shield_impact') {
        const pos = (Number.isFinite(payload.x) && Number.isFinite(payload.y))
            ? new THREE.Vector3(payload.x, payload.y, 0)
            : player.sprite.position;
        this.createShieldImpactFx(pos, payload.angle || 0);
        this.triggerShieldImpact(player, pos);
        return;
    }

    if (payload.fx_type === 'missile_explosion') {
        const pos = (Number.isFinite(payload.x) && Number.isFinite(payload.y))
            ? new THREE.Vector3(payload.x, payload.y, 0)
            : player.sprite.position;
        const radius = Number(payload.radius || 40) || 40;
        this.createExplosionEffect(pos, radius);
        return;
    }
}

    onRemoteDroneLaunch(payload) {
        const player = this.remotePlayers.get(payload.player_id);
        if (!player) return;
        // Placeholder for remote drone visuals
    }

    onRemoteDroneAttack(payload) {
        // Drone attack FX
    }

    onRemoteDroneReturn(payload) {
        // Drone return FX
    }

    triggerRemoteFireFx(player, payload) {
        const item = payload.item;
        if (!item) return;

        const aimPoint = payload.aimPoint ? new THREE.Vector3(payload.aimPoint.x, payload.aimPoint.y, 0) : null;
        if (!aimPoint) return;

        // Start position: weapon hardpoint (if available) rather than ship center
// Prefer authoritative muzzle from event (reduces drift when ship is moving)
        if (Number.isFinite(payload.muzzleX) && Number.isFinite(payload.muzzleY)) {
            const startPos = new THREE.Vector3(payload.muzzleX, payload.muzzleY, 0);
            // If this is a beam weapon, we still want correct range clamping (falloffRange)
    // Brief muzzle flash for remote shooters (visual-only)
try {
    const n = (item.id || item.name || '').toLowerCase();
    const isMissile = n.includes('seeker pod');
    const isPulse = n.includes('pulse cannon');
    // Keep mining/flux clean (they already have continuous beam visuals)
    if (isMissile || isPulse) {
        this.createMuzzleFlashFx(startPos, { size: isMissile ? 28 : 22, intensity: 1.0 });
    }
} catch (e) {}
                const nameLower = (item.id || item.name || '').toLowerCase();
            const isFlux = nameLower.includes('flux');
            const isMining = item.type === 'mining';
            if (isFlux || isMining) {
                // Try to resolve falloffRange from item stats if not provided
                let beamRange = Number(payload.beamRange ?? payload.falloffRange);
                if (!Number.isFinite(beamRange)) {
                    try {
                        const hydrated = item?.final_stats ? item : hydrateItem(item);
                        beamRange = hydrated?.final_stats?.falloffRange;
                    } catch {}
                }
                this.triggerRemoteBeam(player, item, payload.slotId, aimPoint, {
                    startPos,
                    muzzleX: startPos.x,
                    muzzleY: startPos.y,
                    vx: Number.isFinite(payload.vx) ? payload.vx : 0,
                    vy: Number.isFinite(payload.vy) ? payload.vy : 0,
                    t: Number.isFinite(payload.t) ? payload.t : (Number.isFinite(payload.clientTime) ? payload.clientTime : Date.now()),
                    beamRange: Number.isFinite(beamRange) ? beamRange : null
                });
                return;
            }
        }

const shipPos = player.sprite.position.clone();
const shipRot = (typeof player.currentRot === 'number') ? player.currentRot : (player.sprite.rotation || 0);

const shipDef = (typeof SHIP_REGISTRY !== 'undefined') ? SHIP_REGISTRY[player.shipType] : null;
const hps = shipDef?.hardpoints || shipDef?.hardpointPositions || null;

// slotId typically "weapon1"/"weapon2"/"weapon3"
const slotKey = String(payload.slotId || '').trim();
const hp = hps ? (hps[slotKey] || hps[slotKey.toLowerCase()] || hps.weapon1 || hps.weapon_1 || hps.gun1 || hps.gun_1 || null) : null;

let startPos = shipPos;
if (hp && typeof hp.x === 'number' && typeof hp.y === 'number') {
    const ox = hp.x / 64;
    const oy = hp.y / 64;
    const cos = Math.cos(shipRot);
    const sin = Math.sin(shipRot);
    startPos = new THREE.Vector3(
        shipPos.x + ox * cos - oy * sin,
        shipPos.y + ox * sin + oy * cos,
        shipPos.z
    );
}
 
        
// Brief muzzle flash for remote shooters (visual-only)
try {
    const n = (item.id || item.name || '').toLowerCase();
    const isMissile = n.includes('seeker pod');
    const isPulse = n.includes('pulse cannon');
    // Keep mining/flux clean (they already have continuous beam visuals)
    if (isMissile || isPulse) {
        this.createMuzzleFlashFx(startPos, { size: isMissile ? 28 : 22, intensity: 1.0 });
    }
} catch (e) {}
                const nameLower = (item.id || item.name || '').toLowerCase();
        const isFlux = nameLower.includes('flux');
        const isMissile = nameLower.includes('seeker pod');
        const isPulse = nameLower.includes('pulse cannon');
        const isMining = item.type === 'mining';

        if (isPulse) {
            const config = PULSE_CANNON_CONFIGS[item.weaponsize || 'S'] || PULSE_CANNON_CONFIGS['S'];
            const speed = Number.isFinite(payload.projectileSpeed) ? Number(payload.projectileSpeed) : (config.projectileSpeed * 2.0);
            const dir = new THREE.Vector3().subVectors(aimPoint, startPos).normalize();
            const relativeVelocity = dir.multiplyScalar(speed);
            const velocity = new THREE.Vector3(
                relativeVelocity.x + (Number.isFinite(payload.vx) ? payload.vx : 0),
                relativeVelocity.y + (Number.isFinite(payload.vy) ? payload.vy : 0),
                0
            );
            
            const projectile = new PulseProjectile(
                this.scene, 'remote-' + player.id, item, startPos, velocity, 0, 1.0, this, speed
            );
            projectile.isRemote = true;
            this.projectiles.push(projectile);
        } else if (isMissile) {
            const config = MISSILE_CONFIGS[item.weaponsize || 'S'] || MISSILE_CONFIGS['S'];
            const tracking = config.tracking;
            const speed = config.missileSpeed;
            const flightTime = config.flightTime;

            const missile = new MissileProjectile(
                this.scene, 'remote-' + player.id, item, startPos, null, 
                tracking, speed, flightTime, 0, 0, 1.0,
                this, this.missileTexture, aimPoint
            );
            missile.isRemote = true;
            this.missiles.push(missile);
        } else if (isFlux || isMining) {
            this.triggerRemoteBeam(player, item, payload.slotId, aimPoint, {
            muzzleX: Number.isFinite(payload.muzzleX) ? payload.muzzleX : (Number.isFinite(payload.x) ? payload.x : startPos.x),
            muzzleY: Number.isFinite(payload.muzzleY) ? payload.muzzleY : (Number.isFinite(payload.y) ? payload.y : startPos.y),
            vx: Number.isFinite(payload.vx) ? payload.vx : 0,
            vy: Number.isFinite(payload.vy) ? payload.vy : 0,
            t: Number.isFinite(payload.t) ? payload.t : (Number.isFinite(payload.clientTime) ? payload.clientTime : Date.now()),
            beamRange: Number.isFinite(payload.beamRange) ? payload.beamRange : (Number.isFinite(payload.falloffRange) ? payload.falloffRange : null)
        });
        }
    }

    
// -----------------------------------------------------
// EC2 COMBAT: REMOTE FIRE VISUALS
// -----------------------------------------------------
handleWeaponFired(payload) {
    try {
        const shooterId = payload?.userId;
        if (!shooterId) return;

        const localId = cloudService.user?.id || backendSocket?.userId;
        if (localId && shooterId === localId) return;

        const player = this.remotePlayers.get(shooterId);
        if (!player || !player.sprite) return;

        const weaponId = String(payload.weapon_id || '').trim();
        const weaponLabel = String(payload.weapon_name || payload.weapon_subtype || payload.weapon_type || weaponId || '').trim();
        const weaponType = String(payload.weapon_type || '').toLowerCase();
        const weaponSubtype = String(payload.weapon_subtype || '').toLowerCase();
        if (!weaponId && !weaponLabel && !weaponType && !weaponSubtype) return;

        const nameLower = `${weaponLabel} ${weaponType} ${weaponSubtype}`.toLowerCase();
        const isFlux = nameLower.includes('flux');
        const isMining = nameLower.includes('mining') || nameLower.includes('drill');
        const isMissile = nameLower.includes('seeker pod') || nameLower.includes('missile');
        const isPulse = nameLower.includes('pulse cannon') || nameLower.includes('pulse');
        const isBeam = isFlux || isMining || weaponType === 'beam' || weaponSubtype === 'beam';

        const startPos = (Number.isFinite(payload.x) && Number.isFinite(payload.y))
            ? new THREE.Vector3(payload.x, payload.y, 0)
            : player.sprite.position.clone();

        const ax = Number(payload.aimX ?? payload.aim_x);
        const ay = Number(payload.aimY ?? payload.aim_y);
        let aimPoint = null;
        if (Number.isFinite(ax) && Number.isFinite(ay)) {
            aimPoint = new THREE.Vector3(ax, ay, 0);
        } else {
            const rot = Number(payload.rot ?? player.targetRot ?? player.currentRot ?? player.sprite.rotation ?? 0);
            const fallbackRange = isMissile ? 1400 : (isPulse ? 1000 : 900);
            aimPoint = startPos.clone().add(new THREE.Vector3(Math.cos(rot), Math.sin(rot), 0).multiplyScalar(fallbackRange));
        }

        try {
            if (isMissile || isPulse) {
                this.createMuzzleFlashFx(startPos, { size: isMissile ? 28 : 22, intensity: 1.0 });
            }
        } catch (e) {}

        const item = {
            id: weaponId || weaponLabel,
            name: weaponLabel || weaponId,
            type: isMining ? 'mining' : undefined,
            weaponsize: (payload.weaponsize || 'S')
        };

        if (isBeam) {
            let range = Number(payload.beamRange);
            if (!Number.isFinite(range)) range = isMining ? 700 : 900;
            this.triggerRemoteBeam(player, item, weaponId || payload.slotId, aimPoint, {
                startPos,
                muzzleX: startPos.x,
                muzzleY: startPos.y,
                vx: Number.isFinite(payload.vx) ? payload.vx : 0,
                vy: Number.isFinite(payload.vy) ? payload.vy : 0,
                t: Number.isFinite(payload.serverTime) ? payload.serverTime : Date.now(),
                beamRange: range
            });
            return;
        }

        if (isPulse) {
            const config = PULSE_CANNON_CONFIGS[(payload.weaponsize || 'S').toUpperCase()] || PULSE_CANNON_CONFIGS['S'];
            const speed = Number.isFinite(payload.projectileSpeed) ? Number(payload.projectileSpeed) : Number(config?.projectileSpeed || 1200);
            const dir = new THREE.Vector3().subVectors(aimPoint, startPos);
            if (dir.lengthSq() <= 0.0001) dir.set(1, 0, 0);
            dir.normalize();
            const velocity = new THREE.Vector3(
                dir.x * speed + (Number.isFinite(payload.vx) ? payload.vx : 0),
                dir.y * speed + (Number.isFinite(payload.vy) ? payload.vy : 0),
                0
            );
            const projectile = new PulseProjectile(
                this.scene,
                'remote-' + player.id + '-' + Date.now(),
                item,
                startPos.clone(),
                velocity,
                0,
                1.0,
                this,
                speed
            );
            projectile.isRemote = true;
            this.projectiles.push(projectile);
            return;
        }

        if (isMissile) {
            const config = MISSILE_CONFIGS[(payload.weaponsize || 'S').toUpperCase()] || MISSILE_CONFIGS['S'];
            const tracking = config?.tracking;
            const speed = Number(config?.missileSpeed || 650);
            const flightTime = Number(config?.flightTime || 2.5);
            const missile = new MissileProjectile(
                this.scene,
                'remote-' + player.id + '-' + Date.now(),
                item,
                startPos.clone(),
                null,
                tracking,
                speed,
                flightTime,
                0,
                0,
                1.0,
                this,
                this.missileTexture,
                aimPoint.clone()
            );
            missile.isRemote = true;
            this.projectiles.push(missile);
            return;
        }

        if (typeof this.showMiningBeam === 'function') {
            this.showMiningBeam(startPos, aimPoint, 0xffffff);
        }
    } catch {
        // ignore
    }
}

// -----------------------------------------------------
// EC2 COMBAT: AUTHORITATIVE DAMAGE/VITALS
// -----------------------------------------------------
handleServerDamageEvent(payload) {
    try {
        const targetId = payload?.targetId;
        if (!targetId) return;

        this.lastShipDestroyedEvent = {
            targetId,
            killCreditId: payload?.killCreditId || null,
            killCreditType: payload?.killCreditType || null,
            finalBlowId: payload?.finalBlowId || null,
            finalBlowType: payload?.finalBlowType || null,
            assists: Array.isArray(payload?.assists) ? payload.assists : []
        };

        const localId = cloudService.user?.id || backendSocket?.userId;
        const shieldDamage = Number(payload?.shieldDamage || 0);
        const hullDamage = Number(payload?.hullDamage || 0);
        const impactX = Number(payload?.impactX);
        const impactY = Number(payload?.impactY);
        const impactPos = (Number.isFinite(impactX) && Number.isFinite(impactY))
            ? new THREE.Vector3(impactX, impactY, 0)
            : null;

        if (localId && targetId === localId) {
            if (!this.stats) this.stats = {};
            if (typeof payload.hull === 'number') this.stats.hp = payload.hull;
            if (typeof payload.maxHp === 'number') this.stats.maxHp = payload.maxHp;
            if (typeof payload.shields === 'number') this.stats.shields = payload.shields;
            if (typeof payload.maxShields === 'number') this.stats.maxShields = payload.maxShields;
            if (this.ship) {
                if (typeof payload.hull === 'number') this.ship.hp = payload.hull;
                if (typeof payload.maxHp === 'number') this.ship.maxHp = payload.maxHp;
                if (typeof payload.shields === 'number') this.ship.shields = payload.shields;
                if (typeof payload.maxShields === 'number') this.ship.maxShields = payload.maxShields;
            }

            if (shieldDamage > 0 && this.ship) {
                try {
                    this.triggerShieldImpact(this.ship, impactPos);
                    this.showDamageNumber(this.ship, shieldDamage, false, false, 'shield', 'player');
                } catch {}
            }
            if (hullDamage > 0 && this.ship) {
                try {
                    this.showDamageNumber(this.ship, hullDamage, false, false, 'hull', 'player');
                } catch {}
            }

            if (typeof this.updateUi === 'function') this.updateUi();
            this.lastDamageAt = Date.now();

            if (typeof this.stats.hp === 'number' && this.stats.hp <= 0) {
                try { this.handleShipDestroyed({ targetId: localId, maxHp: this.stats.maxHp }); } catch {}
            }
            return;
        }

        const rp = this.remotePlayers.get(targetId);
        if (rp) {
            if (!rp.stats) rp.stats = {};
            if (typeof payload.hull === 'number') rp.stats.hp = payload.hull;
            if (typeof payload.maxHp === 'number') rp.stats.maxHp = payload.maxHp;
            if (typeof payload.shields === 'number') rp.stats.shields = payload.shields;
            if (typeof payload.maxShields === 'number') rp.stats.maxShields = payload.maxShields;
            rp.lastHitAt = Date.now();

            if (shieldDamage > 0 && rp.sprite) {
                try {
                    this.triggerShieldImpact(rp, impactPos || rp.sprite.position);
                    this.showDamageNumber(rp, shieldDamage, false, false, 'shield', targetId);
                } catch {}
            }
            if (hullDamage > 0 && rp.sprite) {
                try {
                    this.showDamageNumber(rp, hullDamage, false, false, 'hull', targetId);
                } catch {}
            }
        }
    } catch {
        // ignore
    }
}

// -----------------------------------------------------
// EC2 COMBAT: DEATH EVENT
// -----------------------------------------------------
handleShipDestroyed(payload) {
    try {
        const targetId = payload?.targetId;
        if (!targetId) return;

        const localId = cloudService.user?.id || backendSocket?.userId;

        // -----------------------------
        // Local player death
        // -----------------------------
        if (localId && targetId === localId) {
            // Debounce: don't re-trigger destruction multiple times
            const now = Date.now();
            if (this.localDestroyedAt && now - this.localDestroyedAt < 1000) return;

            if (!this.stats) this.stats = {};
            this.stats.hp = 0;
            if (typeof payload.maxHp === 'number') this.stats.maxHp = payload.maxHp;

            if (typeof this.updateUi === 'function') this.updateUi();
            this.localDestroyedAt = now;

            // Visuals + callback used by App.js to show the DESTROYED overlay and respawn flow
            try { if (typeof this.triggerShipExplosion === 'function') this.triggerShipExplosion(); } catch {}
            try { if (typeof this.onShipDestroyed === 'function') this.onShipDestroyed(payload); } catch {}

            return;
        }

        // -----------------------------
        // Remote player death
        // -----------------------------
        const rp = this.remotePlayers.get(targetId);
        if (rp) {
            try { if (rp.sprite) this.scene.remove(rp.sprite); } catch {}
            try { if (rp.nameSprite) this.scene.remove(rp.nameSprite); } catch {}
            this.remotePlayers.delete(targetId);
        }
    } catch {
        // ignore
    }
}

spawnOrUpdateRemotePlayer(state) {
        if (!this.scene) return;
        let player = this.remotePlayers.get(state.id);
        
        if (!player) {
            const nameSprite = this.createRemoteNameSprite(state.name || "COMMANDER");
            this.scene.add(nameSprite);

            player = {
                id: state.id,
                name: state.name || "COMMANDER",
                shipType: normalizeShipTypeKey(state.ship_type || state.shipType || "OMNI SCOUT"),
                sprite: null,
                nameSprite: nameSprite,
                currentPos: new THREE.Vector3(state.x, state.y, 0),
                targetPos: new THREE.Vector3(state.x, state.y, 0),
                currentRot: state.rot,
                targetRot: state.rot,
                lastUpdate: Date.now(),
                collisionRadius: 20,
                animation_state: state.animation_state || {},
                visual_config: state.visual_config || {},
                syndicateId: state.syndicateId || state.syndicate_id || state.commanderStats?.syndicate_id || state.commanderStats?.syndicateId || null,
                syndicate_id: state.syndicate_id || state.syndicateId || state.commanderStats?.syndicate_id || state.commanderStats?.syndicateId || null,
                stats: { hp: 100, maxHp: 100, shields: 0, maxShields: 0, energy: 0, maxEnergy: 0, fittings: {}, ...(state.stats || {}) }
            };
            this.remotePlayers.set(state.id, player);
            this.updateRemotePlayerSprite(player, player.shipType);
        } else {
            player.targetPos.set(state.x, state.y, 0);
            player.targetRot = state.rot;
            player.lastUpdate = Date.now();

            player.syndicateId = state.syndicateId || state.syndicate_id || player.syndicateId || player.syndicate_id || null;
            player.syndicate_id = state.syndicate_id || state.syndicateId || player.syndicate_id || player.syndicateId || null;

            // Sync vitals/fittings (optional)
            if (state.stats) {
                player.stats = { ...(player.stats || {}), ...state.stats };

                // Shield visuals depend on whether a shield module is fitted
                const fittings = player.stats?.fittings || {};
                const hasShield = Object.values(fittings).some(m => m?.type === 'shield' || (m?.name && m.name.toLowerCase().includes('shield')));
                if (hasShield && !player.shieldMesh) {
                    player.shieldImpacts = [];
                    for (let i = 0; i < 8; i++) player.shieldImpacts.push(new THREE.Vector3(0, 0, -999));
                    const shipCfg = SHIP_REGISTRY[player.shipType] || {};
                    const scale = (shipCfg.scale || 64) / 64; // fallback-ish; updateRemotePlayerSprite will rescale properly
                    player.shieldMesh = this.createShieldMesh(scale, player.shieldImpacts, player.shipType);
                    player.shieldHitAlpha = 0;
                    player.shieldPulseTimer = 0;
                    this.scene.add(player.shieldMesh);
                } else if (!hasShield && player.shieldMesh) {
                    this.scene.remove(player.shieldMesh);
                    try { player.shieldMesh.geometry?.dispose?.(); player.shieldMesh.material?.dispose?.(); } catch {}
                    player.shieldMesh = null;
                }
            }
            
            // Sync visual properties from mapped state
            if (state.animation_state) player.animation_state = state.animation_state;
            if (state.visual_config) player.visual_config = state.visual_config;

            if (state.ship_type && state.ship_type !== player.shipType) {
                this.updateRemotePlayerSprite(player, state.ship_type);
            }

            if (state.name && state.name !== player.name) {
                player.name = state.name;
                this.updateRemoteNameSprite(player);
            }

            this.applyRemoteVisualState(player);
        }
    }

    // -----------------------------------------------------
    // EC2 REMOTE PLAYER: COMPATIBILITY HELPERS
    // -----------------------------------------------------
    // Older networking code expects a "spawnRemoteShip(userId, x, y, rot)" function.
    // We keep it as a thin wrapper around the modern remote-player pipeline.
    spawnRemoteShip(userId, x, y, rot) {
        const state = {
            id: userId,
            x,
            y,
            rot,
            name: `CMDR_${String(userId).slice(0, 4)}`,
            shipType: 'OMNI SCOUT',
            ship_type: 'OMNI SCOUT'
        };
        this.spawnOrUpdateRemotePlayer(state);
        return this.remotePlayers.get(userId)?.sprite || null;
    }

    // Despawn / cleanup a remote player (used when server tells us PLAYER_LEFT)
    despawnRemotePlayer(userId) {
        try {
            const rp = this.remotePlayers.get(userId);
            if (!rp) return;

            if (rp.sprite) {
                try { this.scene?.remove(rp.sprite); } catch {}
                try { rp.sprite.geometry?.dispose?.(); } catch {}
                try {
                    // materials can be arrays
                    const m = rp.sprite.material;
                    if (Array.isArray(m)) m.forEach(mm => mm?.dispose?.());
                    else m?.dispose?.();
                } catch {}
            }

            if (rp.nameSprite) {
                try { this.scene?.remove(rp.nameSprite); } catch {}
                try { rp.nameSprite.material?.dispose?.(); } catch {}
                try { rp.nameSprite.geometry?.dispose?.(); } catch {}
            }

            if (rp.shieldMesh) {
                try { this.scene?.remove(rp.shieldMesh); } catch {}
                try { rp.shieldMesh.geometry?.dispose?.(); } catch {}
                try { rp.shieldMesh.material?.dispose?.(); } catch {}
                rp.shieldMesh = null;
            }

            if (this.friendlyTarget?.id === userId || this.target?.id === userId || this.locking?.entity?.id === userId) {
                this.breakLock('Target left system');
            }

            this.remotePlayers.delete(userId);
        } catch {
            // ignore
        }
    }

    applyRemoteVisualState(player) {
        if (!player.sprite || !player.sprite.material) return;

        // Apply Colors from Visual Config
        const config = player.visual_config;
        if (config && config.primary_color && player.sprite.material.uniforms) {
            player.sprite.material.uniforms.uColor.value.set(config.primary_color);
        }

        // Apply Toggles from Animation State
        const anim = player.animation_state;
        if (!anim) return;
        
        // Thruster Flares (remote)
        if (player.engineFlares && player.engineFlares.length) {
            this.updateRemoteEngineFlare(player, anim, config);
        }

        // Shield Visual
        if (player.shieldMesh) {
            const shieldValue = Number(player.stats?.shields ?? 0);
            const maxShieldValue = Number(player.stats?.maxShields ?? 0);
            player.shieldMesh.visible = Boolean(anim.shieldsOn || maxShieldValue > 0 || shieldValue > 0 || player.shieldHitAlpha > 0.01);
        }

        // Mining Beams / Industrial Activity
        if (anim.miningActive && anim.miningTargetPos) {
            const targetPos = new THREE.Vector3(anim.miningTargetPos.x, anim.miningTargetPos.y, 0);
            const beamId = `mining-beam-${player.id}`;
            
            if (this.activeBeams[beamId]) {
                this.activeBeams[beamId].lastFired = Date.now();
                this.activeBeams[beamId].aimPoint = targetPos;
            } else {
                // Trigger visual only fire logic
                this.triggerRemoteFireFx(player, {
                    slotId: 'mining',
                    item: { type: 'mining', name: 'Mining Laser' },
                    aimPoint: anim.miningTargetPos
                });
            }
        }
    }

    /**
     * Remote thruster flare animation.
     *
     * Remote ships don't run the local input loop, so we use animation_state hints
     * (accelX/accelY/joyY/thrustPower) provided by the sender to animate flares.
     */
    updateRemoteEngineFlare(player, anim = {}, config = {}) {
        if (!player?.engineFlares || !player.sprite) return;

        const isShipActive = (player.stats?.hp ?? 1) > 0 && player.sprite.visible;

        const thrustPower = Math.max(0, Math.min(1, Number(anim.thrustPower ?? (anim.ionThrusterActive ? 1 : 0)) || 0));
        const accelX = Number(anim.accelX || 0);
        const accelY = Number(anim.accelY || 0);
        const joyInput = { x: Number(anim.joyX || 0), y: Number(anim.joyY || 0) };

        // Convert world accel into local space using the ship rotation (same logic as local updateEngineFlare)
        const rot = typeof player.targetRot === 'number'
            ? player.targetRot
            : (typeof player.currentRot === 'number'
                ? player.currentRot
                : (typeof player.sprite.rotation === 'number' ? player.sprite.rotation : 0));
        const rotationMatrix = new THREE.Matrix4().makeRotationZ(rot);
        const inverseMatrix = rotationMatrix.invert();
        const worldInput = new THREE.Vector3(accelX, accelY, 0);
        const localInput = worldInput.applyMatrix4(inverseMatrix);
        const lX = localInput.x;
        const lY = localInput.y;

        const activeEngines = new Set();
        if (isShipActive) {
            if (lY > 0.01) {
                activeEngines.add('thrusterBack');
                activeEngines.add('thrusterSW');
                activeEngines.add('thrusterSE');
                activeEngines.add('thrusterS');
            }
            if (lY < -0.01) {
                activeEngines.add('thrusterFront');
                activeEngines.add('thrusterNW');
                activeEngines.add('thrusterNE');
                activeEngines.add('thrusterN');
            }
            if (lX > 0.01) {
                activeEngines.add('thrusterLeft');
                activeEngines.add('thrusterNW');
                activeEngines.add('thrusterSW');
                activeEngines.add('thrusterW');
            }
            if (lX < -0.01) {
                activeEngines.add('thrusterRight');
                activeEngines.add('thrusterNE');
                activeEngines.add('thrusterSE');
                activeEngines.add('thrusterE');
            }
        }

        const baseTargetOpacity = (isShipActive && (anim.ionThrusterActive || thrustPower > 0.05 || joyInput.y > 0.1)) ? 0.35 : 0;

        player.engineFlares.forEach((flare) => {
            if (!flare || !flare.group || !flare.glow || !flare.streak) return;

            // Color
            if (config?.thruster_color && flare.glow?.material?.color) {
                try { flare.glow.material.color.set(config.thruster_color); } catch {}
            }

            let isActive = false;
            if (isShipActive) {
                if (flare.side === 'engineL' || flare.side === 'engineR') {
                    isActive = joyInput.y > 0.1 || thrustPower > 0.2;
                } else {
                    const side = flare.side;
                    if (activeEngines.has(side)) {
                        isActive = true;
                    } else if (side?.startsWith?.('thruster')) {
                        // Fallback heuristic (same as local)
                        if (lY > 0.01 && (side.startsWith('thrusterBack') || side.includes('SW') || side.includes('SE') || side === 'thrusterS')) isActive = true;
                        if (lY < -0.01 && (side.startsWith('thrusterFront') || side.includes('NW') || side.includes('NE') || side === 'thrusterN')) isActive = true;
                        if (lX > 0.01 && (side.startsWith('thrusterLeft') || side.includes('NW') || side.includes('SW') || side === 'thrusterW')) isActive = true;
                        if (lX < -0.01 && (side.startsWith('thrusterRight') || side.includes('NE') || side.includes('SE') || side === 'thrusterE')) isActive = true;
                    }
                }
            }

            const targetOpacity = isActive ? baseTargetOpacity : 0;
            const lerpFactor = isActive ? 0.15 : 0.4;

            flare.glow.material.opacity += (targetOpacity - flare.glow.material.opacity) * lerpFactor;
            flare.streak.material.opacity = flare.glow.material.opacity * 0.4;

            if (flare.glow.material.opacity > 0.001) {
                flare.group.visible = true;

                const visualScale = player.sprite.scale.x || 64;
                const baseScaleFactor = (flare.side && String(flare.side).startsWith('thruster')) ? 0.3 : 0.6;
                const baseScale = (18 * Math.max(0.2, thrustPower) * baseScaleFactor) / visualScale;

                flare.glow.scale.set(baseScale, baseScale, 1);
                flare.streak.scale.set(baseScale * 3.0, baseScale * 0.25, 1);
            } else {
                flare.group.visible = false;
                flare.glow.scale.set(0.001, 0.001, 1);
                flare.streak.scale.set(0.001, 0.001, 1);
            }
        });
    }

    getShipScale(shipType) {
        const shipConfig = SHIP_REGISTRY[shipType] || SHIP_REGISTRY['OMNI SCOUT'];
        return shipConfig.visualScale || 64;
    }

    createShipVisual(shipType, isLocal = false) {
        const normalizedShipType = normalizeShipTypeKey(shipType);
        const shipConfig = SHIP_REGISTRY[normalizedShipType] || SHIP_REGISTRY['OMNI SCOUT'];
        const spriteUrl = shipConfig.spriteUrl || 'https://rosebud.ai/assets/spaceship.png.webp?6ILm';
        const visualScale = shipConfig.visualScale || 64;
        
        let visual;
        // Use a mesh for every player ship so remote rotation behaves the same as local rotation.
        if (true) {
            const geometry = new THREE.PlaneGeometry(1, 1);
            const material = new THREE.ShaderMaterial({
                vertexShader: SHIP_VERTEX_SHADER,
                fragmentShader: SHIP_FRAGMENT_SHADER,
                uniforms: {
                    uMap: { value: null },
                    uKeyGreen: { value: normalizedShipType === 'OMNI INTERCEPTOR' },
                    uKeyWhite: { value: normalizedShipType === 'OMNI GUNSHIP' || normalizedShipType === 'OMNI SCOUT' || normalizedShipType === 'OMNI INTERCEPTOR' || normalizedShipType === 'OMNI SOVEREIGN' || normalizedShipType === 'OMNI MINING SHIP' || normalizedShipType === 'OMNI COMMAND' || normalizedShipType === 'OMNI HAULER' },
                    uColor: { value: isLocal ? new THREE.Color(0x33ffcc) : new THREE.Color(0xffcc33) }, // Cyan for local, Amber for remote
                    uDamage: { value: 0.0 },
                    uBrightness: { value: (normalizedShipType === 'OMNI HAULER' || normalizedShipType === 'OMNI SOVEREIGN') ? 1.35 : 1.0 },
                    uTime: { value: 0.0 }
                },
                transparent: true
            });
            visual = new THREE.Mesh(geometry, material);
        } else {
            const material = new THREE.SpriteMaterial({ transparent: true });
            visual = new THREE.Sprite(material);
        }

        visual.renderOrder = isLocal ? 5 : 4;
        visual.scale.set(visualScale, visualScale, 1);

        // Load texture
        const loader = new THREE.TextureLoader();
        loader.load(spriteUrl, (texture) => {
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.LinearMipMapLinearFilter;
            if (visual.isMesh) {
                visual.material.uniforms.uMap.value = texture;
                const aspect = texture.image.width / texture.image.height;
                if (normalizedShipType === 'OMNI COMMAND') {
                    visual.scale.set(visualScale, visualScale, 1);
                } else if (aspect > 1) {
                    visual.scale.x = visualScale * aspect;
                    visual.scale.y = visualScale;
                } else if (aspect < 1) {
                    visual.scale.x = visualScale;
                    visual.scale.y = visualScale / aspect;
                }
            } else {
                visual.material.map = texture;
            }
            visual.material.needsUpdate = true;
        });

        return { visual, config: shipConfig, scale: visualScale };
    }

    updateRemotePlayerSprite(player, shipType) {
        if (!this.scene) return;
        
        // Cleanup old
        if (player.sprite) {
            this.scene.remove(player.sprite);
            if (player.sprite.material?.map) player.sprite.material.map.dispose();
            if (player.sprite.material) player.sprite.material.dispose();
        }
        if (player.shieldMesh) {
            this.scene.remove(player.shieldMesh);
            if (player.shieldMesh.geometry) player.shieldMesh.geometry.dispose();
            if (player.shieldMesh.material) player.shieldMesh.material.dispose();
            player.shieldMesh = null;
        }

        player.shipType = normalizeShipTypeKey(shipType);
        const { visual, config, scale } = this.createShipVisual(player.shipType, false);
        player.sprite = visual;
        player.sprite.position.copy(player.currentPos);
        player.collisionRadius = config.collisionRadius || (scale * 0.45);
        this.scene.add(player.sprite);

        // Init Engine Flares for Remote Ships
        player.engineFlares = [];
        const shipConfig = SHIP_REGISTRY[shipType] || {};
        const hardpoints = shipConfig.hardpoints || {};
        
        const createRemoteFlare = (side) => {
            const hp = hardpoints[side];
            if (!hp) return null;
            const flareGroup = new THREE.Group();
            flareGroup.visible = false; 
            flareGroup.position.set(hp.x / 64, hp.y / 64, 0.01);
            let rotation = -Math.PI / 2;
            if (side === 'thrusterFront' || side === 'thrusterN') rotation = Math.PI / 2;
            else if (side === 'thrusterLeft' || side === 'thrusterW') rotation = Math.PI;
            else if (side === 'thrusterRight' || side === 'thrusterE') rotation = 0;
            flareGroup.rotation.z = rotation;
            const glowTex = this.createParticleTexture();
            const glowMat = new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, opacity: 0 });
            const glowSprite = new THREE.Sprite(glowMat);
            glowSprite.scale.set(0.001, 0.001, 1); 
            flareGroup.add(glowSprite);
            const streakMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
            streakMesh.scale.set(0.001, 0.001, 1); 
            streakMesh.position.x = 0.5; 
            flareGroup.add(streakMesh);
            player.sprite.add(flareGroup);
            return { group: flareGroup, glow: glowSprite, streak: streakMesh, side: side };
        };

        if (hardpoints['engineL']) player.engineFlares.push(createRemoteFlare('engineL'));
        if (hardpoints['engineR']) player.engineFlares.push(createRemoteFlare('engineR'));
        Object.keys(hardpoints).forEach(key => { if (key.startsWith('thruster')) player.engineFlares.push(createRemoteFlare(key)); });

        // Re-init shield if needed
        const fittings = player.stats?.fittings || {};
        const hasShield = Object.values(fittings).some(m => m?.type === 'shield' || (m?.name && m.name.toLowerCase().includes('shield')));
        if (hasShield) {
            player.shieldImpacts = [];
            for (let i = 0; i < 8; i++) player.shieldImpacts.push(new THREE.Vector3(0, 0, -999));
            player.shieldMesh = this.createShieldMesh(scale, player.shieldImpacts, shipType);
            player.shieldHitAlpha = 0;
            player.shieldPulseTimer = 0;
            this.scene.add(player.shieldMesh);
        }
    }

    updateRemoteNameSprite(player) {
        const canvas = player.nameSprite.material.map.image;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.drawNameOnCanvas(ctx, canvas.width, canvas.height, player.name);
        player.nameSprite.material.map.needsUpdate = true;
    }

    createRemoteNameSprite(name) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        this.drawNameOnCanvas(ctx, canvas.width, canvas.height, name);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(material);
        // Match local player's name tag baseline size (see init: this.nameSprite.scale.set(180, 45, 1))
        sprite.scale.set(180, 45, 1);
        sprite.renderOrder = 1000;
        return sprite;
    }

    drawNameOnCanvas(ctx, w, h, name) {
        ctx.font = 'bold 60px monospace';
        const textWidth = ctx.measureText(name).width;
        const padding = 40;
        const capsuleWidth = textWidth + padding;
        const capsuleHeight = 80;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        const x = (w - capsuleWidth) / 2;
        const y = (h - capsuleHeight) / 2;
        const r = capsuleHeight / 2;
        
        // Draw Capsule
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + capsuleWidth - r, y);
        ctx.arcTo(x + capsuleWidth, y, x + capsuleWidth, y + r, r);
        ctx.arcTo(x + capsuleWidth, y + capsuleHeight, x + capsuleWidth - r, y + capsuleHeight, r);
        ctx.lineTo(x + r, y + capsuleHeight);
        ctx.arcTo(x, y + capsuleHeight, x, y + r, r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
        ctx.fill();
        
        ctx.strokeStyle = 'rgba(0, 204, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#00ccff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name.toUpperCase(), w / 2, h / 2);
    }

    constructor(container, setGameState, showNotification, initialShipId = 'OMNI SCOUT', onShipDestroyed, initialCargoWeight = 0, initialCargoVolume = 0, setIsDocked, uiActions = {}, initialHp = null) {
        this.container = container;
        this.setGameState = setGameState;
        this.showNotification = showNotification;
        this.onShipDestroyed = onShipDestroyed;
        this.setIsDockedCallback = setIsDocked;
        
        // Loot Batching System
        this.pendingLoot = new Map();
        this.lootBatchTimer = null;
        this.lastInventoryString = ""; // Idempotency check

        // Battleground NPC spawn tracking
        // Prevents duplicate visual spawns when the same NPC arrives through
        // overlapping battleground messages before texture creation completes.
        this.pendingBattlegroundNpcSpawns = new Set();
        
        // UI Action Callbacks
        this.setActiveMenu = uiActions.setActiveMenu;
        this.setShowStarMap = uiActions.setShowStarMap;
        this.setIsLeapMode = uiActions.setIsLeapMode;
        this.setInitialStarMapView = uiActions.setInitialStarMapView;
        this.onBroodmotherDestroyed = uiActions.onBroodmotherDestroyed;
        this.onSaveRequested = uiActions.onSaveRequested;
        this.onArenaBeaconInteract = uiActions.onArenaBeaconInteract;
        this.onBattlegroundBeaconInteract = uiActions.onBattlegroundBeaconInteract;
        
        // Hostile Spawning State
        this.threatLevel = 0;
        this.threatCooldown = 0;
        this.broodmotherSystemIds = [];
        this.lastPlayerPosForTravelThreat = new THREE.Vector3(0, 0, 0);
        this.travelThreatAccumulator = 0;
        
        // Locked Internal Resolution (1080p)
        this.width = 1920;
        this.height = 1080;
        
        // Camera Zoom / Distance Settings
        this.cameraDistance = 1800.0; // Default set to previous max
        this.minCameraDistance = 650.0;
        this.maxCameraDistance = 2200.0; // Refined max zoom-out range

        // Initialize Ship Stats from Registry
        const shipConfig = SHIP_REGISTRY[initialShipId] || SHIP_REGISTRY['OMNI SCOUT'];
        const isPending = initialShipId === 'PENDING';

        this.baseShipConfig = {
            baseSigRadius: shipConfig.baseSigRadius,
            basePG: shipConfig.basePG,
            baseCPU: shipConfig.baseCPU,
            targetingStrength: shipConfig.targetingStrength ?? shipConfig.lockMultiplier ?? 1,
            scanSpeed: shipConfig.scanSpeed ?? 1,
            recommendedWeaponSizes: shipConfig.recommendedWeaponSizes,
            authoritativeBaseHp: shipConfig.hp,
            authoritativeBaseArmor: shipConfig.armor || 0,
            authoritativeResistances: {
                kinetic: shipConfig.kineticRes || 0,
                thermal: shipConfig.thermalRes || 0,
                blast: shipConfig.blastRes || 0
            }
        };

        this.stats = {
            name: isPending ? 'PENDING' : initialShipId,
            shields: 0,
            maxShields: 0,
            hp: isPending ? 0 : (initialHp ?? shipConfig.hp),
            maxHp: isPending ? 1 : shipConfig.hp, // Set to 1 to avoid div-by-zero
            armor: isPending ? 0 : shipConfig.armor,
            kineticRes: isPending ? 0 : shipConfig.kineticRes,
            thermalRes: isPending ? 0 : shipConfig.thermalRes,
            blastRes: isPending ? 0 : shipConfig.blastRes,
            energy: isPending ? 0 : shipConfig.baseEnergy,
            maxEnergy: isPending ? 1 : shipConfig.baseEnergy,
            jumpEnergyCost: isPending ? 0 : shipConfig.jumpEnergyCost,
            jumpWarmupTime: isPending ? 7000 : (shipConfig.jumpWarmupTime || 7000),
            energyRegen: isPending ? 0 : (shipConfig.baseEnergyRecharge || 1.0),
            reactorRecovery: isPending ? 0 : (shipConfig.baseEnergyRecharge || 1.0),
            cargoHold: isPending ? 0 : shipConfig.cargoHold,
            cargoMaxVolume: isPending ? 0 : (shipConfig.cargoMaxVolume || 100),
            currentCargoWeight: initialCargoWeight,
            currentCargoVolume: initialCargoVolume,
            scanRange: isPending ? 0 : shipConfig.scanRange, 
            scanSpeed: isPending ? 0 : (shipConfig.scanSpeed ?? 1),
            scanTime: 3500,
            lockOnRange: isPending ? 0 : shipConfig.lockOnRange,
            lockOnTime: 4000,
            targetingStrength: isPending ? 0 : (shipConfig.targetingStrength ?? shipConfig.lockMultiplier ?? 1),
            sigRadius: isPending ? 0 : shipConfig.baseSigRadius,
            brakingForce: isPending ? 1.5 : (shipConfig.brakingForce || 1.5),
            thrustImpulse: isPending ? 3.0 : (shipConfig.thrustImpulse || 3.0)
        };

        // Hardpoint World Positions (Calculated every frame)
        this.hardpointWorldPositions = {};
        this.hardpoints = shipConfig.hardpoints;

        // Entities for Radar (Asteroids)
        this.asteroids = [];
        this.entities = []; // For radar logic compatibility
        this.systemStructures = new Map();
        this.scannedEntities = new Set(); // Track which IDs are scanned
        this.anomalyRespawnQueue = []; // [{ systemId: string, respawnTime: number }]
        this.systemAnomalyCounts = {}; // Track how many anomalies are active per system id

        // Scanning state
        this.scanning = {
            active: false,
            entity: null,
            startTime: 0,
            progress: 0
        };

        // Locking state
        this.locking = {
            state: 'Idle', // Idle, Priming, Locked, Broken, Cooldown
            entity: null,
            startTime: 0,
            progress: 0,
            requiredTime: 0,
            cooldownTime: 0,
            lastCooldownStart: 0,
            lastMissileFiredTime: 0
        };

        this.target = null;
        this.remotePlayers = new Map(); // entityId -> Sprite
        this.hostileTarget = null;
        this.friendlyTarget = null;
        this.lastTargetId = null;
        this.fleet = []; // authoritative fleet snapshot from EC2
        this.fleetId = null;
        this.fleetLeaderId = null;
        this.pendingFleetInvites = new Map();
        this.contextMenu = null; // { x, y, entity }

        // Scene setup
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
        this.camera.position.z = 10;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.width, this.height);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.objectFit = 'contain'; // Maintain 16:9 aspect within container
        this.lastFluxFireTime = 0;
        this.container.appendChild(this.renderer.domElement);
        
        // Initial camera bounds setup
        this.onResize();

        // Audio Setup
        this.synth = null;
        this.initAudio();

        this.weaponStates = {}; // Track heat, overheat, and cooling for flux weapons
        this.activeBeams = {}; // Track active continuous visuals for Flux/Mining beams
        this.serverMiningTargetId = null;
        this.serverMiningLastStartAt = 0;
        this.missiles = []; // Active missile projectiles
        this.worldObjects = new WorldObjectsService(this.scene, this); // World objects (loot/ore/etc)
        
        // Multiplayer State
        this.remotePlayers = new Map();
        this.lastBroadcastTime = 0;
        this.broadcastInterval = 100; // ms
        this.lastPersistTime = 0;
        this.persistInterval = 5000; // Authority persistence interval (ms)
        this.isLoaded = false; // Guard against early persistence before cloud sync
        
        cloudService.subscribe((msg) => this.handleNetworkMessage(msg));

        this.projectiles = []; // Active pulse cannon projectiles
        this.inkClouds = []; // Persistent corrosive trails from Star-Eaters
        this.weaponAmmo = {}; // Track ammo for magazine-based weapons
        this.spaceSquids = []; // Decorative space squids
        
        // --- Bio-Acoustic System ---
        this.bioAudio = {
            hum: new Tone.Oscillator({ type: 'sine', frequency: 32, volume: -Infinity }).toDestination(),
            pulse: new Tone.LFO({ frequency: 0.15, min: -20, max: -5 }).start(),
            isInitialized: false
        };
        this.bioAudio.hum.chain(new Tone.Filter(200, 'lowpass'), Tone.Destination);
        this.bioAudio.pulse.connect(this.bioAudio.hum.volume);

        // Input
        this.joystick = new Joystick(this.container);
        // DISABLING MOBILE JOYSTICK - THIS IS NOW A PC GAME
        this.joystick.base.style.display = 'none';

        // Flight Physics - Base Configuration from Registry
        this.ship = {
            id: initialShipId,
            type: initialShipId,
            sprite: null,
            velocity: new THREE.Vector2(0, 0),
            rotation: 0,
            baseMaxSpeed: shipConfig.maxSpeed || 3.5,
            maxSpeed: shipConfig.maxSpeed || 3.5,
            baseThrust: 0.05,
            thrust: 0.05,
            friction: 1.0,
            turnSpeed: shipConfig.turnSpeed || 0.0131,
            baseVisualScale: 64,  // Visual footprint on screen
            inertialDampeners: true // Default to ON
        };

        this.keys = {};
        this.mousePos = new THREE.Vector2(); // Screen space (-1 to 1)
        this.mouseWorldPos = new THREE.Vector3(); // World space
        this.mouseButtons = { 0: false, 2: false }; // LMB, RMB
        this.cursorSprite = null; // Visual cursor
        this.lastUiUpdate = 0;
        this.pulseTimer = 0; // For rarity flashing
        this.hoveredEntity = null; // Track entity under mouse
        this.lastHoveredId = null; // Track hover changes
        this.isMenuOpen = false; // Track if UI menu is open to show/hide cursor
        this.lastTargetId = null; // Track target changes
        
        // Damage stacking management
        this.damageStacks = new Map(); // entityId -> { shield: StackObj, hull: StackObj }
        
        // Asteroid Belt Management
        this.asteroidBelts = [];
        this.beltCounter = 0;
        this.systemConfig = {
            beltCount: 2,
            beltRespawnTime: 120000, // 2 minutes in ms
            beltSize: 6,
            jumpEnergyCost: 50,
            jumpWarmupTime: 7000 // 7 seconds
        };

        // Jump State
        this.jumpDrive = {
            active: false,
            startTime: 0,
            destination: null,
            progress: 0,
            remaining: 0
        };

        this.npcs = [];
        this.patrols = [];
        this.lastNpcUpdate = 0;
        this.miningShipSpawnTimer = 0; // Timer for Cartel Mining Ship respawns

        this.isDocked = false;
        this.currentSystemId = 'cygnus-prime';
        this.instanceBoundaryRefreshPending = false;
        this.instanceBoundaryVisuals = null;
        this.instanceBoundaryTextureCache = new Map();
        this.instanceBoundaryProfileKey = null;
        
        // Player State (managed by App.js but accessible here)
        this.inventory = []; 
        this.fittings = {};
        this.commanderImplants = {};
        
        // Courier Contracts System
        this.courierContracts = []; // { id, ownerId, ownerName, item, originSystemId, destinationSystemId, reward, collateral, expiresAt, haulerId, status: 'available'|'active'|'completed'|'failed' }
        
        // Regional Storage & Markets (State persistence is handled by App.js)
        this.regionalStorage = {}; // systemId -> items[]
        this.globalMarkets = {}; // systemId -> { commodities: [], auctions: [] }
        this.marketHistory = {}; // itemId -> { last7Days: { average, high, low, volume } }
        
        // Background Layers & Trackers (Initialized synchronously to prevent early update crashes)
        this.starLayers = [];
        this.nebulaLayers = [];
        this.planetLayers = [];
        this.flareGhosts = [];
        this.shootingStars = [];
        this.lastShootingStarTime = 0;
        this.nebulaMeshes = [];

        // Weapon Cooldown Tracking (local and for state)
        this.weaponCooldowns = {};
        Object.keys(this.hardpoints).forEach(slotId => {
            this.weaponCooldowns[slotId] = 0;
        });
        
        this.activeWeapons = {};
        Object.keys(this.hardpoints).forEach(slotId => {
            this.activeWeapons[slotId] = false;
        });

        // Audio Activation
        this._audioInitialized = false;
        this._arenaMusicActive = false;
        const activateAudio = () => {
            if (this._audioInitialized) return;
            Tone.start().then(() => {
                this._audioInitialized = true;
                this.initAudio();
                audioManager.init();
                console.log("Audio Engine Online");
            });
        };
        window.addEventListener('mousedown', activateAudio);
        window.addEventListener('touchstart', activateAudio);
        window.addEventListener('keydown', activateAudio);

        // Initialize RNG for world generation
        this.rng = new SeededRandom(2024); // Fresh shared sector seed for multiplayer synchronization

        this.lastFrameTime = performance.now();

        this.droneManager = new DroneManager(this);

        // Initialization
        this.init();
        this.setupEvents();
        this.animate();
    }

    requestSave() {
        if (this.onSaveRequested) {
            this.onSaveRequested();
        }
    }

    addExperience(amount) {
        if (!amount || amount <= 0) return;
        
        this.setGameState(prev => {
            let nextExp = (prev.experience || 0) + amount;
            let nextLevel = prev.level || 1;
            
            // Check for level up
            let requiredExp = getRequiredExp(nextLevel);
            let leveledUp = false;
            
            while (nextExp >= requiredExp && nextLevel < 100) {
                nextExp -= requiredExp;
                nextLevel++;
                requiredExp = getRequiredExp(nextLevel);
                leveledUp = true;
            }
            
            if (leveledUp) {
                this.showNotification(`LEVEL UP: REACHED RANK ${nextLevel}`, "success");
                this.speak(`Congratulations Commander. You have achieved level ${nextLevel}.`);
                // Trigger an immediate cloud sync on level up
                this.syncCommanderProgress(nextExp, nextLevel);
            }
            
            return {
                ...prev,
                experience: nextExp,
                level: nextLevel
            };
        });
    }

    async syncCommanderProgress(xp, level) {
        if (!cloudService.user) return;
        
        try {
            await cloudService.updateCommanderData(cloudService.user.id, {
                experience: xp,
                level: level
            });
            console.log(`[GameManager] Commander progress synchronized: Level ${level}, XP ${xp.toFixed(1)}`);
        } catch (e) {
            console.warn("[GameManager] Failed to sync commander progress:", e.message);
        }
    }

    createExplosionEffect(position, radius) {
        // REFINED AOE PHYSICS: Synchronized visual explosion scale with actual damage radius
        const explosionSize = radius * 2; 
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.2, '#ffcc00');
        grad.addColorStop(0.5, '#ff6600');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const explosion = new THREE.Sprite(material);
        explosion.position.copy(position);
        explosion.scale.set(explosionSize * 0.1, explosionSize * 0.1, 1);
        explosion.renderOrder = 40;
        this.scene.add(explosion);
        
        const duration = 400;
        const start = Date.now();
        
        const animate = () => {
            const now = Date.now();
            const t = (now - start) / duration;
            if (t >= 1) {
                this.scene.remove(explosion);
                texture.dispose();
                material.dispose();
                return;
            }
            explosion.material.opacity = 1 - t;
            const s = explosionSize * (0.1 + 0.9 * Math.sin(t * Math.PI * 0.5));
            explosion.scale.set(s, s, 1);
            requestAnimationFrame(animate);
        };
        animate();

        // Secondary shockwave ring
        const ringGeom = new THREE.RingGeometry(0.95, 1, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.position.copy(position);
        ring.renderOrder = 39;
        this.scene.add(ring);

        const ringDuration = 600;
        const ringStart = Date.now();
        const animateRing = () => {
            const now = Date.now();
            const t = (now - ringStart) / ringDuration;
            if (t >= 1) {
                this.scene.remove(ring);
                ringGeom.dispose();
                ringMat.dispose();
                return;
            }
            ring.material.opacity = (1 - t) * 0.5;
            const s = explosionSize * 1.5 * t;
            ring.scale.set(s, s, 1);
            requestAnimationFrame(animateRing);
        };
        animateRing();
    }

    createWarpInEffect(position) {
        // Visual "jump in" effect: a vertical spike of light and a ring expansion
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.3, '#00ccff');
        grad.addColorStop(0.6, '#0044ff');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const flash = new THREE.Sprite(material);
        flash.position.copy(position);
        flash.scale.set(10, 10, 1);
        flash.renderOrder = 41;
        this.scene.add(flash);
        
        // Ring shockwave
        const ringGeom = new THREE.RingGeometry(0.8, 1, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.position.copy(position);
        ring.renderOrder = 40;
        this.scene.add(ring);

        const duration = 800;
        const start = Date.now();
        
        const animate = () => {
            const now = Date.now();
            const t = (now - start) / duration;
            if (t >= 1) {
                this.scene.remove(flash);
                this.scene.remove(ring);
                texture.dispose();
                material.dispose();
                ringGeom.dispose();
                ringMat.dispose();
                return;
            }
            
            // Flash expands rapidly then fades
            const flashScale = 300 * Math.sin(t * Math.PI);
            flash.scale.set(flashScale, flashScale, 1);
            flash.material.opacity = 1 - t;

            // Ring expands and fades
            const ringScale = 400 * t;
            ring.scale.set(ringScale, ringScale, 1);
            ring.material.opacity = (1 - t) * 0.5;

            requestAnimationFrame(animate);
        };
        animate();
    }

    createWarpOutEffect(position) {
        // Visual "jump out" effect: reverse of jump in, flash and implode
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.3, '#00ccff');
        grad.addColorStop(0.6, '#0044ff');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const flash = new THREE.Sprite(material);
        flash.position.copy(position);
        flash.scale.set(300, 300, 1);
        flash.renderOrder = 41;
        this.scene.add(flash);

        const duration = 600;
        const start = Date.now();
        
        const animate = () => {
            const now = Date.now();
            const t = (now - start) / duration;
            if (t >= 1) {
                this.scene.remove(flash);
                texture.dispose();
                material.dispose();
                return;
            }
            
            // Flash implodes rapidly
            const flashScale = 300 * (1 - t);
            flash.scale.set(flashScale, flashScale, 1);
            flash.material.opacity = 1 - t;

            requestAnimationFrame(animate);
        };
        animate();
    }

    
createMuzzleFlashFx(position, opts = {}) {
    if (!position) return;
    const size = Number.isFinite(opts.size) ? opts.size : 22;
    const intensity = Number.isFinite(opts.intensity) ? opts.intensity : 1.0;
    const duration = Number.isFinite(opts.duration) ? opts.duration : 120;

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(255,255,255,${0.95 * intensity})`);
    grad.addColorStop(0.25, `rgba(255,220,140,${0.75 * intensity})`);
    grad.addColorStop(0.6, `rgba(255,140,60,${0.25 * intensity})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(size, size, 1);
    sprite.renderOrder = 35;
    this.scene.add(sprite);

    const start = Date.now();
    const animate = () => {
        const t = (Date.now() - start) / duration;
        if (t >= 1) {
            this.scene.remove(sprite);
            texture.dispose();
            material.dispose();
            return;
        }
        const s = size * (1 + t * 0.8);
        sprite.scale.set(s, s, 1);
        sprite.material.opacity = (1 - t) * 0.9;
        requestAnimationFrame(animate);
    };
    animate();
}

createBeamImpactSparkFx(position, opts = {}) {
    if (!position) return;
    const size = Number.isFinite(opts.size) ? opts.size : 16;
    const duration = Number.isFinite(opts.duration) ? opts.duration : 140;

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.3, 'rgba(120,220,255,0.6)');
    grad.addColorStop(0.7, 'rgba(0,120,255,0.15)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(size, size, 1);
    sprite.renderOrder = 34;
    this.scene.add(sprite);

    const start = Date.now();
    const animate = () => {
        const t = (Date.now() - start) / duration;
        if (t >= 1) {
            this.scene.remove(sprite);
            texture.dispose();
            material.dispose();
            return;
        }
        sprite.material.opacity = (1 - t) * 0.8;
        sprite.scale.set(size * (1 + t * 1.4), size * (1 + t * 1.4), 1);
        requestAnimationFrame(animate);
    };
    animate();
}

applyMissileDamageToEntity(entity, damage, isMiss, worldImpactPos = null) {
        if (!entity || entity.static || !entity.sprite) return;
        
        const damageType = 'blast';
        let shieldDealt = 0;
        let hullDealt = 0;

        if (entity.id === 'player-ship' || entity.type === 'PLAYER') { // If we ever damage the player with AoE
            const damageResult = this.takeDamage(damage, damageType, worldImpactPos);
            shieldDealt = damageResult.shieldDamage;
            hullDealt = damageResult.hullDamage;
        } else if (entity.type === 'NPC' || entity.type === 'BIO') {
            const damageResult = this.applyDamageToNpc(entity, damage, damageType);
            shieldDealt = damageResult.shieldDamage;
            hullDealt = damageResult.hullDamage;
        } else if (entity.type === 'Asteroid' || ASTEROID_TYPES.some(t => t.name === entity.type) || !entity.type) {
            const prevOre = entity.oreAmount || 0;
            entity.oreAmount = Math.max(0, (entity.oreAmount || 0) - damage);
            hullDealt = prevOre - (entity.oreAmount || 0);
            if (entity.oreAmount <= 0) {
                this.destroyTarget(entity);
            }
        }

        // Show damage numbers
        if (isMiss) {
            this.showDamageNumber(entity, damage, false, true, 'standard', entity.id);
        } else {
            if (shieldDealt > 0) {
                this.showDamageNumber(entity, shieldDealt, false, false, 'shield', entity.id);
            }
            if (hullDealt > 0) {
                this.showDamageNumber(entity, hullDealt, false, false, 'hull', entity.id);
            }
        }

        // Flash effect
        if (entity.sprite && entity.sprite.material && entity.sprite.material.color && damage > 0) {
            const originalColor = entity.sprite.material.color.clone();
            entity.sprite.material.color.set(0xffffff);
            setTimeout(() => {
                if (entity.sprite && entity.sprite.material && entity.sprite.material.color) entity.sprite.material.color.copy(originalColor);
            }, 50);
        }
    }

    droneAttack(drone, target) {
        if (!target) return;

        const damage = drone.damagePerTick || 0;
        const isMiss = Math.random() > (drone.accuracy || 0.5);
        const finalDamage = isMiss ? 0 : damage;
        
        if (finalDamage > 0) {
            const result = this.applyDamageToNpc(target, finalDamage, 'thermal');
            if (result.shieldDamage > 0) this.showDamageNumber(target, result.shieldDamage, false, false, 'shield', target.id);
            if (result.hullDamage > 0) this.showDamageNumber(target, result.hullDamage, false, false, 'hull', target.id);
        } else {
            this.showDamageNumber(target, 0, false, true, 'standard', target.id);
        }
        
        // Beam visual
        this.showMiningBeam(drone.sprite.position, target.sprite.position, 0xff3333); 
    }

    showMiningBeam(startPos, endPos, color = 0x00ff00) {
        const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
        const points = [startPos.clone(), endPos.clone()];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 30;
        this.scene.add(line);
        
        const start = Date.now();
        const duration = 150;
        const animate = () => {
            const t = (Date.now() - start) / duration;
            if (t >= 1) {
                this.scene.remove(line);
                geometry.dispose();
                material.dispose();
                return;
            }
            line.material.opacity = (1 - t) * 0.8;
            requestAnimationFrame(animate);
        };
        animate();
    }

    showRepairBeam(startPos, endPos) {
        this.showMiningBeam(startPos, endPos, 0x33ffcc);
    }

    findNearestAsteroid(position) {
        let nearest = null;
        let minDist = Infinity;
        this.entities.forEach(entity => {
            const isAsteroid = entity.type === 'Asteroid' || ASTEROID_TYPES.some(t => t.name === entity.type);
            if (isAsteroid && entity.oreAmount > 0 && entity.sprite) {
                const dist = position.distanceTo(entity.sprite.position);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = entity;
                }
            }
        });
        return nearest;
    }

    updateProjectiles(dt, currentTime) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.update(dt, currentTime);
            if (p.expired) {
                p.destroy();
                this.projectiles.splice(i, 1);
            }
        }
    }

    updateAmmo(fittings, currentTime) {
        if (!fittings) return;
        Object.keys(fittings).forEach(slotId => {
            const module = fittings[slotId];
            if (!module) return;
            const ammo = this.weaponAmmo[slotId];
            if (ammo && ammo.reloading) {
                const config = PULSE_CANNON_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || PULSE_CANNON_CONFIGS['S'];
                const reloadTime = (module.reload || config.reload) * 1000;
                if (currentTime - ammo.reloadStartTime >= reloadTime) {
                    ammo.current = config.magazine;
                    ammo.reloading = false;
                    this.showNotification("RELOAD COMPLETE", "success");
                }
            }
        });
    }

    updateMissiles(dt, currentTime) {
        for (let i = this.missiles.length - 1; i >= 0; i--) {
            const m = this.missiles[i];
            m.update(dt, currentTime);
            if (m.expired) {
                m.destroy();
                this.missiles.splice(i, 1);
            }
        }
    }

updateLootObjects(dt, currentTime) {
    // Backward-compatible wrapper (some older code may still call this)
    return this.worldObjects.update(dt, currentTime);
}

async spawnLoot(itemData, position) {
    // Delegated to WorldObjectsService
    return await this.worldObjects.spawnLoot(itemData, position, this.currentSystemId || 'cygnus-prime');
}

    spawnBelt(center, texture, count = 15, name) {
        this.beltCounter++;
        const beltId = `belt-${this.beltCounter}-${Date.now()}`;
        const beltName = name || `Asteroid Belt ${this.beltCounter}`;
        const beltAsteroidIds = [];
        
        const system = resolveSystemDefinition(this.currentSystemId);
        const tier = system?.tier || 1;
        const config = TIER_CONFIGS[tier];

        // Security Modifiers for Ore Rarity and Quality
        const secValue = system?.securityValue ?? 1.0;
        let secKey = 'secure';
        if (secValue < 0.2) secKey = 'null';
        else if (secValue < 0.5) secKey = 'low';
        else if (secValue < 0.7) secKey = 'mid';
        const secMod = SECURITY_MODIFIERS[secKey];

        const weights = [...config.weights];
        const rarityMod = secMod.rarity;

        // Apply rarity shift based on security (lower security = shift weights towards rare ores)
        if (rarityMod > 0) {
            // Null/Low sec: Shift weight from common to uncommon, uncommon to rare, etc.
            const shift0to1 = weights[0] * rarityMod;
            weights[0] -= shift0to1;
            weights[1] += shift0to1;

            const shift1to2 = weights[1] * rarityMod;
            weights[1] -= shift1to2;
            weights[2] += shift1to2;

            const shift2to3 = weights[2] * rarityMod;
            weights[2] -= shift2to3;
            weights[3] += shift2to3;
        } else if (rarityMod < 0) {
            // Secure space: Shift rare towards common
            const absMod = Math.abs(rarityMod);
            const shift3to2 = weights[3] * absMod;
            weights[3] -= shift3to2;
            weights[2] += shift3to2;

            const shift2to1 = weights[2] * absMod;
            weights[2] -= shift2to1;
            weights[1] += shift2to1;

            const shift1to0 = weights[1] * absMod;
            weights[1] -= shift1to0;
            weights[0] += shift1to0;
        }

        for (let i = 0; i < count; i++) {
            let x, y, size, radius;
            let attempts = 0;
            let tooClose = false;

            do {
                const angle = this.rng.next() * Math.PI * 2;
                const dist = 150 + this.rng.next() * 600; 
                x = center.x + Math.cos(angle) * dist;
                y = center.y + Math.sin(angle) * dist;
                size = 100 + this.rng.next() * 120;
                radius = size * 0.52;

                tooClose = this.entities.some(e => {
                    if (!e.sprite) return false;
                    const dx = e.x - x;
                    const dy = e.y - y;
                    const distSq = dx * dx + dy * dy;
                    const minDist = e.radius + radius + 50; 
                    return distSq < minDist * minDist;
                });
                attempts++;
            } while (tooClose && attempts < 15);

            // Roll Asteroid Type based on shifted weights
            const roll = this.rng.next();
            let cumulative = 0;
            let typeIndex = 0;
            for (let j = 0; j < weights.length; j++) {
                cumulative += weights[j];
                if (roll < cumulative) {
                    typeIndex = j;
                    break;
                }
            }
            const asteroidType = ASTEROID_TYPES[typeIndex] || ASTEROID_TYPES[0];

            // Roll QL inside system range with security bonus
            const minQL = config.qlRange[0];
            const maxQL = config.qlRange[1];
            // Lower security provides a higher QL floor
            const securityQLBonus = (1.0 - secValue) * 30; 
            let rolledQL = Math.floor(minQL + securityQLBonus + this.rng.next() * (maxQL - minQL + 1));
            
            // Apply modifiers (placeholder for skills/buffs, capped at global max)
            const bonusQL = 0; // future mining buffs
            const finalQL = Math.min(rolledQL + bonusQL, 300); 
            const qlBand = getQLBand(finalQL);

            const spriteMaterial = new THREE.SpriteMaterial({ 
                map: texture,
                color: asteroidType.color
            });
            const sprite = new THREE.Sprite(spriteMaterial);
            
            sprite.scale.set(size, size, 1);
            sprite.material.rotation = this.rng.next() * Math.PI * 2;
            sprite.position.set(x, y, 0);
            
            this.scene.add(sprite);
            sprite.renderOrder = 10;

            const oreAmount = 100 + Math.floor(this.rng.next() * 150);
            const asteroidId = `asteroid-${beltId}-${i}`;

            this.entities.push({
                id: asteroidId,
                beltId: beltId,
                x: x,
                y: y,
                radius: radius,
                color: asteroidType.color,
                type: asteroidType.name,
                oreType: asteroidType.ore,
                ql: finalQL,
                qlBand: qlBand,
                oreAmount: oreAmount,
                sprite: sprite
            });
            beltAsteroidIds.push(asteroidId);
        }

        this.asteroidBelts.push({
            id: beltId,
            name: beltName,
            center: center.clone(),
            asteroidIds: new Set(beltAsteroidIds),
            depleted: false,
            respawnTime: null
        });
    }

    _getModifierSum(tag) {
        if (!this.fittings) return 0;
        return Object.values(this.fittings).reduce((sum, mod) => {
            if (!mod || !mod.modifiers) return sum;
            return sum + mod.modifiers.filter(m => m.tag === tag).reduce((s, m) => s + m.currentRoll, 0);
        }, 0);
    }

    rebuildShip(shipObject) {
        const shipType = shipObject.type;
        if (!SHIP_REGISTRY[shipType]) return;

        // Reset HP bonus so scaling starts from a clean base for the new ship
        this.currentHpBonus = 0;

        // Cleanup old sprite if exists
        if (this.ship.sprite) {
            this.scene.remove(this.ship.sprite);
            if (this.ship.sprite.material?.map) this.ship.sprite.material.map.dispose();
            if (this.ship.sprite.material) this.ship.sprite.material.dispose();
            this.ship.sprite = null;
        }

        // CRITICAL: Update the engine ship reference with new type and ID
        this.ship.id = shipObject.id;
        this.ship.type = shipType;

        const { visual, config, scale } = this.createShipVisual(shipType, true);
        this.ship.sprite = visual;
        this.ship.sprite.renderOrder = 5;
        this.scene.add(this.ship.sprite);


        // Ensure local name tag returns after death/respawn cycles
        try {
            if (this.nameSprite) {
                if (!this.nameSprite.parent) this.scene.add(this.nameSprite);
                this.nameSprite.visible = true;
            }
        } catch (e) {}
        // Update core stats in engine
        this.baseShipConfig = {
            baseSigRadius: config.baseSigRadius,
            basePG: config.basePG,
            baseCPU: config.baseCPU,
            targetingStrength: config.targetingStrength ?? config.lockMultiplier ?? 1,
            scanSpeed: config.scanSpeed ?? 1,
            recommendedWeaponSizes: config.recommendedWeaponSizes
        };

        this.stats = {
            ...this.stats,
            name: shipType,
            maxHp: Number.isFinite(this.stats?.maxHp) ? this.stats.maxHp : config.hp,
            hp: shipObject.hp ?? this.stats.hp ?? config.hp,
            armor: Number.isFinite(this.stats?.armor) ? this.stats.armor : (shipObject.armor ?? config.armor),
            kineticRes: Number.isFinite(this.stats?.kineticRes) ? this.stats.kineticRes : (shipObject.kineticRes ?? config.kineticRes),
            thermalRes: Number.isFinite(this.stats?.thermalRes) ? this.stats.thermalRes : (shipObject.thermalRes ?? config.thermalRes),
            blastRes: Number.isFinite(this.stats?.blastRes) ? this.stats.blastRes : (shipObject.blastRes ?? config.blastRes),
            maxEnergy: Number.isFinite(this.stats?.maxEnergy) ? this.stats.maxEnergy : config.baseEnergy,
            energy: shipObject.energy ?? this.stats.energy ?? config.baseEnergy,
            jumpPower: shipObject.jumpPower !== undefined ? shipObject.jumpPower : (config.jumpPower !== undefined ? config.jumpPower : 1),
            jumpWarmupTime: config.jumpWarmupTime || 7000,
            reactorRecovery: shipObject.reactorRecovery || config.baseEnergyRecharge || 1.0,
            energyRegen: shipObject.reactorRecovery || config.baseEnergyRecharge || 1.0,
            cargoHold: config.cargoHold || config.cargoHold,
            scanRange: config.scanRange,
            lockOnRange: config.lockOnRange,
            targetingStrength: config.targetingStrength ?? config.lockMultiplier ?? 1,
            scanSpeed: config.scanSpeed ?? this.stats.scanSpeed ?? 1,
            sigRadius: config.baseSigRadius,
            maxSpeed: shipObject.maxSpeed || config.maxSpeed || 3.5,
            turnSpeed: shipObject.turnSpeed || config.turnSpeed || 0.045,
            brakingForce: config.brakingForce || 1.5,
            thrustImpulse: config.thrustImpulse || 3.0
        };

        this.ship.baseMaxSpeed = shipObject.maxSpeed || config.maxSpeed || 3.5;
        this.ship.maxSpeed = shipObject.maxSpeed || config.maxSpeed || 3.5;
        this.ship.turnSpeed = shipObject.turnSpeed || config.turnSpeed || 0.045;
        this.ship.baseVisualScale = scale;
        this.ship.collisionRadius = config.collisionRadius || (scale * 0.45);

        this.hardpoints = config.hardpoints;
        this.stats.collisionRadius = config.collisionRadius || (this.stats.sigRadius * 1.5);
        this.hardpointWorldPositions = {}; // Clear cached positions

        // Re-initialize weapon cooldowns and active states for the new ship's hardpoints
        const newCooldowns = {};
        const newActive = {};
        Object.keys(this.hardpoints).forEach(slotId => {
            newCooldowns[slotId] = 0;
            newActive[slotId] = false;
        });
        this.weaponCooldowns = newCooldowns;
        this.activeWeapons = newActive;

        // Re-initialize weapon/module visuals
        this.initShieldVisual();
        this.weaponStates = {};
        this.activeBeams = {};
        
        // Setup engine flares for new ship
        this.initEngineParticles();

        this.updateUi();
        console.log(`[Engine] Ship rebuilt: ${shipType}`);
    }

    syncFittings(newFittings) {
        // Universal Hydration Pass: Ensure all items in fittings are hydrated for engine performance
        const hydratedFittings = {};
        Object.entries(newFittings).forEach(([slotId, item]) => {
            if (item) {
                hydratedFittings[slotId] = item.final_stats ? item : hydrateItem(item);
            } else {
                hydratedFittings[slotId] = null;
            }
        });
        
        this.fittings = hydratedFittings;
        
        // Check for removed modules and cleanup visual beams
        Object.keys(this.activeBeams).forEach(slotId => {
            if (!hydratedFittings[slotId]) {
                const beam = this.activeBeams[slotId];
                if (beam) {
                    this.scene.remove(beam.line);
                    beam.line.geometry.dispose();
                    beam.line.material.dispose();
                }
                delete this.activeBeams[slotId];
            }
        });
        console.log("[Engine] Fittings synchronized and hydrated");
    }

    updateStateToReact() {
        // Force an immediate UI update by bypassing the throttle
        this.lastUiUpdate = 0; 
        this.updateUi();
    }

    async init() {
const textureLoader = new THREE.TextureLoader();

const __origLoadAsync = textureLoader.loadAsync.bind(textureLoader);
textureLoader.loadAsync = (url) => {
  console.log("[TextureLoader] loadAsync url =", url);

  if (typeof url !== "string" || !url.trim()) {
    // THIS will show you the call stack that produced undefined
    throw new Error("[TextureLoader] Invalid URL: " + String(url));
  }

  return __origLoadAsync(url);
};
   // Load Weapon Textures
this.weaponTextures = {};
for (const [key, url] of Object.entries(WEAPON_ASSETS || {})) {
  if (typeof url !== "string" || !url.trim()) {
    console.warn("[Assets] Skipping invalid weapon texture:", key, url);
    continue;
  }

  const tex = await textureLoader.loadAsync(url);
  tex.magFilter = THREE.NearestFilter;
  this.weaponTextures[key] = tex;
}

        // Pre-cache Nebula Textures (supports variants per color)
        // NEBULA_URLS expected shape: { blue: [url...], gold: [url...], purple: [url...] }
        this.nebulaTextureMap = {};
        this.nebulaTextures = {};

        const __nebulaEntries = Object.entries(NEBULA_URLS || {});
        await Promise.all(__nebulaEntries.map(async ([type, urls]) => {
            const list = Array.isArray(urls) ? urls : [urls];
            this.nebulaTextureMap[type] = [];

            for (const u of list) {
                if (typeof u !== "string" || !u.trim()) continue;
                const tex = await textureLoader.loadAsync(u);
                tex.magFilter = THREE.LinearFilter;
                this.nebulaTextureMap[type].push(tex);
            }

            // Legacy: first texture per type
            this.nebulaTextures[type] = this.nebulaTextureMap[type][0] || null;
        }));

        // Create Shared Missile Texture (Grayscale/White for dynamic tinting)
        const mCanvas = document.createElement('canvas');
        mCanvas.width = 32;
        mCanvas.height = 32;
        const mCtx = mCanvas.getContext('2d');
        const mGrad = mCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
        mGrad.addColorStop(0, '#ffffff');
        mGrad.addColorStop(0.4, '#ffffff'); 
        mGrad.addColorStop(1, 'rgba(0,0,0,0)');
        mCtx.fillStyle = mGrad;
        mCtx.fillRect(0, 0, 32, 32);
        this.missileTexture = new THREE.CanvasTexture(mCanvas);

        // Locking Reticle (Red square bits)
        this.lockingGroup = new THREE.Group();
        this.lockingGroup.visible = false;
        this.lockingGroup.renderOrder = 20; 
        const lineMat = new THREE.LineBasicMaterial({ 
            color: 0xff0000, 
            depthTest: false,
            transparent: true 
        });
        for (let i = 0; i < 4; i++) {
            const size = 30;
            const geom = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-size, size, 0),
                new THREE.Vector3(-size + 10, size, 0),
                new THREE.Vector3(-size, size, 0),
                new THREE.Vector3(-size, size - 10, 0)
            ]);
            const line = new THREE.Line(geom, lineMat);
            line.rotation.z = (Math.PI / 2) * i;
            line.renderOrder = 20;
            this.lockingGroup.add(line);
        }
        this.scene.add(this.lockingGroup);

        // Scene background color
        this.scene.background = new THREE.Color(0x000000);

        // Name Label under ship
        this.nameCanvas = document.createElement('canvas');
        this.nameCanvas.width = 1024;
        this.nameCanvas.height = 256;
        this.nameContext = this.nameCanvas.getContext('2d');
        this.nameTexture = new THREE.CanvasTexture(this.nameCanvas);
        this.nameTexture.magFilter = THREE.LinearFilter;
        
        const nameMaterial = new THREE.SpriteMaterial({ 
            map: this.nameTexture,
            transparent: true,
            depthTest: false
        });
        this.nameSprite = new THREE.Sprite(nameMaterial);
        this.nameSprite.scale.set(180, 45, 1);
        this.nameSprite.renderOrder = 1000;
        this.scene.add(this.nameSprite);

        // Create Starfield Layers for Depth
        const createStarLayer = (count, size, depth, parallaxFactor) => {
            const geometry = new THREE.BufferGeometry();
            const vertices = [];
            const worldSize = 25000; 
            for (let i = 0; i < count; i++) {
                vertices.push(
                    (this.rng.next() - 0.5) * worldSize,
                    (this.rng.next() - 0.5) * worldSize,
                    depth
                );
            }
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            const material = new THREE.PointsMaterial({
                color: 0xffffff,
                size: size,
                sizeAttenuation: false,
                transparent: true,
                opacity: this.rng.next() * 0.4 + 0.6
            });
            const stars = new THREE.Points(geometry, material);
            this.scene.add(stars);
            return { mesh: stars, factor: parallaxFactor };
        };

        this.starLayers.push(createStarLayer(15000, 1.2, -10, 0.9995));
        this.starLayers[0].mesh.renderOrder = -10;
        this.starLayers.push(createStarLayer(6000, 1.6, -5, 0.998));
        this.starLayers[1].mesh.renderOrder = -9;
        this.starLayers.push(createStarLayer(2000, 2.2, -2, 0.995));
        this.starLayers[2].mesh.renderOrder = -8;
        this.starLayers.push(createStarLayer(800, 3.0, -1, 0.85));
        this.starLayers[3].mesh.renderOrder = -7;

        // Load asteroids texture
        // Load asteroids texture (accept string or map-of-urls)
      // Load asteroid texture (single shared texture)
if (typeof ASTEROID_URL === "string" && ASTEROID_URL) {
  this.asteroidTexture = await textureLoader.loadAsync(ASTEROID_URL);
  this.asteroidTexture.magFilter = THREE.NearestFilter;
} else {
  console.warn("[Assets] ASTEROID_URL invalid:", ASTEROID_URL);
}
        
        // Load Anomaly Texture
        this.anomalyTexture = await textureLoader.loadAsync(ANOMALY_URL);
        this.anomalyTexture.magFilter = THREE.LinearFilter;
        
        // Distant Sun setup (Fiery Core)
        const sunTex = await textureLoader.loadAsync(SUN_URL);
        const sunMaterial = new THREE.SpriteMaterial({ 
            map: sunTex, 
            transparent: true, 
            depthTest: false
        });
        this.sunSprite = new THREE.Sprite(sunMaterial);
        const sunSize = 180; 
        this.sunSprite.scale.set(sunSize, sunSize, 1);
        
        const sunX = 350;
        const sunY = 250;
        this.sunSprite.position.set(sunX, sunY, -25);
        this.sunSprite.renderOrder = -4; 
        this.scene.add(this.sunSprite);

        // Atmospheric Corona Glow
        const coronaTex = this.createParticleTexture();
        const coronaMat = new THREE.SpriteMaterial({
            map: coronaTex,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            depthTest: false,
            color: new THREE.Color(0xff8800) 
        });
        this.sunCorona = new THREE.Sprite(coronaMat);
        this.sunCorona.scale.set(sunSize * 1.8, sunSize * 1.8, 1);
        this.sunCorona.position.set(sunX, sunY, -25.1);
        this.sunCorona.renderOrder = -4.1;
        this.scene.add(this.sunCorona);

        // High Intensity Inner Halo
        const haloMat = new THREE.SpriteMaterial({
            map: coronaTex,
            transparent: true,
            opacity: 0.4,
            blending: THREE.AdditiveBlending,
            depthTest: false,
            color: new THREE.Color(0xffffcc) 
        });
        this.sunHalo = new THREE.Sprite(haloMat);
        this.sunHalo.scale.set(sunSize * 1.2, sunSize * 1.2, 1);
        this.sunHalo.position.set(sunX, sunY, -24.9);
        this.sunHalo.renderOrder = -3.9;
        this.scene.add(this.sunHalo);

        this.sunData = {
            basePos: new THREE.Vector3(sunX, sunY, -25),
            factor: 0.98, 
            baseSize: sunSize,
            pulseTimer: 0
        };

        // Single Cinematic Ringed Planet
        const planetTex = await textureLoader.loadAsync(ASSETS.planetRingedGold);
        const planetMat = new THREE.SpriteMaterial({ 
            map: planetTex, 
            transparent: true, 
            opacity: 1.0, 
            depthTest: false 
        });
        this.majorPlanet = new THREE.Sprite(planetMat);
        
        const pScale = 90;
        this.majorPlanet.scale.set(pScale, pScale, 1);
        
        const pX = -700;
        const pY = -400;
        const pZ = -2;
        this.majorPlanet.position.set(pX, pY, pZ);
        this.majorPlanet.renderOrder = 3; 
        this.scene.add(this.majorPlanet);

        this.planetLayers = [{
            mesh: this.majorPlanet,
            factor: 0.985, 
            basePos: new THREE.Vector3(pX, pY, pZ),
            rotationSpeed: 0.0002
        }];

        // Anomaly POI
        const anomalyMat = new THREE.ShaderMaterial({
            uniforms: {
                uMap: { value: this.anomalyTexture },
                uOpacity: { value: 0.8 },
                uTime: { value: 0 }
            },
            vertexShader: ANOMALY_VERTEX_SHADER,
            fragmentShader: ANOMALY_FRAGMENT_SHADER,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthTest: false
        });
        this.anomalySprite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), anomalyMat);
        this.anomalySprite.visible = false;
        this.anomalySprite.renderOrder = 2; // Template, kept hidden
        this.anomalyData = {
            basePos: new THREE.Vector3(0, 0, -5),
            factor: 0.99, // High parallax
            pulseTimer: 0
        };

        // Lens Flare Ghosts setup
        const hexTex = await textureLoader.loadAsync(FLARE_URLS.hex);
        const ringTex = await textureLoader.loadAsync(FLARE_URLS.ring);
        
        const flareConfigs = [
            { tex: ringTex, scale: 0.4, dist: 0.2, alpha: 0.3 },
            { tex: hexTex, scale: 0.15, dist: 0.45, alpha: 0.2 },
            { tex: hexTex, scale: 0.08, dist: 0.6, alpha: 0.15 },
            { tex: ringTex, scale: 0.25, dist: 0.8, alpha: 0.25 },
            { tex: hexTex, scale: 0.12, dist: 1.1, alpha: 0.1 }
        ];

        flareConfigs.forEach(config => {
            const mat = new THREE.SpriteMaterial({
                map: config.tex,
                transparent: true,
                opacity: 0, 
                blending: THREE.AdditiveBlending,
                depthTest: false
            });
            const ghost = new THREE.Sprite(mat);
            ghost.renderOrder = 1001; 
            this.scene.add(ghost);
            this.flareGhosts.push({
                sprite: ghost,
                config: config
            });
        });

        // Scanning Animation (Expanding Rings)
        this.scanRingsGroup = new THREE.Group();
        this.scanRingsGroup.visible = false;
        this.scanRingsGroup.renderOrder = 25;
        this.scene.add(this.scanRingsGroup);
        this.activeRings = [];

        this.ringGeometry = new THREE.RingGeometry(0.9, 1, 32);
        this.ringMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x00ccff, 
            transparent: true, 
            opacity: 0, 
            side: THREE.DoubleSide,
            depthTest: false
        });

        // Engine Particles Initialization
        this.initEngineParticles();

        // Load ship visual
        if (this.stats.name !== 'PENDING') {
            const { visual, config, scale } = this.createShipVisual(this.stats.name, true);
            this.ship.sprite = visual;
            this.ship.baseVisualScale = scale;
            this.ship.sprite.renderOrder = 5; 
            this.scene.add(this.ship.sprite);
        } else {
            console.log("[Engine] Ship visual creation deferred (Authority-First mode)");
        }

        // Initialize Shield Visuals
        this.initShieldVisual();

        // Load starports
        const __pickUrl = (u) => {
            if (!u) return null;
            if (typeof u === "string") return u;
            if (typeof u === "object") {
                return u.omni || u.federation || u.cartel || u.crimson || u.industrial || u.ferron || u.default || Object.values(u).find(v => typeof v === "string") || null;
            }
            return null;
        };
        const starportTexture = await textureLoader.loadAsync(__pickUrl(STARPORT_URL));
        starportTexture.magFilter = THREE.LinearFilter;
        this.starportMaterial = new THREE.SpriteMaterial({ map: starportTexture });
        
        const crimsonTexture = await textureLoader.loadAsync((STARPORT_URL && (STARPORT_URL.cartel || STARPORT_URL.crimson)) || (STARPORT_URL && (STARPORT_URL.cartel || STARPORT_URL.crimson)));
        crimsonTexture.magFilter = THREE.LinearFilter;
        this.crimsonStarportMaterial = new THREE.SpriteMaterial({ map: crimsonTexture });

        const industrialTexture = await textureLoader.loadAsync((STARPORT_URL && (STARPORT_URL.industrial || STARPORT_URL.ferron)) || (STARPORT_URL && (STARPORT_URL.industrial || STARPORT_URL.ferron)));
        industrialTexture.magFilter = THREE.LinearFilter;
        this.industrialStarportMaterial = new THREE.SpriteMaterial({ map: industrialTexture });

        // The station will be a Sprite for Federation, Cartel, and Industrial
        this.starportSprite = new THREE.Sprite(this.starportMaterial);
        this.crimsonStarportMesh = new THREE.Sprite(this.crimsonStarportMaterial);
        this.industrialStarportSprite = new THREE.Sprite(this.industrialStarportMaterial);
        
        const starportSize = 800;
        this.starportSprite.scale.set(starportSize, starportSize, 1);
        this.crimsonStarportMesh.scale.set(starportSize, starportSize, 1);
        this.industrialStarportSprite.scale.set(starportSize, starportSize, 1);
        
        this.starportSprite.position.set(0, 0, 0);
        this.crimsonStarportMesh.position.set(0, 0, 0);
        this.industrialStarportSprite.position.set(0, 0, 0);
        
        this.starportSprite.renderOrder = 4; 
        this.crimsonStarportMesh.renderOrder = 4;
        this.industrialStarportSprite.renderOrder = 4;
        
        this.scene.add(this.starportSprite);
        this.scene.add(this.crimsonStarportMesh);
        this.scene.add(this.industrialStarportSprite);
        this.starportSprite.visible = false;
        this.crimsonStarportMesh.visible = false;
        this.industrialStarportSprite.visible = false;

        // Load warp gate
        const warpGateTexture = await textureLoader.loadAsync(WARP_GATE_URL);
        warpGateTexture.magFilter = THREE.LinearFilter;
        
        // Custom shader for the Quantum Gate to allow recoloring and animation
        const quantumGateShader = {
            uniforms: {
                tDiffuse: { value: warpGateTexture },
                uTime: { value: 0 },
                uColor: { value: new THREE.Color(0xffffff) }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float uTime;
                uniform vec3 uColor;
                varying vec2 vUv;
                void main() {
                    vec4 tex = texture2D(tDiffuse, vUv);
                    
                    // Recolor pink/purple areas to white
                    // The asset likely has high red/blue for pink. We'll boost the green and normalize.
                    float pinkness = max(0.0, (tex.r + tex.b) * 0.5 - tex.g);
                    vec3 whiteCore = tex.rgb + vec3(pinkness * 3.0); // Increased boost for whiter core
                    
                    // Subtle energy pulse animation
                    float pulse = 0.95 + 0.05 * sin(uTime * 2.0);
                    
                    // Add a slight blue tint to the energy edges
                    vec3 finalColor = whiteCore * uColor * pulse;
                    
                    // Boost alpha to make it less transparent
                    float alpha = tex.a * 1.5;
                    
                    gl_FragColor = vec4(finalColor, min(1.0, alpha));
                }
            `
        };

        this.warpGateMaterial = new THREE.ShaderMaterial({
            uniforms: quantumGateShader.uniforms,
            vertexShader: quantumGateShader.vertexShader,
            fragmentShader: quantumGateShader.fragmentShader,
            transparent: true,
            blending: THREE.NormalBlending, // Changed from AdditiveBlending for more opacity
            depthWrite: false
        });

        this.warpGateSprite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.warpGateMaterial);
        const warpGateSize = 600;
        this.warpGateSprite.scale.set(warpGateSize, warpGateSize, 1);
        this.warpGateSprite.renderOrder = 4;
        // Note: Warp Gate is NOT added to scene here, it's added during loadSystem if the system has it.

        // Finalize Jump logic
        await this.refreshInstanceBoundaryVisualsForCurrentSystem();

        this._isLoadingSystem = false;
        this.initialized = true; // Mark as fully ready after first load

        // Lens Flare for Ship (Additive Glint)
        const flareTex = await textureLoader.loadAsync(FLARE_URLS.ring);
        const flareMat = new THREE.SpriteMaterial({ 
            map: flareTex, 
            transparent: true, 
            opacity: 0, 
            blending: THREE.AdditiveBlending,
            depthTest: false
        });
        this.shipFlare = new THREE.Sprite(flareMat);
        this.shipFlare.scale.set(120, 120, 1);
        this.shipFlare.renderOrder = 1002;
        this.scene.add(this.shipFlare);

        // Custom Cursor Setup
        const cursorTex = await textureLoader.loadAsync('https://rosebud.ai/assets/crosshair-aim-icon.png.webp?Qm1s');
        const cursorMat = new THREE.SpriteMaterial({ map: cursorTex, transparent: true, depthTest: false });
        this.cursorSprite = new THREE.Sprite(cursorMat);
        this.cursorSprite.scale.set(40, 40, 1);
        this.cursorSprite.renderOrder = 2000;
        this.cursorSprite.visible = false;
        this.scene.add(this.cursorSprite);

        // Mark manager as ready for system loading
        this.ready = true;
    }

    updateMouseWorldPos() {
        if (!this.camera) return;
        
        // Precise world coordinate calculation for Orthographic Camera
        // ndc -1 to 1 maps to camera left to right / bottom to top
        const worldX = this.camera.position.x + (this.mousePos.x * (this.camera.right - this.camera.left) / 2) / (this.camera.zoom || 1);
        const worldY = this.camera.position.y + (this.mousePos.y * (this.camera.top - this.camera.bottom) / 2) / (this.camera.zoom || 1);
        
        this.mouseWorldPos.set(worldX, worldY, 0);
    }

    setupEvents() {
        window.addEventListener('keydown', (e) => {
            // Ignore hotkeys if an input field is focused
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                return;
            }

            this.keys[e.code] = true;
            
            // Toggle Inertial Dampeners
            if (e.code === 'KeyZ') {
                this.ship.inertialDampeners = !this.ship.inertialDampeners;
                const status = this.ship.inertialDampeners ? "ACTIVE" : "OFFLINE";
                this.showNotification(`INERTIAL DAMPENERS: ${status}`, this.ship.inertialDampeners ? "info" : "warning");
                this.speak(`Inertial dampeners ${status.toLowerCase()}.`);
            }

            // Action: Emergency Jump
            if (e.code === 'KeyX') {
                this.performEmergencyJump();
            }

            // Action: Toggle Commander Menu
            if (e.code === 'KeyC') {
                if (this.setActiveMenu) {
                    this.setActiveMenu(prev => prev === 'commander' ? null : 'commander');
                }
            }

            // Action: Manual Reload
            if (e.code === 'KeyR') {
                this.performManualReload();
            }

            // Action: Dock / Leap
            if (e.code === 'KeyE' || e.code === 'KeyF') {
                // Priority Interaction System: Hover > Target > Proximity
                let interactTarget = this.hoveredEntity;

                // 2. Passive structure hover fallback (starports / gates / arena beacons)
                if (!interactTarget) {
                    interactTarget = this.findHoveredPassiveStructure();
                }

                // 3. Locked Target Fallback
                if (!interactTarget && this.target && !this.isPassiveStructureEntity(this.target)) {
                    interactTarget = this.target;
                }

                // 4. Proximity Fallback (Scan for nearest interactable within 1000 units)
                if (!interactTarget) {
                    const interactables = this.entities.filter(ent => 
                        ent.type === 'Starport' || ent.type === 'WarpGate' || ent.type === 'ArenaBeacon' || ent.type === 'BattlegroundBeacon'
                    );
                    let nearest = null;
                    let minDist = 1000;
                    interactables.forEach(ent => {
                        if (this.ship && this.ship.sprite && ent.sprite) {
                            const d = this.ship.sprite.position.distanceTo(ent.sprite.position);
                            if (d < minDist) {
                                minDist = d;
                                nearest = ent;
                            }
                        }
                    });
                    interactTarget = nearest;
                }

                if (interactTarget && interactTarget.sprite && this.ship && this.ship.sprite) {
                    if (interactTarget.type === 'ArenaBeacon') {
                        const dist = this.ship.sprite.position.distanceTo(interactTarget.sprite.position);
                        const interactionRadius = interactTarget.interactionRadius || ((interactTarget.radius || 0) + 120);
                        if (dist <= interactionRadius) {
                            if (typeof this.onArenaBeaconInteract === 'function') this.onArenaBeaconInteract(interactTarget);
                        } else {
                            this.showNotification('Arena access failed: Ship outside control radius.', 'error');
                        }
                    } else if (interactTarget.type === 'BattlegroundBeacon') {
                        const dist = this.ship.sprite.position.distanceTo(interactTarget.sprite.position);
                        const interactionRadius = interactTarget.interactionRadius || ((interactTarget.radius || 0) + 120);
                        if (dist <= interactionRadius) {
                            if (typeof this.onBattlegroundBeaconInteract === 'function') this.onBattlegroundBeaconInteract(interactTarget);
                        } else {
                            this.showNotification('Battleground access failed: Ship outside control radius.', 'error');
                        }
                    } else if (interactTarget.type === 'Starport') {
                        const dist = this.ship.sprite.position.distanceTo(interactTarget.sprite.position);
                        const dockingCorridor = (interactTarget.radius || 0) + 250; 
                        if (dist <= dockingCorridor) {
                            const dockStarportId = String(interactTarget.id || '').trim() || null;
                            console.log("[Dock][GameManager] docking corridor reached", { dockStarportId, dist, dockingCorridor });

                            if (this.setIsDockedCallback) {
                                this.setIsDockedCallback(true, dockStarportId);
                            } else {
                                this.setDocked(true);
                            }
                        } else {
                            this.showNotification("Docking failed: Ship outside docking corridor.", "error");
                        }
                    } else if (interactTarget.type === 'WarpGate') {
                        const dist = this.ship.sprite.position.distanceTo(interactTarget.sprite.position);
                        const gateCorridor = (interactTarget.radius || 0) + 300;
                        if (dist <= gateCorridor) {
                            // Signal to App to open Leap mode using direct callbacks
                            if (this.setActiveMenu) this.setActiveMenu(null);
                            if (this.setInitialStarMapView) this.setInitialStarMapView('galaxy');
                            if (this.setIsLeapMode) this.setIsLeapMode(true);
                            if (this.setShowStarMap) this.setShowStarMap(true);
                        } else {
                            this.showNotification("Quantum Leap failed: Ship outside resonance zone.", "error");
                        }
                    }
                }
            }

            // Action: Target Cycle (Tab)
            if (e.code === 'Tab') {
                e.preventDefault();
                this.cycleTarget();
            }

            // Action: Scan
            if (e.code === 'KeyQ') {
                if (this.target) {
                    const result = this.startScan(this.target);
                    if (result === "OUT_OF_RANGE") {
                        this.showNotification("Target out of range for scanning.", "error");
                    }
                }
            }
        });
        window.addEventListener('keyup', (e) => {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
                return;
            }
            this.keys[e.code] = false;
        });

        window.addEventListener('focusin', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                this.keys = {};
            }
        });

        window.addEventListener('resize', () => this.onResize());
        
        window.addEventListener('mousemove', (e) => {
            const rect = this.container.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            this.mousePos.set(
                x * 2 - 1,
                -(y * 2 - 1)
            );
            this.updateMouseWorldPos();
        });

        window.addEventListener('mousedown', (e) => {
            if (e.target !== this.renderer.domElement) return;
            this.mouseButtons[e.button] = true;
            if (e.button === 2) e.preventDefault();
        });

        window.addEventListener('mouseup', (e) => {
            this.mouseButtons[e.button] = false;
        });

        window.addEventListener('contextmenu', (e) => {
            if (e.target === this.renderer.domElement) e.preventDefault();
        });

        // Mouse/Touch Interaction for Selection
        const handleSelection = (clientX, clientY) => {
            const rect = this.container.getBoundingClientRect();
            const x = (clientX - rect.left) / rect.width;
            const y = (clientY - rect.top) / rect.height;

            const mouse = new THREE.Vector2(
                x * 2 - 1,
                -(y * 2 - 1)
            );
            
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, this.camera);
            
            // Check only against targetable entity sprites
            const allCandidates = [
                ...this.entities.filter(e => e.sprite && (!e.static || e.type === 'anomaly' || e.type === 'Starport' || e.type === 'WarpGate' || e.type === 'ArenaBeacon' || e.type === 'BattlegroundBeacon')),
                ...this.npcs.filter(n => n.sprite),
                ...Array.from(this.remotePlayers.values()).filter(p => p?.sprite)
            ];
            const sprites = allCandidates.map(e => e.sprite);
            const intersects = raycaster.intersectObjects(sprites);
            
            if (intersects.length > 0) {
                // Find first valid intersection (considering detailed collision for bio-creatures)
                let selectedEntity = null;
                for (const intersect of intersects) {
                    const clickedSprite = intersect.object;
                    const entity = allCandidates.find(e => e.sprite === clickedSprite);
                    
                    if (entity) {
                        // Detailed check for entities with collisionCircles (like Star-Eaters)
                        if (entity.collisionCircles && entity.collisionCircles.length > 0) {
                            const point2d = new THREE.Vector2(intersect.point.x, intersect.point.y);
                            const hit = entity.collisionCircles.some(c => 
                                point2d.distanceTo(new THREE.Vector2(c.x, c.y)) < c.radius
                            );
                            if (hit) {
                                selectedEntity = entity;
                                break;
                            }
                        } else {
                            selectedEntity = entity;
                            break;
                        }
                    }
                }
                
                if (selectedEntity) {
                    if (this.isPassiveStructureEntity(selectedEntity)) {
                        this.hoveredEntity = selectedEntity;
                        if (selectedEntity.type === 'ArenaBeacon') {
                            this.showNotification('Arena beacon selected. Press E to view.', 'info');
                        } else if (selectedEntity.type === 'BattlegroundBeacon') {
                            this.showNotification('Battleground beacon selected. Press E to view.', 'info');
                        }
                    } else {
                        this.setTarget(selectedEntity);
                    }
                }
            } else {
                // User requested to keep target until destroyed or new one is selected.
                // Clicking empty space no longer clears the target.
            }
        };

        this.container.addEventListener('mousedown', (e) => {
            this.handleGesture();
            if (e.target !== this.renderer.domElement) return;
            if (e.button === 0) handleSelection(e.clientX, e.clientY);
        });

        this.container.addEventListener('touchstart', (e) => {
            this.handleGesture();
            if (e.target !== this.renderer.domElement) return;
            if (e.touches.length === 1) {
                this._touchPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
        });

        this.container.addEventListener('touchend', (e) => {
            if (e.target !== this.renderer.domElement) {
                this._touchPos = null;
                return;
            }
            if (this._touchPos) {
                handleSelection(this._touchPos.x, this._touchPos.y);
                this._touchPos = null;
            }
        });

        // Mouse Wheel Zoom
        this.container.addEventListener('wheel', (e) => {
            if (e.target !== this.renderer.domElement) return;
            e.preventDefault();
            
            const sensitivity = 2.0;
            // Prompt: scrollDelta > 0 => zoom in (decrease distance)
            // Wheel Up (deltaY < 0) should be zoom in.
            const scrollDelta = -e.deltaY;
            const zoomStep = scrollDelta * sensitivity;
            
            this.setZoom(this.cameraDistance - zoomStep);
        }, { passive: false });

        // Touch Pinch Zoom
        this.lastPinchDist = 0;

        this.container.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                this._touchPos = null; // Cancel single touch
                this.lastPinchDist = Math.hypot(
                    e.touches[0].pageX - e.touches[1].pageX,
                    e.touches[0].pageY - e.touches[1].pageY
                );
            }
        }, { passive: false });

        this.container.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const currentDist = Math.hypot(
                    e.touches[0].pageX - e.touches[1].pageX,
                    e.touches[0].pageY - e.touches[1].pageY
                );
                
                if (this.lastPinchDist > 0) {
                    const sensitivity = 2.0;
                    const pinchDelta = currentDist - this.lastPinchDist;
                    // Prompt: pinchDelta > 0 => zoom out (increase distance)
                    const zoomStep = pinchDelta * sensitivity;
                    this.setZoom(this.cameraDistance + zoomStep);
                }
                this.lastPinchDist = currentDist;
            }
        }, { passive: false });
    }

    setZoom(value) {
        // Clamp zoom to prevent extreme zoom-in or zoom-out levels
        this.cameraDistance = Math.max(this.minCameraDistance, Math.min(this.maxCameraDistance, value));
        this.onResize(); // Force camera bounds update
    }

    startScan(entity) {
        if (!entity || !entity.sprite || !this.ship || !this.ship.sprite) return "INVALID";
        if (this.scanning.active) return;
        
        const dist = this.ship.sprite.position.distanceTo(entity.sprite.position);
        const effectiveDist = dist - (entity.radius || 0);
        
        if (effectiveDist > this.stats.scanRange) {
            return "OUT_OF_RANGE";
        }

        const isScanned = this.scannedEntities.has(entity.id);
        const isAnomaly = entity.type === 'anomaly';
        const isSurvey = isAnomaly && isScanned;
        const totalTimeMs = this.computeScanTime(this.baseShipConfig, entity, isSurvey);

        this.scanning = {
            active: true,
            entity: entity,
            startTime: Date.now(),
            progress: 0,
            isSurvey,
            totalTimeMs
        };

        if (this.scanning.isSurvey) {
            this.speak("Initiating deep-resonance survey of cosmic landmark.");
            this.showNotification("SURVEY INITIATED", "info");
        } else {
            this.speak("Scanner frequency locked. Signal decoding in progress.");
        }

        return "SUCCESS";
    }

    getTargetSignature(target) {
        if (!target) return 30;
        const isAsteroid = ASTEROID_TYPES.some(t => t.name === target.type);
        if (isAsteroid) return 999;
        if (target.type === 'anomaly') return Math.max(120, Number(target.scanSignature || target.sigRadius || target.finalSigRadius || 120));
        return Math.max(5, Number(target.finalSigRadius || target.sigRadius || target.signatureRadius || 30));
    }

    getTargetingStrength(attacker) {
        const n = Number(attacker?.targetingStrength ?? attacker?.lockMultiplier ?? this.stats?.targetingStrength ?? 1);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    getScanSpeed(attacker) {
        const n = Number(attacker?.scanSpeed ?? this.stats?.scanSpeed ?? 1);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    getScanDifficulty(target, isSurvey = false) {
        if (!target) return isSurvey ? 3 : 1;
        if (target.type === 'anomaly') {
            const base = Number(target.scanDifficulty || 1.25);
            return Math.max(0.25, isSurvey ? base * 3 : base);
        }
        const isAsteroid = ASTEROID_TYPES.some(t => t.name === target.type);
        if (isAsteroid) return Math.max(0.25, Number(target.scanDifficulty || 0.85));
        return Math.max(0.25, Number(target.scanDifficulty || 1));
    }

    computeScanTime(attacker, target, isSurvey = false) {
        const baseScanMs = 3500;
        const speed = this.getScanSpeed(attacker);
        const difficulty = this.getScanDifficulty(target, isSurvey);
        return Math.max(500, (baseScanMs * difficulty) / speed);
    }

    computeLockTime(attacker, target, baseLockTime = 3000) {
        const isAsteroid = ASTEROID_TYPES.some(t => t.name === target?.type);
        if (isAsteroid) return 250;

        const referenceSig = 30;
        const minLockTime = 300;
        const targetSig = this.getTargetSignature(target);
        const strength = this.getTargetingStrength(attacker);
        const raw = (baseLockTime * (referenceSig / targetSig)) / strength;
        return Math.max(minLockTime, raw);
    }

    setTarget(entity) {
        if (!entity || !entity.sprite) return "INVALID_TARGET";
        // Allow targeting anomalies and warp gates even if they are static/ethereal. Starports are now untargetable to focus on fleet/combat targets.
        if (entity.static && entity.type !== 'anomaly' && entity.type !== 'WarpGate' && entity.type !== 'ArenaBeacon' && entity.type !== 'BattlegroundBeacon') return "INVALID_TARGET";
        if (!this.ship || !this.ship.sprite) return "PLAYER_NOT_READY";

        // Check for cooldown
        if (this.locking.state === 'Cooldown') return "COOLDOWN";

        const isFriendly = this.fleet.some(m => m.id === entity.id) || entity.type === 'WarpGate';

        // Check if already locked to this entity
        const currentTarget = isFriendly ? this.friendlyTarget : this.target;
        if (currentTarget && currentTarget.id === entity.id) {
            return "ALREADY_LOCKED";
        }

        // Check if already priming this specific entity
        if (this.locking.state === 'Priming' && this.locking.entity?.id === entity.id) {
            return "ALREADY_PRIMING";
        }
        
        const dist = this.ship.sprite.position.distanceTo(entity.sprite.position);
        const effectiveDist = dist - (entity.radius || 0);

        if (effectiveDist > this.stats.lockOnRange) {
            return "OUT_OF_RANGE";
        }

        // Begin Lock Procedure
        const baseLockTime = this.calculateFinalLockTime(this.fittings); 
        const calculatedLockTime = this.computeLockTime(this.baseShipConfig, entity, baseLockTime);
        
        this.locking = {
            ...this.locking,
            state: 'Priming',
            entity: entity,
            isFriendlyLock: isFriendly,
            startTime: Date.now(),
            progress: 0,
            requiredTime: calculatedLockTime
        };

        // Update locking reticle color immediately based on target type
        if (this.lockingGroup) {
            const color = isFriendly ? 0x00ff00 : 0xff0000;
            this.lockingGroup.children.forEach(child => {
                if (child.material) child.material.color.setHex(color);
            });
        }

        // Reset weapons on new target attempt (only if hostile lock)
        if (!isFriendly) {
            Object.keys(this.hardpoints).forEach(slotId => {
                this.activeWeapons[slotId] = false;
            });
            if (this.targetReticle) {
                this.scene.remove(this.targetReticle);
                this.targetReticle = null;
            }
            this.target = null;
        } else {
            if (this.friendlyReticle) {
                this.scene.remove(this.friendlyReticle);
                this.friendlyReticle = null;
            }
            this.friendlyTarget = null;
        }
        
        return "SUCCESS";
    }

    syncBackendLockState(entity, isFriendly = false) {
        try {
            if (!entity?.id) return;
            if (window.backendSocket?.sendLockTargetState) {
                window.backendSocket.sendLockTargetState({
                    targetId: entity.id,
                    isFriendly: !!isFriendly,
                    targetType: entity.type || entity.entityType || undefined,
                    lockRange: this.stats?.lockOnRange || this.baseShipConfig?.lockOnRange || undefined
                });
            }
        } catch {}
    }

    clearBackendLockState(targetId = undefined, isFriendly = undefined) {
        try {
            if (window.backendSocket?.clearLockTargetState) {
                window.backendSocket.clearLockTargetState(
                    targetId || this.target?.id || this.friendlyTarget?.id || this.locking?.entity?.id,
                    (typeof isFriendly === 'boolean') ? isFriendly : undefined
                );
            }
        } catch {}
    }

    handleServerTargetLockInvalidated(payload = {}) {
        const targetId = payload?.targetId || payload?.target_id;
        if (!targetId) return;
        const isFriendly = !!payload?.isFriendly;
        const current = isFriendly ? this.friendlyTarget : this.target;
        if (current?.id === targetId) {
            const reason = String(payload?.reason || 'Target invalidated by server').replace(/_/g, ' ');
            this.breakLock(`Lock lost: ${reason}`);
        }
    }

    finalizeTarget(entity) {
        const isFriendly = this.locking.isFriendlyLock;
        if (isFriendly) {
            this.friendlyTarget = entity;
        } else {
            this.target = entity;
            // Ensure weapons are off for the new hostile target
            Object.keys(this.hardpoints).forEach(slotId => {
                this.activeWeapons[slotId] = false;
            });
        }
        
        this.locking.state = 'Locked';
        
        // Visual Cleanup: Hide the "locking on" (priming) reticle
        if (this.lockingGroup) this.lockingGroup.visible = false;
        
        // Visual indicator logic - Fixed size for tighter profile
        const reticle = new THREE.Group();
        const size = 35; // Standardized tight locking box
        const bracketLen = 12;
        const lineMat = new THREE.LineBasicMaterial({ 
            color: isFriendly ? 0x00ff00 : 0xff0000, 
            depthTest: false, 
            transparent: true,
            opacity: 0.8
        });

        for (let i = 0; i < 4; i++) {
            const geom = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-size, size, 0),
                new THREE.Vector3(-size + bracketLen, size, 0),
                new THREE.Vector3(-size, size, 0),
                new THREE.Vector3(-size, size - bracketLen, 0)
            ]);
            const line = new THREE.Line(geom, lineMat);
            line.rotation.z = (Math.PI / 2) * i;
            line.renderOrder = 21;
            reticle.add(line);
        }

        reticle.position.copy(entity.sprite.position);
        this.scene.add(reticle);

        if (isFriendly) {
            this.friendlyReticle = reticle;
        } else {
            this.targetReticle = reticle;
        }

        this.syncBackendLockState(entity, isFriendly);

        if (this.synth) {
            try {
                this.synth.triggerAttackRelease(isFriendly ? "G4" : "C5", "8n", Tone.now());
            } catch (e) { console.warn("Audio scheduling overlap", e); }
        }
    }

setDocked(docked) {
  // If transitioning into docked, snapshot last in-space telemetry FIRST
  if (docked) {
    const liveTelemetry = this.getTelemetry?.() || null;
    const x = Number.isFinite(liveTelemetry?.x) ? liveTelemetry.x : this.ship?.x;
    const y = Number.isFinite(liveTelemetry?.y) ? liveTelemetry.y : this.ship?.y;
    const rot = Number.isFinite(liveTelemetry?.rot)
      ? liveTelemetry.rot
      : (liveTelemetry?.rotation ?? this.ship?.rotation ?? this.ship?.rot ?? 0);
    const vx = Number.isFinite(liveTelemetry?.vx)
      ? liveTelemetry.vx
      : (liveTelemetry?.velocity?.x ?? this.ship?.velocity?.x ?? 0);
    const vy = Number.isFinite(liveTelemetry?.vy)
      ? liveTelemetry.vy
      : (liveTelemetry?.velocity?.y ?? this.ship?.velocity?.y ?? 0);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.lastSpaceTelemetry = {
        system_id: this.currentSystemId || null,
        x, y, rot, vx, vy
      };
      console.log('[Dock][Client] cached lastSpaceTelemetry', this.lastSpaceTelemetry);
    }
  }

  this.isDocked = docked;

  if (this.ship.sprite) this.ship.sprite.visible = !docked;
  if (this.nameSprite) this.nameSprite.visible = !docked;
  if (this.shieldMesh) this.shieldMesh.visible = !docked;

  if (docked) {
    const system = resolveSystemDefinition(this.currentSystemId);
    this.speak(`Docking sequence complete. Welcome back to ${system?.name || 'Starport'}, Commander.`);

    // ... your existing welcome audio ...

    this.ship.velocity.set(0, 0);
    Object.keys(this.hardpoints).forEach(slotId => this.activeWeapons[slotId] = false);
    this.activeWeapons.engine = false;
    this.clearBackendLockState();
    this.target = null;

    if (this.targetReticle) {
      this.scene.remove(this.targetReticle);
      this.targetReticle = null;
    }

    if (this.engineFlares) {
      this.engineFlares.forEach(f => {
        f.glow.material.opacity = 0;
        f.streak.material.opacity = 0;
      });
    }
  }

  // Trigger auto-save on docking state change
  this.requestSave();
}
performUndock() {
  this.setDocked(false);

  if (this.ship?.velocity?.set) this.ship.velocity.set(0, 0);

  // Send undock with last known space coords (if available)
  const t = this.lastSpaceTelemetry;
  if (window.backendSocket?.sendUndock) {
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) {
      window.backendSocket.sendUndock(this.currentSystemId, t.x, t.y, t.rot ?? 0);
    } else {
      window.backendSocket.sendUndock(this.currentSystemId);
    }
  }

  this.speak("Undocking sequence initiated. Fly safe.");
}

    getTelemetry() {
        // Authority Guard: Do not report telemetry if ship identity is unresolved (PENDING) or sprite is missing
        if (!this.ship || !this.ship.sprite || this.ship.type === 'PENDING') return null;
        
        // Map active drones for telemetry with safety guards
        const droneData = (this.droneManager?.drones || []).map(d => ({
            id: d.id,
            type: d.type,
            pos: d.sprite ? { x: d.sprite.position.x, y: d.sprite.position.y } : { x: 0, y: 0 },
            hull: d.hull,
            maxHull: d.maxHull,
            state: d.state,
            cargo: d.cargo
        }));

        return {
            position: { x: this.ship.sprite.position.x, y: this.ship.sprite.position.y },
            rotation: this.ship.rotation || 0,
            velocity: this.ship.velocity ? { x: this.ship.velocity.x, y: this.ship.velocity.y } : { x: 0, y: 0 },
            stats: {
                hp: this.stats?.hp || 0,
                maxHp: this.stats?.maxHp || 0,
                shields: this.stats?.shields || 0,
                maxShields: this.stats?.maxShields || 0,
                energy: this.stats?.energy || 0,
                maxEnergy: this.stats?.maxEnergy || 0
            },
            shipType: this.ship.type, // Use 'type' consistently
            activeWeapons: this.activeWeapons || {},
            drones: droneData,
            cargo: this.inventory || []
        };
    }

    persistShipState() {
        if (!this.isLoaded) return; // Prevent overwriting cloud data before initial load completes
        // ✅ IMPORTANT: only persist to Supabase while DOCKED. In-space persistence is handled by EC2.
        if (!this.isDocked) return;
        const telemetry = this.getTelemetry();
        if (!telemetry || !this.currentStarportId || !cloudService.user) return;
        
        console.log(`[Engine] [PERSIST] Telemetry Snapshot. Cargo Length: ${telemetry.cargo?.length || 0}`, telemetry);
        
        // Authority Handshake: Ship persistent state must match the physical engine state.
        // This persists the manifest back to Supabase during flight.
        cloudService.saveToCloud(cloudService.user.id, this.currentStarportId, {
            ship_type: this.ship.type,
            cargo: telemetry.cargo || [],
            telemetry: {
                ...telemetry,
                // Flatten manifest-standard fields into telemetry root for Postgres consistency
                x: telemetry.position.x,
                y: telemetry.position.y,
                rot: telemetry.rotation,
                vx: telemetry.velocity.x,
                vy: telemetry.velocity.y,
                hp: telemetry.stats.hp,
                maxHp: telemetry.stats.maxHp,
                shields: telemetry.stats.shields,
                maxShields: telemetry.stats.maxShields,
                energy: telemetry.stats.energy,
                maxEnergy: telemetry.stats.maxEnergy,
                system_id: this.currentSystemId
            }
        }).catch(err => {
            console.warn("[Engine] Persistence Handshake failed:", err.message);
        });
    }

    forceBroadcastTelemetry() {
        // Essential to establish presence and trigger state synchronization across the network
        const telemetry = this.getTelemetry();
        if (telemetry) {
            console.log("%c[Engine] [BROADCAST] Forced Authority Handshake: Telemetry synchronized.", 'color: #00ccff; font-weight: bold;');
            cloudService.broadcastTelemetry(telemetry);
            this.lastBroadcastTime = Date.now();
        }
    }

    setTelemetry(data) {
        // Multi-layered Guard: Wait for authoritative cloud resolution before applying telemetry
        // We accept both a nested 'stats' object (from live broadcast) or flat properties (from Postgres)
        if (!data) {
            console.log("[Engine] Telemetry update deferred: No valid state data received yet.");
            return;
        }
        
        // CRITICAL: Ensure recovered ship type matches the engine state
        // If data provides a ship type and it differs from current or sprite is missing, trigger resolution
        const targetShipType = data.shipType || data.ship_type;
        const needsRebuild = targetShipType && (targetShipType !== this.ship.type || !this.ship.sprite);

        // Extract stats regardless of nesting
        // Use Nullish Coalescing (??) but ensure we don't treat 0 as "missing" for HP (though HP 0 usually means death)
        const hp = data.hp !== undefined ? data.hp : (data.stats?.hp !== undefined ? data.stats.hp : undefined);
        const energy = data.energy !== undefined ? data.energy : (data.stats?.energy !== undefined ? data.stats.energy : undefined);

        if (needsRebuild) {
            console.log(`[Engine] Identity Authority synchronized. Resolution: ${targetShipType}`);
            this.rebuildShip({ 
                type: targetShipType, 
                hp: hp, 
                energy: energy 
            });
        }
        
        // Update physics - Apply manifest values directly from the telemetry properties
        if (this.ship.sprite) {
            // Support manifest (x, y) or broadcast (position.x, position.y) formats
            // Use Nullish Coalescing (??) to preserve existing values if data fields are missing
            const tx = data.x ?? data.position?.x ?? this.ship.sprite.position.x;
            const ty = data.y ?? data.position?.y ?? this.ship.sprite.position.y;
            const trot = data.rot ?? data.rotation ?? this.ship.rotation;
            const tvx = data.vx ?? data.velocity?.x ?? this.ship.velocity.x;
            const tvy = data.vy ?? data.velocity?.y ?? this.ship.velocity.y;

            this.ship.sprite.position.set(tx, ty, 0);
            // Also update camera to snap to the manifested position immediately
            this.camera.position.x = tx;
            this.camera.position.y = ty;
            
            this.ship.rotation = trot;
            this.ship.velocity.set(tvx, tvy);
        }
            
        // Apply hull/shield/energy vitals if provided
        // Telemetry is the ABSOLUTE authority over internal state
        if (hp !== undefined) this.stats.hp = hp;
        if (data.maxHp !== undefined || data.stats?.maxHp !== undefined) this.stats.maxHp = data.maxHp ?? data.stats.maxHp;
        
        // Reconstruct Cargo Manifest and Weight from Telemetry JSON
        if (data.cargo) {
            // Hydrate items to ensure engine-side stats (weight/volume) and UI descriptions are present
            const hydratedInventory = data.cargo.map(item => hydrateItem(item));
            this.inventory = hydratedInventory;
            
            const totalWeight = hydratedInventory.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
            const totalVolume = hydratedInventory.reduce((sum, item) => sum + (Number(item.volume || (item.weight * 2)) || 0), 0);
            this.stats.currentCargoWeight = totalWeight;
            this.stats.currentCargoVolume = totalVolume;
            
            // Sync back to React state to ensure HUD is accurate
            if (this.setGameState) {
                this.setGameState(prev => ({
                    ...prev,
                    inventory: hydratedInventory,
                    currentCargoWeight: totalWeight,
                    currentCargoVolume: totalVolume
                }));
            }

            // Engine-side HUD Update: Rebuild the manifest for in-space UI components
            if (typeof window !== 'undefined' && window.HUD?.updateCargo) {
                window.HUD.updateCargo(hydratedInventory);
            }
        }
        
        const nextFittings = (data.fittings && typeof data.fittings === 'object' && !Array.isArray(data.fittings))
            ? data.fittings
            : ((this.fittings && typeof this.fittings === 'object' && !Array.isArray(this.fittings)) ? this.fittings : {});
        this.fittings = nextFittings;
        if (this.ship) this.ship.fittings = nextFittings;
        if (this.gameState && typeof this.gameState === 'object') {
            this.gameState = { ...this.gameState, fittings: nextFittings };
        }

        const nextCombatStats = (data.combat_stats && typeof data.combat_stats === 'object')
            ? data.combat_stats
            : ((data.combatStats && typeof data.combatStats === 'object') ? data.combatStats : null);
        if (nextCombatStats) {
            this.stats.combatStats = nextCombatStats;
            if (this.ship) this.ship.combatStats = nextCombatStats;
        }

        const shields = data.shields ?? data.stats?.shields;
        const maxShields = data.maxShields ?? data.stats?.maxShields ?? nextCombatStats?.maxShields;
        if (shields !== undefined) this.stats.shields = shields;
        if (maxShields !== undefined) this.stats.maxShields = maxShields;
        
        if (energy !== undefined) this.stats.energy = energy;
        if (data.maxEnergy !== undefined || data.stats?.maxEnergy !== undefined) this.stats.maxEnergy = data.maxEnergy ?? data.stats.maxEnergy;

        // Force an immediate UI update
        this.updateUi();

        // Force an immediate broadcast to establish presence with manifest values
        this.forceBroadcastTelemetry();
    }

    handleNetworkMessage(msg) {
        if (!cloudService.user || msg.userId === cloudService.user.id) return;

        if (msg.type === 'TELEMETRY') {
            // Unify all remote-player spawning/updating through the single, battle-tested path
            // (prevents missing shader constants + duplicated sprite/shield logic).
            const userId = msg.userId || msg.player_id || msg.id;
            if (!userId) return;

            const x = (msg.x ?? msg.position?.x ?? msg.telemetry?.x ?? 0);
            const y = (msg.y ?? msg.position?.y ?? msg.telemetry?.y ?? 0);
            const rot = (msg.rot ?? msg.rotation ?? msg.position?.rot ?? msg.telemetry?.rot ?? 0);

            const shipType = (msg.shipType || msg.ship_type || msg.telemetry?.shipType || msg.telemetry?.ship_type || "OMNI SCOUT");

            // Optional: carry over vitals/fittings for shield visuals + UI hints
            const stats = {
                hp: msg.hp ?? msg.hull ?? msg.telemetry?.hp ?? msg.telemetry?.hull,
                maxHp: msg.maxHp ?? msg.telemetry?.maxHp,
                shields: msg.shields ?? msg.telemetry?.shields,
                maxShields: msg.maxShields ?? msg.telemetry?.maxShields,
                energy: msg.energy ?? msg.telemetry?.energy,
                maxEnergy: msg.maxEnergy ?? msg.telemetry?.maxEnergy,
                fittings: msg.fittings ?? msg.telemetry?.fittings,
            };

            this.spawnOrUpdateRemotePlayer({
                id: userId,
                name: msg.userName || msg.name || "COMMANDER",
                shipType,
                ship_type: shipType, // compatibility with existing update code
                x, y, rot,
                animation_state: msg.animation_state || msg.telemetry?.animation_state || {},
                visual_config: msg.visual_config || msg.telemetry?.visual_config || {},
                stats
            });

        } else if (msg.type === 'COMBAT_EVENT') {
            const remotePlayer = this.remotePlayers.get(msg.userId);
            if (remotePlayer && msg.action === 'FIRE_WEAPON') {
                this.renderRemoteFire(remotePlayer, msg);
            }
        } else if (msg.type === 'FLEET_INVITE') {
            if (msg.targetUserId === cloudService.user.id) {
                // Show interactive invite
                this.showNotification({
                    message: `FLEET INVITE: Commander ${msg.userName} requests your assistance.`,
                    type: 'info',
                    persistent: true,
                    actions: [
                        { 
                            label: 'ACCEPT', 
                            type: 'success', 
                            onClick: () => this.joinFleet(msg.userId, msg.userName) 
                        },
                        { 
                            label: 'DECLINE', 
                            type: 'error', 
                            onClick: () => {
                                this.showNotification(`Declined fleet invite from ${msg.userName}`, 'info');
                                cloudService.broadcastGameEvent({
                                    type: 'FLEET_DECLINE',
                                    targetUserId: msg.userId,
                                });
                            }
                        }
                    ]
                });
            }
        } else if (msg.type === 'FLEET_DECLINE') {
            if (msg.targetUserId === cloudService.user.id) {
                this.showNotification(`${msg.userName} declined your fleet invitation.`, 'warning');
            }
        } else if (msg.type === 'FLEET_JOIN') {
            if (msg.fleetLeaderId === cloudService.user.id || this.fleet.some(m => m.id === msg.fleetLeaderId)) {
                this.addFleetMember(msg.userId, msg.userName, msg.fleetLeaderId);
            }
        } else if (msg.type === 'FLEET_SYNC') {
            // Synchronize full fleet list from leader
            if (this.fleet.some(m => m.id === msg.userId) || msg.members.some(m => m.id === cloudService.user.id)) {
                this.fleet = msg.members;
                this.fleetLeaderId = msg.leaderId;
                // Update all local name tags
                this.remotePlayers.forEach(p => this.updateRemotePlayerNameTag(p));
            }
        } else if (msg.type === 'FLEET_LEAVE') {
            if (this.fleetLeaderId === msg.fleetLeaderId) {
                this.fleet = this.fleet.filter(m => m.id !== msg.userId);
                // If we are leader, update everyone
                if (this.fleetLeaderId === cloudService.user.id) {
                    this.broadcastFleetSync();
                }
                const player = this.remotePlayers.get(msg.userId);
                if (player) {
                    this.updateRemotePlayerNameTag(player);
                    this.showNotification(`${player.name} left the fleet.`, "info");
                }
            }
        } else if (msg.type === 'FLEET_KICK') {
            if (msg.targetUserId === cloudService.user.id) {
                this.showNotification("You have been kicked from the fleet.", "error");
                this.fleet = [];
                this.fleetLeaderId = null;
                // Update all local name tags
                this.remotePlayers.forEach(p => this.updateRemotePlayerNameTag(p));
            } else if (this.fleet.some(m => m.id === msg.targetUserId)) {
                this.fleet = this.fleet.filter(m => m.id !== msg.targetUserId);
                const player = this.remotePlayers.get(msg.targetUserId);
                if (player) {
                    this.updateRemotePlayerNameTag(player);
                }
            }
        }
    }

    updateRemotePlayerNameTag(player) {
        const { nameCtx, nameTex, name, id } = player;
        const isInFleet = this.fleet.some(m => m.id === id);
        
        nameCtx.clearRect(0, 0, 512, 128);
        nameCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        nameCtx.fillRect(0, 0, 512, 128);
        nameCtx.font = 'bold 60px monospace';
        nameCtx.textAlign = 'center';
        nameCtx.textBaseline = 'middle';
        nameCtx.strokeStyle = 'black';
        nameCtx.lineWidth = 6;
        nameCtx.strokeText(name, 256, 64);
        nameCtx.fillStyle = isInFleet ? '#00ff66' : '#00ffcc'; // Green for fleet members
        nameCtx.fillText(name, 256, 64);
        nameTex.needsUpdate = true;
    }

    handleContextMenu(clientX, clientY) {
        const rect = this.container.getBoundingClientRect();
        const x = (clientX - rect.left) / rect.width;
        const y = (clientY - rect.top) / rect.height;

        const mouse = new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);
        
        // Only other players are valid candidates for the social context menu
        const allCandidates = Array.from(this.remotePlayers.values());
        const sprites = allCandidates.map(e => e.sprite).filter(s => !!s);
        const intersects = raycaster.intersectObjects(sprites);
        
        if (intersects.length > 0) {
            const entity = allCandidates.find(e => e.sprite === intersects[0].object);
            if (entity) {
                this.contextMenu = { x: clientX, y: clientY, entity };
            } else {
                this.contextMenu = null;
            }
        } else {
            this.contextMenu = null;
        }
    }


    refreshFleetUiState() {
        if (typeof this.setGameState === 'function') {
            this.setGameState(prev => ({
                ...prev,
                fleet: [...this.fleet]
            }));
        }
    }

    syncFleetVitalsFromRuntime() {
        if (!Array.isArray(this.fleet) || this.fleet.length <= 0) return;
        this.fleet = this.fleet.map(member => {
            if (!member || !member.id) return member;
            if (member.id === cloudService.user?.id) {
                return {
                    ...member,
                    shipId: this.ship?.id || member.shipId || member.shipType || 'OMNI SCOUT',
                    shipType: this.ship?.id || member.shipType || member.shipId || 'OMNI SCOUT',
                    hp: Number.isFinite(this.stats?.hp) ? this.stats.hp : member.hp,
                    maxHp: Number.isFinite(this.stats?.maxHp) ? this.stats.maxHp : member.maxHp,
                    shields: Number.isFinite(this.stats?.shields) ? this.stats.shields : member.shields,
                    maxShields: Number.isFinite(this.stats?.maxShields) ? this.stats.maxShields : member.maxShields,
                    energy: Number.isFinite(this.stats?.energy) ? this.stats.energy : member.energy,
                    maxEnergy: Number.isFinite(this.stats?.maxEnergy) ? this.stats.maxEnergy : member.maxEnergy
                };
            }

            const remote = this.remotePlayers.get(member.id);
            const stats = remote?.stats || null;
            if (!stats) return member;
            return {
                ...member,
                hp: Number.isFinite(stats.hp) ? stats.hp : member.hp,
                maxHp: Number.isFinite(stats.maxHp) ? stats.maxHp : member.maxHp,
                shields: Number.isFinite(stats.shields) ? stats.shields : member.shields,
                maxShields: Number.isFinite(stats.maxShields) ? stats.maxShields : member.maxShields,
                energy: Number.isFinite(stats.energy) ? stats.energy : member.energy,
                maxEnergy: Number.isFinite(stats.maxEnergy) ? stats.maxEnergy : member.maxEnergy,
                shipType: remote?.shipType || member.shipType || member.shipId,
                shipId: remote?.shipType || member.shipId || member.shipType
            };
        });
    }

    applyFleetState(payload = {}) {
        const members = Array.isArray(payload.members) ? payload.members.map(member => ({
            ...member,
            id: member.id || member.userId,
            isLeader: !!member.isLeader
        })).filter(member => !!member.id) : [];

        this.fleetId = payload.fleetId || null;
        this.fleetLeaderId = payload.leaderId || null;
        this.fleet = members;
        this.syncFleetVitalsFromRuntime();
        this.remotePlayers.forEach(p => this.updateRemotePlayerNameTag(p));
        this.refreshFleetUiState();
    }

    handleFleetInviteReceived(payload = {}) {
        if (!payload?.inviteId) return;
        this.pendingFleetInvites.set(payload.inviteId, payload);

        const inviterName = payload.inviterName || 'COMMANDER';
        this.showNotification({
            message: `FLEET INVITE: Commander ${inviterName} requests your assistance.`,
            type: 'info',
            persistent: true,
            actions: [
                {
                    label: 'ACCEPT',
                    type: 'success',
                    onClick: () => {
                        backendSocket.send({
                            type: 'FLEET_INVITE_ACCEPT',
                            userId: cloudService.user?.id,
                            inviteId: payload.inviteId,
                            clientTime: Date.now()
                        });
                        this.pendingFleetInvites.delete(payload.inviteId);
                    }
                },
                {
                    label: 'DECLINE',
                    type: 'error',
                    onClick: () => {
                        backendSocket.send({
                            type: 'FLEET_INVITE_DECLINE',
                            userId: cloudService.user?.id,
                            inviteId: payload.inviteId,
                            clientTime: Date.now()
                        });
                        this.pendingFleetInvites.delete(payload.inviteId);
                    }
                }
            ]
        });
    }

    handleFleetInviteResult(payload = {}) {
        const action = String(payload.action || '').toLowerCase();
        const ok = payload.ok !== false;
        if (payload.inviteId) this.pendingFleetInvites.delete(payload.inviteId);

        if (!ok) {
            const message = payload.message || `Fleet ${action || 'action'} failed.`;
            this.showNotification(message, 'warning');
            return;
        }

        if (action === 'invite') {
            this.showNotification(payload.message || 'Fleet invite sent.', 'info');
            return;
        }
        if (action === 'accepted') {
            this.showNotification('Fleet invite accepted.', 'success');
            return;
        }
        if (action === 'declined' || action === 'decline') {
            this.showNotification('Fleet invite declined.', 'warning');
            return;
        }
        if (payload.message) {
            this.showNotification(payload.message, 'info');
        }
    }

    handleFleetError(payload = {}) {
        const message = payload.message || 'Fleet action failed.';
        this.showNotification(message, 'error');
    }

    inviteToFleet(entity) {
        if (!entity || !entity.id) return;

        if (this.fleet.length > 0 && this.fleetLeaderId && this.fleetLeaderId !== cloudService.user?.id) {
            this.showNotification("Only the Fleet Leader can issue invitations.", "error");
            return;
        }

        this.showNotification(`Transmitting invitation to ${entity.name}...`, 'info');
        backendSocket.send({
            type: 'FLEET_INVITE_REQUEST',
            userId: cloudService.user?.id,
            targetUserId: entity.id,
            clientTime: Date.now()
        });
    }

    leaveFleet() {
        if (!this.fleet || this.fleet.length === 0) return;
        backendSocket.send({
            type: 'FLEET_LEAVE_REQUEST',
            userId: cloudService.user?.id,
            clientTime: Date.now()
        });
    }

    kickMember(memberId) {
        if (!memberId || this.fleetLeaderId !== cloudService.user?.id) return;
        backendSocket.send({
            type: 'FLEET_KICK_REQUEST',
            userId: cloudService.user?.id,
            targetUserId: memberId,
            clientTime: Date.now()
        });
    }

    promoteMember(memberId) {
        if (!memberId || this.fleetLeaderId !== cloudService.user?.id) return;
        backendSocket.send({
            type: 'FLEET_PROMOTE_REQUEST',
            userId: cloudService.user?.id,
            targetUserId: memberId,
            clientTime: Date.now()
        });
    }

    inspectPlayer(entity) {
        if (!entity) return;
        this.inspectingRemotePlayer = entity;
    }

    renderRemoteFire(player, msg) {
        if (!player || !player.sprite) return;
        
        // Store last aim point for sustained beam tracking
        player.lastAimPoints = player.lastAimPoints || {};
        player.lastAimPoints[msg.slotId] = msg.aimPoint;

        const startPos = (Number.isFinite(payload.x) && Number.isFinite(payload.y)) ? new THREE.Vector3(payload.x, payload.y, 0) : player.sprite.position.clone();
        const endPos = new THREE.Vector3(msg.aimPoint.x, msg.aimPoint.y, 0);
        const nameLower = (msg.moduleName || '').toLowerCase();
        const isMissile = nameLower.includes('seeker pod') || (msg.moduleType === 'weapon' && nameLower.includes('missile'));
        const isPulse = nameLower.includes('pulse cannon');
        const isFlux = nameLower.includes('laser') && msg.moduleType === 'weapon';
        const isMining = msg.moduleType === 'mining';

        if (isFlux || isMining) {
            if (!player.activeBeams) player.activeBeams = new Map();
            
            let beam = player.activeBeams.get(msg.slotId);
            if (!beam) {
                const rarityColorHex = msg.moduleRarity === 'mythic' || msg.moduleRarity === 'legendary' ? 0xffcc00 : 
                                       (msg.moduleRarity === 'epic' ? 0xa335ee : 
                                       (msg.moduleRarity === 'rare' ? 0x00ccff : 
                                       (msg.moduleRarity === 'uncommon' ? 0x00ff00 :
                                       (msg.moduleRarity === 'common' && isFlux ? 0xffffff : 0xff4444))));
                const beamColor = isMining ? (msg.moduleRarity === 'common' ? 0xccffff : rarityColorHex) : rarityColorHex;
                
                const fluxMaterial = new THREE.ShaderMaterial({
                    uniforms: {
                        uTime: { value: 0 },
                        uOpacity: { value: 1.0 },
                        uColor: { value: new THREE.Color(beamColor) },
                        uFluxJitter: { value: isMining ? 0.05 : 0.18 }
                    },
                    vertexShader: FLUX_BEAM_VERTEX_SHADER,
                    fragmentShader: FLUX_BEAM_FRAGMENT_SHADER,
                    transparent: true,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                });
                
                const fluxGeom = new THREE.PlaneGeometry(1, 1);
                const laser = new THREE.Mesh(fluxGeom, fluxMaterial);
                laser.renderOrder = 30;
                this.scene.add(laser);
                
                beam = { laser, lastFired: Date.now() };
                player.activeBeams.set(msg.slotId, beam);
            } else {
                beam.lastFired = Date.now();
            }
            
            // Per-frame beam placement
            const hp = SHIP_REGISTRY[player.shipType]?.hardpoints?.[msg.slotId] || { x: 0, y: 0 };
            const cos = Math.cos(player.currentRot);
            const sin = Math.sin(player.currentRot);
            const shipScale = (SHIP_REGISTRY[player.shipType]?.visualScale || 64) / 64;
            const rx = (hp.x * shipScale) * cos - (hp.y * shipScale) * sin;
            const ry = (hp.x * shipScale) * sin + (hp.y * shipScale) * cos;
            const anchorPos = new THREE.Vector3(player.currentPos.x + rx, player.currentPos.y + ry, 0.1);

            const laser = beam.laser;
            const dist = anchorPos.distanceTo(endPos);
            const dir = new THREE.Vector3().subVectors(endPos, anchorPos).normalize();
            const angle = Math.atan2(dir.y, dir.x);
            
            laser.position.copy(anchorPos).add(dir.clone().multiplyScalar(dist * 0.5));
            laser.rotation.z = angle;
            laser.scale.set(dist, isMining ? 12 : 8, 1);
            laser.material.uniforms.uTime.value = Date.now() / 1000;
            laser.material.uniforms.uOpacity.value = 1.0;

            if (isFlux && this.fluxPlayer && this.fluxPlayer.loaded) {
                this.playFluxLaserSound();
            }
        } else if (isPulse) {
            const velocity = new THREE.Vector3().subVectors(endPos, startPos).normalize().multiplyScalar(10);
            const projectile = new PulseProjectile(
                this.scene, 'remote', { rarity: msg.moduleRarity, weaponsize: 'S' }, startPos, velocity, 0, 1, this, 10
            );
            this.projectiles.push(projectile);

            if (this.pulsePlayer && this.pulsePlayer.loaded) {
                try { this.pulsePlayer.start(Tone.now()); } catch (e) {}
            }
        } else if (isMissile) {
            const seekerTexture = this.missileTexture;
            const config = MISSILE_CONFIGS['S'];
            const mods = MISSILE_RARITY_MODS[msg.moduleRarity || 'common'];
            
            const missile = new MissileProjectile(
                this.scene, msg.slotId, { rarity: msg.moduleRarity, weaponsize: 'S' }, startPos, null, 
                config.tracking * mods.tracking, 
                config.missileSpeed * mods.speed, 
                config.flightTime, 
                config.damage * mods.dmg, 
                config.aoeRadius * mods.aoe, 
                1.0, this, seekerTexture, endPos
            );
            this.missiles.push(missile);
            
            if (this.weaponSynth) {
                try { this.weaponSynth.triggerAttackRelease("G2", "4n", Tone.now()); } catch (e) {}
            }
        }
    }

    updateRemotePlayers(dt) {
        const now = Date.now();
        const timeout = 5000; // 5 seconds timeout

        this.remotePlayers.forEach((player, userId) => {
            if (now - player.lastUpdate > timeout) {
                console.log(`[Multiplayer] Commander ${player.name} left the sector (timeout).`);
                this.scene.remove(player.sprite);
                this.scene.remove(player.nameSprite);
                if (player.shieldMesh) this.scene.remove(player.shieldMesh);
                if (player.drones) {
                    player.drones.forEach(d => this.scene.remove(d.sprite));
                    player.drones.clear();
                }
                if (player.activeBeams) {
                    player.activeBeams.forEach(beam => {
                        this.scene.remove(beam.laser);
                        beam.laser.geometry.dispose();
                        beam.laser.material.dispose();
                    });
                    player.activeBeams.clear();
                }
                this.remotePlayers.delete(userId);
                return;
            }

            this.updateRemoteShip(player, dt);
        });
    }

    updateRemoteShip(player, dt) {
        if (!player || !player.currentPos || !player.targetPos) return;

        // Use frame-rate independent smoothing
        // Higher value = faster/snappier, Lower value = smoother/laggier
        const smoothingFactor = 8.0; 
        const lerpFactor = 1.0 - Math.exp(-smoothingFactor * dt);

        // Interpolate Drones
        if (player.drones) {
            player.drones.forEach(drone => {
                if (drone.currentPos && drone.targetPos) {
                    drone.currentPos.lerp(drone.targetPos, lerpFactor);
                    drone.sprite.position.copy(drone.currentPos);
                }
                if (drone.sprite && drone.sprite.material) {
                    drone.sprite.material.rotation += dt * 4.0;
                }
            });
        }

        // Smooth position interpolation
        player.currentPos.lerp(player.targetPos, lerpFactor);
        
        // Smooth rotation interpolation (with shortest-path wrap-around)
        if (player.targetRot !== undefined && player.currentRot !== undefined) {
            let diff = player.targetRot - player.currentRot;
            // Shortest path logic
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            player.currentRot += diff * lerpFactor;
        }

        // Apply to sprite mesh
        if (player.sprite) {
            player.sprite.position.copy(player.currentPos);
            player.sprite.rotation.z = player.currentRot || 0;
        }

        // Update visuals from state telemetry
        this.updateVisualFromState(player, dt);

        // Position name label
        if (player.nameSprite) {
            player.nameSprite.position.set(player.currentPos.x, player.currentPos.y - 50, 0.5);
            const scaleFactor = Math.sqrt(this.cameraDistance / 1400);
            // Keep remote name tag size consistent with local baseline (180x45)
            player.nameSprite.scale.set(180 * scaleFactor, 45 * scaleFactor, 1);
        }
    }

    updateVisualFromState(player, dt) {
        const now = Date.now();
        const shipConfig = SHIP_REGISTRY[player.shipType] || SHIP_REGISTRY['OMNI SCOUT'];
        const shipScale = shipConfig.visualScale || 64;

        // --- 0. Network Culling ---
        if (!this.ship || !this.ship.sprite) return;
        const distToLocal = player.currentPos.distanceTo(this.ship.sprite.position);
        const sensorRange = this.stats.scanRange * 1.5; // Visual cull slightly beyond sensor range
        
        if (distToLocal > sensorRange) {
            if (player.sprite) player.sprite.visible = false;
            if (player.nameSprite) player.nameSprite.visible = false;
            if (player.shieldMesh) player.shieldMesh.visible = false;
            if (player.drones) player.drones.forEach(d => d.sprite.visible = false);
            return;
        } else {
            if (player.sprite) player.sprite.visible = true;
            if (player.nameSprite) player.nameSprite.visible = true;
            // Shield visibility is handled by its own logic below
            if (player.drones) player.drones.forEach(d => d.sprite.visible = true);
        }

        // 1. Update Ship Shader (Hull Damage & Brightness)
        if (player.sprite && player.sprite.material && player.sprite.material.uniforms) {
            player.damageFlashTimer = Math.max(0, (player.damageFlashTimer || 0) - dt * 2.0);
            player.sprite.material.uniforms.uDamage.value = player.damageFlashTimer;
            player.sprite.material.uniforms.uTime.value = now / 1000;
            player.sprite.scale.set(shipScale, shipScale, 1);
        }

        // 2. Shield Visuals
        if (player.shieldMesh) {
            player.shieldMesh.position.copy(player.currentPos);
            player.shieldMesh.rotation.z = player.currentRot;
            
            player.shieldPulseTimer = (player.shieldPulseTimer || 0) + dt;
            const sweepProgress = (Math.sin(player.shieldPulseTimer * 1.5) * 0.5 + 0.5);
            player.shieldHitAlpha = Math.max(0, (player.shieldHitAlpha || 0) - dt * 2.5);

            player.shieldMesh.material.uniforms.uTime.value = now / 1000.0;
            player.shieldMesh.material.uniforms.uProgress.value = sweepProgress;
            player.shieldMesh.material.uniforms.uHitAlpha.value = player.shieldHitAlpha;
            
            const shieldRatio = player.stats?.maxShields > 0 ? (player.stats.shields / player.stats.maxShields) : 0;
            player.shieldMesh.material.uniforms.uShieldRatio.value = shieldRatio;

            // Sync shield scale with ship pulse
            const normalizedType = (player.shipType || 'OMNI SCOUT').toString().trim().toUpperCase();
            const shipConfig = SHIP_REGISTRY[normalizedType];
            const multiplier = shipConfig?.shieldScale || 1.25;
            
            const scaleBase = shipScale * multiplier;
            const pulseImpact = (Math.sin(player.shieldPulseTimer * 2.0) * 0.5 + 0.5);
            const scaleBonus = (pulseImpact * (shipScale * 0.02)) + (player.shieldHitAlpha * (shipScale * 0.15));
            player.shieldMesh.scale.set(scaleBase + scaleBonus, scaleBase + scaleBonus, 1);
            player.shieldMesh.visible = (Number(player.stats?.maxShields ?? 0) > 0) || player.shieldHitAlpha > 0.01;
        }

        // 3. Sustained Beam Refinement (Active Weapons Check)
        const fittings = player.fittings || {};
        const activeWeaponsMask = player.activeWeapons || {};
        
        if (!player.activeBeams) player.activeBeams = new Map();

        Object.entries(activeWeaponsMask).forEach(([slotId, isActive]) => {
            if (isActive) {
                const module = fittings[slotId];
                if (!module) return;
                
                const nameLower = (module.name || '').toLowerCase();
                const isFlux = nameLower.includes('flux') || nameLower.includes('laser');
                const isMining = module.type === 'mining';

                if (isFlux || isMining) {
                    // Update or create beam
                    const lastAim = (player.lastAimPoints && player.lastAimPoints[slotId]) || { 
                        x: player.currentPos.x + Math.cos(player.currentRot) * 500, 
                        y: player.currentPos.y + Math.sin(player.currentRot) * 500 
                    };
                    
                    this.renderRemoteFire(player, {
                        slotId,
                        moduleType: module.type,
                        moduleName: module.name,
                        moduleRarity: module.rarity,
                        aimPoint: lastAim
                    });
                }
            }
        });

        // Beam Fade Out logic
        player.activeBeams.forEach((beam, slotId) => {
            if (now - beam.lastFired > 200) { // Slightly longer window for telemetry jitter
                beam.laser.material.uniforms.uOpacity.value -= dt * 6.0;
                if (beam.laser.material.uniforms.uOpacity.value <= 0) {
                    this.scene.remove(beam.laser);
                    beam.laser.geometry.dispose();
                    beam.laser.material.dispose();
                    player.activeBeams.delete(slotId);
                }
            } else {
                // Keep beam anchored to ship
                const hp = SHIP_REGISTRY[player.shipType]?.hardpoints?.[slotId] || { x: 0, y: 0 };
                const cos = Math.cos(player.currentRot);
                const sin = Math.sin(player.currentRot);
                const shipScaleFactor = shipScale / 64;
                const rx = (hp.x * shipScaleFactor) * cos - (hp.y * shipScaleFactor) * sin;
                const ry = (hp.x * shipScaleFactor) * sin + (hp.y * shipScaleFactor) * cos;
                
                const startPos = new THREE.Vector3(player.currentPos.x + rx, player.currentPos.y + ry, 0.1);
                // Aim point should ideally be in telemetry, for now we reuse beam's current state or aimPoint
                // Usually updated in renderRemoteFire
            }
        });

        // 4. Remote Engine Trails (Based on movement magnitude)
        const moveMagnitude = player.currentPos.distanceTo(player.targetPos);
        if (moveMagnitude > 0.5) {
            // Throttled emitter for remote players
            player.lastEmitterTime = player.lastEmitterTime || 0;
            if (now - player.lastEmitterTime > 50) {
                this.emitRemoteParticles(player, moveMagnitude);
                player.lastEmitterTime = now;
            }
        }
    }

    emitRemoteParticles(player, magnitude) {
        const shipConfig = SHIP_REGISTRY[player.shipType] || SHIP_REGISTRY['OMNI SCOUT'];
        const hardpoints = shipConfig.hardpoints || {};
        const shipScale = (shipConfig.visualScale || 64) / 64;
        
        // Find thruster hardpoints
        const engines = Object.keys(hardpoints).filter(k => k.startsWith('engine') || k.startsWith('thruster'));
        if (engines.length === 0) return;

        const shipAngle = player.currentRot;
        const cos = Math.cos(shipAngle);
        const sin = Math.sin(shipAngle);

        engines.forEach(key => {
            const hp = hardpoints[key];
            const rx = (hp.x * shipScale) * cos - (hp.y * shipScale) * sin;
            const ry = (hp.x * shipScale) * sin + (hp.y * shipScale) * cos;
            const pos = new THREE.Vector3(player.currentPos.x + rx, player.currentPos.y + ry, -1);
            
            // Simple visual particle
            const p = new THREE.Sprite(new THREE.SpriteMaterial({ 
                map: this.createParticleTexture(), 
                transparent: true, 
                blending: THREE.AdditiveBlending,
                color: new THREE.Color(0x3399ff)
            }));
            p.position.copy(pos);
            p.scale.set(10, 10, 1);
            this.scene.add(p);
            
            const start = Date.now();
            const duration = 300;
            const animate = () => {
                const t = (Date.now() - start) / duration;
                if (t >= 1) {
                    this.scene.remove(p);
                    p.material.dispose();
                    return;
                }
                p.material.opacity = (1 - t) * 0.5;
                p.scale.set(10 * (1 - t), 10 * (1 - t), 1);
                requestAnimationFrame(animate);
            };
            animate();
        });
    }

    updateCommanderName(newName) {
        this.commanderName = newName;
        if (!this.nameContext) return;
        const ctx = this.nameContext;
        const w = 1024;
        const h = 256;
        
        ctx.clearRect(0, 0, w, h);
        
        // Setup font for measuring
        ctx.font = 'bold 120px monospace';
        const textWidth = ctx.measureText(newName).width;
        const padding = 80;
        const capsuleWidth = textWidth + padding;
        const capsuleHeight = 160;
        
        // Draw Capsule Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.beginPath();
        const x = (w - capsuleWidth) / 2;
        const y = (h - capsuleHeight) / 2;
        const r = capsuleHeight / 2;
        ctx.roundRect(x, y, capsuleWidth, capsuleHeight, r);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 4;
        ctx.stroke();

        // Draw Text
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Heavy outline for maximum readability
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 12;
        ctx.strokeText(newName, w / 2, h / 2);
        
        ctx.fillStyle = '#ffffff';
        ctx.fillText(newName, w / 2, h / 2);
        
        this.nameTexture.needsUpdate = true;
    }

    createParticleTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');   
        gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)'); 
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');      
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(canvas);
    }

    createRayTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        
        // Realistic needle-sharp ray tapering
        const grad = ctx.createLinearGradient(0, 16, 256, 16);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
        grad.addColorStop(0.2, 'rgba(255, 230, 180, 0.4)');
        grad.addColorStop(1, 'rgba(255, 200, 150, 0)');
        
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, 16);
        ctx.bezierCurveTo(40, 14, 100, 15, 256, 16);
        ctx.bezierCurveTo(100, 17, 40, 18, 0, 16);
        ctx.fill();
        
        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.LinearFilter;
        return tex;
    }

    initEngineParticles() {
        this.particleCount = 600; // Increased for a solid beam look
        this.particles = new Float32Array(this.particleCount * 3);
        this.particleData = [];
        
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.particles, 3));
        
        const alphas = new Float32Array(this.particleCount);
        const sizes = new Float32Array(this.particleCount);
        const colors = new Float32Array(this.particleCount * 3); 
        
        geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        for (let i = 0; i < this.particleCount; i++) {
            this.particles[i * 3] = 99999;
            this.particles[i * 3 + 1] = 99999;
            this.particles[i * 3 + 2] = -1;
            alphas[i] = 0;
            sizes[i] = 0;
        }

        const material = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: this.createParticleTexture() },
                uGlobalOpacity: { value: 1.0 }
            },
            vertexShader: `
                attribute float alpha;
                attribute float size;
                attribute vec3 color;
                varying float vAlpha;
                varying vec3 vColor;
                void main() {
                    vAlpha = alpha;
                    vColor = color;
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = size * (300.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float uGlobalOpacity;
                varying float vAlpha;
                varying vec3 vColor;
                void main() {
                    vec4 tex = texture2D(tDiffuse, gl_PointCoord);
                    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha * uGlobalOpacity);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.particleSystem = new THREE.Points(geometry, material);
        this.particleSystem.renderOrder = 4;
        this.particleSystem.frustumCulled = false;
        this.scene.add(this.particleSystem);

        for (let i = 0; i < this.particleCount; i++) {
            this.particleData.push({
                active: false,
                life: 0,
                velocity: new THREE.Vector2(),
                baseSize: 0.35 // Significantly reduced for a narrower, needle-thin beam
            });
        }

        // --- Dual Engine Flare Setup ---
        if (this.engineFlares) {
            this.engineFlares.forEach(flare => {
                if (flare.group.parent) flare.group.parent.remove(flare.group);
                flare.glow.material.dispose();
                flare.streak.material.dispose();
            });
        }
        this.engineFlares = []; 
        
        const createFlare = (side) => {
            const hp = this.hardpoints[side];
            if (!hp) return null;

            const flareGroup = new THREE.Group();
            flareGroup.visible = false; 
            
            // Set local position relative to ship (which is Plane(1,1) scaled by visualScale)
            // hardpoints are in "pixel" units assuming 64x64 ship
            flareGroup.position.set(hp.x / 64, hp.y / 64, 0.01);
            
            // Determine local rotation for streak orientation
            // N = +Y (PI/2), E = +X (0), S = -Y (-PI/2), W = -X (PI)
            let rotation = -Math.PI / 2; // Default back (South)
            if (side === 'thrusterFront' || side === 'thrusterN') rotation = Math.PI / 2;
            else if (side === 'thrusterLeft' || side === 'thrusterW') rotation = Math.PI;
            else if (side === 'thrusterRight' || side === 'thrusterE') rotation = 0;
            else if (side.includes('NW')) rotation = 3 * Math.PI / 4;
            else if (side.includes('NE')) rotation = Math.PI / 4;
            else if (side.includes('SW')) rotation = -3 * Math.PI / 4;
            else if (side.includes('SE')) rotation = -Math.PI / 4;
            
            flareGroup.rotation.z = rotation;

            // Primary Glow (Sprite stays camera facing, good for circular glow)
            const glowTex = this.createParticleTexture();
            const glowMat = new THREE.SpriteMaterial({ 
                map: glowTex, 
                blending: THREE.AdditiveBlending, 
                transparent: true, 
                opacity: 0 
            });
            const glowSprite = new THREE.Sprite(glowMat);
            glowSprite.scale.set(0.001, 0.001, 1); 
            flareGroup.add(glowSprite);

            // Anamorphic Streak (Mesh ensures it rotates with the hull)
            const streakCanvas = document.createElement('canvas');
            streakCanvas.width = 256;
            streakCanvas.height = 32;
            const sCtx = streakCanvas.getContext('2d');
            const sGrad = sCtx.createLinearGradient(0, 16, 256, 16);
            sGrad.addColorStop(0, 'rgba(0, 150, 255, 0)');
            sGrad.addColorStop(0.5, 'rgba(200, 230, 255, 0.8)');
            sGrad.addColorStop(1, 'rgba(0, 150, 255, 0)');
            sCtx.fillStyle = sGrad;
            sCtx.fillRect(0, 12, 256, 8);
            
            const streakTex = new THREE.CanvasTexture(streakCanvas);
            const streakMat = new THREE.MeshBasicMaterial({ 
                map: streakTex, 
                blending: THREE.AdditiveBlending, 
                transparent: true, 
                opacity: 0,
                depthWrite: false
            });
            const streakMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streakMat);
            streakMesh.scale.set(0.001, 0.001, 1); 
            // Position the streak so it starts at the flare point and extends outwards
            // Since it's pointing along X relative to flareGroup, we offset it by half width
            streakMesh.position.x = 0.5; 
            flareGroup.add(streakMesh);

            flareGroup.renderOrder = 6;
            
            // Parent directly to ship hull
            if (this.ship.sprite) {
                this.ship.sprite.add(flareGroup);
            }
            
            return { group: flareGroup, glow: glowSprite, streak: streakMesh, side: side };
        };

        // Only create flares for hardpoints that actually exist on this ship
        if (this.hardpoints['engineL']) this.engineFlares.push(createFlare('engineL'));
        if (this.hardpoints['engineR']) this.engineFlares.push(createFlare('engineR'));
        
        Object.keys(this.hardpoints).forEach(key => {
            if (key.startsWith('thruster')) {
                this.engineFlares.push(createFlare(key));
            }
        });
    }

    emitParticles(thrustPower, accelX = 0, accelY = 0, joyInput = { x: 0, y: 0 }) {
        if (!this.ship.sprite || !this.particleSystem) return;
        
        // Manual world-to-local transformation using the ship's rotation matrix
        const rotationMatrix = new THREE.Matrix4().makeRotationZ(this.ship.rotation);
        const inverseMatrix = rotationMatrix.invert();
        const worldInput = new THREE.Vector3(accelX, accelY, 0);
        const localInput = worldInput.applyMatrix4(inverseMatrix);
        
        const lX = localInput.x;
        const lY = localInput.y;
        
        const engines = [];
        
        // Determine which thrusters to fire based on Newtonian movement in LOCAL SPACE.
        const hpKeys = Object.keys(this.hardpoints);
        
        // To move Forward (+Y local), fire BACK thrusters.
        if (lY > 0.01) hpKeys.filter(k => k.startsWith('thrusterBack') || k.includes('SW') || k.includes('SE') || k === 'thrusterS').forEach(k => engines.push(k)); 
        // To move Backward (-Y local), fire FRONT thrusters.
        if (lY < -0.01) hpKeys.filter(k => k.startsWith('thrusterFront') || k.includes('NW') || k.includes('NE') || k === 'thrusterN').forEach(k => engines.push(k));
        // To move Right (+X local), fire LEFT thrusters.
        if (lX > 0.01) hpKeys.filter(k => k.startsWith('thrusterLeft') || k.includes('NW') || k.includes('SW') || k === 'thrusterW').forEach(k => engines.push(k));
        // To move Left (-X local), fire RIGHT thrusters.
        if (lX < -0.01) hpKeys.filter(k => k.startsWith('thrusterRight') || k.includes('NE') || k.includes('SE') || k === 'thrusterE').forEach(k => engines.push(k));

        // Joystick triggers main engines if pushing forward
        if (joyInput.y > 0.1) {
            engines.push('engineL', 'engineR');
        }

        // Default if we somehow don't have omni-thrusters defined but are thrusting
        if (engines.length === 0 && (accelX !== 0 || accelY !== 0)) {
            if (this.hardpoints['engineL']) engines.push('engineL');
            if (this.hardpoints['engineR']) engines.push('engineR');
        }
        
        const emissionPerEngine = 4;
        
        engines.forEach(engineKey => {
            let hp = this.hardpoints[engineKey];
            if (!hp) return;

            // Thruster direction is relative to ship orientation normally, 
            // but for OMNI movement, we might want them fixed relative to the hull.
            // Current engineL/R are at the back, so they fire -Y (relative to ship).
            let thrustDir;
            const shipAngle = this.ship.rotation;

            if ((engineKey === 'thrusterN' || engineKey.startsWith('thrusterFront')) && !engineKey.includes('NW') && !engineKey.includes('NE')) {
                thrustDir = new THREE.Vector2(Math.sin(shipAngle), -Math.cos(shipAngle)); 
            } else if ((engineKey === 'thrusterS' || engineKey.startsWith('thrusterBack') || engineKey === 'engineL' || engineKey === 'engineR') && !engineKey.includes('SW') && !engineKey.includes('SE')) {
                thrustDir = new THREE.Vector2(-Math.sin(shipAngle), Math.cos(shipAngle)); 
            } else if ((engineKey === 'thrusterW' || engineKey.startsWith('thrusterLeft')) && !engineKey.includes('NW') && !engineKey.includes('SW')) {
                thrustDir = new THREE.Vector2(Math.cos(shipAngle), Math.sin(shipAngle)); 
            } else if ((engineKey === 'thrusterE' || engineKey.startsWith('thrusterRight')) && !engineKey.includes('NE') && !engineKey.includes('SE')) {
                thrustDir = new THREE.Vector2(-Math.cos(shipAngle), -Math.sin(shipAngle)); 
            } else if (engineKey.includes('NW')) {
                thrustDir = new THREE.Vector2(Math.sin(shipAngle + Math.PI/4), -Math.cos(shipAngle + Math.PI/4)); 
            } else if (engineKey.includes('NE')) {
                thrustDir = new THREE.Vector2(Math.sin(shipAngle - Math.PI/4), -Math.cos(shipAngle - Math.PI/4));
            } else if (engineKey.includes('SW')) {
                thrustDir = new THREE.Vector2(-Math.sin(shipAngle - Math.PI/4), Math.cos(shipAngle - Math.PI/4));
            } else if (engineKey.includes('SE')) {
                thrustDir = new THREE.Vector2(-Math.sin(shipAngle + Math.PI/4), Math.cos(shipAngle + Math.PI/4));
            }
            
            const shipPos = this.ship.sprite.position;
            const shipScale = this.ship.sprite.scale.x / 64;

            const cos = Math.cos(shipAngle);
            const sin = Math.sin(shipAngle);
            const rx = (hp.x * shipScale) * cos - (hp.y * shipScale) * sin;
            const ry = (hp.x * shipScale) * sin + (hp.y * shipScale) * cos;
            
            const emissionPoint = new THREE.Vector2(shipPos.x + rx, shipPos.y + ry);

            for (let e = 0; e < emissionPerEngine; e++) {
                const positions = this.particleSystem.geometry.attributes.position.array;
                const colors = this.particleSystem.geometry.attributes.color.array;

                for (let i = 0; i < this.particleCount; i++) {
                    const p = this.particleData[i];
                    if (!p.active) {
                        p.active = true;
                        p.life = 1.0;
                        
                        // Extremely tight emission for a focused beam
                        const subFrame = e / emissionPerEngine;
                        positions[i * 3] = emissionPoint.x - (this.ship.velocity.x * subFrame);
                        positions[i * 3 + 1] = emissionPoint.y - (this.ship.velocity.y * subFrame);
                        positions[i * 3 + 2] = -1;

                        // Initial color: Hot White
                        colors[i * 3] = 1.0;
                        colors[i * 3 + 1] = 1.0;
                        colors[i * 3 + 2] = 1.0;

                        this.particleSystem.geometry.attributes.alpha.array[i] = 1.0;
                        this.particleSystem.geometry.attributes.size.array[i] = p.baseSize;

                        // Inherit ship velocity + thrust speed
                        const spread = 0.01;
                        p.velocity.set(
                            this.ship.velocity.x * 0.5 - thrustDir.x * (2.0 + this.rng.next() * 0.5) + (this.rng.next() - 0.5) * spread,
                            this.ship.velocity.y * 0.5 - thrustDir.y * (2.0 + this.rng.next() * 0.5) + (this.rng.next() - 0.5) * spread
                        );
                        
                        this.particleSystem.geometry.attributes.position.needsUpdate = true;
                        this.particleSystem.geometry.attributes.color.needsUpdate = true;
                        break; 
                    }
                }
            }
        });
    }

    updateEngineParticles() {
        if (!this.particleSystem) return;
        const positions = this.particleSystem.geometry.attributes.position.array;
        const alphas = this.particleSystem.geometry.attributes.alpha.array;
        const sizes = this.particleSystem.geometry.attributes.size.array;
        const colors = this.particleSystem.geometry.attributes.color.array;
        let needsUpdate = false;

        for (let i = 0; i < this.particleCount; i++) {
            const p = this.particleData[i];
            if (!p.active) continue;

            p.life -= 0.08; // Slower decay for a longer, more majestic trail
            
            if (p.life <= 0) {
                p.active = false;
                positions[i * 3] = 99999;
                positions[i * 3 + 1] = 99999;
                alphas[i] = 0;
                sizes[i] = 0;
                needsUpdate = true;
                continue;
            }

            // Tapering: Blue at the end, White at the start
            // RGB: White (1,1,1) -> Blue (0, 0.6, 1)
            colors[i * 3] = p.life * 1.0; // R fades fast
            colors[i * 3 + 1] = 0.4 + p.life * 0.6; // G stays a bit
            colors[i * 3 + 2] = 1.0; // B stays high

            alphas[i] = p.life * 1.2;
            sizes[i] = p.baseSize * (0.2 + p.life * 0.8); 

            positions[i * 3] += p.velocity.x;
            positions[i * 3 + 1] += p.velocity.y;
            p.velocity.multiplyScalar(0.98); 
            
            needsUpdate = true;
        }
        
        if (needsUpdate) {
            this.particleSystem.geometry.attributes.position.needsUpdate = true;
            this.particleSystem.geometry.attributes.alpha.needsUpdate = true;
            this.particleSystem.geometry.attributes.size.needsUpdate = true;
            this.particleSystem.geometry.attributes.color.needsUpdate = true;
        }
    }

    updateEngineFlare(thrustPower, accelX = 0, accelY = 0, joyInput = { x: 0, y: 0 }) {
        if (!this.engineFlares || !this.ship.sprite) return;

        // Manual world-to-local transformation using the ship's rotation matrix
        const rotationMatrix = new THREE.Matrix4().makeRotationZ(this.ship.rotation);
        const inverseMatrix = rotationMatrix.invert();
        const worldInput = new THREE.Vector3(accelX, accelY, 0);
        const localInput = worldInput.applyMatrix4(inverseMatrix);
        
        const lX = localInput.x;
        const lY = localInput.y;

        // If the ship is dead or invisible (docked), force all flares off immediately
        const isShipActive = this.stats.hp > 0 && this.ship.sprite.visible;
        
        const activeEngines = new Set();
        if (isShipActive) {
            // Forward movement (+Y local) -> Fire BACK thrusters
            if (lY > 0.01) {
                activeEngines.add('thrusterBack');
                activeEngines.add('thrusterSW');
                activeEngines.add('thrusterSE');
                activeEngines.add('thrusterS');
            }
            // Backward movement (-Y local) -> Fire FRONT thrusters
            if (lY < -0.01) {
                activeEngines.add('thrusterFront');
                activeEngines.add('thrusterNW');
                activeEngines.add('thrusterNE');
                activeEngines.add('thrusterN');
            }
            // Right movement (+X local) -> Fire LEFT thrusters
            if (lX > 0.01) {
                activeEngines.add('thrusterLeft');
                activeEngines.add('thrusterNW');
                activeEngines.add('thrusterSW');
                activeEngines.add('thrusterW');
            }
            // Left movement (-X local) -> Fire RIGHT thrusters
            if (lX < -0.01) {
                activeEngines.add('thrusterRight');
                activeEngines.add('thrusterNE');
                activeEngines.add('thrusterSE');
                activeEngines.add('thrusterE');
            }
        }

        const baseTargetOpacity = (isShipActive && thrustPower > 0.1) ? 0.35 : 0; 
        
        this.engineFlares.forEach(flare => {
            let isActive = false;
            if (isShipActive) {
                if (flare.side === 'engineL' || flare.side === 'engineR') {
                    isActive = joyInput.y > 0.1;
                } else {
                    const side = flare.side;
                    if (activeEngines.has(side)) {
                        isActive = true;
                    } else if (side.startsWith('thruster')) {
                        // Fallback check using the same local logic
                        if (lY > 0.01 && (side.startsWith('thrusterBack') || side.includes('SW') || side.includes('SE') || side === 'thrusterS')) isActive = true;
                        if (lY < -0.01 && (side.startsWith('thrusterFront') || side.includes('NW') || side.includes('NE') || side === 'thrusterN')) isActive = true;
                        if (lX > 0.01 && (side.startsWith('thrusterLeft') || side.includes('NW') || side.includes('SW') || side === 'thrusterW')) isActive = true;
                        if (lX < -0.01 && (side.startsWith('thrusterRight') || side.includes('NE') || side.includes('SE') || side === 'thrusterE')) isActive = true;
                    }
                }
            }

            const targetOpacity = isActive ? baseTargetOpacity : 0;
            
            // Fast fade out if inactive, smooth fade in if active
            const lerpFactor = isActive ? 0.15 : 0.4;
            flare.glow.material.opacity += (targetOpacity - flare.glow.material.opacity) * lerpFactor;
            flare.streak.material.opacity = flare.glow.material.opacity * 0.4;

            if (flare.glow.material.opacity > 0.001) {
                flare.group.visible = true;
                
                // Scale is now relative to parent ship's internal units (1x1 base)
                // We use visualScale to normalize the effect size
                const visualScale = this.ship.sprite.scale.x;
                const baseScaleFactor = flare.side.startsWith('thruster') ? 0.3 : 0.6; // Slightly adjusted for Mesh scaling
                const baseScale = (18 * thrustPower * baseScaleFactor) / visualScale; 
                
                flare.glow.scale.set(baseScale, baseScale, 1);
                // Streak length is along its local X axis due to 0.5 offset in init
                flare.streak.scale.set(baseScale * 3.0, baseScale * 0.25, 1);
            } else {
                flare.group.visible = false;
            }
        });
    }

    createShieldTexture() {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        
        const centerX = size / 2;
        const centerY = size / 2;
        const radius = (size / 2) - 15;

        const drawHex = (x, y, r) => {
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (i * Math.PI * 2) / 6;
                const px = x + Math.cos(angle) * r;
                const py = y + Math.sin(angle) * r;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.stroke();
        };

        ctx.save();
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.clip();

        // Match Shield Status Bar Color (#00ccff)
        ctx.strokeStyle = '#00ccff';
        ctx.lineWidth = 3;
        
        const hexSize = 35; // Slightly smaller hexes for more detail
        const xStep = hexSize * 1.5;
        const yStep = hexSize * Math.sqrt(3);

        // Robust grid drawing
        for (let x = -hexSize; x < size + hexSize; x += xStep) {
            const colIndex = Math.round(x / xStep);
            for (let y = -hexSize; y < size + hexSize; y += yStep) {
                const yOffset = (colIndex % 2 === 0) ? 0 : yStep / 2;
                const xPos = x;
                const yPos = y + yOffset;
                
                const dx = xPos - centerX;
                const dy = yPos - centerY;
                if (Math.sqrt(dx*dx + dy*dy) < radius + hexSize) {
                    // Draw hex fill for more "body"
                    ctx.globalAlpha = 0.15;
                    ctx.fillStyle = '#00ccff';
                    drawHex(xPos, yPos, hexSize * 0.9);
                    ctx.fill();
                    
                    // Draw hex border
                    ctx.globalAlpha = 0.85; 
                    drawHex(xPos, yPos, hexSize * 0.9);
                }
            }
        }
        ctx.restore();

        // Bright outer rim
        ctx.globalAlpha = 1.0;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();

        return new THREE.CanvasTexture(canvas);
    }

    initShieldVisual() {
        if (this.shieldMesh) {
            this.scene.remove(this.shieldMesh);
            if (this.shieldMesh.geometry) this.shieldMesh.geometry.dispose();
            if (this.shieldMesh.material) this.shieldMesh.material.dispose();
        }

        // Initialize impact tracking
        this.shieldImpacts = []; // Array of vec3(x, y, time) for ripples
        this.maxShieldImpacts = 8;
        for (let i = 0; i < this.maxShieldImpacts; i++) {
            this.shieldImpacts.push(new THREE.Vector3(0, 0, -999)); // x, y, startTime
        }

        const shipScale = this.ship?.baseVisualScale || 64;
        const shipType = this.ship?.type || 'OMNI SCOUT';
        this.shieldMesh = this.createShieldMesh(shipScale, this.shieldImpacts, shipType);
        this.scene.add(this.shieldMesh);

        this.shieldHitAlpha = 0;
        this.shieldPulseTimer = 0;
    }

    createShieldMesh(shipScale, impactArray, shipType = null) {
        const shieldTexture = this.createShieldTexture();
        
        const shieldShader = {
            uniforms: {
                tDiffuse: { value: shieldTexture },
                uTime: { value: 0.0 },
                uProgress: { value: 0.0 },
                uHitAlpha: { value: 0.0 },
                uShieldRatio: { value: 1.0 },
                uColor: { value: new THREE.Color('#00ccff') },
                uImpacts: { value: impactArray }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vPosition;
                void main() {
                    vUv = uv;
                    vPosition = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float uTime;
                uniform float uProgress;
                uniform float uHitAlpha;
                uniform float uShieldRatio;
                uniform vec3 uColor;
                uniform vec3 uImpacts[8];
                varying vec2 vUv;

                float hexDist(vec2 p) {
                    p = abs(p);
                    float d = dot(p, normalize(vec2(1.0, 1.7320508)));
                    return max(d, p.x);
                }

                void main() {
                    vec2 uv = vUv;
                    
                    // Hexagonal Grid Calculation (Turtle Shell)
                    vec2 hexUv = (uv - 0.5) * 15.0; // Scale for hex density
                    vec2 r = vec2(1.0, 1.7320508);
                    vec2 h = r * 0.5;
                    vec2 a = mod(hexUv, r) - h;
                    vec2 b = mod(hexUv - h, r) - h;
                    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
                    float d = hexDist(gv);
                    
                    // Hex border effect
                    float hexLine = smoothstep(0.42, 0.48, d);
                    float hexFill = smoothstep(0.5, 0.4, d) * 0.1;
                    
                    // Ripple Distortion & Glow
                    float rippleEffect = 0.0;
                    vec2 distortion = vec2(0.0);
                    
                    for (int i = 0; i < 8; i++) {
                        vec3 impact = uImpacts[i];
                        float t = uTime - impact.z;
                        if (t > 0.0 && t < 1.5) {
                            float dist = distance(uv, impact.xy);
                            // Ripple wave
                            float wave = sin(dist * 40.0 - t * 12.0);
                            float falloff = smoothstep(0.4, 0.0, dist) * (1.5 - t) / 1.5;
                            float strength = wave * falloff;
                            
                            rippleEffect += max(0.0, strength) * 0.6;
                            distortion += normalize(uv - impact.xy) * strength * 0.03;
                        }
                    }
                    
                    // Apply distortion to hex lookup (mild)
                    vec2 distortedUv = uv + distortion;
                    
                    // Re-calculate hex based on distorted UV for visual "wiggle"
                    vec2 distortedHexUv = (distortedUv - 0.5) * 15.0;
                    vec2 da = mod(distortedHexUv, r) - h;
                    vec2 db = mod(distortedHexUv - h, r) - h;
                    vec2 dgv = dot(da, da) < dot(db, db) ? da : db;
                    float dd = hexDist(dgv);
                    float dHexLine = smoothstep(0.42, 0.48, dd);

                    vec4 tex = texture2D(tDiffuse, distortedUv);
                    
                    // Sweep Logic
                    float feather = 0.25;
                    float lead = uProgress * (1.0 + feather * 2.0); 
                    float trail = lead - 0.5;
                    float sweep = smoothstep(trail, trail + feather, uv.x) * (1.0 - smoothstep(lead - feather, lead, uv.x));
                    
                    // Combine effects
                    vec3 finalColor = uColor;
                    
                    // Add bright ripples
                    finalColor += vec3(0.5, 0.8, 1.0) * rippleEffect;
                    
                    // Final alpha mix: Base circle + Hex lines + Sweep + Ripples
                    float hexAlpha = dHexLine * 0.4 + hexFill * 0.8; 
                    float finalAlpha = max(sweep * 0.6, uHitAlpha);
                    finalAlpha = max(finalAlpha, rippleEffect);
                    finalAlpha = max(finalAlpha, hexAlpha * 0.3); 
                    
                    finalAlpha *= tex.a * uShieldRatio;
                    
                    gl_FragColor = vec4(finalColor, finalAlpha);
                }
            `
        };

        const shieldMaterial = new THREE.ShaderMaterial({
            uniforms: shieldShader.uniforms,
            vertexShader: shieldShader.vertexShader,
            fragmentShader: shieldShader.fragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthTest: false
        });
        
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shieldMaterial);
        
        // Resolve shield scale from registry or default to 1.25x
        // Use a robust, case-insensitive lookup to find the configuration
        let multiplier = 1.25;
        if (shipType) {
            const normalizedType = shipType.toString().trim().toUpperCase();
            const shipConfig = SHIP_REGISTRY[normalizedType];
            if (shipConfig && shipConfig.shieldScale) {
                multiplier = shipConfig.shieldScale;
            }
        }
        
        const shieldScale = shipScale * multiplier; 
        
        mesh.scale.set(shieldScale, shieldScale, 1); 
        mesh.renderOrder = 6;
        return mesh;
    }

    triggerShieldImpact(player, worldImpactPos = null) {
        if (!player) return;

        // Determine if it's the local ship or a remote player
        const isLocal = player.id === 'player-ship' || player === this.ship;
        const target = isLocal ? this : player; // For remote, the object in the Map is the target

        if (target.shieldMesh) {
            target.shieldHitAlpha = 1.0;

            if (worldImpactPos && target.shieldImpacts) {
                const currentTime = Date.now() / 1000.0;
                const shieldScale = target.shieldMesh.scale.x;
                const shipPos = isLocal ? this.ship.sprite.position : player.currentPos;
                const shipRot = isLocal ? this.ship.rotation : player.currentRot;

                // Convert world impact pos to local UV space
                const relPos = new THREE.Vector3().subVectors(worldImpactPos, shipPos);
                relPos.applyAxisAngle(new THREE.Vector3(0, 0, 1), -shipRot);

                const uvX = (relPos.x / shieldScale) + 0.5;
                const uvY = (relPos.y / shieldScale) + 0.5;

                // Find oldest impact slot or empty slot
                let oldestIdx = 0;
                let minTime = Infinity;
                for (let i = 0; i < target.shieldImpacts.length; i++) {
                    if (target.shieldImpacts[i].z < minTime) {
                        minTime = target.shieldImpacts[i].z;
                        oldestIdx = i;
                    }
                }
                target.shieldImpacts[oldestIdx].set(uvX, uvY, currentTime);
            }
        }
    }
    refreshShipConfig() {
        const shipConfig = SHIP_REGISTRY[this.stats.name];
        if (!shipConfig) return;

        const authoritativeResistances = (this.stats?.resistances && typeof this.stats.resistances === 'object')
            ? this.stats.resistances
            : ((this.ship?.resistances && typeof this.ship.resistances === 'object') ? this.ship.resistances : {});
        const hasAuthoritativeDefense = typeof this.stats?.armor === 'number' || Object.keys(authoritativeResistances).length > 0;

        this.baseShipConfig = {
            ...this.baseShipConfig,
            baseSigRadius: shipConfig.baseSigRadius,
            basePG: shipConfig.basePG,
            baseCPU: shipConfig.baseCPU,
            targetingStrength: shipConfig.targetingStrength ?? shipConfig.lockMultiplier ?? 1,
            scanSpeed: shipConfig.scanSpeed ?? 1,
            recommendedWeaponSizes: shipConfig.recommendedWeaponSizes,
            authoritativeBaseHp: Number.isFinite(this.stats?.maxHp) ? this.stats.maxHp : shipConfig.hp,
            authoritativeBaseArmor: hasAuthoritativeDefense
                ? Number(this.stats?.armor || 0)
                : (shipConfig.armor || 0),
            authoritativeResistances: {
                kinetic: hasAuthoritativeDefense ? Number(authoritativeResistances.kinetic || 0) : (shipConfig.kineticRes || 0),
                thermal: hasAuthoritativeDefense ? Number(authoritativeResistances.thermal || 0) : (shipConfig.thermalRes || 0),
                blast: hasAuthoritativeDefense ? Number(authoritativeResistances.blast || 0) : (shipConfig.blastRes || 0)
            }
        };

        const currentHp = this.stats.hp;
        const currentEnergy = this.stats.energy;

        this.stats = {
            ...this.stats,
            hp: (currentHp === null || currentHp === 0) ? (Number.isFinite(this.stats?.maxHp) ? this.stats.maxHp : shipConfig.hp) : currentHp,
            maxHp: Number.isFinite(this.stats?.maxHp) ? this.stats.maxHp : (shipConfig.hp || this.stats.maxHp),
            armor: Number.isFinite(this.stats?.armor) ? this.stats.armor : (hasAuthoritativeDefense ? 0 : (shipConfig.armor !== undefined ? shipConfig.armor : this.stats.armor)),
            kineticRes: Number.isFinite(this.stats?.kineticRes) ? this.stats.kineticRes : (hasAuthoritativeDefense ? Number(authoritativeResistances.kinetic || 0) : (shipConfig.kineticRes !== undefined ? shipConfig.kineticRes : this.stats.kineticRes)),
            thermalRes: Number.isFinite(this.stats?.thermalRes) ? this.stats.thermalRes : (hasAuthoritativeDefense ? Number(authoritativeResistances.thermal || 0) : (shipConfig.thermalRes !== undefined ? shipConfig.thermalRes : this.stats.thermalRes)),
            blastRes: Number.isFinite(this.stats?.blastRes) ? this.stats.blastRes : (hasAuthoritativeDefense ? Number(authoritativeResistances.blast || 0) : (shipConfig.blastRes !== undefined ? shipConfig.blastRes : this.stats.blastRes)),
            resistances: hasAuthoritativeDefense
                ? {
                    kinetic: Number(authoritativeResistances.kinetic || 0),
                    thermal: Number(authoritativeResistances.thermal || 0),
                    blast: Number(authoritativeResistances.blast || 0)
                }
                : (this.stats?.resistances || {
                    kinetic: shipConfig.kineticRes || 0,
                    thermal: shipConfig.thermalRes || 0,
                    blast: shipConfig.blastRes || 0
                }),
            energy: (currentEnergy === null || currentEnergy === 0) ? (Number.isFinite(this.stats?.maxEnergy) ? this.stats.maxEnergy : shipConfig.baseEnergy) : currentEnergy,
            maxEnergy: Number.isFinite(this.stats?.maxEnergy) ? this.stats.maxEnergy : (shipConfig.baseEnergy || this.stats.maxEnergy),
            jumpEnergyCost: shipConfig.jumpEnergyCost || this.stats.jumpEnergyCost,
            energyRegen: shipConfig.baseEnergyRecharge ? shipConfig.baseEnergyRecharge : this.stats.energyRegen,
            reactorRecovery: shipConfig.baseEnergyRecharge || this.stats.reactorRecovery,
            cargoHold: shipConfig.cargoHold || this.stats.cargoHold,
            cargoMaxVolume: shipConfig.cargoMaxVolume || this.stats.cargoMaxVolume || 100,
            scanRange: shipConfig.scanRange || this.stats.scanRange,
            lockOnRange: shipConfig.lockOnRange || this.stats.lockOnRange,
            targetingStrength: shipConfig.targetingStrength ?? shipConfig.lockMultiplier ?? this.stats.targetingStrength ?? 1,
            scanSpeed: shipConfig.scanSpeed ?? this.stats.scanSpeed ?? 1,
            sigRadius: shipConfig.baseSigRadius || this.stats.sigRadius,
            brakingForce: shipConfig.brakingForce || 1.5,
            thrustImpulse: shipConfig.thrustImpulse || 3.0
        };

        // Force an immediate UI update
        this.lastUiUpdate = 0; 
        this.updateUi();
        console.log(`[Engine] Ship config refreshed for: ${this.stats.name}. Hull integrity preserved: ${this.stats.hp}/${this.stats.maxHp}`);
    }

    clearArenaBeaconEntities() {
        const doomed = (this.entities || []).filter(e => e.type === 'ArenaBeacon' || e.type === 'BattlegroundBeacon');
        doomed.forEach(entity => {
            try { if (entity.core) this.scene.remove(entity.core); } catch {}
            try { if (entity.ring) this.scene.remove(entity.ring); } catch {}
            try { if (entity.sprite) this.scene.remove(entity.sprite); } catch {}
            try { entity.core?.material?.dispose?.(); } catch {}
            try { entity.ring?.material?.dispose?.(); } catch {}
            try { entity.sprite?.material?.dispose?.(); } catch {}
        });
        this.entities = (this.entities || []).filter(e => e.type !== 'ArenaBeacon' && e.type !== 'BattlegroundBeacon');
    }

    syncSystemStructures(structures = [], systemId = this.currentSystemId) {
        const sys = String(systemId || this.currentSystemId || 'cygnus-prime');
        this.systemStructures.set(sys, Array.isArray(structures) ? structures : []);
        if (sys === this.currentSystemId) this.applySystemStructures(sys);
    }

    resolveStructureWorldPosition(row = {}) {
        const offsetX = Number(row?.x) || 0;
        const offsetY = Number(row?.y) || 0;
        const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
        const config = row?.config && typeof row.config === 'object' ? row.config : {};
        const positionMode = String(config.position_mode || metadata.position_mode || '').toLowerCase();
        const absolutePosition = metadata.absolute_position === true || positionMode === 'absolute';
        const hasParentStarport = !!row?.parent_starport_id;

        if (!absolutePosition && hasParentStarport) {
            const starport = this.entities.find(e => e.type === 'Starport' && e.sprite);
            if (starport?.sprite?.position) {
                return {
                    x: starport.sprite.position.x + offsetX,
                    y: starport.sprite.position.y + offsetY,
                };
            }
        }

        return { x: offsetX, y: offsetY };
    }


    isPassiveStructureEntity(entity) {
        const type = String(entity?.type || '');
        return type === 'Starport' || type === 'WarpGate' || type === 'ArenaBeacon' || type === 'BattlegroundBeacon';
    }

    findHoveredPassiveStructure() {
        if (!this.mouseWorldPos) return null;
        let nearest = null;
        let minDist = Infinity;
        this.entities.forEach(entity => {
            if (!entity?.sprite || !this.isPassiveStructureEntity(entity)) return;
            const threshold = Math.max(120, Number(entity.interactionRadius) || Number(entity.radius) || 120);
            const dist = this.mouseWorldPos.distanceTo(entity.sprite.position);
            if (dist <= threshold && dist < minDist) {
                minDist = dist;
                nearest = entity;
            }
        });
        return nearest;
    }

    applySystemStructures(systemId = this.currentSystemId) {
        this.clearArenaBeaconEntities();
        const rows = this.systemStructures.get(String(systemId || '')) || [];
        if (!rows.length) return;
        const loader = new THREE.TextureLoader();
        const arenaTexture = loader.load(ARENA_BEACON_URL);
        arenaTexture.magFilter = THREE.LinearFilter;
        const battlegroundTexture = loader.load(BATTLEGROUND_BEACON_URL);
        battlegroundTexture.magFilter = THREE.LinearFilter;
        rows.filter(row => { const t = String(row?.structure_type || '').toLowerCase(); return t === 'arena_beacon' || t === 'battleground_beacon'; }).forEach((row, index) => {
            const { x, y } = this.resolveStructureWorldPosition(row);
            const typeKey = String(row?.structure_type || '').toLowerCase();
            const isArenaBeacon = typeKey === 'arena_beacon';
            const beaconTexture = isArenaBeacon ? arenaTexture : battlegroundTexture;
            const baseMat = new THREE.SpriteMaterial({ map: beaconTexture, transparent: true, depthWrite: false });
            const sprite = new THREE.Sprite(baseMat);
            sprite.position.set(x, y, 0.1);
            sprite.scale.set(200, 200, 1);
            sprite.renderOrder = 8;
            this.scene.add(sprite);

            const glowCanvas = document.createElement('canvas');
            glowCanvas.width = 256; glowCanvas.height = 256;
            const glowCtx = glowCanvas.getContext('2d');
            const grad = glowCtx.createRadialGradient(128, 128, 6, 128, 128, 120);
            grad.addColorStop(0, isArenaBeacon ? 'rgba(120,220,255,0.95)' : 'rgba(150,220,255,0.95)');
            grad.addColorStop(0.38, isArenaBeacon ? 'rgba(0,170,255,0.42)' : 'rgba(0,140,255,0.42)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            glowCtx.fillStyle = grad; glowCtx.fillRect(0, 0, 256, 256);
            const glowTex = new THREE.CanvasTexture(glowCanvas);
            const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }));
            core.position.set(x, y, 0);
            core.scale.set(92, 92, 1);
            core.renderOrder = 9;
            this.scene.add(core);

            const ringCanvas = document.createElement('canvas');
            ringCanvas.width = 256; ringCanvas.height = 256;
            const ringCtx = ringCanvas.getContext('2d');
            ringCtx.strokeStyle = isArenaBeacon ? 'rgba(0,204,255,0.92)' : 'rgba(102,204,255,0.92)';
            ringCtx.lineWidth = 10;
            ringCtx.beginPath(); ringCtx.arc(128, 128, 92, 0, Math.PI * 2); ringCtx.stroke();
            const ringTex = new THREE.CanvasTexture(ringCanvas);
            const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5 }));
            ring.position.set(x, y, 0);
            ring.scale.set(220, 220, 1);
            ring.renderOrder = 9;
            this.scene.add(ring);

            this.entities.push({
                id: row.id || `${isArenaBeacon ? 'arena' : 'battleground'}-beacon-${index}`,
                name: row.structure_name || (isArenaBeacon ? 'ARENA BEACON' : 'BATTLEGROUND BEACON'),
                x, y,
                radius: Number(row.collision_radius) || 140,
                interactionRadius: Math.max(600, Number(row.interaction_radius) || 260),
                color: '#00ccff',
                type: isArenaBeacon ? 'ArenaBeacon' : 'BattlegroundBeacon',
                sprite,
                core,
                ring,
                static: true,
                structureRow: row,
                actions: [{ id: isArenaBeacon ? 'view_arena' : 'view_battleground', label: 'View', color: '#00ccff' }],
                passiveStructure: true,
                targetable: false,
                scannable: false
            });
        });
    }

    resolveBattlegroundNpcLoadout(payload = {}) {
        const raw = String(payload?.loadoutId || payload?.classId || payload?.npcType || payload?.type || '').trim();
        switch (raw) {
            case 'cartel_patrol':
            case 'pirate_interceptor':
            case 'cartel_patrol_scout':
                return 'cartel_patrol_scout';
            case 'cartel_gunship':
            case 'pirate_gunship':
            case 'cartel_patrol_gunship':
                return 'cartel_patrol_gunship';
            default:
                return raw || 'cartel_patrol_scout';
        }
    }

    resolveBattlegroundNpcSpriteFallback(loadoutId = '', npcType = '') {
        const key = String(loadoutId || npcType || '').trim().toLowerCase();
        if (key.includes('gunship')) return '/assets/pirate-gunship2.webp';
        return '/assets/pirate-interceptor.png.webp';
    }

    spawnBattlegroundNpc(payload = {}) {
        try {
            const npcId = payload?.id || `bg-npc-${Date.now()}`;
            const existing = this.npcs.find((n) => n?.id === npcId);
            if (existing) return existing;
            if (this.pendingBattlegroundNpcSpawns?.has(npcId)) return null;
            this.pendingBattlegroundNpcSpawns?.add(npcId);
            const loadoutId = this.resolveBattlegroundNpcLoadout(payload);
            console.log('[Battleground] spawning NPC sprite:', npcId, 'npcType=', payload?.npcType, 'loadoutId=', loadoutId);
            const profile = createNpcShipProfile(loadoutId, { security: 0.0 });
            const pos = new THREE.Vector2(Number(payload?.x || 0), Number(payload?.y || 0));
            const textureLoader = new THREE.TextureLoader();
            const spawnNpcWithTexture = (texture) => {
                if (!texture) {
                    this.pendingBattlegroundNpcSpawns?.delete(npcId);
                    return null;
                }
                texture.magFilter = THREE.NearestFilter;
                const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 1 });
                const sprite = new THREE.Sprite(spriteMaterial);
                const visualScale = Number(profile.visualScale) > 0 ? Number(profile.visualScale) : 96;
                const texImage = texture?.image;
                const texWidth = Number(texImage?.width || texImage?.videoWidth || 0);
                const texHeight = Number(texImage?.height || texImage?.videoHeight || 0);
                const aspect = (texWidth > 0 && texHeight > 0) ? (texWidth / texHeight) : 1;
                sprite.scale.set(visualScale * aspect, visualScale, 1);
                sprite.position.set(pos.x, pos.y, 0);
                sprite.renderOrder = 5;
                this.scene.add(sprite);
                this.createWarpInEffect(new THREE.Vector3(pos.x, pos.y, 0));
                const npc = {
                    id: npcId,
                    type: 'NPC',
                    faction: profile.faction,
                    shipType: profile.shipType,
                    ship_id: profile.shipId,
                    x: pos.x, y: pos.y, radius: profile.radius, sigRadius: profile.sigRadius, sprite,
                    velocity: new THREE.Vector2(0,0), rotation: Number(payload?.rot || 0),
                    stats: { ...profile.stats, hp: Number(payload?.hp ?? profile.stats.hp), maxHp: Number(payload?.maxHp ?? profile.stats.maxHp), shields: Number(payload?.shields ?? profile.stats.shields ?? 0), maxShields: Number(payload?.maxShields ?? profile.stats.maxShields ?? 0) },
                    fittings: profile.fittings, weaponCooldowns: profile.weaponCooldowns,
                    locking: { state: 'Idle', entity: null, startTime: 0, progress: 0, requiredTime: 0 },
                    target: this.ship || null,
                    battlegroundInstanceId: payload?.instanceId || null,
                    battlegroundWave: payload?.waveNumber || 1,
                    behavior: 'battleground'
                };
                npc.ai = new NPCAI(npc, this);
                this.npcs.push(npc);
                this.entities.push(npc);
                this.pendingBattlegroundNpcSpawns?.delete(npcId);
                return npc;
            };
            const fallbackUrl = this.resolveBattlegroundNpcSpriteFallback(loadoutId, payload?.npcType);
            textureLoader.load(
                profile.spriteUrl,
                (texture) => spawnNpcWithTexture(texture),
                undefined,
                (err) => {
                    console.warn('[Battleground] primary NPC sprite load failed, using fallback', profile.spriteUrl, err);
                    textureLoader.load(
                        fallbackUrl,
                        (texture) => spawnNpcWithTexture(texture),
                        undefined,
                        (fallbackErr) => {
                            this.pendingBattlegroundNpcSpawns?.delete(npcId);
                            console.warn('[Battleground] fallback NPC sprite load failed', fallbackUrl, fallbackErr);
                        }
                    );
                }
            );
        } catch (e) {
            this.pendingBattlegroundNpcSpawns?.delete(payload?.id);
            console.warn('[Battleground] spawnBattlegroundNpc failed', e);
        }
    }


    handleInitialNpcs(npcs = []) {
        if (!Array.isArray(npcs) || npcs.length <= 0) return;
        if (!String(this.currentSystemId || '').startsWith('bg:pve:')) return;
        npcs.forEach((npc) => this.spawnBattlegroundNpc(npc));
    }

    handleBattlegroundNpcSpawned(payload = {}) {
        const spawn = payload?.spawn || payload;
        if (!spawn) return;
        if (!String(this.currentSystemId || '').startsWith('bg:pve:')) return;
        this.spawnBattlegroundNpc(spawn);
    }

    handleBattlegroundWaveStarted(payload = {}) {
        // Live battleground NPC creation is handled by INITIAL_NPCS for sync/reconnect
        // and BATTLEGROUND_NPC_SPAWNED for real-time activation. Spawning here as well
        // can duplicate visuals for the same backend NPCs.
        const waveNumber = Number(payload?.waveNumber || 0);
        const spawnCount = Array.isArray(payload?.spawns) ? payload.spawns.length : 0;
        console.log('[Battleground] wave started:', waveNumber, 'spawnCount=', spawnCount);
    }

    async loadSystem(systemId, starportId) {
        this.pendingBattlegroundNpcSpawns?.clear?.();
        let system = SYSTEMS_REGISTRY[systemId] || getSyntheticSystem(systemId);
        const isArenaInstance = String(systemId).startsWith("arena:");
        const isBattlegroundInstance = String(systemId).startsWith("bg:pve:");
        const isCombatInstance = isArenaInstance || isBattlegroundInstance;
        if (isCombatInstance) {
            console.log(isArenaInstance ? "[Arena] Loading arena instance:" : "[Battleground] Loading battleground instance:", systemId);
            system = {
                ...(system || {}),
                name: isArenaInstance ? "Arena" : "Battleground",
                cluster: "instance",
                sector: isArenaInstance ? "ARENA" : "BATTLEGROUND",
                security: isArenaInstance ? "Open Conflict (0.0)" : "Controlled Combat Space",
                securityValue: 0.0,
                nebulaTypes: isBattlegroundInstance ? [] : ["blue", "purple"],
                nebulaCount: isBattlegroundInstance ? 0 : 12,
                hasStarport: false,
                hasWarpGate: false,
                belts: [],
                anomaly: null,
                controlledBy: isArenaInstance ? 'OMNI DIRECTORATE COMBAT NETWORK' : 'OMNI DIRECTORATE TACTICAL COMMAND'
            };
            this.isArenaInstance = isArenaInstance;
            this.isBattlegroundInstance = isBattlegroundInstance;
            this.worldBounds = isBattlegroundInstance
                ? { minX: -1750, maxX: 1750, minY: -1750, maxY: 1750 }
                : { minX: -2000, maxX: 2000, minY: -2000, maxY: 2000 };
            this.setInstanceMusicMode(isArenaInstance ? 'arena' : 'battleground');
        } else {
            this.isArenaInstance = false;
            this.isBattlegroundInstance = false;
            this.worldBounds = null;
            this.setInstanceMusicMode('normal');
        }
        if (!system) return;

        // If a load is already in progress for this specific system, skip it.
        // If it's for a different system, we allow it to proceed to ensure navigation works.
        // We bypass this check if it's the very first load (this.initialized is false).
        if (this._isLoadingSystem && systemId === this.currentSystemId && this.initialized) {
            return;
        }
        
        this._isLoadingSystem = true;
        this.currentSystemId = systemId;
        this.currentStarportId = starportId || null;
        this.clearInstanceBoundaryVisuals();

        if (this.sunSprite) this.sunSprite.visible = !isBattlegroundInstance;
        if (this.sunCorona) this.sunCorona.visible = !isBattlegroundInstance;
        if (this.sunHalo) this.sunHalo.visible = !isBattlegroundInstance;
        if (this.majorPlanet) this.majorPlanet.visible = !isBattlegroundInstance;
        if (this.flareGhosts) this.flareGhosts.forEach((ghost) => { if (ghost?.sprite) ghost.sprite.visible = !isBattlegroundInstance; });

// ⭐ CONNECT TO EC2 AUTHORITATIVE SERVER HERE ⭐
    backendSocket.connect(this.currentSystemId);


        console.log(`[GameManager] Loading sector: ${system.name} (Starport: ${starportId || 'NONE'})`);
        
        // Clear all dynamic and static entities to ensure a fresh system load
        this.entities = [];
        this.npcs = [];
        this.patrols = [];
        this.asteroidBelts = [];
        this.scannedEntities.clear();
        this.miningShipSpawnTimer = 0;
        this.threatLevel = 0;
        this.threatCooldown = 0;
        this.travelThreatAccumulator = 0;
        if (this.ship && this.ship.sprite) {
            this.lastPlayerPosForTravelThreat.copy(this.ship.sprite.position);
        }
        
        // Reset Locking State on system transition
        this.target = null;
        this.activeBeams = {};
        this.locking.state = 'Idle';
        this.locking.entity = null;
        if (this.targetReticle) {
            this.scene.remove(this.targetReticle);
            this.targetReticle = null;
        }
        if (this.lockingGroup) this.lockingGroup.visible = false;

        // Remove old nebula meshes
        this.nebulaMeshes.forEach(mesh => {
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
            this.scene.remove(mesh);
        });
        this.nebulaMeshes = [];
        this.nebulaLayers = [];

        // Remove old asteroids and other sprites safely
        const spritesToRemove = [];
        this.scene.children.forEach(child => {
            if ((child instanceof THREE.Sprite || child instanceof THREE.Mesh) && 
                child !== this.ship.sprite && 
                child !== this.sunSprite && 
                child !== this.sunCorona && 
                child !== this.sunHalo && 
                child !== this.majorPlanet && 
                child !== this.anomalySprite &&
                child !== this.nameSprite &&
                child !== this.starportSprite &&
                child !== this.crimsonStarportMesh &&
                child !== this.industrialStarportSprite &&
                child !== this.warpGateSprite &&
                child !== this.particleSystem &&
                child !== this.shieldMesh &&
                child !== this.lockingGroup &&
                child !== this.scanRingsGroup &&
                child !== this.cursorSprite &&
                child !== this.shipFlare &&
                !this.starLayers.some(sl => sl.mesh === child) &&
                !this.flareGhosts.some(fg => fg.sprite === child)) { 
                
                spritesToRemove.push(child);
            }
        });
        spritesToRemove.forEach(s => this.scene.remove(s));

        if (isBattlegroundInstance) {
            this.scene.children
                .filter((child) => child?.userData?.systemNebula)
                .forEach((child) => {
                    this.scene.remove(child);
                    try { child.geometry?.dispose?.(); } catch (e) {}
                    try { child.material?.dispose?.(); } catch (e) {}
                });
        }

        // Re-add starport entity for this specific system
        if (system.hasStarport) {
            const isCartel = system.starportType === 'cartel';
            const isIndustrial = system.starportType === 'industrial';
            
            let activeStarport = this.starportSprite;
            let entityColor = '#00ccff';
            
            if (isCartel) {
                activeStarport = this.crimsonStarportMesh;
                entityColor = '#ff3300';
            } else if (isIndustrial) {
                activeStarport = this.industrialStarportSprite;
                entityColor = '#ffcc00'; // Dull yellow
            }

            const starportId = `starport-${systemId}`;
            
            this.entities.push({
                id: starportId,
                name: `${system.name.toUpperCase()} STARPORT`,
                x: 0,
                y: 0,
                radius: 800 * 0.52, // Increased from 0.45 for a more solid feel
                color: entityColor,
                type: 'Starport',
                sprite: activeStarport,
                static: true
            });
            
            // Ensure starport is in the scene if it was somehow missing
            if (!this.scene.children.includes(activeStarport)) {
                this.scene.add(activeStarport);
            }
            
            this.starportSprite.visible = (!isCartel && !isIndustrial);
            this.crimsonStarportMesh.visible = isCartel;
            this.industrialStarportSprite.visible = isIndustrial;

            // Add Starport to destinations
            this.asteroidBelts.push({
                id: starportId,
                name: `${system.name.toUpperCase()} STARPORT`,
                center: new THREE.Vector2(0, 0),
                asteroidIds: new Set(),
                depleted: false,
                respawnTime: null,
                isStation: true
            });
        } else {
            if (this.starportSprite) this.starportSprite.visible = false;
            if (this.crimsonStarportMesh) this.crimsonStarportMesh.visible = false;
            if (this.industrialStarportSprite) this.industrialStarportSprite.visible = false;
        }

        // Re-apply DB-backed structures after the system clear/rebuild so they are not lost
        this.applySystemStructures(this.currentSystemId);

        // Spawn Quantum Gate if present
        if (system.hasWarpGate && this.warpGateSprite) {
            const gateId = `warpgate-${systemId}`;
            const gatePos = system.warpGatePos || { x: 1500, y: 1500 };
            
            this.warpGateSprite.position.set(gatePos.x, gatePos.y, 0);
            this.scene.add(this.warpGateSprite);
            this.warpGateSprite.visible = true;

            const gateName = `QUANTUM GATE: ${system.cluster === 'beta' ? 'BETA' : 'ALPHA'} RELAY`;

            this.entities.push({
                id: gateId,
                name: gateName,
                x: gatePos.x,
                y: gatePos.y,
                radius: 600 * 0.52, // Increased from 0.45
                color: '#00ccff',
                type: 'WarpGate',
                sprite: this.warpGateSprite,
                static: true
            });

            // Add to jump destinations
            this.asteroidBelts.push({
                id: gateId,
                name: gateName,
                center: new THREE.Vector2(gatePos.x, gatePos.y),
                asteroidIds: new Set(),
                depleted: false,
                respawnTime: null,
                isWarpGate: true
            });
        } else if (this.warpGateSprite) {
            this.warpGateSprite.visible = false;
        }

        const nebulaColors = system.nebulaTypes;
        const count = system.nebulaCount || 100; 
        const worldSize = 9000; // tuned for visible density in camera frustum
        console.log(`[Nebula] Palette=${(nebulaColors||[]).join(",")} count=${count} system=${systemId}`);
        const nebulaGeom = new THREE.PlaneGeometry(1, 1);

        if (!isBattlegroundInstance && Array.isArray(nebulaColors) && nebulaColors.length > 0 && count > 0) {
        const nebulaVertexShader = `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;
        const nebulaFragmentShader = `
            uniform sampler2D tDiffuse;
            uniform float uOpacity;
            uniform vec3 uColor;
            uniform float uShimmer;
            varying vec2 vUv;
            void main() {
                vec4 tex = texture2D(tDiffuse, vUv);
                
                // Subtle color shifting shimmer
                vec3 shimmer = vec3(
                    sin(uShimmer + vUv.x * 2.0) * 0.05,
                    cos(uShimmer + vUv.y * 2.0) * 0.05,
                    sin(uShimmer * 0.5 + (vUv.x + vUv.y)) * 0.05
                );
                
                vec3 finalColor = uColor + shimmer;
                
                // Radial falloff for softer edges - Relaxed to preserve asset detail
                float dist = distance(vUv, vec2(0.5));
                float mask = smoothstep(0.5, 0.4, dist);
                gl_FragColor = vec4(tex.rgb * finalColor, tex.a * mask * uOpacity);
            }
        `;

        for (let i = 0; i < count; i++) {
            const color = nebulaColors[i % nebulaColors.length];
            
            // Pick a nebula texture for this type (supports variants)
            const _list = this.nebulaTextureMap?.[color] || [];
            const tex = (_list.length > 0)
              ? _list[Math.floor(((this.rng?.next?.() ?? Math.random())) * _list.length)]
              : (this.nebulaTextures?.blue || this.nebulaTextures?.purple || this.nebulaTextures?.gold || null);
            if (!tex) continue;

            const layerIndex = i % 3;
            let parallaxFactor, baseOpacity;

            if (layerIndex === 0) {
                // farthest layer (barely moves)
                parallaxFactor = 0.985 + (this.rng.next() * 0.01); // 0.985 - 0.995
                baseOpacity = 0.18 + (this.rng.next() * 0.08);
            } else if (layerIndex === 1) {
                // mid layer
                parallaxFactor = 0.97 + (this.rng.next() * 0.015); // 0.97 - 0.985
                baseOpacity = 0.22 + (this.rng.next() * 0.08);
            } else {
                // closest layer (most parallax)
                parallaxFactor = 0.95 + (this.rng.next() * 0.02); // 0.95 - 0.97
                baseOpacity = 0.26 + (this.rng.next() * 0.08);
            }

            let nebulaOpacity = baseOpacity;
            if (color === 'blue') nebulaOpacity *= 0.8;
            if (color === 'gold') nebulaOpacity *= 0.85; // keep gold visible

            const material = new THREE.ShaderMaterial({
                uniforms: {
                    tDiffuse: { value: tex },
                    uOpacity: { value: nebulaOpacity },
                    uColor: { value: color === 'gold' ? new THREE.Color(0.8, 0.6, 0.4) : new THREE.Color(1, 1, 1) },
                    uShimmer: { value: 0 }
                },
                vertexShader: nebulaVertexShader,
                fragmentShader: nebulaFragmentShader,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthTest: false,
                depthWrite: false
            });

            const mesh = new THREE.Mesh(nebulaGeom, material);
            mesh.userData.systemNebula = true;
            const scaleMult = (color === 'gold' ? 1.0 : 1.0) * (1.0 + (2 - layerIndex) * 0.2); 
            const baseSize = (800 + this.rng.next() * 1200) * scaleMult; 
            mesh.scale.set(baseSize, baseSize, 1);
            mesh.rotation.z = this.rng.next() * Math.PI * 2;

            const x = (this.rng.next() - 0.5) * worldSize;
            const y = (this.rng.next() - 0.5) * worldSize;

            mesh.position.set(x, y, -18);
            mesh.renderOrder = -5;
            this.scene.add(mesh);
            this.nebulaMeshes.push(mesh);

            this.nebulaLayers.push({
                mesh: mesh,
                factor: parallaxFactor,
                basePos: new THREE.Vector3(x, y, -18),
                baseScale: baseSize,
                baseOpacity: nebulaOpacity,
                drift: new THREE.Vector2((this.rng.next() - 0.5) * 0.012, (this.rng.next() - 0.5) * 0.012), // Slower independent drift
                rotationSpeed: (this.rng.next() - 0.5) * 0.0002, // Slower rotation
                colorPhase: this.rng.next() * Math.PI * 2,
                shimmerPhase: this.rng.next() * Math.PI * 2,
                shimmerSpeed: 0.002 + this.rng.next() * 0.003 // Slower shimmer
            });
        }
        }
        console.log(`[Nebula] Spawned ${this.nebulaMeshes.length} nebula meshes for ${systemId}`);


        // Procedurally generate belt positions if not specified
        const tier = system.tier || 1;
        const tierConfig = TIER_CONFIGS[tier];
        const beltCountRoll = Math.floor(tierConfig.belts[0] + this.rng.next() * (tierConfig.belts[1] - tierConfig.belts[0] + 1));
        
        const beltPositions = system.belts && system.belts.length > 0 ? system.belts : [];
        
        if (beltPositions.length === 0) {
            for (let i = 0; i < beltCountRoll; i++) {
                const angle = (i / beltCountRoll) * Math.PI * 2 + (this.rng.next() * 0.5);
                const dist = 6000 + this.rng.next() * 4000;
                beltPositions.push({
                    pos: { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist },
                    size: Math.floor(tierConfig.count[0] + this.rng.next() * (tierConfig.count[1] - tierConfig.count[0] + 1)),
                    name: `${system.name} Belt ${i + 1}`
                });
            }
        }

        // Spawn Belts
        if (!isCombatInstance) {
            beltPositions.forEach(belt => {
                this.spawnBelt(new THREE.Vector2(belt.pos.x, belt.pos.y), this.asteroidTexture, belt.size, belt.name);
            });
        }

        // Sync Game State
        this.setGameState(prev => ({
            ...prev,
            currentSystem: {
                id: systemId,
                name: system.name,
                sector: system.sector,
                security: system.security,
                securityValue: system.securityValue
            },
            asteroidBelts: [...this.asteroidBelts]
        }));

        // Finalize Jump logic
        this._isLoadingSystem = false;
        this.initialized = true; // Mark as fully ready after first load
        
        // Update multiplayer sector if enabled
        switchSystem(systemId);

        // Singleton Broodmother Spawning
        const isBroodmotherSystem = (this.broodmotherSystemIds || []).includes(systemId);
        if (!isCombatInstance && isBroodmotherSystem) {
            console.log(`[GameManager] Spawning Singleton Broodmother in ${system.name}`);
            const angle = Math.random() * Math.PI * 2;
            const dist = 5000 + Math.random() * 5000;
            this.spawnBroodmother(new THREE.Vector3(Math.cos(angle) * dist, Math.sin(angle) * dist, 0));
        }

        // Decorative signal sources in Null-Sec
        if (!isCombatInstance && system.securityValue < 0.1) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 6000 + Math.random() * 2000;
            const px = Math.cos(angle) * dist;
            const py = Math.sin(angle) * dist;
            this.spawnSignalSource(px + 400, py + 400); 
        }

        // Update Sun Position and Size for the current system
        if (system.sun && this.sunData) {
            this.sunData.basePos.set(system.sun.pos.x, system.sun.pos.y, -25);
            this.sunData.baseSize = system.sun.size;
            if (this.sunSprite) {
                this.sunSprite.scale.set(system.sun.size, system.sun.size, 1);
            }
            if (this.sunCorona) {
                this.sunCorona.scale.set(system.sun.size * 1.8, system.sun.size * 1.8, 1);
            }
            if (this.sunHalo) {
                this.sunHalo.scale.set(system.sun.size * 1.2, system.sun.size * 1.2, 1);
            }
        }

        // Update Planet Position and Size for the current system
        if (this.planetLayers && this.planetLayers[0]) {
            const pLayer = this.planetLayers[0];
            if (pLayer.mesh) {
                pLayer.mesh.visible = !isBattlegroundInstance;
            }
            if (system.planet && !isBattlegroundInstance) {
                pLayer.basePos.set(system.planet.pos.x, system.planet.pos.y, -2);

                // Handle system-specific rotation speed
                pLayer.rotationSpeed = system.planet.rotationSpeed !== undefined ? 
                                       system.planet.rotationSpeed : 0.0002;

                if (pLayer.mesh) {
                    pLayer.mesh.scale.set(system.planet.size, system.planet.size, 1);
                }
            }
        }

        // Spawn dynamically generated anomalies for this system
        const existingCount = this.systemAnomalyCounts[systemId] || 0;
        const targetCount = 3 + Math.floor(this.rng.next() * 3); // 3 to 5
        
        if (!isCombatInstance && existingCount < targetCount) {
            const needed = targetCount - existingCount;
            for (let i = 0; i < needed; i++) {
                this.spawnAnomaly(systemId);
            }
        } else {
            // Just ensure they are in the scene if we are coming back
            this.entities.forEach(e => {
                if (e.type === 'anomaly' && e.sprite && !this.scene.children.includes(e.sprite)) {
                    this.scene.add(e.sprite);
                }
            });
        }
    }

    initiateJump(destinationId) {
        if (this.isArenaInstance) return "INVALID_DESTINATION";
        const dest = this.asteroidBelts.find(b => b.id === destinationId);
        if (!dest) return "INVALID_DESTINATION";

        if (this.jumpDrive.active) return "ALREADY_JUMPING";
        
        // Jump Power check
        const jumpPower = this.stats.jumpPower !== undefined ? this.stats.jumpPower : 1;
        if (jumpPower <= 0) {
            this.showNotification("Jump Aborted: Insufficient jump power in propulsion dynamics.", "error");
            this.speak("Insufficient jump power. Navigation systems unable to calculate warp vectors.");
            return "INSUFFICIENT_JUMP_POWER";
        }
        
        const jumpEnergyCost = this.stats.jumpEnergyCost || this.systemConfig.jumpEnergyCost || 50;

        if (this.stats.energy < jumpEnergyCost) {
            this.showNotification(`Insufficient reactor energy: ${jumpEnergyCost} units required.`, "error");
            this.speak("Insufficient reactor energy for jump drive initialization.");
            return "INSUFFICIENT_ENERGY";
        }

        this.stats.energy -= jumpEnergyCost;
        this.speak("Jump drive charging. Core stabilization in progress.");

        if (this.jumpVoicePlayer && this.jumpVoicePlayer.loaded) {
            try { this.jumpVoicePlayer.start(Tone.now()); } catch (e) {}
        }

        this.jumpDrive = {
            active: true,
            isSystemJump: false,
            isStation: dest.isStation,
            startTime: Date.now(),
            destination: dest.center.clone(),
            progress: 0,
            jumpPlayed: false,
            remaining: (this.stats.jumpWarmupTime || 7000) / 1000,
            warmupTotal: this.stats.jumpWarmupTime || 7000
        };

        return "SUCCESS";
    }

    initiateSystemJump(systemId) {
        if (this.currentSystemId === systemId) return "ALREADY_IN_SYSTEM";
        const system = resolveSystemDefinition(systemId);
        if (!system) return "INVALID_SYSTEM";

        if (this.jumpDrive.active) return "ALREADY_JUMPING";
        
        // Jump Power check
        const jumpPower = this.stats.jumpPower !== undefined ? this.stats.jumpPower : 1;
        if (jumpPower <= 0) {
            this.showNotification("System Jump Failed: Propulsion dynamics report 0 jump power.", "error");
            this.speak("Insufficient jump power for interstellar transit.");
            return "INSUFFICIENT_JUMP_POWER";
        }
        
        // System jumps cost more energy and take longer
        const systemJumpCost = this.stats.jumpEnergyCost || 30;
        const systemJumpTime = this.stats.jumpWarmupTime || 10000;

        if (this.stats.energy < systemJumpCost) {
            this.showNotification(`Critical Energy Deficit: ${systemJumpCost} units required for interstellar transit.`, "error");
            this.speak("Insufficient reactor energy for interstellar jump sequence.");
            return "INSUFFICIENT_ENERGY";
        }

        this.stats.energy -= systemJumpCost;
        this.speak(`Interstellar jump to ${system.name} initiated. Collating navigational data.`);

        if (this.jumpVoicePlayer && this.jumpVoicePlayer.loaded) {
            try { this.jumpVoicePlayer.start(Tone.now()); } catch (e) {}
        }

        this.jumpDrive = {
            active: true,
            isSystemJump: true,
            startTime: Date.now(),
            destinationId: systemId,
            progress: 0,
            jumpPlayed: false,
            remaining: systemJumpTime / 1000,
            warmupTotal: systemJumpTime
        };

        return "SUCCESS";
    }

    performEmergencyJump() {
        if (this.jumpDrive.active) return "ALREADY_JUMPING";
        if (this.stats.isDocked) return "CANNOT_JUMP_WHILE_DOCKED";

        // Jump Power check
        const jumpPower = this.stats.jumpPower !== undefined ? this.stats.jumpPower : 1;
        if (jumpPower <= 0) {
            this.showNotification("Emergency Jump Aborted: Propulsion dynamics report jump power deficit.", "error");
            this.speak("Insufficient jump power for emergency warp sequence.");
            return "INSUFFICIENT_JUMP_POWER";
        }

        // Emergency jump has a steep cost (45 units)
        const emergencyCost = 45; 

        if (this.stats.energy < emergencyCost) {
            this.showNotification(`Emergency Jump Failed: Minimum ${emergencyCost} reactor units required.`, "error");
            this.speak("Insufficient reactor energy for emergency jump sequence.");
            return "INSUFFICIENT_ENERGY";
        }

        // 50% of standard warmup time
        const baseWarmup = this.stats.jumpWarmupTime || 7000;
        const emergencyWarmup = baseWarmup * 0.5;

        this.stats.energy -= emergencyCost;
        this.speak("Emergency jump initiated. Brace for core cavitation.");
        this.showNotification("EMERGENCY JUMP: CRITICAL CORE OVERLOAD", "warning");

        if (this.jumpVoicePlayer && this.jumpVoicePlayer.loaded) {
            try { this.jumpVoicePlayer.start(Tone.now()); } catch (e) {}
        }

        // Random destination within system bounds
        const angle = Math.random() * Math.PI * 2;
        const dist = 3500 + Math.random() * 4500;
        const targetX = Math.cos(angle) * dist;
        const targetY = Math.sin(angle) * dist;

        this.jumpDrive = {
            active: true,
            isSystemJump: false,
            isEmergencyJump: true,
            startTime: Date.now(),
            destination: new THREE.Vector3(targetX, targetY, 0),
            progress: 0,
            jumpPlayed: false,
            remaining: emergencyWarmup / 1000,
            warmupTotal: emergencyWarmup
        };
        
        return "SUCCESS";
    }

    finalizeJump() {
        if (this.jumpDrive.isSystemJump) {
            const systemId = this.jumpDrive.destinationId;
            const starportId = SYSTEM_TO_STARPORT[systemId];
            this.speak(`Jump complete. Entering ${SYSTEMS_REGISTRY[systemId]?.name || 'new sector'}.`);
            this.loadSystem(systemId, starportId);
            
            // Randomize arrival position for system jump at a safe distance from center/starport
            const angle = Math.random() * Math.PI * 2;
            const dist = 1200 + Math.random() * 400; 
            this.ship.sprite.position.set(Math.cos(angle) * dist, Math.sin(angle) * dist, 0);
            
            // Face the system center
            this.ship.rotation = Math.atan2(-Math.cos(angle), Math.sin(angle));
            this.ship.velocity.set(0, 0);
        } else if (this.jumpDrive.isEmergencyJump) {
            const destPos = this.jumpDrive.destination;
            if (!destPos) return;

            this.speak("Emergency jump complete. Re-aligning telemetry.");
            
            // Visual Out Effect (from current position)
            this.createWarpOutEffect(this.ship.sprite.position.clone());

            // Teleport
            this.ship.sprite.position.copy(destPos);
            this.ship.velocity.set(0, 0);
            this.ship.rotation = Math.random() * Math.PI * 2;

            // Visual In Effect (at new position)
            this.createWarpInEffect(this.ship.sprite.position.clone());
            
            // Clear targets as sensors are scrambled by the core burst
            this.setTarget(null);
        } else {
            const destPos = this.jumpDrive.destination;
            if (!destPos) return;

            this.speak("Jump sequence complete. Re-aligning telemetry.");

            // Local jump to belt or station
            const angle = Math.random() * Math.PI * 2;
            if (this.jumpDrive.isStation) {
                // Apply random offset around the station so we don't land inside it
                const dist = 600 + Math.random() * 200; // Safe distance outside station radius
                this.ship.sprite.position.set(
                    destPos.x + Math.cos(angle) * dist,
                    destPos.y + Math.sin(angle) * dist,
                    0
                );
                // Face the station for immediate docking alignment
                this.ship.rotation = Math.atan2(-Math.cos(angle), Math.sin(angle));
            } else {
                // Local jump to asteroid belt - arrive at a safe perimeter
                const dist = 1000 + Math.random() * 300; // Arrive outside the spread of asteroids
                this.ship.sprite.position.set(
                    destPos.x + Math.cos(angle) * dist,
                    destPos.y + Math.sin(angle) * dist,
                    0
                );
                // Face the center of the belt for tactical overview
                this.ship.rotation = Math.atan2(-Math.cos(angle), Math.sin(angle));
            }
            this.ship.velocity.set(0, 0);
        }

        this.jumpDrive.active = false;
        this.setGameState(prev => ({
            ...prev,
            jumpDrive: { active: false, remaining: 0, progress: 0 }
        }));
        
        // Trigger auto-save after jump
        this.requestSave();
    }

    onResize() {
        // Internal rendering resolution is fixed at 1920x1080.
        // We use a fixed 16:9 aspect ratio for the camera to match the canvas buffer.
        const aspect = 1920 / 1080;

        let frustumWidth, frustumHeight;
        // The cameraDistance represents the size of the view in world units.
        frustumHeight = this.cameraDistance;
        frustumWidth = frustumHeight * aspect;

        this.camera.left = -frustumWidth / 2;
        this.camera.right = frustumWidth / 2;
        this.camera.top = frustumHeight / 2;
        this.camera.bottom = -frustumHeight / 2;
        this.camera.updateProjectionMatrix();
        
        // Ensure the renderer internal buffer stays at 1080p regardless of window scaling
        this.renderer.setSize(1920, 1080, false);
    }

    createShootingStar() {
        const angle = Math.random() * Math.PI * 2;
        const dist = 400; // Relative to camera
        const startX = this.camera.position.x + Math.cos(angle) * dist;
        const startY = this.camera.position.y + Math.sin(angle) * dist;

        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({ 
            color: 0xffffff, 
            transparent: true,
            opacity: 1,
            blending: THREE.AdditiveBlending
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        
        // Random direction
        const dir = new THREE.Vector3(
            (Math.random() - 0.5) * 40,
            (Math.random() - 0.5) * 40,
            0
        );
        
        const lookAngle = Math.atan2(dir.y, dir.x);
        mesh.rotation.z = lookAngle;
        
        const length = 60 + Math.random() * 60;
        mesh.scale.set(length, 2, 1);
        
        // Place at the furthest star layer depth
        mesh.position.set(startX, startY, -10);
        
        this.scene.add(mesh);
        
        // We track the relative position to the camera to apply parallax properly
        this.shootingStars.push({
            mesh: mesh,
            relativePos: new THREE.Vector3(startX - this.camera.position.x, startY - this.camera.position.y, -10),
            velocity: dir.multiplyScalar(0.8),
            life: 1.0,
            parallaxFactor: 0.999 // Matches furthest star layer
        });
    }

    updateShootingStars() {
        if (!this.shootingStars) return;
        const now = Date.now();
        // Increased cooldown and decreased spawn chance for rarity
        if (now - this.lastShootingStarTime > 8000 && Math.random() < 0.01) {
            this.createShootingStar();
            this.lastShootingStarTime = now;
        }

        for (let i = this.shootingStars.length - 1; i >= 0; i--) {
            const ss = this.shootingStars[i];
            
            // Move the relative position
            ss.relativePos.add(ss.velocity);
            
            // Apply parallax: Camera Pos + (Relative Pos * parallax adjustment)
            // This ensures they "stay" in the background while moving
            ss.mesh.position.x = this.camera.position.x * ss.parallaxFactor + ss.relativePos.x;
            ss.mesh.position.y = this.camera.position.y * ss.parallaxFactor + ss.relativePos.y;
            
            ss.life -= 0.025;
            ss.mesh.material.opacity = Math.max(0, ss.life);
            
            if (ss.life <= 0) {
                this.scene.remove(ss.mesh);
                this.shootingStars.splice(i, 1);
            }
        }
    }

    initAudio() {
        if (this.synth) return;
        
        // Global Audio Chain for Ducking and Clipping Protection
        this.masterLimiter = new Tone.Limiter(-2).toDestination(); // Prevent digital clipping
        
        // Primary Synth for tactical locking and UI
        this.synth = new Tone.MonoSynth({
            oscillator: { type: "square" },
            envelope: { attack: 0.05, decay: 0.1, sustain: 0.3, release: 0.1 }
        }).connect(this.masterLimiter);
        this.synth.volume.value = -15;

        // Weapon Synth for firing
        this.weaponSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "triangle" },
            envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.2 }
        }).connect(this.masterLimiter);
        this.weaponSynth.volume.value = -18;

        // Create pulse sound for Pulse Cannon (ARC chip sound)
        this.pulseSynth = new Tone.MonoSynth({
            oscillator: { type: "square" },
            envelope: {
                attack: 0.001,
                decay: 0.05,
                sustain: 0,
                release: 0.05
            },
            filter: {
                Q: 1,
                type: "lowpass",
                rolloff: -12
            },
            filterEnvelope: {
                attack: 0.001,
                decay: 0.05,
                sustain: 0,
                release: 0.05,
                baseFrequency: 200,
                octaves: 4,
                exponent: 2
            }
        }).connect(this.masterLimiter);
        this.pulseSynth.volume.value = -12;

        // Dedicated Scanner Synth for atmospheric ripples
        this.scannerSynth = new Tone.FMSynth({
            harmonicity: 3,
            modulationIndex: 10,
            oscillator: { type: "sine" },
            envelope: { attack: 0.01, decay: 0.4, sustain: 0.1, release: 0.5 },
            modulation: { type: "square" },
            modulationEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2 }
        }).connect(this.masterLimiter);
        this.scannerSynth.volume.value = -20;

        // Load specific weapon sound assets
        this.pulsePlayer = new Tone.Player({
            url: "https://rosebud.ai/assets/pulsecannonsound.wav?aS58",
            autostart: false,
            fadeOut: "64n"
        }).connect(this.masterLimiter);
        this.pulsePlayer.volume.value = -10;

        this.fluxPlayer = new Tone.Player({
            url: "https://rosebud.ai/assets/fluxlasersound.wav?hxVM",
            autostart: false,
            loop: true,
            fadeOut: "32n"
        }).connect(this.masterLimiter);
        this.fluxPlayer.volume.value = -12;

        // Ambient Background Music
        this.bgMusic = new Tone.Player({
            url: AUDIO_URLS.backgroundMusic,
            loop: true,
            autostart: true,
            fadeIn: 2,
            fadeOut: 1.2
        }).connect(this.masterLimiter);
        this.bgMusic.volume.value = -22; 

        this.arenaMusic = new Tone.Player({
            url: AUDIO_URLS.arenaMusic,
            loop: true,
            autostart: false,
            fadeIn: 2,
            fadeOut: 1.2
        }).connect(this.masterLimiter);
        this.arenaMusic.volume.value = -30;

        this.battlegroundMusic = new Tone.Player({
            url: AUDIO_URLS.battlegroundMusic || AUDIO_URLS.arenaMusic,
            loop: true,
            autostart: false,
            fadeIn: 2,
            fadeOut: 1.2
        }).connect(this.masterLimiter);
        this.battlegroundMusic.volume.value = -22;

        this.jumpPlayer = new Tone.Player({
            url: "https://rosebud.ai/assets/jump.wav?jF2d",
            autostart: false
        }).connect(this.masterLimiter);
        this.jumpPlayer.volume.value = -10;

        this.jumpVoicePlayer = new Tone.Player({
            url: "https://rosebud.ai/assets/jumpvoice.mp3?4B1X",
            autostart: false
        }).connect(this.masterLimiter);
        this.jumpVoicePlayer.volume.value = -8;

        this.welcomeCygnusPlayer = new Tone.Player({
            url: AUDIO_URLS.welcomeCygnus,
            autostart: false
        }).connect(this.masterLimiter);
        this.welcomeCygnusPlayer.volume.value = -4;

        this.setInstanceMusicMode(String(this.currentSystemId || '').startsWith('bg:pve:') ? 'battleground' : (String(this.currentSystemId || '').startsWith('arena:') ? 'arena' : 'normal'));
    }

    setInstanceMusicMode(mode = 'normal') {
        this._arenaMusicActive = mode === 'arena';
        this._instanceMusicMode = mode;
        if (!this.masterLimiter) return;

        const stopIfPlaying = (player, now) => {
            if (player && player.loaded && player.state === 'started') {
                try { player.stop(now); } catch (e) {}
            }
        };

        const startIfStopped = (player, now) => {
            if (player && player.loaded && player.state !== 'started') {
                try { player.start(now); } catch (e) {}
            }
        };

        const applyMode = () => {
            const now = Tone.now();
            const arenaPlayer = this.arenaMusic;
            const bgPlayer = this.bgMusic;
            const battlegroundPlayer = this.battlegroundMusic;

            stopIfPlaying(arenaPlayer, now);

            if (mode === 'arena') {
                stopIfPlaying(bgPlayer, now);
                stopIfPlaying(battlegroundPlayer, now);
                return;
            }

            if (mode === 'battleground') {
                stopIfPlaying(bgPlayer, now);
                startIfStopped(battlegroundPlayer, now);
                return;
            }

            stopIfPlaying(battlegroundPlayer, now);
            startIfStopped(bgPlayer, now);
        };

        applyMode();
        if (typeof Tone?.loaded === 'function') {
            Tone.loaded().then(() => {
                if (this._instanceMusicMode !== mode) return;
                applyMode();
            }).catch(() => {});
        }
    }

    playFluxLaserSound() {
        this.lastFluxFireTime = Date.now();
        if (this.fluxPlayer && this.fluxPlayer.loaded && this.fluxPlayer.state !== 'started') {
            try { this.fluxPlayer.start(Tone.now()); } catch (e) {}
        }
    }

    updateWeaponVisuals(fittings) {
        if (!fittings || !this.ship.sprite) return;

        // Iterate through all defined hardpoints
        Object.keys(this.hardpoints).forEach(slotId => {
            const hp = this.hardpoints[slotId];
            const shipPos = this.ship.sprite.position;
            const shipAngle = this.ship.rotation;
            const shipScaleFactor = this.ship.sprite.scale.x / 64;

            // Rotational transform for offset relative to ship
            const cos = Math.cos(shipAngle);
            const sin = Math.sin(shipAngle);
            
            // Calculate current world position of this hardpoint
            const rotatedX = (hp.x * shipScaleFactor) * cos - (hp.y * shipScaleFactor) * sin;
            const rotatedY = (hp.x * shipScaleFactor) * sin + (hp.y * shipScaleFactor) * cos;
            
            this.hardpointWorldPositions[slotId] = new THREE.Vector3(
                shipPos.x + rotatedX, 
                shipPos.y + rotatedY, 
                0.1
            );
        });

        // Cleanup: If any weapon sprites still exist in scene from previous version, remove them
        if (this.weaponSprites) {
            Object.values(this.weaponSprites).forEach(ws => {
                if (ws.sprite) this.scene.remove(ws.sprite);
            });
            delete this.weaponSprites;
        }
    }

    calculateFluxDamage(distance, module) {
        const { item: effectiveModule, finalStats } = getEffectiveModuleStats(module);
        module = effectiveModule || module;
        const config = FLUX_LASER_CONFIGS[module.weaponsize || module.size || 'S'];
        const optimal = Number(finalStats.optimalRange ?? module.optimalRange ?? config?.optimalRange ?? 0);
        const falloff = Number(finalStats.falloffRange ?? module.falloffRange ?? config?.falloffRange ?? optimal);
        const baseDmg = Number(finalStats.damagePerTick ?? module.damagePerTick ?? config?.damagePerTick ?? 0);

        if (distance <= optimal) return baseDmg;
        if (distance >= falloff) return 0;
        
        // Linear falloff
        const factor = 1.0 - (distance - optimal) / Math.max(1, (falloff - optimal));
        return baseDmg * factor;
    }

    canWeaponHit(slotId, module, target) {
        if (!target || !target.sprite || !module) return false;
        if (!this.ship || !this.ship.sprite) return false;
        
        const nameLower = (module.name || '').toLowerCase();
        const idLower = (module.item_id || module.id || '').toLowerCase();
        const isFlux = nameLower.includes('flux') || idLower.includes('flux');
        const isMining = module.type === 'mining';

        if (isFlux || isMining) {
            const { item: effectiveModule, finalStats } = getEffectiveModuleStats(module);
            module = effectiveModule || module;
            const config = isFlux ? 
                (FLUX_LASER_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || FLUX_LASER_CONFIGS['S']) :
                (MINING_LASER_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || MINING_LASER_CONFIGS['S']);
            
            const falloffLimit = Number(finalStats.falloffRange ?? module.falloffRange ?? config.falloffRange ?? 0);
            
            if (!target || !target.sprite || !this.ship || !this.ship.sprite) return false;
            const dist = this.ship.sprite.position.distanceTo(target.sprite.position);
            const effectiveDist = dist - (target.radius || 0);
            
            if (effectiveDist > falloffLimit) return false;

            const targetPos = target.sprite.position.clone();
            const shipPos = this.ship.sprite.position.clone();
            const toTarget = new THREE.Vector2(targetPos.x - shipPos.x, targetPos.y - shipPos.y).normalize();
            const forward = new THREE.Vector2(-Math.sin(this.ship.rotation), Math.cos(this.ship.rotation)).normalize();
            const dot = forward.dot(toTarget);
            const angleDeg = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
            
            if (angleDeg > config.hitArc) return false;
        }
        
        return true;
    }

    checkBeamImpact(start, end, module, sourceId = 'player-ship') {
        let closestEntity = null;
        let minDist = Infinity;
        let impactPoint = end.clone();

        const diff = new THREE.Vector3().subVectors(end, start);
        const beamLen = diff.length();
        const beamDir = diff.normalize();

        // Potential targets: all entities (includes NPCs, asteroids) + player ship
        const targets = [...this.entities];
        if (sourceId !== 'player-ship' && this.ship && this.ship.sprite) {
            targets.push({
                id: 'player-ship',
                sprite: this.ship.sprite,
                radius: this.ship.baseVisualScale * 0.5 || 32,
                type: 'PLAYER'
            });
        }

        targets.forEach(entity => {
            // Cannot hit self
            if (entity.id === sourceId || !entity.sprite || entity.static) return;
            
            const entityPos = entity.sprite.position;
            const toEntity = new THREE.Vector3().subVectors(entityPos, start);
            const projection = toEntity.dot(beamDir);
            
            // Check if entity is along the beam segment
            if (projection < 0 || projection > beamLen + (entity.radius || 20)) return;
            
            const closestPointOnBeam = start.clone().add(beamDir.clone().multiplyScalar(Math.max(0, Math.min(beamLen, projection))));
            const distToBeam = entityPos.distanceTo(closestPointOnBeam);
            const entityRadius = entity.radius || 20;

            if (distToBeam < entityRadius) {
                const distToHit = start.distanceTo(closestPointOnBeam);
                if (distToHit < minDist) {
                    minDist = distToHit;
                    closestEntity = entity;
                    impactPoint.copy(closestPointOnBeam);
                }
            }
        });

        return { entity: closestEntity, point: impactPoint };
    }

fireWeapon(slotId, module) {
    // Cooldown check
    if (this.weaponCooldowns[slotId] > 0) return;

    // 🔥 SEND TO EC2 SERVER (correct path)
    // 🔥 SEND TO EC2 SERVER (intent only; EC2 is authority)
    // Use slotId as weapon_id (stable per-ship hardpoint), and send the item template id for future loadout validation.
    const weaponMeta = {
        item_id: module.item_id || null,     // template/type id (preferred)
        instance_id: module.id || null,      // unique instance id (inventory)
        name: module.name || null,
        weaponsize: (module.weaponsize || module.size || null),
        rarity: (module.rarity || null),
        type: (module.type || null),
        subtype: (module.subtype || null)
    };

// AUTHORITATIVE HYDRATION: Ensure we have the latest calculated stats
    const effectiveModule = module.final_stats ? module : hydrateItem(module);
    module = effectiveModule || module;
    const fStats = (effectiveModule && effectiveModule.final_stats) ? effectiveModule.final_stats : {};

        const nameLower = (module.name || '').toLowerCase();
        const idLower = (module.item_id || module.id || '').toLowerCase();
        const isFlux = nameLower.includes('flux') || idLower.includes('flux');
        const isMissile = nameLower.includes('seeker pod') || idLower.includes('seeker pod');
        const isPulse = nameLower.includes('pulse cannon') || idLower.includes('pulse cannon');
        const isMining = module.type === 'mining';
        
        // Authoritative Stat Resolution: Fallbacks are only used for base template if manifest is empty
        const config = isFlux ? FLUX_LASER_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || FLUX_LASER_CONFIGS['S'] : 
                      (isMining ? MINING_LASER_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || MINING_LASER_CONFIGS['S'] :
                      (isMissile ? MISSILE_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || MISSILE_CONFIGS['S'] : 
                      (isPulse ? PULSE_CANNON_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || PULSE_CANNON_CONFIGS['S'] : null)));

        // Target Lock Bonuses
        const isLocked = this.locking.state === 'Locked' && this.target;
        const lockBonus = isLocked ? 1.5 : 1.0; 

        // Ammo Management for Pulse Cannons
        if (isPulse && config) {
            const magSize = fStats.magazine || config.magazine;
            if (!this.weaponAmmo[slotId]) {
                this.weaponAmmo[slotId] = { current: magSize, reloading: false, reloadStartTime: 0 };
            }
            const ammo = this.weaponAmmo[slotId];
            if (ammo.reloading) return;
            if (ammo.current <= 0) {
                ammo.reloading = true;
                ammo.reloadStartTime = Date.now();
                this.showNotification("RELOADING...", "warning");
                return;
            }
        }

        // Accuracy / HitChance for Missiles, Lasers and Cannons
        let hitChance = 1.0;
        const baseAccuracy = fStats.accuracy || fStats.baseAccuracy || (config?.baseAccuracy || 0.85);
        const lockMultiplier = isLocked ? 1.15 : 1.0; 
        
        if (isMissile && config) {
            const mods = MISSILE_RARITY_MODS[module.rarity || 'common'] || { tracking: 1.0 };
            const attackerTracking = (fStats.tracking || config.tracking || 24) * mods.tracking * lockBonus;
            
            if (this.target) {
                const isAsteroid = this.target && ASTEROID_TYPES.some(t => t.name === this.target.type);
                const targetSig = this.target.finalSigRadius || this.target.sigRadius || (isAsteroid ? 10 : 30);
                hitChance = Math.min(1.0, Math.max(0.0, (baseAccuracy * lockMultiplier) * (attackerTracking / targetSig)));
            } else {
                hitChance = baseAccuracy * 0.5; // Reduced accuracy without target
            }
        } else if (isPulse && config) {
            const attackerTracking = (fStats.tracking || config.tracking || 22) * lockBonus;
            if (this.target) {
                const targetSig = this.target.finalSigRadius || this.target.sigRadius || 30;
                hitChance = Math.min(1.0, Math.max(0.0, (baseAccuracy * lockMultiplier) * (attackerTracking / targetSig)));
            } else {
                hitChance = baseAccuracy * 0.7;
            }
        } else if (isFlux && config) {
            // Lasers use baseAccuracy and tracking vs selected target if available
            if (this.target) {
                const targetSig = this.target.finalSigRadius || this.target.sigRadius || 30;
                const attackerTracking = (fStats.tracking || config.tracking || 28) * lockBonus;
                
                // Distance Penalty to tracking: Tracking effectiveness decays with distance
                const dist = this.ship.sprite.position.distanceTo(this.target.sprite.position);
                const optimalRange = fStats.optimalRange || config.optimalRange || 300;
                const distFactor = Math.max(0.5, 1.0 - Math.max(0, dist - optimalRange) / 1000);
                
                // Refined laser hit chance: sensitivity to tracking/sig ratio with power curve damping
                hitChance = Math.min(0.92, Math.max(0.0, (baseAccuracy * lockMultiplier) * Math.pow(attackerTracking / targetSig, 1.2) * distFactor));
            }
        }

        // --- 1. Determine Aim Point with Lead Targeting for Pulse Cannons ---
        let aimPoint = this.mouseWorldPos.clone();
        
        if (isLocked && this.target) {
            const targetPos = this.target.sprite.position.clone();
            
            // Apply Lead Targeting for Pulse Cannons
            if (isPulse && config) {
                const muzzleSpeed = (fStats.projectileSpeed || config.projectileSpeed) * 2.0;
                const startPos = this.hardpointWorldPositions[slotId] || this.ship.sprite.position.clone();
                
                // Relative velocity of target to shooter
                const targetVel = this.target.velocity || new THREE.Vector2(0, 0);
                const shipVel = this.ship.velocity || new THREE.Vector2(0, 0);
                const relVel = new THREE.Vector2(targetVel.x - shipVel.x, targetVel.y - shipVel.y);
                
                const distVec = new THREE.Vector2(targetPos.x - startPos.x, targetPos.y - startPos.y);
                
                // Standard Lead Equation: at^2 + bt + c = 0
                const a = relVel.x * relVel.x + relVel.y * relVel.y - muzzleSpeed * muzzleSpeed;
                const b = 2 * (distVec.x * relVel.x + distVec.y * relVel.y);
                const c = distVec.x * distVec.x + distVec.y * distVec.y;
                
                const discriminant = b * b - 4 * a * c;
                
                if (discriminant >= 0) {
                    const t1 = (-b + Math.sqrt(discriminant)) / (2 * a);
                    const t2 = (-b - Math.sqrt(discriminant)) / (2 * a);
                    const t = t1 > 0 ? (t2 > 0 ? Math.min(t1, t2) : t1) : t2;
                    
                    if (t > 0) {
                        aimPoint.set(
                            targetPos.x + relVel.x * t,
                            targetPos.y + relVel.y * t,
                            0
                        );
                    } else {
                        aimPoint = targetPos;
                    }
                } else {
                    aimPoint = targetPos;
                }
            } else {
                aimPoint = targetPos;
            }
        }
        
        // Apply Spread
        const finalAimPoint = aimPoint.clone();
        let spreadFactor = 0;
        if (isPulse) {
            // Pulse Cannons have a base spread even when locked, and much more when manual
            spreadFactor = isLocked ? 12 : 75; 
        } else if (!isLocked) {
            // Significant jitter spread for other weapons when not locked
            spreadFactor = isFlux ? 80 : 30;
        }

        if (spreadFactor > 0) {
            finalAimPoint.x += (Math.random() - 0.5) * spreadFactor;
            finalAimPoint.y += (Math.random() - 0.5) * spreadFactor;
        }

        // --- 2. Angular Arc Check ---
        if ((isFlux || isMissile || isPulse || isMining) && config) {
            const hitArc = fStats.hitArc || config.hitArc || (isFlux ? 45 : (isPulse ? 60 : (isMining ? 45 : 180)));
            const shipPos = this.ship.sprite.position.clone();
            const toAim = new THREE.Vector2(finalAimPoint.x - shipPos.x, finalAimPoint.y - shipPos.y).normalize();
            const forward = new THREE.Vector2(-Math.sin(this.ship.rotation), Math.cos(this.ship.rotation)).normalize();
            const dot = forward.dot(toAim);
            const angleDeg = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
            
            if (angleDeg > hitArc) return; // Out of turret arc
        }

        // Flux Laser specific heat/overheat check
        if (isFlux && config) {
            if (!this.weaponStates[slotId]) this.weaponStates[slotId] = { heat: 0, overheated: false };
            if (this.weaponStates[slotId].overheated) return; 
        }

        // 🔥 SEND TO EC2 SERVER (authoritative fire solution in world coords)
        // We send muzzle + aim in world coords so server hitscan and remote FX line up exactly.
        if (typeof backendSocket !== "undefined" && backendSocket && backendSocket.sendFireWeapon) {
            const muzzle = (this.hardpointWorldPositions && this.hardpointWorldPositions[slotId])
                ? this.hardpointWorldPositions[slotId].clone()
                : (this.ship?.sprite?.position
                    ? this.ship.sprite.position.clone()
                    : new THREE.Vector3(this.ship?.x || 0, this.ship?.y || 0, 0));

            const aim = finalAimPoint.clone();
            const fireRot = Math.atan2((aim.y - muzzle.y), (aim.x - muzzle.x));

            backendSocket.sendFireWeapon(this.ship, slotId, weaponMeta, {
                x: muzzle.x,
                y: muzzle.y,
                rot: fireRot,
                aimX: aim.x,
                aimY: aim.y,
                vx: this.ship?.velocity?.x ?? 0,
                vy: this.ship?.velocity?.y ?? 0,
                t: Date.now(),
                beamRange: (fStats?.falloffRange || config?.falloffRange || null)
            });
        }

        // Cooldown Accumulator: STRICTLY AUTHORITATIVE
        let secondsPerShot = 1.0;
        if (isMining) secondsPerShot = fStats.fireRate || fStats.cycle_time || config.fireRate || 1.0;
        else if (isFlux) secondsPerShot = 1.0 / (fStats.fireRate || config.fireRate || 12);
        else if (isPulse) secondsPerShot = 1.0 / (fStats.fireRate || config.fireRate || 4);
        else if (isMissile) {
            const mods = MISSILE_RARITY_MODS[module.rarity || 'common'] || { reload: 1.0 };
            secondsPerShot = (fStats.reload || config.reload || 3.0) * mods.reload;
        } else {
            secondsPerShot = fStats.fireRate || module.fireRate || 1.0;
        }
        
        this.weaponCooldowns[slotId] += secondsPerShot;

        // NOTE: Fire visuals are now driven by EC2 via FIRE_WEAPON -> WEAPON_FIRED.
        // We intentionally do NOT broadcast fire_item via Supabase anymore.

        // Audio
        if (this.weaponSynth) {
            try {
                if (isPulse) {
                    if (this.pulsePlayer && this.pulsePlayer.loaded) {
                        this.pulsePlayer.start(Tone.now());
                    } else if (this.pulseSynth) {
                        this.pulseSynth.triggerAttackRelease("C6", "32n", Tone.now());
                    }
                } else if (isFlux) {
                    if (this.fluxPlayer && this.fluxPlayer.loaded) {
                        this.playFluxLaserSound();
                    } else {
                        let note = module.size === 'small' ? "G4" : (module.size === 'medium' ? "C4" : "E3");
                        this.weaponSynth.triggerAttackRelease(note, "16n", Tone.now());
                    }
                } else {
                    let note = isMissile ? "G2" : (isMining ? "A4" : (module.size === 'small' ? "G4" : (module.size === 'medium' ? "C4" : "E3")));
                    this.weaponSynth.triggerAttackRelease(note, isMining ? "2n" : (isMissile ? "4n" : "16n"), Tone.now());
                }
            } catch (e) {}
        }

        const startPos = this.hardpointWorldPositions[slotId] || this.ship.sprite.position.clone();

        // --- 3. Pulse Cannon Firing ---
        if (isPulse && config) {
            const speed = (module.projectileSpeed || config.projectileSpeed) * 2.0; // scale up for visual speed
            const damage = (module.damage || config.damage);
            const toAimDir = new THREE.Vector3().subVectors(finalAimPoint, startPos).normalize();
            
            // Projectile velocity relative to ship
            const relativeVelocity = toAimDir.multiplyScalar(speed);
            
            // Add ship's current velocity so projectiles inherit ship momentum
            const velocity = new THREE.Vector3(
                relativeVelocity.x + (this.ship.velocity.x || 0),
                relativeVelocity.y + (this.ship.velocity.y || 0),
                0
            );
            
            const projectile = new PulseProjectile(
                this.scene, slotId, module, startPos, velocity, damage, hitChance, this, speed
            );
            this.projectiles.push(projectile);
            
            // Consume ammo
            if (this.weaponAmmo[slotId]) {
                this.weaponAmmo[slotId].current--;
            }
            return;
        }

        // --- 4. Missile Firing ---
        if (isMissile) {
            const mods = MISSILE_RARITY_MODS[module.rarity || 'common'];
            const tracking = (module.tracking || config.tracking) * mods.tracking * lockBonus;
            const speed = (module.missileSpeed || config.missileSpeed) * mods.speed;
            const flightTime = module.flightTime || config.flightTime;
            const damage = (module.damage || config.damage) * mods.dmg;
            const aoeRadius = (module.aoeRadius || config.aoeRadius) * mods.aoe;

            const missile = new MissileProjectile(
                this.scene, slotId, module, startPos, isLocked ? this.target : null, 
                tracking, speed, flightTime, damage, aoeRadius, hitChance,
                this, this.missileTexture, finalAimPoint
            );
            this.missiles.push(missile);
            this.locking.lastMissileFiredTime = Date.now();
            return;
        }

        // --- 4. Laser / Beam Raycasting ---
        const isContinuous = isFlux || isMining;
        const mods = isFlux ? (FLUX_RARITY_MODS[module.rarity || 'common'] || { range: 1.0 }) : 
                             (isMining ? (MINING_RARITY_MODS[module.rarity || 'common'] || { range: 1.0 }) : { range: 1.0 });
        const baseFalloff = isFlux ? (config.falloffRange || 400) : (isMining ? (config.falloffRange || 400) : 400);
        const actualFalloff = baseFalloff * (mods.range || 1.0);
        const maxRange = actualFalloff;
        
        // Extend aim point to max range to ensure raycast finds things beyond the cursor
        const toAimDir = new THREE.Vector3().subVectors(finalAimPoint, startPos).normalize();
        
        // Range Check for firing initiation (especially for mining lasers)
        if (isMining) {
            const distToAim = startPos.distanceTo(finalAimPoint);
            if (distToAim > maxRange) return; // Prevent firing if clicking beyond max range
        }

        const extendedEnd = startPos.clone().add(toAimDir.multiplyScalar(maxRange));
        
        const impact = this.checkBeamImpact(startPos, extendedEnd, module);
        const hitEntity = impact.entity;
        const hitPoint = impact.point;
        const effectiveDist = startPos.distanceTo(hitPoint);

        // Apply hit chance for Flux Lasers if hitting the intended target
        const isMiss = (isFlux && hitEntity === this.target) ? (Math.random() > hitChance) : false;

        // Visual update for existing beam
        if (isContinuous && this.activeBeams[slotId]) {
            this.activeBeams[slotId].lastFired = Date.now();
            this.activeBeams[slotId].aimPoint = hitPoint;
            this.activeBeams[slotId].hitEntity = hitEntity;
            
            if (hitEntity) {
                if (isMining) {
                    const success = this.applyMiningToTarget(hitEntity, module);
                    if (!success) this.activeWeapons[slotId] = false;
                } else {
                    this.applyDamageToTarget(hitEntity, module, effectiveDist, isMiss);
                }
            }
            return;
        }

        // Create new beam visual
        const rarityColorHex = module.rarity === 'mythic' || module.rarity === 'legendary' ? 0xffcc00 : 
                               (module.rarity === 'epic' ? 0xa335ee : 
                               (module.rarity === 'rare' ? 0x00ccff : 
                               (module.rarity === 'uncommon' ? 0x00ff00 :
                               (module.rarity === 'common' && isFlux ? 0xffffff : 0xff4444))));
        const beamColor = isMining ? (module.rarity === 'common' ? 0xccffff : rarityColorHex) : rarityColorHex;
        
        let laser;
        if (isFlux || isMining) {
            const fluxMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    uTime: { value: 0 },
                    uOpacity: { value: 1.0 },
                    uColor: { value: new THREE.Color(beamColor) },
                    uFluxJitter: { value: isMining ? 0.05 : 0.18 }
                },
                vertexShader: FLUX_BEAM_VERTEX_SHADER,
                fragmentShader: FLUX_BEAM_FRAGMENT_SHADER,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            // Use a PlaneGeometry for the high-fidelity beam. Length 1, Width 1.
            // We scale it later.
            const fluxGeom = new THREE.PlaneGeometry(1, 1);
            laser = new THREE.Mesh(fluxGeom, fluxMaterial);
        } else {
            const laserGeom = new THREE.BufferGeometry().setFromPoints([startPos, hitPoint]);
            const laserMat = new THREE.LineBasicMaterial({ color: beamColor, transparent: true, opacity: 1, linewidth: isMining ? 6 : 2 });
            laser = new THREE.Line(laserGeom, laserMat);
        }
        
        laser.renderOrder = 30;
        this.scene.add(laser);

        if (isContinuous) {
            this.activeBeams[slotId] = { laser, lastFired: Date.now(), slotId, hitEntity, aimPoint: hitPoint, type: module.type };
        }

        let sparks = null;
        let particles = [];
        if ((isMining || isFlux) && hitEntity) {
            sparks = this.createMiningSparks(hitPoint, beamColor);
            for (let i = 0; i < 4; i++) particles.push(this.createOreParticle(hitPoint, beamColor));
        }

        let opacity = 1.0;
        const fadeStep = 1.0 / (isContinuous ? 15 : 10);
        let frameCount = 0;
        
        const fade = () => {
            frameCount++;
            const state = this.weaponStates[slotId];
            const group1 = module.weaponGroup1 && this.mouseButtons[0];
            const group2 = module.weaponGroup2 && this.mouseButtons[2];
            
            // Re-check auto-mining condition for visual persistence
            const isAsteroid = this.target && ASTEROID_TYPES.some(t => t.name === this.target.type);
            const isMining = module.type === 'mining';
            const isLocked = this.locking.state === 'Locked';
            const shouldAutoFire = isMining && isAsteroid && isLocked;

            let isActuallyFiring = (this.activeWeapons[slotId] || group1 || group2 || shouldAutoFire) && (!state || !state.overheated);

            // Visual arc check: ensure beam snaps off when pointing outside tracking limits
            if (isActuallyFiring && this.ship.sprite) {
                const shipPos = this.ship.sprite.position;
                const aimPoint = (this.locking.state === 'Locked' && this.target) ? this.target.sprite.position : this.mouseWorldPos;
                const toAim = new THREE.Vector2(aimPoint.x - shipPos.x, aimPoint.y - shipPos.y).normalize();
                const forward = new THREE.Vector2(-Math.sin(this.ship.rotation), Math.cos(this.ship.rotation)).normalize();
                const dot = forward.dot(toAim);
                const angleDeg = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
                const laserConfig = FLUX_LASER_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()];
                if (angleDeg > (laserConfig?.hitArc || 45)) isActuallyFiring = false;
            }

            if (isContinuous && isActuallyFiring) opacity = 1.0; 
            else opacity -= fadeStep;

            // Handle material updates
            if (isFlux || isMining) {
                laser.material.uniforms.uOpacity.value = opacity;
                laser.material.uniforms.uTime.value += 0.016; // Approx 60fps
            } else {
                laser.material.opacity = Math.min(1.0, opacity * 2); 
            }
            
            if (this.ship.sprite && opacity > 0) {
                const currentStart = this.hardpointWorldPositions[slotId] ? this.hardpointWorldPositions[slotId].clone() : this.ship.sprite.position.clone();
                // Recalculate impact every frame for continuous beams
                const currentAimPoint = isLocked && this.target ? this.target.sprite.position.clone() : this.mouseWorldPos.clone();
                if (!isLocked) {
                    currentAimPoint.x += (Math.random() - 0.5) * 80;
                    currentAimPoint.y += (Math.random() - 0.5) * 80;
                }
                
                const currentToAimDir = new THREE.Vector3().subVectors(currentAimPoint, currentStart).normalize();
                const currentExtendedEnd = currentStart.clone().add(currentToAimDir.multiplyScalar(maxRange));
                const currentImpact = this.checkBeamImpact(currentStart, currentExtendedEnd, module);
                
                if (isFlux || isMining) {
                    const diff = new THREE.Vector3().subVectors(currentImpact.point, currentStart);
                    const length = diff.length();
                    const angle = Math.atan2(diff.y, diff.x);
                    
                    laser.position.copy(currentStart).add(diff.multiplyScalar(0.5));
                    laser.rotation.z = angle;
                    laser.scale.set(length, isMining ? 24 : 32, 1); // Mining beams slightly thinner than flux
                } else {
                    laser.geometry.setFromPoints([currentStart, currentImpact.point]);
                }
                
                if ((isMining || isFlux) && currentImpact.entity && opacity > 0) {
                    const jitterX = (Math.random() - 0.5) * 4;
                    const jitterY = (Math.random() - 0.5) * 4;
                    if (sparks) {
                        sparks.position.set(currentImpact.point.x + jitterX, currentImpact.point.y + jitterY, 0);
                        const pulse = (isFlux ? 60 : 40) + (Math.random() * 20); // Restored original impact size
                        sparks.scale.set(pulse * Math.min(1, opacity * 2), pulse * Math.min(1, opacity * 2), 1);
                        sparks.visible = true;
                    }
                    if (frameCount % 8 === 0) for (let i = 0; i < 2; i++) particles.push(this.createOreParticle(currentImpact.point, beamColor));
                }
                
                // Particle physics
                for (let i = particles.length - 1; i >= 0; i--) {
                    const p = particles[i];
                    p.life -= 0.01; 
                    p.sprite.position.add(p.velocity);
                    p.sprite.material.opacity = Math.min(p.life, opacity * 3);
                    if (p.life <= 0) { this.scene.remove(p.sprite); p.sprite.material.dispose(); particles.splice(i, 1); }
                }
            } else {
                if (isMining && sparks) sparks.visible = false;
                particles.forEach(p => {
                    p.life -= 0.02; p.sprite.position.add(p.velocity); p.sprite.material.opacity = p.life;
                    if (p.life <= 0) { this.scene.remove(p.sprite); p.sprite.material.dispose(); }
                });
            }

            if (opacity > 0) requestAnimationFrame(fade);
            else {
                if (isMining && this.serverMiningTargetId && typeof backendSocket?.sendStopMining === 'function') {
                    try { backendSocket.sendStopMining(this.serverMiningTargetId); } catch {}
                    this.serverMiningTargetId = null;
                    this.serverMiningLastStartAt = 0;
                }
                if (isContinuous && this.activeBeams[slotId] && this.activeBeams[slotId].laser === laser) delete this.activeBeams[slotId];
                this.scene.remove(laser); laser.geometry.dispose(); laser.material.dispose();
                if (sparks) { this.scene.remove(sparks); sparks.material.dispose(); }
                particles.forEach(p => {
                    this.scene.remove(p.sprite);
                    p.sprite.material.dispose();
                });
                particles.length = 0;
            }
        };
        fade();

        if (hitEntity) {
            if (isMining) {
                const success = this.applyMiningToTarget(hitEntity, module);
                if (!success) this.activeWeapons[slotId] = false;
            } else {
                this.applyDamageToTarget(hitEntity, module, effectiveDist, isMiss);
            }
        }
    }

    createOreParticle(position, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        
        // Jagged shard shape
        ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
        ctx.beginPath();
        ctx.moveTo(16, 4);
        ctx.lineTo(28, 16);
        ctx.lineTo(16, 28);
        ctx.lineTo(4, 16);
        ctx.closePath();
        ctx.fill();
        
        // Sparkle highlight
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(14, 14, 4, 4);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ 
            map: texture, 
            transparent: true,
            depthTest: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.copy(position);
        
        // Random drift direction away from impact (speed reduced for tighter effect)
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.2 + Math.random() * 0.4;
        const velocity = new THREE.Vector3(Math.cos(angle) * speed, Math.sin(angle) * speed, 0);
        
        const size = 8 + Math.random() * 12;
        sprite.scale.set(size, size, 1);
        sprite.renderOrder = 32;
        
        this.scene.add(sprite);
        return { sprite, velocity, rotationSpeed: (Math.random() - 0.5) * 0.2, life: 1.0 };
    }

    createMiningSparks(position, color) {
        const sparkCanvas = document.createElement('canvas');
        sparkCanvas.width = 64;
        sparkCanvas.height = 64;
        const ctx = sparkCanvas.getContext('2d');
        const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        const hexColor = '#' + new THREE.Color(color).getHexString();
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.3, hexColor);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);

        const texture = new THREE.CanvasTexture(sparkCanvas);
        const material = new THREE.SpriteMaterial({ 
            map: texture, 
            transparent: true, 
            blending: THREE.AdditiveBlending,
            depthTest: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.copy(position);
        sprite.scale.set(40, 40, 1);
        sprite.renderOrder = 31;
        this.scene.add(sprite);
        return sprite;
    }

    _getRarityMult(rarity) {
        const mults = {
            common: 1.0,
            uncommon: 1.25,
            rare: 1.5,
            epic: 2.0,
            mythic: 3.0
        };
        return mults[rarity] || 1.0;
    }

    applyMiningToTarget(target, module) {
        if (target.type === 'SignalSource') {
            const entry = LORE_REGISTRY[target.loreKey];
            if (entry && this.onLoreScanned) {
                this.onLoreScanned(entry);
                this.destroyTarget(target);
            }
            return true;
        }

        if (!ASTEROID_TYPES.some(t => t.name === target.type)) return true;

        const effectiveModule = module.final_stats ? module : hydrateItem(module);
        const stats = effectiveModule.final_stats;
        const baseExtraction = stats.mining_yield || stats.baseExtraction || 1.0;
        const extractionSkill = (this.commanderStats && this.commanderStats.mining) || 0;
        const skillBonus = 1.0 + (extractionSkill * 0.1);
        const oreExtracted = Number((baseExtraction * skillBonus).toFixed(2));
        const actualExtraction = Math.min(target.oreAmount, oreExtracted);
        if (actualExtraction <= 0) return false;

        const authorityActive = !!backendSocket && !!backendSocket.socket && backendSocket.socket.readyState === WebSocket.OPEN && !backendSocket.isDocked;
        if (authorityActive && typeof backendSocket.sendStartMining === 'function') {
            try {
                this.serverMiningTargetId = target.id;
                this.serverMiningLastStartAt = Date.now();
                backendSocket.sendStartMining(target.id, {
                    target_id: target.id,
                    target_type: target.type || 'Asteroid',
                    target_x: target.sprite?.position?.x,
                    target_y: target.sprite?.position?.y,
                    target_oreAmount: target.oreAmount,
                    target_oreType: target.oreType || target.type,
                    target_ql: target.ql || 1,
                    target_qlBand: target.qlBand || getQLBand(target.ql || 1),
                    target_collisionRadius: target.radius || target.collisionRadius || 40,
                    yieldPerCycle: actualExtraction,
                    cycleMs: Math.max(250, Number((stats.fireRate || stats.cycle_time || 0.7) * 1000) || 700),
                    range: stats.falloffRange || stats.range || 650,
                    weapon_id: module.item_id || module.id || module.name || 'mining-laser'
                });
            } catch {}
            return true;
        }

        target.oreAmount -= actualExtraction;
        const oreName = target.oreType || target.type;
        const ql = target.ql || 1;
        const qlBand = target.qlBand || getQLBand(ql);
        if (this.addExperience) {
            this.addExperience(actualExtraction * 0.25);
        }
        const impactPoint = this.activeBeams[Object.keys(this.fittings || {}).find(k => this.fittings[k] === module)]?.impactPoint || target.sprite.position;
        this.spawnLoot({
            name: `${oreName} Fragment`,
            oreType: oreName,
            ql: ql,
            qlBand: qlBand,
            type: 'resource',
            rarity: 'common',
            amount: actualExtraction,
            weight: Number((actualExtraction * 0.1).toFixed(2)),
            description: `Unrefined ${oreName} fragment.`
        }, impactPoint);

        if (target.oreAmount <= 0) {
            this.destroyTarget(target);
        }
        return true;
    }

    showDamageNumber(target, damage, isLegendary = false, isMiss = false, type = 'standard', entityId = null) {
        let position = target;
        let trackingTarget = null;

        // If target is an object with a sprite (Entity/NPC/Player)
        if (target && target.sprite) {
            trackingTarget = target.sprite;
            position = target.sprite.position;
        } else if (target && target.isObject3D) {
            trackingTarget = target;
            position = target.position;
        }

        if (isMiss || damage <= 0) {
            this.spawnDamageSprite(position, damage, isLegendary, isMiss, type, false, entityId, trackingTarget);
            return;
        }

        // Handle Additive Stacking for Shield and Hull
        if (entityId && (type === 'shield' || type === 'hull')) {
            if (!this.damageStacks.has(entityId)) {
                this.damageStacks.set(entityId, { shield: null, hull: null });
            }
            const stacks = this.damageStacks.get(entityId);
            const stack = stacks[type];
            const now = Date.now();

            // Stack if firing continuously (within 300ms of last tick)
            if (stack && (now - stack.lastTick < 300) && (now - stack.startTime < 1500)) {
                // Update existing stack
                stack.damage += damage;
                stack.lastTick = now;
                stack.isLegendary = stack.isLegendary || isLegendary;
                this.updateDamageSprite(stack);
                
                // Refresh the finalization timer so it doesn't expire while we are actively updating
                this.scheduleStackFinalization(entityId, type);
                return;
            } else {
                // Finalize old stack if it exists
                if (stack) {
                    this.finalizeDamageStack(stack);
                }
                // Create new stack
                const newStack = {
                    entityId,
                    type,
                    damage,
                    startTime: now,
                    lastTick: now,
                    isLegendary,
                    sprite: this.spawnDamageSprite(position, damage, isLegendary, false, type, true, entityId, trackingTarget),
                    timeout: null
                };
                stacks[type] = newStack;
                
                // Set the cleanup timeout
                this.scheduleStackFinalization(entityId, type);
                return;
            }
        }

        // Fallback for standard damage
        this.spawnDamageSprite(position, damage, isLegendary, isMiss, type, false, entityId, trackingTarget);
    }

    scheduleStackFinalization(entityId, type) {
        const stacks = this.damageStacks.get(entityId);
        if (!stacks || !stacks[type]) return;
        const stack = stacks[type];

        if (stack.timeout) clearTimeout(stack.timeout);
        
        stack.timeout = setTimeout(() => {
            const currentStacks = this.damageStacks.get(entityId);
            if (currentStacks && currentStacks[type] === stack) {
                this.finalizeDamageStack(stack);
                currentStacks[type] = null;
            }
        }, 1000);
    }

    finalizeDamageStack(stack) {
        if (!stack || !stack.sprite) return;
        
        // Brief Pop Animation on Finalization
        const sprite = stack.sprite;
        const originalScale = sprite.scale.clone();
        const startTime = Date.now();
        const popDuration = 150;

        const animatePop = () => {
            const elapsed = Date.now() - startTime;
            const progress = elapsed / popDuration;
            
            if (progress >= 1) {
                sprite.scale.copy(originalScale);
                // Begin normal fade-out sequence
                stack.isFinalized = true;
                return;
            }

            // Simple subtle "bump" scale
            const scaleMod = 1 + Math.sin(progress * Math.PI) * 0.2;
            sprite.scale.set(originalScale.x * scaleMod, originalScale.y * scaleMod, 1);
            requestAnimationFrame(animatePop);
        };
        
        animatePop();
    }

    updateDamageSprite(stack) {
        const sprite = stack.sprite;
        if (!sprite || !sprite.material.map) return;
        
        const canvas = sprite.material.map.image;
        const ctx = canvas.getContext('2d');
        const damage = stack.damage;
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = 'bold 120px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const dmgText = (damage < 10 && damage > 0) ? damage.toFixed(1) : Math.round(damage).toString();
        
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 12;
        ctx.strokeText(dmgText, 256, 128);
        
        if (stack.isLegendary) {
            ctx.fillStyle = '#ffcc00';
        } else if (stack.type === 'shield') {
            ctx.fillStyle = '#00ccff';
        } else if (stack.type === 'hull') {
            ctx.fillStyle = '#ff4444';
        }
        ctx.fillText(dmgText, 256, 128);
        sprite.material.map.needsUpdate = true;
    }

    spawnDamageSprite(position, damage, isLegendary = false, isMiss = false, type = 'standard', persistent = false, entityId = null, trackingTarget = null) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        
        // Boosted font size for maximum visibility
        ctx.font = 'bold 120px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Format: show 1 decimal for small values, otherwise round
        const dmgText = isMiss ? "MISS" : ((damage < 10 && damage > 0) ? damage.toFixed(1) : Math.round(damage).toString());
        
        // Heavy outline for readability
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 12;
        ctx.strokeText(dmgText, 256, 128);
        
        // Color coding: Gold for Legendary hits, Gray for 0/MISS, Blue for shield, Red for hull
        if (isMiss || damage <= 0) {
            ctx.fillStyle = '#888888';
        } else if (isLegendary) {
            ctx.fillStyle = '#ffcc00';
        } else if (type === 'shield') {
            ctx.fillStyle = '#00ccff'; // Bright Blue
        } else if (type === 'hull') {
            ctx.fillStyle = '#ff4444'; // Bright Red
        } else {
            ctx.fillStyle = '#ffffff';
        }
        ctx.fillText(dmgText, 256, 128);
        
        const texture = new THREE.CanvasTexture(canvas);
        texture.magFilter = THREE.LinearFilter;
        
        const material = new THREE.SpriteMaterial({ 
            map: texture, 
            transparent: true, 
            depthTest: false 
        });
        const sprite = new THREE.Sprite(material);
        
        // Jitter to prevent perfect overlap on continuous fire
        const jitterX = (Math.random() - 0.5) * 40;
        const initialYOffset = 40 + (Math.random() * 20); 
        let currentRise = 0;

        sprite.position.copy(position);
        sprite.position.x += jitterX;
        sprite.position.y += initialYOffset;

        // Store relative offsets if tracking
        const relativeOffset = new THREE.Vector2(jitterX, initialYOffset);

        // Important: Store entityId and type in userData for stack logic
        sprite.userData = { entityId, type, fadeStartTime: null };

        // Initial adaptive scaling (Boosted base size)
        const baseScaleX = 100;
        const baseScaleY = 50;
        const initialScaleFactor = Math.sqrt(this.cameraDistance / 1400);
        sprite.scale.set(baseScaleX * initialScaleFactor, baseScaleY * initialScaleFactor, 1);
        sprite.renderOrder = 1000;
        
        this.scene.add(sprite);
        
        const startTime = Date.now();
        const duration = 1000;
        
        const animateDamage = () => {
            const now = Date.now();
            
            // If tracking target exists and is still in scene, follow it
            if (trackingTarget && trackingTarget.parent) {
                sprite.position.x = trackingTarget.position.x + relativeOffset.x;
                sprite.position.y = trackingTarget.position.y + relativeOffset.y + currentRise;
            }

            // If persistent (stacking), we wait for finalization flag
            if (persistent) {
                const stack = this.damageStacks.get(sprite.userData.entityId)?.[sprite.userData.type];
                // Check if this sprite belongs to a stack that is still active
                const isStillStacking = stack && stack.sprite === sprite && !stack.isFinalized;
                
                if (isStillStacking) {
                    // Update scale based on zoom
                    const currentScaleFactor = Math.sqrt(this.cameraDistance / 1400);
                    sprite.scale.set(100 * currentScaleFactor, 50 * currentScaleFactor, 1);
                    requestAnimationFrame(animateDamage);
                    return;
                }
                
                // Once stack is finalized, we transition to fade-out
                if (!sprite.userData.fadeStartTime) {
                    sprite.userData.fadeStartTime = Date.now();
                }
                const fadeElapsed = Date.now() - sprite.userData.fadeStartTime;
                const progress = fadeElapsed / duration;
                
                if (progress >= 1) {
                    this.scene.remove(sprite);
                    texture.dispose();
                    material.dispose();
                    return;
                }
                
                const currentScaleFactor = Math.sqrt(this.cameraDistance / 1400);
                sprite.scale.set(100 * currentScaleFactor, 50 * currentScaleFactor, 1);
                currentRise += 0.5;
                sprite.material.opacity = 1.0 - progress;
                requestAnimationFrame(animateDamage);
                return;
            }

            const elapsed = now - startTime;
            const progress = elapsed / duration;
            
            if (progress >= 1) {
                this.scene.remove(sprite);
                texture.dispose();
                material.dispose();
                return;
            }
            
            // Continuous scale adjustment synchronized with camera zoom
            const currentScaleFactor = Math.sqrt(this.cameraDistance / 1400);
            sprite.scale.set(100 * currentScaleFactor, 50 * currentScaleFactor, 1);
            
            currentRise += 0.5; // Rise slowly
            if (!trackingTarget || !trackingTarget.parent) {
                sprite.position.y += 0.5;
            }
            
            sprite.material.opacity = 1.0 - progress;
            
            requestAnimationFrame(animateDamage);
        };
        
        animateDamage();
        return sprite;
    }

    spawnSignalSource(posX, posY) {
        const signalId = `signal-${Date.now()}`;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255, 255, 100, 1)');
        grad.addColorStop(0.5, 'rgba(255, 150, 0, 0.4)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const sprite = new THREE.Sprite(material);
        sprite.position.set(posX, posY, 0);
        sprite.scale.set(60, 60, 1);
        sprite.renderOrder = 20;
        this.scene.add(sprite);

        // Pulsing animation
        const startTime = Date.now();
        const animate = () => {
            if (!sprite.parent) return;
            const t = (Date.now() - startTime) / 1000;
            const s = 60 + Math.sin(t * 5) * 20;
            sprite.scale.set(s, s, 1);
            sprite.material.opacity = 0.5 + Math.sin(t * 5) * 0.3;
            requestAnimationFrame(animate);
        };
        animate();

        // Random lore entry
        const loreKeys = Object.keys(LORE_REGISTRY);
        const loreKey = loreKeys[Math.floor(Math.random() * loreKeys.length)];

        const signal = {
            id: signalId,
            type: 'SignalSource',
            x: posX,
            y: posY,
            radius: 40,
            sprite: sprite,
            loreKey: loreKey,
            static: true
        };

        this.entities.push(signal);
    }

    applyDamageToTarget(target, module, effectiveDist = null, forceMiss = false) {
        // Prevent damage to static Omni Directorate structures
        if (target.static) return;

        let totalDamage = 0;
        let damageType = module.damageType || 'kinetic';
        const nameLower = (module.name || '').toLowerCase();
        const idLower = (module.item_id || module.id || '').toLowerCase();
        const isFlux = nameLower.includes('flux') || idLower.includes('flux');
        
        let maxDisplayRange = 9999;

        if (effectiveDist !== null && isFlux) {
            totalDamage = forceMiss ? 0 : this.calculateFluxDamage(effectiveDist, module);
            
            const config = FLUX_LASER_CONFIGS[module.weaponsize || 'S'];
            damageType = config.damageType || 'thermal';
            const mods = FLUX_RARITY_MODS[module.rarity || 'common'];
            const falloff = config.falloffRange * mods.range;
            // Limit display to 15% past falloff range
            maxDisplayRange = falloff * 1.15;
        } else {
            const rarityMult = this._getRarityMult(module.rarity);
            let rawDmg = (module.damageShield || 0) + (module.damageHull || 0);
            totalDamage = forceMiss ? 0 : rawDmg * rarityMult;

            // Apply Damage Modifiers for standard weapons
            if (module.modifiers && totalDamage > 0) {
                const dmgMod = 1 + (module.modifiers.filter(m => m.tag === 'damage').reduce((sum, m) => sum + (m.currentRoll / 100), 0) || 0);
                totalDamage *= dmgMod;
            }
        }

        if (totalDamage <= 0 && !forceMiss) return;

        // Apply damage based on target type
        let shieldDealt = 0;
        let hullDealt = 0;

        if (target.type === 'NPC' || target.type === 'BIO') {
            const damageResult = this.applyDamageToNpc(target, totalDamage, damageType);
            shieldDealt = damageResult.shieldDamage;
            hullDealt = damageResult.hullDamage;
        } else if (target.type === 'PLAYER') {
            const damageResult = this.takeDamage(totalDamage, damageType);
            shieldDealt = damageResult.shieldDamage;
            hullDealt = damageResult.hullDamage;
        } else if (target.type === 'Asteroid' || !target.type) {
            // Asteroid logic (legacy oreAmount usage) - asteroids treat all damage as hull
            const prevOre = target.oreAmount || 0;
            target.oreAmount = Math.max(0, (target.oreAmount || 0) - totalDamage);
            hullDealt = prevOre - (target.oreAmount || 0);
            if (target.oreAmount <= 0) {
                this.destroyTarget(target);
            }
        }

        // Visual damage numbers above target
        if (effectiveDist === null || effectiveDist <= maxDisplayRange) {
            if (forceMiss) {
                this.showDamageNumber(target, 0, false, true, 'standard', target.id);
            } else {
                if (shieldDealt > 0) {
                    this.showDamageNumber(target, shieldDealt, module.rarity === 'legendary', false, 'shield', target.id);
                }
                if (hullDealt > 0) {
                    this.showDamageNumber(target, hullDealt, module.rarity === 'legendary', false, 'hull', target.id);
                }
            }
        }

        // Flash target if damage > 0
        if (target.sprite && target.sprite.material && target.sprite.material.color && totalDamage > 0) {
            const originalColor = target.sprite.material.color.clone();
            target.sprite.material.color.set(0xffffff);
            setTimeout(() => {
                if (target.sprite && target.sprite.material && target.sprite.material.color) target.sprite.material.color.copy(originalColor);
            }, 50);
        }
    }

    applyDamageToNpc(npc, amount, type = 'thermal') {
        if (amount <= 0) return { shieldDamage: 0, hullDamage: 0 };

        const authorityActive =
            !!backendSocket &&
            !!backendSocket.socket &&
            backendSocket.socket.readyState === WebSocket.OPEN &&
            !backendSocket.isDocked;

        if (authorityActive && backendSocket?.sendNpcHitRequest && npc && !npc._serverApplyingDamage) {
            try {
                backendSocket.sendNpcHitRequest({
                    target_id: npc.id,
                    target_type: npc.type || (npc.isBio ? 'BIO' : 'NPC'),
                    target_shipType: npc.shipType,
                    target_creatureType: npc.creatureType,
                    target_classId: npc.classId,
                    target_isBio: !!npc.isBio,
                    target_x: npc.sprite?.position?.x,
                    target_y: npc.sprite?.position?.y,
                    target_hp: npc.stats?.hp,
                    target_maxHp: npc.stats?.maxHp,
                    target_shields: npc.stats?.shields,
                    target_maxShields: npc.stats?.maxShields,
                    target_armor: npc.stats?.armor,
                    target_kineticRes: npc.stats?.kineticRes,
                    target_thermalRes: npc.stats?.thermalRes,
                    target_blastRes: npc.stats?.blastRes,
                    target_collisionRadius: npc.collisionRadius || npc.radius || 25,
                    target_cargo: npc.cargo,
                    target_cargoType: npc.cargoType,
                    target_cargoQL: npc.cargoQL,
                    target_cargoQLBand: npc.cargoQLBand,
                    damageType: type,
                    amount
                });
            } catch {}
            return { shieldDamage: 0, hullDamage: 0 };
        }
        
        // Wake up passive creatures when damaged
        if (npc.isBio && npc.isPassiveUntilAttacked) {
            npc.isAggravated = true;
        }

        let shieldDamage = 0;
        let hullDamage = 0;

        // Player resistance modifiers (if target is player - though this function is applyDamageToNpc)
        // We'll apply modifiers to the NPC logic if NPCs had modifiers, but the request was for fitted modules (player).
        // Since player takes damage elsewhere, let's find that.
        
        // NPC Shield Logic
        if (npc.stats.shields > 0) {
            // Apply Resistance
            let res = 0;
            if (type === 'kinetic') res = npc.stats.kineticRes || 0;
            if (type === 'thermal') res = npc.stats.thermalRes || 0;
            if (type === 'blast') res = npc.stats.blastRes || 0;
            
            const reducedDamage = amount * (1 - res);
            shieldDamage = Math.min(npc.stats.shields, reducedDamage);
            npc.stats.shields -= shieldDamage;
            
            // For calculating remaining hull damage, we need to know how much 'base' damage was used by shields
            const baseDamageUsed = shieldDamage / (1 - res);
            amount -= baseDamageUsed;
            
            // Visual feedback for NPC shield hit (simple scale pulse for now)
            if (npc.sprite) {
                npc.sprite.scale.multiplyScalar(1.05);
                setTimeout(() => { if (npc.sprite) npc.sprite.scale.multiplyScalar(1/1.05); }, 50);
            }
        }

        // NPC Hull Logic
        if (amount > 0) {
            // Apply resistances (matching OMNI SCOUT/CartelScout stats)
            const hullDmg = amount * (1 - (npc.stats.armor || 0.15));
            const oldHpRatio = npc.stats.hp / npc.stats.maxHp;
            npc.stats.hp = Math.max(0, npc.stats.hp - hullDmg);
            const newHpRatio = npc.stats.hp / npc.stats.maxHp;
            hullDamage = hullDmg;

            // BROODMOTHER SPECIAL ABILITIES: Threshold triggers (75%, 50%, 25%)
            if (npc.creatureType === 'Star-Eater Broodmother') {
                const thresholds = [0.75, 0.50, 0.25];
                thresholds.forEach(t => {
                    const flag = `hasTriggered${Math.floor(t * 100)}`;
                    if (oldHpRatio > t && newHpRatio <= t && !npc[flag]) {
                        npc[flag] = true;
                        this.triggerBroodmotherPhase(npc, t);
                    }
                });
            }
            
            if (npc.stats.hp <= 0) {
                this.destroyTarget(npc);
            }
        }

        return { shieldDamage, hullDamage };
    }

    handleNpcLoot(npc) {
        // Experience Reward
        let expReward = 15; 
        const type = (npc.shipType || '').toUpperCase();
        if (type.includes('GUNSHIP')) expReward = 60;
        else if (type.includes('SOVEREIGN') || type.includes('DESTROYER')) expReward = 150;
        else if (type.includes('INTERCEPTOR')) expReward = 30;
        this.addExperience(expReward);

        const system = resolveSystemDefinition(this.currentSystemId);
        if (!system) return;

        // 1. Flux Catalyst Independent Roll
        this.rollFluxCatalyst(npc, system);

        // 2. Blueprint Drops
        const secValue = system.securityValue;
        let band = 'secure';
        if (secValue < 0.2) band = 'null';
        else if (secValue < 0.5) band = 'low';
        else if (secValue < 0.7) band = 'mid';

        const table = LOOT_TABLES.Blueprint_Drops;
        const overall = table.overallChance[band];
        
        const rarityWeights = table.rarityWeights[band];
        const sizeWeights = table.sizeWeights;

        // Calculate dynamic sums to support non-100% weight sets if provided
        const rarityWeightSum = Object.values(rarityWeights).reduce((a, b) => a + b, 0);
        const sizeWeightSum = Object.values(sizeWeights).reduce((a, b) => a + b, 0);
        
        const totalDropChance = overall * rarityWeightSum * sizeWeightSum;

        // Roll for drop (Every kill rolls one chance)
        if (this.rng.next() < totalDropChance) {
            // Success! A blueprint drops. Now determine its rarity and size.
            const outcomes = [];
            for (const rarity in rarityWeights) {
                for (const size in sizeWeights) {
                    outcomes.push({
                        rarity,
                        size,
                        weight: rarityWeights[rarity] * sizeWeights[size]
                    });
                }
            }

            const totalWeight = outcomes.reduce((sum, o) => sum + o.weight, 0);
            let roll = this.rng.next() * totalWeight;
            let selectedOutcome = outcomes[0];

            for (const outcome of outcomes) {
                if (roll < outcome.weight) {
                    selectedOutcome = outcome;
                    break;
                }
                roll -= outcome.weight;
            }

            // Find matching blueprint from registry
            const eligibleBps = Object.keys(BLUEPRINT_REGISTRY).filter(id => {
                const bp = BLUEPRINT_REGISTRY[id];
                const bpSize = bp.weaponsize || bp.size;
                return bp.rarity === selectedOutcome.rarity && bpSize === selectedOutcome.size && 
                    (bp.outputType === 'weapon' || bp.outputType === 'shield' || bp.outputType === 'mining' || bp.outputType === 'drone-module');
            });

            if (eligibleBps.length > 0) {
                const bpId = eligibleBps[Math.floor(this.rng.next() * eligibleBps.length)];
                const bpData = BLUEPRINT_REGISTRY[bpId];
                // PHYSICAL LOOT: Instead of direct inventory, spawn in space
                this.spawnLoot({
                    ...bpData,
                    type: 'blueprint',
                    blueprintId: bpId
                }, npc.sprite.position);
            }
        }

        // 3. NPC Cargo Drop (Mining ships)
        if (npc.cargo > 0 && npc.cargoType) {
            const safeCargoAmount = Number(npc.cargo.toFixed(2));
            this.spawnLoot({
                name: `${npc.cargoType} Fragment`,
                oreType: npc.cargoType,
                ql: npc.cargoQL || 1,
                qlBand: npc.cargoQLBand || '1-25',
                type: 'resource',
                rarity: 'common',
                amount: safeCargoAmount,
                weight: Number((safeCargoAmount * 0.1).toFixed(2)),
                description: `Recovered ${npc.cargoType} from pirate salvage.`
            }, npc.sprite.position);
        }
    }

    handleBioLoot(npc) {
        // Experience Reward
        if (npc.creatureType === 'Star-Eater Broodmother') {
            this.addExperience(500);
        } else if (npc.creatureType === 'Star-Eater Larva') {
            this.addExperience(1);
        }

        const dropConfig = LOOT_TABLES.Bio_Material_Drops[npc.classId];
        if (!dropConfig) return;

        const count = dropConfig.min + Math.floor(this.rng.next() * (dropConfig.max - dropConfig.min + 1));
        
        // Get all available bio-materials
        const allMaterials = Object.keys(BIO_MATERIAL_REGISTRY);

        for (let i = 0; i < count; i++) {
            // Pick a random material with equal probability
            const materialId = allMaterials[Math.floor(this.rng.next() * allMaterials.length)];
            const materialData = BIO_MATERIAL_REGISTRY[materialId];
            // PHYSICAL LOOT: Spawn in space
            this.spawnLoot({
                ...materialData,
                type: 'bio-material',
                materialKey: materialId
            }, npc.sprite.position);
        }
    }

    addExperience(amount) {
        if (!amount || amount <= 0) return;
        
        this.setGameState(prev => {
            let nextExp = prev.experience + amount;
            let nextLevel = prev.level;
            
            // Check for level up
            let requiredExp = getRequiredExp(nextLevel);
            let leveledUp = false;
            
            while (nextExp >= requiredExp && nextLevel < 100) {
                nextExp -= requiredExp;
                nextLevel++;
                requiredExp = getRequiredExp(nextLevel);
                leveledUp = true;
            }
            
            if (leveledUp) {
                this.showNotification(`COMMANDER LEVEL INCREASED: LEVEL ${nextLevel}`, "info");
                this.speak(`Congratulations Commander. You have achieved level ${nextLevel}.`);
            }
            
            return {
                ...prev,
                experience: nextExp,
                level: nextLevel
            };
        });
    }

    addOreToInventory(oreData) {
        const { oreType, ql, qlBand, amount, weight } = oreData;
        const volume = (oreData.volume || weight * 1.5 || amount * 0.15);
        const currentWeight = this.stats.currentCargoWeight;
        const currentVolume = this.stats.currentCargoVolume || 0;

        if (currentWeight + weight > this.stats.cargoHold) {
            this.showNotification("Cargo Bay Full: Vessel Mass Overload", "error");
            return false;
        }
        if (currentVolume + volume > this.stats.cargoMaxVolume) {
            this.showNotification("Cargo Bay Full: Volume Capacity Reached", "error");
            return false;
        }

        this.stats.currentCargoWeight += weight;
        this.stats.currentCargoVolume = (this.stats.currentCargoVolume || 0) + volume;
        
        // Authoritative synchronization for telemetry
        const inventory = [...(this.inventory || [])];
        const stackId = `${oreType}-QL-${qlBand}`;
        const existingStackIndex = inventory.findIndex(item => item.id === stackId);

        const unitCount = Math.round(amount);
        const newQLs = new Array(unitCount).fill(ql);

        if (existingStackIndex !== -1) {
            const existingStack = { ...inventory[existingStackIndex] };
            existingStack.amount += amount;
            existingStack.weight = (existingStack.amount * 0.1).toFixed(1);
            existingStack.volume = (existingStack.amount * 0.15).toFixed(1);
            existingStack.qlList = [...(existingStack.qlList || []), ...newQLs];
            inventory[existingStackIndex] = existingStack;
        } else {
            inventory.push({
                id: stackId,
                name: `${oreType} [QL ${qlBand}]`,
                oreType: oreType,
                qlBand: qlBand,
                type: 'resource',
                subtype: 'ore',
                rarity: 'common',
                quality: qlBand * 10,
                amount: amount,
                stack: amount,
                maxStack: 1000,
                metadata: {},
                weight: (amount * 0.1).toFixed(1),
                volume: (amount * 0.15).toFixed(1),
                qlList: newQLs,
                description: `Unrefined ${oreType} within quality range ${qlBand}.`
            });
        }

        this.inventory = inventory;

        this.setGameState(prev => {
            return {
                ...prev,
                currentCargoWeight: this.stats.currentCargoWeight,
                currentCargoVolume: this.stats.currentCargoVolume,
                inventory: this.inventory
            };
        });
        return true;
    }

    addBioMaterialToInventory(materialKey) {
        const materialData = BIO_MATERIAL_REGISTRY[materialKey];
        if (!materialData) return;

        const itemWeight = materialData.weight || 0.1;
        const itemVolume = materialData.volume || (itemWeight * 1.5);
        
        if (this.stats.currentCargoWeight + itemWeight > this.stats.cargoHold) {
            this.showNotification(`CARGO FULL: Vessel Mass Overload`, "warning");
            return false;
        }
        if ((this.stats.currentCargoVolume || 0) + itemVolume > this.stats.cargoMaxVolume) {
            this.showNotification(`CARGO FULL: Volume Capacity Reached`, "warning");
            return false;
        }

        this.showNotification({
            type: "loot",
            name: materialData.name,
            rarity: materialData.rarity,
            itemType: "BIO-MATERIAL",
            color: '#00ccff'
        });
        
        this.stats.currentCargoWeight += itemWeight;
        this.stats.currentCargoVolume = (this.stats.currentCargoVolume || 0) + itemVolume;

        // Authoritative synchronization for telemetry
        const inventory = [...(this.inventory || [])];
        const existingIndex = inventory.findIndex(item => 
            item.type === 'bio-material' && item.materialKey === materialKey
        );

        if (existingIndex !== -1) {
            const existing = { ...inventory[existingIndex] };
            existing.amount = (existing.amount || 1) + 1;
            existing.weight = existing.amount * itemWeight;
            existing.volume = existing.amount * itemVolume;
            inventory[existingIndex] = existing;
        } else {
            inventory.push({
                id: `bio-${materialKey}-${Date.now()}-${Math.floor(this.rng.next()*10000)}`,
                materialKey: materialKey,
                name: materialData.name,
                type: 'bio-material',
                subtype: 'harvested-material',
                rarity: materialData.rarity,
                quality: 50,
                amount: 1,
                stack: 1,
                maxStack: 100,
                metadata: {},
                weight: itemWeight,
                volume: itemVolume,
                description: materialData.description
            });
        }

        this.inventory = inventory;

        this.setGameState(prev => ({ 
            ...prev, 
            inventory: this.inventory, 
            currentCargoWeight: this.stats.currentCargoWeight, 
            currentCargoVolume: this.stats.currentCargoVolume 
        }));
        return true;
    }

    rollFluxCatalyst(npc, system) {
        if (npc.isBio) return; // Biological entities don't drop technological catalysts
        const shipClassName = npc.classId || 'Scout'; // Default to Scout if missing
        // Map long class names to categories
        let category = 'Scout';
        if (shipClassName.includes('INTERCEPTOR')) category = 'OMNI INTERCEPTOR';
        else if (shipClassName.includes('GUNSHIP')) category = 'Gunship';
        else if (shipClassName.includes('DESTROYER')) category = 'Destroyer';

        const baseTable = CATALYST_DROP_TABLES[category] || CATALYST_DROP_TABLES['Scout'];
        
        // Security Modifiers
        const secValue = system.securityValue;
        let secKey = 'secure';
        if (secValue < 0.2) secKey = 'null';
        else if (secValue < 0.5) secKey = 'low';
        else if (secValue < 0.7) secKey = 'mid';

        const secMod = SECURITY_MODIFIERS[secKey];
        
        // Apply quantity modifier to drop chance
        const dropChance = baseTable.chance * (1 + secMod.quantity);
        
        if (this.rng.next() < dropChance) {
            // Success! Now determine rarity
            const weights = { ...baseTable.weights };
            const rarityMod = secMod.rarity;

            // Rarity weighting shift: shift weight from lower to higher tiers
            if (rarityMod > 0) {
                // Higher security/hazardous = shift common to uncommon, uncommon to rare, etc.
                const shiftCtoU = weights.common * rarityMod;
                weights.common -= shiftCtoU;
                weights.uncommon += shiftCtoU;

                const shiftUtoR = weights.uncommon * rarityMod;
                weights.uncommon -= shiftUtoR;
                weights.rare += shiftUtoR;

                const shiftRtoVR = weights.rare * rarityMod;
                weights.rare -= shiftRtoVR;
                weights.very_rare += shiftRtoVR;
            } else if (rarityMod < 0) {
                // Secure space = shift rare to uncommon, uncommon to common
                const absMod = Math.abs(rarityMod);
                
                const shiftVRtoR = weights.very_rare * absMod;
                weights.very_rare -= shiftVRtoR;
                weights.rare += shiftVRtoR;

                const shiftRtoU = weights.rare * absMod;
                weights.rare -= shiftRtoU;
                weights.uncommon += shiftRtoU;

                const shiftUtoC = weights.uncommon * absMod;
                weights.uncommon -= shiftUtoC;
                weights.common += shiftUtoC;
            }

            // Select rarity
            const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
            let roll = this.rng.next() * totalWeight;
            let selectedRarity = 'common';
            
            for (const [r, w] of Object.entries(weights)) {
                if (roll < w) {
                    selectedRarity = r;
                    break;
                }
                roll -= w;
            }

            // Pick specific catalyst from rarity pool
            const pool = Object.keys(FLUX_CATALYSTS).filter(id => FLUX_CATALYSTS[id].rarity === selectedRarity);
            if (pool.length > 0) {
                const catalystId = pool[Math.floor(this.rng.next() * pool.length)];
                const catalystData = FLUX_CATALYSTS[catalystId];
                // PHYSICAL LOOT: Spawn in space
                this.spawnLoot({
                    ...catalystData,
                    type: 'catalyst',
                    catalystId: catalystId
                }, npc.sprite.position);
            }
        }
    }

    addCatalystToInventory(catalystId, catalystData) {
        const itemWeight = 0.1; // Catalysts are lightweight
        
        if (this.stats.currentCargoWeight + itemWeight > this.stats.cargoHold) {
            this.showNotification("CARGO HOLD FULL: Catalyst Loot Abandoned", "warning");
            return false;
        }

        this.showNotification({
            type: "loot",
            name: catalystData.name,
            rarity: catalystData.rarity,
            itemType: "CATALYST"
        });
        
        this.stats.currentCargoWeight += itemWeight;

        this.setGameState(prev => {
            const inventory = [...(prev.inventory || [])];
            const existingIndex = inventory.findIndex(item => 
                item.type === 'catalyst' && item.catalystId === catalystId
            );

            if (existingIndex !== -1) {
                const existing = { ...inventory[existingIndex] };
                existing.amount = (existing.amount || 1) + 1;
                existing.weight = existing.amount * itemWeight;
                inventory[existingIndex] = existing;
            } else {
                inventory.push({
                    id: `catalyst-${catalystId}-${Date.now()}`,
                    catalystId: catalystId,
                    name: catalystData.name,
                    type: 'catalyst',
                    subtype: 'crafting-consumable',
                    rarity: catalystData.rarity,
                    quality: 50,
                    amount: 1,
                    stack: 1,
                    maxStack: 10,
                    metadata: {},
                    weight: itemWeight,
                    description: catalystData.description
                });
            }
            return { ...prev, inventory, currentCargoWeight: this.stats.currentCargoWeight };
        });
        return true;
    }

    async requestLootCollection(objectId, itemData) {
    if (!objectId) return false;

    let updatedInventory = null;

    const ec2Ready = !!backendSocket && !!backendSocket.socket && backendSocket.socket.readyState === WebSocket.OPEN && !backendSocket.isDocked;
    if (ec2Ready && typeof backendSocket.sendCollectWorldObject === 'function') {
        updatedInventory = await backendSocket.sendCollectWorldObject(objectId);
    } else if (cloudService.user) {
        // Transitional fallback if EC2 is unavailable
        updatedInventory = await cloudService.collectWorldObjectToCargo(objectId, cloudService.user.id);
        if (updatedInventory && Array.isArray(updatedInventory)) {
            broadcastLootRemoval(objectId);
        }
    }

    if (updatedInventory && Array.isArray(updatedInventory)) {
        const inventoryString = JSON.stringify(updatedInventory);
        if (inventoryString === this.lastInventoryString) return true;
        this.lastInventoryString = inventoryString;

        applyAuthoritativeInventory(this, updatedInventory);
        queueLootToast(this, itemData);
        return true;
    }

    return false;
}

    addBlueprintToInventory(blueprintId, blueprintData) {
        const itemWeight = 0.5;
        
        // Check for cargo capacity
        if (this.stats.currentCargoWeight + itemWeight > this.stats.cargoHold) {
            this.showNotification("CARGO HOLD FULL: Loot Abandoned", "warning");
            return false;
        }

        this.showNotification({
            type: "loot",
            name: blueprintData.name,
            rarity: blueprintData.rarity,
            size: blueprintData.size,
            itemType: "BLUEPRINT"
        });
        this.speak(`Blueprint acquisition confirmed. ${blueprintData.name} transferred to cargo hold.`);
        
        this.stats.currentCargoWeight += itemWeight;

        // Authoritative synchronization for telemetry
        const inventory = [...(this.inventory || [])];
        
        // Check for existing stack
        const existingIndex = inventory.findIndex(item => 
            item.type === 'blueprint' && 
            item.blueprintId === blueprintId && 
            item.rarity === blueprintData.rarity && 
            item.size === blueprintData.size
        );

        if (existingIndex !== -1) {
            const existing = { ...inventory[existingIndex] };
            existing.amount = (existing.amount || 1) + 1;
            existing.weight = existing.amount * itemWeight;
            inventory[existingIndex] = existing;
        } else {
            inventory.push({
                id: `blueprint-${blueprintId}-${Date.now()}`,
                blueprintId: blueprintId,
                name: blueprintData.name,
                type: 'blueprint',
                subtype: 'manufacturing-data',
                rarity: blueprintData.rarity,
                quality: 50,
                size: blueprintData.size,
                amount: 1,
                stack: 1,
                maxStack: 10,
                metadata: {},
                weight: itemWeight,
                description: `Manufacturing data for ${blueprintData.outputId}. Requires Fabrication Bay.`
            });
        }

        this.inventory = inventory;

        this.setGameState(prev => ({ 
            ...prev, 
            inventory: this.inventory, 
            currentCargoWeight: this.stats.currentCargoWeight 
        }));
        return true;
    }

onNetworkObjectSpawned(obj) {
    if (obj && obj.data && typeof obj.data === 'object') {
        obj._ownership = obj.data.ownership || obj.data.lootOwnership || null;
    }
    return this.worldObjects.onNetworkObjectSpawned(obj);
}

onNetworkObjectRemoved(objectId) {
    return this.worldObjects.onNetworkObjectRemoved(objectId);
}

handleCargoSync(data) {
    const updatedInventory = Array.isArray(data?.cargo) ? data.cargo : (Array.isArray(data?.inventory) ? data.inventory : null);
    if (!updatedInventory) return false;

    const inventoryString = JSON.stringify(updatedInventory);
    if (inventoryString === this.lastInventoryString) return true;
    this.lastInventoryString = inventoryString;

    applyAuthoritativeInventory(this, updatedInventory);
    return true;
}


handleServerNpcDamageEvent(payload) {
    try {
        const targetId = payload?.targetId;
        if (!targetId) return;
        const npc = (this.npcs || []).find(n => n.id === targetId) || (this.entities || []).find(e => e.id === targetId);
        if (!npc) return;
        if (!npc.stats) npc.stats = {};
        npc._serverApplyingDamage = true;
        if (typeof payload.hull === 'number') npc.stats.hp = payload.hull;
        if (typeof payload.maxHp === 'number') npc.stats.maxHp = payload.maxHp;
        if (typeof payload.shields === 'number') npc.stats.shields = payload.shields;
        if (typeof payload.maxShields === 'number') npc.stats.maxShields = payload.maxShields;
        if (typeof payload.x === 'number' && typeof payload.y === 'number' && npc.sprite?.position) {
            npc.sprite.position.set(payload.x, payload.y, npc.sprite.position.z || 0);
        }
        if (payload.shieldDamage > 0) this.showDamageNumber(npc, payload.shieldDamage, false, false, 'shield', npc.id);
        if (payload.hullDamage > 0) this.showDamageNumber(npc, payload.hullDamage, false, false, 'hull', npc.id);
        npc._serverApplyingDamage = false;
    } catch {}
}

handleServerNpcDestroyed(payload) {
    try {
        const targetId = payload?.targetId;
        if (!targetId) return;
        const npc = (this.npcs || []).find(n => n.id === targetId) || (this.entities || []).find(e => e.id === targetId);
        if (!npc) return;
        if (npc._serverDestroyed) return;
        npc._serverDestroyed = true;
        if (npc.stats) npc.stats.hp = 0;
        npc._serverLootAuthority = payload?.lootAuthority === 'server';
        const localId = cloudService.user?.id || backendSocket?.userId;
        const rewardOwnerId = payload?.killCreditId || payload?.attackerId;
        if (rewardOwnerId && localId && rewardOwnerId === localId && payload?.expReward > 0 && this.addExperience) {
            this.addExperience(payload.expReward);
        }
        npc._serverKillCredit = {
            killCreditId: payload?.killCreditId || null,
            killCreditType: payload?.killCreditType || null,
            finalBlowId: payload?.finalBlowId || null,
            finalBlowType: payload?.finalBlowType || null,
            assists: Array.isArray(payload?.assists) ? payload.assists : []
        };
        this.destroyTarget(npc, { skipLoot: npc._serverLootAuthority });
    } catch {}
}

handleServerAsteroidDamageEvent(payload) {
    try {
        const targetId = payload?.targetId;
        if (!targetId) return;
        const entity = (this.entities || []).find(e => e.id === targetId);
        if (!entity) return;
        if (typeof payload.oreAmount === 'number') entity.oreAmount = payload.oreAmount;
        if (typeof payload.x === 'number' && typeof payload.y === 'number' && entity.sprite?.position) {
            entity.sprite.position.set(payload.x, payload.y, entity.sprite.position.z || 0);
        }
        // Mining is extraction, not combat: keep asteroid state authoritative but do not show combat damage numbers here.
    } catch {}
}

handleServerAsteroidDepleted(payload) {
    try {
        const targetId = payload?.targetId;
        if (!targetId) return;
        const entity = (this.entities || []).find(e => e.id === targetId);
        if (!entity) return;
        entity.oreAmount = 0;
        if (this.serverMiningTargetId && this.serverMiningTargetId === targetId) {
            this.serverMiningTargetId = null;
            this.serverMiningLastStartAt = 0;
        }
        this.destroyTarget(entity);
    } catch {}
}

handleServerMiningState(payload) {
    try {
        if (!payload) return;
        const localId = cloudService.user?.id || backendSocket?.userId;
        if (payload.userId && localId && payload.userId === localId) {
            if (payload.state === 'start' && payload.targetId) {
                this.serverMiningTargetId = payload.targetId;
                this.serverMiningLastStartAt = Date.now();
            }
            if (payload.state === 'stop') {
                this.serverMiningTargetId = null;
                this.serverMiningLastStartAt = 0;
            }
        }
        if (payload.state === 'stop' && this.target && payload.targetId && this.target.id === payload.targetId && this.target.oreAmount <= 0) {
            this.target = null;
        }
    } catch {}
}

    destroyTarget(target, options = {}) {
        if (!target || target._destroyingNow) return;
        target._destroyingNow = true;
        // Courier Contract Failure on Death
        const activeContract = (this.courierContracts || []).find(c => c.haulerId === target.id && (c.status === 'active' || c.status === 'in-transit'));
        if (activeContract) {
            activeContract.status = 'failed';
            if (this.onContractFailed) this.onContractFailed(activeContract);
            console.log(`[Courier] Hauler ${target.id} destroyed. Contract ${activeContract.id} failed.`);
        }

        // Cleanup damage stacks
        if (this.damageStacks.has(target.id)) {
            const stacks = this.damageStacks.get(target.id);
            if (stacks.shield) clearTimeout(stacks.shield.timeout);
            if (stacks.hull) clearTimeout(stacks.hull.timeout);
            this.damageStacks.delete(target.id);
        }

        if (this.target === target) {
            this.target = null;
            if (this.targetReticle) {
                this.scene.remove(this.targetReticle);
                this.targetReticle = null;
            }
            // If this was our active lock, break it immediately
            if (this.locking.state === 'Locked' || this.locking.state === 'Priming') {
                this.breakLock("Target destroyed");
            }
        }
        
        if (this.locking.entity === target) {
            this.breakLock("Target destroyed");
        }
        
        if (target.sprite) {
            this.scene.remove(target.sprite);
        }

        // Cleanup from entities
        this.entities = this.entities.filter(e => e.id !== target.id);
        
        const skipLoot = !!options.skipLoot || !!target._serverLootAuthority;

        // NPC/BIO Cleanup
        if (target.type === 'NPC' || target.type === 'BIO') {
            if (target instanceof SpaceSquid) {
                this.spaceSquids = this.spaceSquids.filter(s => s.id !== target.id);
                target.destroy();
            }
            if (target.type === 'NPC') {
                if (!skipLoot) this.handleNpcLoot(target);
                this.npcs = this.npcs.filter(n => n.id !== target.id);
                // Find patrol this npc belongs to
                const patrol = this.patrols.find(p => p.npcIds.has(target.id));
                if (patrol) {
                    patrol.npcIds.delete(target.id);
                    if (patrol.npcIds.size === 0) {
                        console.log(`[GameManager] Patrol ${patrol.id} fully destroyed.`);
                        this.patrols = this.patrols.filter(p => p.id !== patrol.id);
                    }
                }
            } else {
                // Bio Cleanup and Harvesting
                if (!skipLoot) this.handleBioLoot(target);
                this.npcs = this.npcs.filter(n => n.id !== target.id);
            }
        }

        // Handle Belt Depletion
        if (target.beltId) {
            const belt = this.asteroidBelts.find(b => b.id === target.beltId);
            if (belt && !belt.depleted) {
                belt.asteroidIds.delete(target.id);
                if (belt.asteroidIds.size === 0) {
                    belt.depleted = true;
                    belt.respawnTime = Date.now() + this.systemConfig.beltRespawnTime;
                    this.showNotification(`Asteroid cluster depleted. Sensors tracking new formation.`, "info");
                }
            }
        }
    }

    updateWeaponCooldowns(dt = 0.016) {
        let changed = false;
        for (const slotId in this.weaponCooldowns) {
            if (this.weaponCooldowns[slotId] > 0) {
                this.weaponCooldowns[slotId] -= dt;
                changed = true;
            } else {
                // Hard clamp at 0 to prevent "double-firing" on the first shot due to accumulator debt
                this.weaponCooldowns[slotId] = 0;
            }
        }
        return changed;
    }

    // handleGesture is now obsolete but we'll keep it as a no-op if called
    async handleGesture() {}

    calculateFinalSigRadius(fittings) {
        if (!fittings) return this.baseShipConfig.baseSigRadius;

        let totalPenalty = 0;
        
        // Check all fittings for oversize penalties
        Object.values(fittings).forEach(module => {
            if (module) {
                const info = getOversizeInfo(this.baseShipConfig, module);
                if (info.oversized) {
                    totalPenalty += info.tierDiff * 8;
                }
            }
        });

        // Module adjustments (Placeholder for future signature-modifying modules like Shield Extenders)
        let moduleAdjustments = 0;

        const finalSig = this.baseShipConfig.baseSigRadius + totalPenalty + moduleAdjustments;
        return Math.max(10, Math.min(200, finalSig));
    }

    calculateFinalLockTime(fittings, attackerConfig = this.baseShipConfig) {
        const strength = this.getTargetingStrength(attackerConfig);
        return Math.max(300, 3000 / strength);
    }

    updateLocking() {
        if (!this.ship.sprite) return;
        const now = Date.now();

        // 1. Maintain Cooldown state
        if (this.locking.state === 'Cooldown') {
            const elapsed = now - this.locking.lastCooldownStart;
            if (elapsed >= this.locking.cooldownTime) {
                this.locking.state = 'Idle';
                this.locking.progress = 0;
            }
            return;
        }

        // 2. Handle position and range for current locks (regardless of state)
        if (this.target) {
            const target = this.target;
            if (!target || !target.sprite) {
                this.clearBackendLockState(target?.id, false);
                this.target = null;
                if (this.targetReticle) {
                    this.scene.remove(this.targetReticle);
                    this.targetReticle = null;
                }
            } else {
                const dist = this.ship.sprite.position.distanceTo(target.sprite.position);
                const effectiveDist = dist - (target.radius || 0);
                if (effectiveDist > this.stats.lockOnRange) {
                    this.clearBackendLockState(target?.id, false);
                    this.target = null;
                    if (this.targetReticle) {
                        this.scene.remove(this.targetReticle);
                        this.targetReticle = null;
                    }
                    this.showNotification("Hostile lock lost: Out of range", "warning");
                } else if (this.targetReticle) {
                    this.targetReticle.position.copy(target.sprite.position);
                }
            }
        }

        if (this.friendlyTarget) {
            const target = this.friendlyTarget;
            if (!target || !target.sprite) {
                this.clearBackendLockState(target?.id, true);
                this.friendlyTarget = null;
                if (this.friendlyReticle) {
                    this.scene.remove(this.friendlyReticle);
                    this.friendlyReticle = null;
                }
            } else {
                const dist = this.ship.sprite.position.distanceTo(target.sprite.position);
                const effectiveDist = dist - (target.radius || 0);
                if (effectiveDist > this.stats.lockOnRange) {
                    this.clearBackendLockState(target?.id, true);
                    this.friendlyTarget = null;
                    if (this.friendlyReticle) {
                        this.scene.remove(this.friendlyReticle);
                        this.friendlyReticle = null;
                    }
                    this.showNotification("Fleet lock lost: Out of range", "warning");
                } else if (this.friendlyReticle) {
                    this.friendlyReticle.position.copy(target.sprite.position);
                }
            }
        }

        // 3. Handle Priming state for new locks
        if (this.locking.state === 'Priming') {
            const target = this.locking.entity;
            if (!target || !target.sprite) {
                this.breakLock("Target lost during priming");
                return;
            }

            const dist = this.ship.sprite.position.distanceTo(target.sprite.position);
            const effectiveDist = dist - (target.radius || 0);

            if (effectiveDist > this.stats.lockOnRange) {
                this.breakLock("Target out of range during priming");
                return;
            }

            const elapsed = now - this.locking.startTime;
            const requiredTime = this.locking.requiredTime || 4000;
            this.locking.progress = Math.min(100, (elapsed / requiredTime) * 100);

            // Visual Updates for Priming
            if (this.lockingGroup) {
                this.lockingGroup.visible = true;
                this.lockingGroup.position.copy(target.sprite.position);
                this.lockingGroup.rotation.z += 0.05;
                const scale = 2.0 - (this.locking.progress / 100);
                this.lockingGroup.scale.set(scale, scale, 1);
            }

            if (this.locking.progress >= 100) {
                this.finalizeTarget(target);
            }
        } else if (this.locking.state === 'Locked') {
            // Check if we lost all targets, revert to idle if so
            if (!this.target && !this.friendlyTarget) {
                this.locking.state = 'Idle';
            }
        } else if (this.locking.state === 'Idle') {
            if (this.lockingGroup) this.lockingGroup.visible = false;
        }
    }

    breakLock(reason = "Lock broken") {
        console.log(`[LockSystem] ${reason}`);
        
        // Visual Cleanup
        if (this.lockingGroup) this.lockingGroup.visible = false;
        if (this.targetReticle) {
            this.scene.remove(this.targetReticle);
            this.targetReticle = null;
        }
        if (this.friendlyReticle) {
            this.scene.remove(this.friendlyReticle);
            this.friendlyReticle = null;
        }

        // State Cleanup
        const releasedTargetId = this.target?.id || this.friendlyTarget?.id || this.locking?.entity?.id;
        const releasedFriendly = this.friendlyTarget ? true : (this.locking?.isFriendlyLock || false);
        this.clearBackendLockState(releasedTargetId, releasedFriendly);
        this.target = null;
        this.friendlyTarget = null;
        Object.keys(this.hardpoints).forEach(slotId => {
            this.activeWeapons[slotId] = false;
        });
        
        // Transition to Cooldown
        this.locking.state = 'Cooldown';
        this.locking.lastCooldownStart = Date.now();
        this.locking.cooldownTime = 1000; // 1 second cooldown after break
        this.locking.progress = 0;
        this.locking.entity = null;
        this.locking.lastMissileFiredTime = 0;

        if (this.showNotification) {
            this.showNotification(reason, "info");
        }
    }

    updateUi(dt = 0.016) {
        const now = Date.now();
        const delta = now - this.lastUiUpdate;
        
        // We only throttle the "heavy" radar/stats update
        const shouldUpdateHeavy = delta >= 100; 

        // Update Hover Detection every frame for responsiveness
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(this.mousePos, this.camera);
        const allCandidates = [
            ...this.entities.filter(ent => ent.sprite),
            ...this.npcs.filter(n => n.sprite),
            ...Array.from(this.remotePlayers.values()).filter(player => player?.sprite)
        ];
        const sprites = allCandidates.map(ent => ent.sprite);
        const intersects = raycaster.intersectObjects(sprites);
        let foundHover = this.findHoveredPassiveStructure();
        if (!foundHover && intersects.length > 0) {
            for (const intersect of intersects) {
                const hoveredSprite = intersect.object;
                const entity = allCandidates.find(ent => ent.sprite === hoveredSprite);
                if (entity) {
                    if (entity.collisionCircles && entity.collisionCircles.length > 0) {
                        const point2d = new THREE.Vector2(intersect.point.x, intersect.point.y);
                        const hit = entity.collisionCircles.some(c => 
                            point2d.distanceTo(new THREE.Vector2(c.x, c.y)) < c.radius
                        );
                        if (hit) {
                            foundHover = entity;
                            break;
                        }
                    } else {
                        foundHover = entity;
                        break;
                    }
                }
            }
        }
        this.hoveredEntity = foundHover || null;

        // Check if target has changed or been lost
        const currentTargetId = this.target ? this.target.id : null;
        const targetChanged = currentTargetId !== this.lastTargetId;
        
        if (targetChanged) {
            this.lastTargetId = currentTargetId;
        }

        this.setGameState(prev => {
            // Detect if fittings have changed since last heavy update to force a refresh
            const fittingsChanged = JSON.stringify(prev.fittings) !== this._lastFittingsJson;
            if (fittingsChanged) {
                this._lastFittingsJson = JSON.stringify(prev.fittings);
            }

            const contextMenuChanged = this.contextMenu !== prev.contextMenu;

            // Calculate final signature based on current fittings
            const currentSig = this.calculateFinalSigRadius(prev.fittings);
            this.stats.sigRadius = currentSig;

            // If nothing meaningful changed, skip update
            if (!shouldUpdateHeavy && !fittingsChanged && !targetChanged && !contextMenuChanged && JSON.stringify(this.activeWeapons) === JSON.stringify(prev.activeWeapons)) {
                return prev;
            }

            this.syncFleetVitalsFromRuntime();

            const baseState = {
                ...prev,
                cooldowns: { ...this.weaponCooldowns },
                weaponStates: { ...this.weaponStates },
                activeWeapons: { ...this.activeWeapons },
                target: this.target,
                friendlyTarget: this.friendlyTarget,
                fleet: [...this.fleet],
                contextMenu: this.contextMenu,
                inspectingRemotePlayer: this.inspectingRemotePlayer,
                hoveredEntity: this.hoveredEntity ? { id: this.hoveredEntity.id, type: this.hoveredEntity.type, name: this.hoveredEntity.name } : null
            };

            if (shouldUpdateHeavy) {
                this.lastUiUpdate = now;
                // Calculate radar entities
                const radarRange = 3500; 
                const shipPos = this.ship.sprite ? this.ship.sprite.position : this.camera.position;
                const localSyndicateId = this.commanderStats?.syndicate_id || this.commanderStats?.syndicateId || this.stats?.commanderStats?.syndicate_id || this.stats?.commanderStats?.syndicateId || null;
                const fleetMemberIds = new Set((this.fleet || []).map(member => member?.id).filter(Boolean));
                const radarRemotePlayers = Array.from(this.remotePlayers.values()).map(player => ({
                    ...player,
                    type: 'player',
                    x: Number.isFinite(player?.sprite?.position?.x) ? player.sprite.position.x : (Number.isFinite(player?.currentPos?.x) ? player.currentPos.x : player.x),
                    y: Number.isFinite(player?.sprite?.position?.y) ? player.sprite.position.y : (Number.isFinite(player?.currentPos?.y) ? player.currentPos.y : player.y)
                })).filter(player => Number.isFinite(player.x) && Number.isFinite(player.y));

                const radarEntities = [...this.entities, ...this.npcs, ...radarRemotePlayers]
                    .map(ent => {
                        const dx = (ent.x - shipPos.x) / radarRange;
                        const dy = -(ent.y - shipPos.y) / radarRange; 
                        
                        let radarColor = '#ffffff';
                        const eType = String(ent.type || '').toLowerCase();
                        if (eType === 'player') {
                            const sameFleet = fleetMemberIds.has(ent.id);
                            const entSyndicateId = ent.syndicateId || ent.syndicate_id || ent.commanderStats?.syndicate_id || ent.commanderStats?.syndicateId || ent.stats?.syndicate_id || ent.stats?.syndicateId || null;
                            const sameSyndicate = !!localSyndicateId && !!entSyndicateId && String(localSyndicateId) === String(entSyndicateId);
                            radarColor = (sameFleet || sameSyndicate) ? '#00ff66' : '#ffffff';
                        } else if (eType === 'starport') {
                            radarColor = '#00ccff';
                        } else if (eType === 'anomaly') {
                            radarColor = '#cc00ff'; // Match anomaly purple
                        } else if (ent.faction === 'Crimson Rift Cartel') {
                            radarColor = '#ff0000';
                        } else if (ent.isBio) {
                            radarColor = '#00ff88'; // Bioluminescent green for bios
                        }
                        return { x: dx, y: dy, color: radarColor };
                    })
                    .filter(ent => Math.sqrt(ent.x * ent.x + ent.y * ent.y) <= 1);

                const currentSystem = resolveSystemDefinition(this.currentSystemId);

                return {
                    ...baseState,
                    shipName: this.stats.name,
                    shipClass: SHIP_REGISTRY[this.stats.name]?.classId || 'Unknown',
                    shields: this.stats.shields,
                    maxShields: this.stats.maxShields,
                    hp: this.stats.hp,
                    maxHp: this.stats.maxHp,
                    energy: this.stats.energy,
                    maxEnergy: this.stats.maxEnergy,
                    maxPowerGrid: this.baseShipConfig.basePG,
                    maxCpu: this.baseShipConfig.baseCPU,
                    armor: this.stats.armor,
                    kineticRes: this.stats.kineticRes,
                    thermalRes: this.stats.thermalRes,
                    blastRes: this.stats.blastRes,
                    reactorRecovery: this.stats.reactorRecovery,
                    shieldRegen: this.stats.shieldRegen || 0,
                    maxSpeed: this.ship.maxSpeed,
                    turnSpeed: this.ship.turnSpeed,
                    jumpWarmupTime: (this.stats.jumpWarmupTime || 7000) / 1000,
                    scanRange: this.stats.scanRange,
                    scanTime: this.stats.scanTime / 1000,
                    scanSpeed: this.stats.scanSpeed,
                    targetingStrength: this.stats.targetingStrength,
                    lockOnRange: this.stats.lockOnRange,
                    lockOnTime: this.stats.lockOnTime / 1000,
                    sigRadius: this.stats.sigRadius,
                    brakingForce: this.stats.brakingForce,
                    thrustImpulse: this.stats.thrustImpulse,
                    radarEntities: radarEntities,
                    cargoHold: this.stats.cargoHold,
                    cargoMaxVolume: this.stats.cargoMaxVolume,
                    currentCargoWeight: this.stats.currentCargoWeight,
                    currentCargoVolume: this.stats.currentCargoVolume,
                    oreAmount: this.stats.oreAmount || 0,
                    aurelliteAmount: this.stats.aurelliteAmount || 0,
                    pyroxiteAmount: this.stats.pyroxiteAmount || 0,
                    scanning: { ...this.scanning },
                    locking: { ...this.locking },
                    scannedEntities: Array.from(this.scannedEntities),
                    jumpDrive: { ...this.jumpDrive },
                    currentSystem: {
                        id: this.currentSystemId,
                        name: currentSystem.name,
                        sector: currentSystem.sector,
                        security: currentSystem.security,
                        securityValue: currentSystem.securityValue
                    },
                    asteroidBelts: this.asteroidBelts
                        .filter(b => !b.depleted)
                        .map(b => ({ id: b.id, name: b.name, x: b.center.x, y: b.center.y })),
                    courierContracts: [...this.courierContracts],
                    ownedShips: prev.ownedShips.map(ship => 
                        ship.id === prev.activeShipId ? { ...ship, hp: this.stats.hp / (1 + (this.currentHpBonus || 0)), energy: this.stats.energy } : ship
                    )
                };
            }

            return baseState;
        });
    }

    updateScanning() {
        if (!this.scanning.active || !this.ship.sprite) {
            if (this.scanRingsGroup) this.scanRingsGroup.visible = false;
            // Clean up rings when scan ends
            this.activeRings.forEach(r => this.scanRingsGroup.remove(r.mesh));
            this.activeRings = [];
            return;
        }

        const now = Date.now();
        const elapsed = now - this.scanning.startTime;
        
        // Surveying takes 3x the standard scan time
        const totalScanTime = Number(this.scanning.totalTimeMs || this.computeScanTime(this.baseShipConfig, this.scanning.entity, this.scanning.isSurvey));
        this.scanning.progress = Math.min(100, (elapsed / totalScanTime) * 100);

        if (this.scanning.entity) {
            this.scanRingsGroup.visible = true;
            const start = this.ship.sprite.position;
            const end = this.scanning.entity.sprite.position;
            
            // Check if still in range
            const effectiveDist = start.distanceTo(end) - (this.scanning.entity.radius || 0);
            if (effectiveDist > this.stats.scanRange) {
                this.scanning.active = false;
                return;
            }

            // Spawn a new ring periodically (every 600ms)
            if (!this._lastRingSpawn || now - this._lastRingSpawn > 600) {
                const mesh = new THREE.Mesh(this.ringGeometry, this.ringMaterial.clone());
                mesh.position.copy(end);
                mesh.renderOrder = 25;
                this.scanRingsGroup.add(mesh);
                this.activeRings.push({
                    mesh: mesh,
                    startTime: now,
                    life: 1.0
                });
                this._lastRingSpawn = now;

                // Play Scanner Sonar Chirp
                if (this.scannerSynth) {
                    try {
                        // High resonant chirp that descends slightly
                        this.scannerSynth.triggerAttackRelease("G5", "32n", Tone.now());
                        this.scannerSynth.triggerAttackRelease("C5", "16n", Tone.now() + 0.05);
                    } catch (e) { /* audio scheduling safety */ }
                }
            }

            // Update all active rings
            const ringDuration = 1500; // Each ring lasts 1.5s
            const maxScale = 200;
            for (let i = this.activeRings.length - 1; i >= 0; i--) {
                const ring = this.activeRings[i];
                const ringElapsed = now - ring.startTime;
                const t = ringElapsed / ringDuration;

                if (t >= 1) {
                    this.scanRingsGroup.remove(ring.mesh);
                    this.activeRings.splice(i, 1);
                    continue;
                }

                const currentScale = t * maxScale;
                ring.mesh.scale.set(currentScale, currentScale, 1);
                ring.mesh.material.opacity = (1 - t) * 0.6;
            }
        }

        if (this.scanning.progress >= 100) {
            const entity = this.scanning.entity;
            const wasSurvey = this.scanning.isSurvey;
            
            if (wasSurvey) {
                this.completeSurvey(entity);
            } else {
                this.scannedEntities.add(entity.id);
                this.scanning.active = false;
                
                // Scan Completion Chime
                if (this.scannerSynth) {
                    try {
                        this.scannerSynth.triggerAttackRelease("C6", "8n", Tone.now());
                        this.scannerSynth.triggerAttackRelease("E6", "8n", Tone.now() + 0.1);
                    } catch (e) { /* audio scheduling safety */ }
                }

                this.speak("Signal decoded. Landmark data added to tactical overview.");
                this.showNotification("SCAN COMPLETE: Landmark Profile Acquired", "success");
            }
        }
    }

    completeSurvey(entity) {
        this.scanning.active = false;
        
        // Survey Completion Chime
        if (this.scannerSynth) {
            try {
                this.scannerSynth.triggerAttackRelease("E6", "8n", Tone.now());
                this.scannerSynth.triggerAttackRelease("G6", "8n", Tone.now() + 0.1);
                this.scannerSynth.triggerAttackRelease("C7", "4n", Tone.now() + 0.2);
            } catch (e) { /* audio scheduling safety */ }
        }

        // Generate Flux Catalyst loot
        const count = Math.floor(this.rng.next() * 2) + 1; // 1 or 2
        const systemId = this.currentSystemId;
        const system = resolveSystemDefinition(systemId);
        const security = system?.securityValue ?? 1.0;

        // Group catalysts by rarity for selection
        const catalystsByRarity = {};
        Object.entries(FLUX_CATALYSTS).forEach(([key, data]) => {
            const r = data.rarity.toLowerCase();
            if (!catalystsByRarity[r]) catalystsByRarity[r] = [];
            catalystsByRarity[r].push({ ...data, catalystId: data.id, type: 'catalyst' });
        });

        for (let i = 0; i < count; i++) {
            const rarityTier = this.calculateFluxRarity(security);
            const pool = catalystsByRarity[rarityTier] || catalystsByRarity['common'];
            const chosen = pool[Math.floor(this.rng.next() * pool.length)];
            
            this.spawnLoot({
                ...chosen,
                id: `loot-${Date.now()}-${i}-${Math.floor(this.rng.next()*1000)}`
            }, entity.sprite.position.clone().add(new THREE.Vector3((this.rng.next()-0.5)*50, (this.rng.next()-0.5)*50, 0)));
        }

        this.speak("Survey complete. Anomaly stabilized. Flux catalysts detected in nearby space.");
        this.showNotification("SURVEY COMPLETE: Flux Catalysts Recovered", "success");

        // Schedule respawn (5-10 minutes)
        const respawnDelay = (5 + this.rng.next() * 5) * 60 * 1000;
        this.anomalyRespawnQueue.push({
            systemId: systemId,
            respawnTime: Date.now() + respawnDelay
        });

        // Track system counts
        if (this.systemAnomalyCounts[systemId]) {
            this.systemAnomalyCounts[systemId]--;
        }

        // Remove from simulation
        if (entity.sprite) {
            this.scene.remove(entity.sprite);
        }
        
        this.entities = this.entities.filter(e => e.id !== entity.id);
        this.asteroidBelts = this.asteroidBelts.filter(b => b.id !== entity.id);
        
        if (this.target && this.target.id === entity.id) {
            this.target = null;
            if (this.targetReticle) {
                this.scene.remove(this.targetReticle);
                this.targetReticle = null;
            }
        }
    }

    spawnAnomaly(systemId) {
        let system = SYSTEMS_REGISTRY[systemId] || getSyntheticSystem(systemId);
        const isArenaInstance = String(systemId).startsWith("arena:");
        const isBattlegroundInstance = String(systemId).startsWith("bg:pve:");
        if (isArenaInstance || isBattlegroundInstance) {
            console.log("[Arena] Loading arena instance:", systemId);
            system = {
                ...(system || {}),
                name: isArenaInstance ? "Arena" : "Battleground",
                cluster: "instance",
                sector: isArenaInstance ? "ARENA" : "BATTLEGROUND",
                security: isArenaInstance ? "Open Conflict (0.0)" : "Controlled Combat Space",
                securityValue: 0.0,
                nebulaTypes: isBattlegroundInstance ? [] : ["blue", "purple"],
                nebulaCount: isBattlegroundInstance ? 0 : 12,
                hasStarport: false,
                hasWarpGate: false,
                belts: [],
                anomaly: null,
                controlledBy: isArenaInstance ? 'OMNI DIRECTORATE COMBAT NETWORK' : 'OMNI DIRECTORATE TACTICAL COMMAND'
            };
            this.isArenaInstance = isArenaInstance;
            this.worldBounds = { minX: -2000, maxX: 2000, minY: -2000, maxY: 2000 };
            this.setInstanceMusicMode(isArenaInstance ? 'arena' : 'battleground');
        } else {
            this.isArenaInstance = false;
            this.worldBounds = null;
        }
        if (!system) return;

        const starportPos = new THREE.Vector3(0, 0, 0); 
        const minDistanceFromStarport = 3000; // Increased from 1500
        const minDistanceFromOthers = 2000; // New proximity check
        
        let validPos = false;
        let x, y;
        let attempts = 0;

        while (!validPos && attempts < 25) {
            // Spawn anomalies within a wider range for exploration
            const dist = 2000 + this.rng.next() * 8000; 
            const angle = this.rng.next() * Math.PI * 2;
            x = Math.cos(angle) * dist;
            y = Math.sin(angle) * dist;

            const pos = new THREE.Vector3(x, y, 0);
            
            // Check distance from starport
            const distToStarport = pos.distanceTo(starportPos);
            
            // Check distance from other existing anomalies in this system
            const otherAnomalies = this.entities.filter(e => e.type === 'anomaly');
            const tooCloseToOther = otherAnomalies.some(a => {
                const aPos = new THREE.Vector3(a.x, a.y, 0);
                return pos.distanceTo(aPos) < minDistanceFromOthers;
            });

            if (distToStarport > minDistanceFromStarport && !tooCloseToOther) {
                validPos = true;
            }
            attempts++;
        }

        const anomalyId = `anomaly-${systemId}-${Date.now()}-${Math.floor(this.rng.next() * 1000)}`;
        
        // Create specialized mesh for this anomaly (cloning the material for unique pulsing)
        const anomalyMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            this.anomalySprite.material.clone()
        );
        
        const baseSize = 350 + this.rng.next() * 200;
        anomalyMesh.position.set(x, y, -10);
        anomalyMesh.scale.set(baseSize, baseSize, 1);
        anomalyMesh.renderOrder = 5;
        
        // Data for internal update tracking
        const anomalyData = {
            id: anomalyId,
            name: 'VORTEX ANOMALY',
            type: 'anomaly',
            x: x,
            y: y,
            size: baseSize,
            sprite: anomalyMesh,
            pulseTimer: this.rng.next() * 10,
            factor: 0, // STATIONARY: Matches radar dots perfectly
            basePos: new THREE.Vector3(x, y, -10)
        };

        this.entities.push(anomalyData);
        
        // Only add to scene if we are currently in this system
        if (systemId === this.currentSystemId) {
            this.scene.add(anomalyMesh);
        }

        if (!this.systemAnomalyCounts[systemId]) this.systemAnomalyCounts[systemId] = 0;
        this.systemAnomalyCounts[systemId]++;

        return anomalyData;
    }

    updateAnomalyRespawning(dt) {
        const now = Date.now();
        for (let i = this.anomalyRespawnQueue.length - 1; i >= 0; i--) {
            const task = this.anomalyRespawnQueue[i];
            if (now >= task.respawnTime) {
                this.spawnAnomaly(task.systemId);
                this.anomalyRespawnQueue.splice(i, 1);
            }
        }

        // Also update anomaly visuals (pulsing)
        this.entities.forEach(e => {
            if (e.type === 'anomaly' && e.sprite) {
                e.pulseTimer += dt * 0.5;
                const pulse = 1.0 + Math.sin(e.pulseTimer) * 0.05;
                e.sprite.scale.set(e.size * pulse, e.size * pulse, 1);
                
                // Update position (Parallax)
                if (e.sprite.visible) {
                    // Stationary if factor is 0, parallax otherwise
                    e.sprite.position.x = this.camera.position.x * e.factor + e.basePos.x;
                    e.sprite.position.y = this.camera.position.y * e.factor + e.basePos.y;
                    
                    // Update entity world coordinates for radar/targeting
                    e.x = e.sprite.position.x;
                    e.y = e.sprite.position.y;
                }

                if (e.sprite.material.uniforms) {
                    e.sprite.material.uniforms.uTime.value = e.pulseTimer;
                }
            }
        });
    }

    calculateFluxRarity(security) {
        // Curve: mostly commons up to 0.5 then increases significantly to 0.0
        const roll = this.rng.next();
        
        // Normalize: 0.0 (safe) to 1.0 (dangerous/null)
        const danger = 1.0 - security;

        if (security > 0.5) {
            // High Sec: Mostly Common, tiny chance of Uncommon
            if (roll < 0.15) return 'uncommon';
            return 'common';
        }

        // Low/Null Sec Logic
        // At 0.0 security (danger 1.0):
        // Very Rare: ~15%, Rare: ~35%, Uncommon: ~35%, Common: ~15%
        const veryRareChance = Math.pow(danger, 4) * 0.15;
        const rareChance = Math.pow(danger, 2) * 0.35;
        const uncommonChance = danger * 0.45;

        if (roll < veryRareChance) return 'very_rare';
        if (roll < veryRareChance + rareChance) return 'rare';
        if (roll < veryRareChance + rareChance + uncommonChance) return 'uncommon';
        return 'common';
    }

    scheduleHostileJumpOut(delayMs = 10000) {
        if (this._jumpOutTimer) clearTimeout(this._jumpOutTimer);
        
        this._jumpOutTimer = setTimeout(() => {
            if (!this.patrols || this.patrols.length === 0) return;
            
            console.log(`[GameManager] Player destroyed. Hostile patrols jumping out.`);
            this.showNotification("Hostile signatures jumping out of sector.", "info");
            
            // Create a copy since we modify the arrays during iteration
            const activePatrols = [...this.patrols];
            activePatrols.forEach(patrol => {
                const patrolNpcs = this.npcs.filter(n => patrol.npcIds.has(n.id));
                
                patrolNpcs.forEach(npc => {
                    if (npc.sprite) {
                        // Visual effect at NPC position
                        this.createWarpOutEffect(npc.sprite.position);
                        
                        // Cleanup entity
                        this.scene.remove(npc.sprite);
                        if (npc.sprite.material) npc.sprite.material.dispose();
                        this.npcs = this.npcs.filter(n => n.id !== npc.id);
                        this.entities = this.entities.filter(e => e.id !== npc.id);
                    }
                });
                
                this.patrols = this.patrols.filter(p => p.id !== patrol.id);
            });
            
            this._jumpOutTimer = null;
        }, delayMs);
    }

    triggerShipExplosion() {
        if (!this.ship || !this.ship.sprite) return;

        // Immediately hide ship and anchored visuals
        this.ship.sprite.visible = false;
        if (this.nameSprite) this.nameSprite.visible = false;
        if (this.shieldMesh) this.shieldMesh.visible = false;
        if (this.shipFlare) this.shipFlare.visible = false;
        if (this.engineFlares) {
            this.engineFlares.forEach(f => {
                f.group.visible = false;
                f.glow.material.opacity = 0;
            });
        }

        const explosionPos = this.ship.sprite.position.clone();
        const shipColor = 0xffcc00; // Bright fiery explosion
        
        // Intensity and count for full ship explosion
        const particleCount = 200; 
        
        for (let i = 0; i < particleCount; i++) {
            const p = this.createOreParticle(explosionPos, shipColor);
            p.velocity.set(
                (this.rng.next() - 0.5) * 15,
                (this.rng.next() - 0.5) * 15
            );
            p.rotationSpeed = (this.rng.next() - 0.5) * 0.4;
            
            // Override the default fade behavior for the explosion
            const duration = 120 + this.rng.next() * 60;
            let frames = 0;
            
            const animateParticle = () => {
                frames++;
                const t = frames / duration;
                
                if (t >= 1) {
                    this.scene.remove(p.sprite);
                    p.sprite.material.dispose();
                    return;
                }

                p.sprite.position.add(p.velocity);
                p.sprite.material.opacity = 1 - t;
                p.sprite.material.rotation += p.rotationSpeed;
                p.velocity.multiplyScalar(0.98); // Slight deceleration
                
                requestAnimationFrame(animateParticle);
            };
            
            animateParticle();
        }

        // Add a bright central flash
        const flashTex = this.createParticleTexture();
        const flashMat = new THREE.SpriteMaterial({
            map: flashTex,
            transparent: true,
            opacity: 1,
            blending: THREE.AdditiveBlending,
            color: 0xffffff
        });
        const flash = new THREE.Sprite(flashMat);
        flash.position.copy(explosionPos);
        flash.scale.set(300, 300, 1);
        this.scene.add(flash);

        let flashFrames = 0;
        const animateFlash = () => {
            flashFrames++;
            const t = flashFrames / 30;
            if (t >= 1) {
                this.scene.remove(flash);
                flashMat.dispose();
                return;
            }
            flash.scale.set(300 * (1 + t), 300 * (1 + t), 1);
            flash.material.opacity = 1 - t;
            requestAnimationFrame(animateFlash);
        };
        animateFlash();

        // NOTE: We intentionally DO NOT remove/null the ship sprite or name tag here.
        // Keeping the sprite object alive prevents the main update loop from early-returning,
        // so the player can spectate the battle while destroyed UI is up.
        // The ship is already hidden above via `.visible = false`.
    }

    takeDamage(amount, type = 'kinetic', worldImpactPos = null) {
        if (amount <= 0 || !this.ship?.sprite || this.isDocked) return { shieldDamage: 0, hullDamage: 0 };

        const authorityActive =
            !!backendSocket &&
            !!backendSocket.socket &&
            backendSocket.socket.readyState === WebSocket.OPEN &&
            !backendSocket.isDocked;

        // Read current vitals but do NOT mutate them unless we are offline.
        let shieldsNow = Number(this.stats?.shields ?? 0);
        let hpNow = Number(this.stats?.hp ?? 0);

        if (!Number.isFinite(shieldsNow)) shieldsNow = 0;
        if (!Number.isFinite(hpNow)) hpNow = 0;

        let shieldDamage = 0;
        let hullDamage = 0;

        // Damage first hits shields (compute against local snapshot)
        if (shieldsNow > 0) {
            // Apply Resistance
            let res = 0;
            if (type === 'kinetic') res = this.stats.kineticRes || 0;
            if (type === 'thermal') res = this.stats.thermalRes || 0;
            if (type === 'blast') res = this.stats.blastRes || 0;
            if (type === 'energy') res = this.stats.thermalRes || 0;

            const reducedDamage = amount * (1 - res);
            shieldDamage = Math.min(shieldsNow, reducedDamage);
            shieldsNow -= shieldDamage;

            const baseDamageUsed = shieldDamage / (1 - res);
            amount -= baseDamageUsed;

            // Trigger local ripple immediately only when not using EC2 authority.
            // Under EC2, the authoritative DAMAGE_EVENT will play the ripple once.
            if (!authorityActive) {
                this.triggerShieldImpact(this.ship, worldImpactPos);
            }
// Broadcast shield impact so other clients can play the *same* impact ripple (does not change shield shell)
try {
    const shipPos = this.ship?.sprite?.position || new THREE.Vector3(0, 0, 0);
    const impact = (worldImpactPos && Number.isFinite(worldImpactPos.x) && Number.isFinite(worldImpactPos.y))
        ? worldImpactPos
        : shipPos;

    const angle = Math.atan2((impact.y - shipPos.y), (impact.x - shipPos.x));

    // Send visual-only shield impact to EC2 so other clients can play the same ripple.
    // (Does NOT change your shield turtle-shell idle effect.)
    try {
        if (typeof backendSocket !== 'undefined' && backendSocket?.sendFxEvent) {
            backendSocket.sendFxEvent({
                fx_type: 'shield_impact',
                x: impact.x,
                y: impact.y,
                angle
            });
        }
    } catch (e) {}
} catch (e) {}

            // Visual/Audio Feedback for shield hit
            if (this.synth) {
                try { this.synth.triggerAttackRelease("A2", "16n", Tone.now()); } catch (e) {}
            }
        }

        // Remaining damage hits Hull (compute against local snapshot)
        if (amount > 0) {
            this.lastHitTime = Date.now();
            const hullDmg = amount * (1 - (this.stats.armor || 0.15));
            hullDamage = hullDmg;
            hpNow = Math.max(0, hpNow - hullDmg);

            // Visual/Audio Feedback for hull hit
            if (this.synth) {
                try { this.synth.triggerAttackRelease("C2", "8n", Tone.now()); } catch (e) {}
            }
        }

        // ✅ EC2 is the ONLY source of truth for vitals while in space.
        // We report the already-computed deltas; EC2 applies & persists, then sends DAMAGE_EVENT.
        if (authorityActive && (shieldDamage > 0 || hullDamage > 0)) {
            try {
                if (backendSocket.sendSelfDamage) {
                    backendSocket.sendSelfDamage({
                        hullDamage,
                        shieldDamage,
                        source: "environment",
                        reason: type || "collision"
                    });
                }
            } catch (e) {}
            return { shieldDamage, hullDamage };
        }

        // Offline / no EC2: apply locally (legacy behavior)
        if (shieldDamage > 0) this.stats.shields = Math.max(0, (this.stats.shields || 0) - shieldDamage);
        if (hullDamage > 0) this.stats.hp = Math.max(0, (this.stats.hp || 0) - hullDamage);

        // Ship Destruction Trigger (local-only)
        if (this.stats.hp <= 0) {
            this.triggerShipExplosion();
            if (this.onShipDestroyed) this.onShipDestroyed();
            this.scheduleHostileJumpOut(10000);
        }

        return { shieldDamage, hullDamage };
    }


    applyDirectDamage(target, amount, type = 'kinetic') {
        if (!target) return;
        
        let shieldDealt = 0;
        let hullDealt = 0;

        if (target === this.ship || target.id === 'player-ship') {
            const res = this.takeDamage(amount, type);
            shieldDealt = res.shieldDamage;
            hullDealt = res.hullDamage;
            
            if (shieldDealt > 0) this.showDamageNumber(this.ship, shieldDealt, false, false, 'shield', 'player');
            if (hullDealt > 0) this.showDamageNumber(this.ship, hullDealt, false, false, 'hull', 'player');
        } else if (target.type === 'NPC' || target.type === 'BIO') {
            const res = this.applyDamageToNpc(target, amount, type);
            shieldDealt = res.shieldDamage;
            hullDealt = res.hullDamage;
            
            if (shieldDealt > 0) this.showDamageNumber(target, shieldDealt, false, false, 'shield', target.id);
            if (hullDealt > 0) this.showDamageNumber(target, hullDealt, false, false, 'hull', target.id);
        }

        // Target Flash
        if (target.sprite && target.sprite.material && target.sprite.material.color && (shieldDealt > 0 || hullDealt > 0)) {
            const originalColor = target.sprite.material.color.clone();
            target.sprite.material.color.set(0xffffff);
            setTimeout(() => {
                if (target.sprite && target.sprite.material && target.sprite.material.color) {
                    target.sprite.material.color.copy(originalColor);
                }
            }, 50);
        }
    }

    applyAoEDamage(position, radius, damage, type = 'blast', excludeId = null) {
        const source = excludeId ? this.npcs.find(n => n.id === excludeId) : null;
        const isBioSource = source?.isBio;

        // 1. Check Player
        if (this.ship && this.ship.sprite && excludeId !== 'player') {
            const shipPos = this.ship.sprite.position;
            const distToPlayer = position.distanceTo(shipPos);
            if (distToPlayer < radius) {
                const falloff = 1.0 - (distToPlayer / radius);
                this.applyDirectDamage(this.ship, damage * falloff, type);
            }
        }

        // 2. Check NPCs (including BIO)
        this.npcs.forEach(npc => {
            if (!npc.sprite || npc.id === excludeId) return;
            
            // Friendly fire prevention: BIO creatures do not damage other BIO creatures
            if (isBioSource && npc.isBio) return;

            const dist = position.distanceTo(npc.sprite.position);
            if (dist < radius) {
                const falloff = 1.0 - (dist / radius);
                this.applyDirectDamage(npc, damage * falloff, type);
            }
        });
    }

    handleCollisions() {
        if (!this.ship.sprite) return;
        const shipPos = this.ship.sprite.position;
        const shipRadius = this.ship.collisionRadius || 20; 

        // 1. Check persistent Ink Clouds
        const now = Date.now();
        for (let i = this.inkClouds.length - 1; i >= 0; i--) {
            const cloud = this.inkClouds[i];
            if (now > cloud.expiry) {
                this.scene.remove(cloud.sprite);
                cloud.material.dispose();
                cloud.texture.dispose();
                this.inkClouds.splice(i, 1);
                continue;
            }

            const dist = shipPos.distanceTo(cloud.sprite.position);
            if (dist < shipRadius + cloud.radius) {
                this.triggerGasCloudEffect(shipPos);
                
                // Damage based on cloud type
                const baseDamage = cloud.isLava ? 8.0 : 1.5; 
                this.takeDamage(baseDamage);
                
                if (Math.random() < 0.02) {
                    const msg = cloud.isLava ? "DANGER: HIGH-TEMPERATURE BIOLOGICAL EFFLUENT" : "CAUTION: ENTERING RESIDUAL BIOLOGICAL INK TRAIL";
                    this.showNotification(msg, "warning");
                }
            }
        }

        // 2. Combined collision check for entities, NPCs, and other players
        const remotePlayersArray = Array.from(this.remotePlayers.values());
        const collisionTargets = [...this.entities, ...this.npcs, ...remotePlayersArray];
        for (const entity of collisionTargets) {
            if (!entity.sprite) continue; // Safety check for loading models
            const entityRadius = entity.radius || entity.collisionRadius;
            if (!entityRadius || entity.id === 'player-ship' || entity.noCollision) continue;

            // Broad phase check
            const dist = shipPos.distanceTo(entity.sprite.position);
            const minDist = shipRadius + entityRadius;

            if (dist < minDist) {
                // --- GAS CLOUD BEHAVIOR ---
                if (entity.isGasCloud) {
                    // Bio-creatures release light blue corrosive gas based on BROAD radius
                    this.triggerGasCloudEffect(shipPos);
                    
                    // Fixed tick damage (approx 120 damage per second at 60fps)
                    const damagePerFrame = 2.0; 
                    this.takeDamage(damagePerFrame);
                    
                    // Show small notification if first frame of damage
                    if (Math.random() < 0.05) {
                        this.showNotification("DANGER: CORROSIVE BIOLOGICAL AGENTS DETECTED", "warning");
                    }
                    
                    // No rebound or spine check for gas clouds
                    continue; 
                }

                // If the entity has specialized collision circles (like SpaceSquid), check those
                let collisionDetected = false;
                let collisionPoint = entity.sprite.position;
                let finalMinDist = minDist;
                let finalDist = dist;

                if (entity.collisionCircles && entity.collisionCircles.length > 0) {
                    for (const circle of entity.collisionCircles) {
                        const circlePos = new THREE.Vector2(circle.x, circle.y);
                        const d = new THREE.Vector2(shipPos.x, shipPos.y).distanceTo(circlePos);
                        const md = shipRadius + circle.radius;
                        if (d < md) {
                            collisionDetected = true;
                            collisionPoint = new THREE.Vector3(circle.x, circle.y, 0);
                            finalMinDist = md;
                            finalDist = d;
                            break;
                        }
                    }
                } else {
                    collisionDetected = true;
                }

                if (!collisionDetected) continue;

                // Collision detected!
                const speed = this.ship.velocity.length();
                
                // Calculate damage based on speed
                const damageFactor = 35.0; 
                const damage = speed * damageFactor;
                
                const dmgResult = this.takeDamage(damage, 'kinetic', collisionPoint);
                // EC2 combat authority: do not spawn local collision damage numbers here.
                // The authoritative DAMAGE_EVENT will drive the final local numbers/UI once.

                // Collision should still trigger immediate local shield hit feedback when shields absorb damage.
                if (dmgResult && Number(dmgResult.shieldDamage || 0) > 0) {
                    this.triggerShieldImpact(this.ship, collisionPoint);
                }

                // If colliding with a remote player, trigger their shield impact too
                if (this.remotePlayers.has(entity.id)) {
                    this.triggerShieldImpact(entity, collisionPoint);
                }

                if (!this.ship.sprite) return;

                // Rebound Physics using the specific collision point
                let reboundDir = new THREE.Vector2()
                    .subVectors(
                        new THREE.Vector2(shipPos.x, shipPos.y),
                        new THREE.Vector2(collisionPoint.x, collisionPoint.y)
                    );
                
                if (reboundDir.length() < 0.1) {
                    // If ship is perfectly on center, push randomly
                    reboundDir.set(Math.random() - 0.5, Math.random() - 0.5).normalize();
                } else {
                    reboundDir.normalize();
                }
                
                // Push ship out of collision to prevent sticking
                const overlap = finalMinDist - finalDist;
                // Add a slightly stronger push (1.5) to ensure we don't get stuck
                this.ship.sprite.position.x += reboundDir.x * (overlap + 1.5);
                this.ship.sprite.position.y += reboundDir.y * (overlap + 1.5);

                // Reflect and dampen velocity
                this.ship.velocity.copy(reboundDir.multiplyScalar(speed * 0.4));
                // ⭐ SEND TELEMETRY ⭐ 
              this.backendSocket.sendTelemetry({
    type: "TELEMETRY",

    player_id: this.playerId,
    ship_id: this.ship.id,
    system_id: this.currentSystemId,

    x: this.ship.sprite.position.x,
    y: this.ship.sprite.position.y,
    rot: this.ship.rotation,

    vx: this.ship.velocity.x,
    vy: this.ship.velocity.y,

    hp: this.stats.hp,
    maxHp: this.stats.maxHp,

    shields: this.stats.shields,
    maxShields: this.stats.maxShields,

    energy: this.stats.energy,
    maxEnergy: this.stats.maxEnergy,

    timestamp: Date.now()
});

            }
        }
    }

    createInkCloud(pos, radius, duration = 10000) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        // Darker, "inky" blue for the trail
        grad.addColorStop(0, 'rgba(0, 80, 180, 0.4)');
        grad.addColorStop(0.5, 'rgba(0, 40, 100, 0.15)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ 
            map: tex, 
            transparent: true, 
            blending: THREE.NormalBlending, // Normal blending for a "thick" ink look
            opacity: 0.6
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        sprite.scale.set(radius * 2, radius * 2, 1);
        sprite.renderOrder = 9; // Just behind the creature
        this.scene.add(sprite);

        this.inkClouds.push({
            sprite: sprite,
            material: mat,
            texture: tex,
            radius: radius,
            expiry: Date.now() + duration
        });
    }

    createLavaCloud(pos, radius, duration = 12000) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        // Fiery, glowing orange/red for biological "lava"
        grad.addColorStop(0, 'rgba(255, 100, 0, 0.6)');
        grad.addColorStop(0.4, 'rgba(200, 40, 0, 0.3)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ 
            map: tex, 
            transparent: true, 
            blending: THREE.AdditiveBlending, // Additive for glowing effect
            opacity: 0.8
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        sprite.scale.set(radius * 2, radius * 2, 1);
        sprite.renderOrder = 11; // Slightly above creatures for visibility
        this.scene.add(sprite);

        // Reuse inkClouds array for collision handling but with a 'lava' tag or just higher damage
        this.inkClouds.push({
            sprite: sprite,
            material: mat,
            texture: tex,
            radius: radius,
            expiry: Date.now() + duration,
            isLava: true
        });
    }

    triggerBroodmotherPhase(npc, threshold) {
        const percent = Math.floor(threshold * 100);
        this.showNotification(`CRITICAL ALERT: Broodmother Integrity at ${percent}% - Biological Eruption Detected!`, "warning");
        this.speak(`Warning. Substantial biological venting detected from target. Environmental hazards increasing.`);

        // 1. Create a ring of "Lava" (Fiery Bio-venting)
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const dist = 100 + Math.random() * 200;
            const lavaPos = new THREE.Vector3(
                npc.sprite.position.x + Math.cos(angle) * dist,
                npc.sprite.position.y + Math.sin(angle) * dist,
                0
            );
            this.createLavaCloud(lavaPos, 80 + Math.random() * 40, 15000 + Math.random() * 5000);
        }

        // 2. Spawn reinforcements
        const system = resolveSystemDefinition(this.currentSystemId);
        const security = system?.securityValue || 1.0;
        const powerMult = 1.0 + (1.0 - security) * 0.8;
        
        const spawnCount = threshold === 0.25 ? 8 : 5; // More on final phase
        for (let i = 0; i < spawnCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = npc.radius + 100 + Math.random() * 100;
            const px = npc.x + Math.cos(angle) * dist;
            const py = npc.y + Math.sin(angle) * dist;
            this.spawnSingleBioCreature('Star-Eater Larva', px, py, angle, powerMult, { isAggravated: true });
        }

        if (this.createBioPulseEffect) {
            this.createBioPulseEffect(npc.sprite.position, npc.radius * 3);
        }
    }

    triggerGasCloudEffect(pos) {
        // Throttled effect: only spawn particles every few frames to prevent sprite saturation
        if (Math.random() > 0.15) return;

        // Create 1-2 light blue particles around the player
        for (let i = 0; i < 1; i++) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            grad.addColorStop(0, 'rgba(100, 200, 255, 0.4)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 64, 64);

            const tex = new THREE.CanvasTexture(canvas);
            const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending });
            const sprite = new THREE.Sprite(mat);
            
            // Random offset around position
            sprite.position.set(
                pos.x + (Math.random() - 0.5) * 50,
                pos.y + (Math.random() - 0.5) * 50,
                5 // Front of ship
            );
            
            const baseSize = 30 + Math.random() * 40;
            sprite.scale.set(baseSize, baseSize, 1);
            sprite.renderOrder = 45;
            this.scene.add(sprite);

            const duration = 1000 + Math.random() * 1000;
            const start = Date.now();
            const vx = (Math.random() - 0.5) * 0.5;
            const vy = (Math.random() - 0.5) * 0.5;

            const animate = () => {
                const age = Date.now() - start;
                const t = age / duration;
                if (t >= 1) {
                    this.scene.remove(sprite);
                    tex.dispose();
                    mat.dispose();
                    return;
                }
                sprite.position.x += vx;
                sprite.position.y += vy;
                sprite.material.opacity = (1 - t) * 0.5;
                const s = baseSize * (1 + t * 0.5);
                sprite.scale.set(s, s, 1);
                requestAnimationFrame(animate);
            };
            animate();
        }
    }

    createBioPulseEffect(position, radius) {
        const explosionSize = radius * 2; 
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(0, 255, 255, 0.8)');
        grad.addColorStop(0.5, 'rgba(0, 100, 255, 0.2)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const pulse = new THREE.Sprite(material);
        pulse.position.copy(position);
        pulse.scale.set(10, 10, 1);
        pulse.renderOrder = 40;
        this.scene.add(pulse);
        
        const duration = 600;
        const start = Date.now();
        
        const animate = () => {
            const now = Date.now();
            const t = (now - start) / duration;
            if (t >= 1) {
                this.scene.remove(pulse);
                texture.dispose();
                material.dispose();
                return;
            }
            pulse.material.opacity = 1 - t;
            const s = explosionSize * t;
            pulse.scale.set(s, s, 1);
            requestAnimationFrame(animate);
        };
        animate();
    }

    speak(text) {
        // AI Voice disabled as per request
        return;
        if (!window.speechSynthesis) return;
        // Cancel any ongoing speech to avoid overlapping
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        // Preferred female-sounding voices across common platforms
        const preferredVoices = ['Google US English', 'Samantha', 'Zira', 'Microsoft Zira', 'Victoria', 'Karen'];
        const voice = voices.find(v => preferredVoices.some(p => v.name.includes(p))) || voices.find(v => v.name.toLowerCase().includes('female'));
        
        if (voice) utterance.voice = voice;
        utterance.pitch = 1.05; 
        utterance.rate = 0.95;
        utterance.volume = 0.8;
        window.speechSynthesis.speak(utterance);
    }

    updateJumpDrive() {
        if (!this.jumpDrive.active) return;

        const now = Date.now();
        const elapsed = now - this.jumpDrive.startTime;
        
        // Use specifically calculated warmupTotal if available, else fallback to system config
        const totalTime = this.jumpDrive.warmupTotal || (this.jumpDrive.isSystemJump ? 10000 : this.systemConfig.jumpWarmupTime);
        
        this.jumpDrive.progress = (elapsed / totalTime) * 100;
        this.jumpDrive.remaining = Math.max(0, (totalTime - elapsed) / 1000);

        // Play jump sound on last 2.5 seconds
        if (this.jumpDrive.remaining <= 2.5 && !this.jumpDrive.jumpPlayed) {
            this.jumpDrive.jumpPlayed = true;
            if (this.jumpPlayer && this.jumpPlayer.loaded) {
                try { this.jumpPlayer.start(Tone.now()); } catch (e) {}
            }
        }

        if (elapsed >= totalTime) {
            this.finalizeJump();
        }
    }

    updateSunAndFlares() {
        if (!this.sunSprite || !this.sunData) return;

        if (this.isBattlegroundInstance) {
            this.sunSprite.visible = false;
            if (this.sunCorona) this.sunCorona.visible = false;
            if (this.sunHalo) this.sunHalo.visible = false;
            if (this.flareGhosts) this.flareGhosts.forEach((ghost) => { if (ghost?.sprite) ghost.sprite.visible = false; });
            return;
        }

        this.sunSprite.visible = true;
        if (this.sunCorona) this.sunCorona.visible = true;
        if (this.sunHalo) this.sunHalo.visible = true;
        if (this.flareGhosts) this.flareGhosts.forEach((ghost) => { if (ghost?.sprite) ghost.sprite.visible = true; });

        // 1. Update Sun Parallax Position
        const sunX = this.camera.position.x * this.sunData.factor + this.sunData.basePos.x;
        const sunY = this.camera.position.y * this.sunData.factor + this.sunData.basePos.y;
        
        this.sunSprite.position.set(sunX, sunY, -25);
        if (this.sunCorona) this.sunCorona.position.set(sunX, sunY, -25.1);
        if (this.sunHalo) this.sunHalo.position.set(sunX, sunY, -24.9);
        
        // 2. Animate Sun "Breathing" and Churning
        this.sunData.pulseTimer += 0.01;
        
        // Sun breathing effect (Core)
        const breath = Math.sin(this.sunData.pulseTimer * 0.4) * 0.03 + 0.97;
        this.sunSprite.scale.set(this.sunData.baseSize * breath, this.sunData.baseSize * breath, 1);
        this.sunSprite.material.rotation += 0.0003; // Slow surface rotation

        // Corona Pulse (Atmospheric)
        if (this.sunCorona) {
            const coronaBreath = Math.sin(this.sunData.pulseTimer * 0.7) * 0.1 + 0.9;
            this.sunCorona.scale.set(this.sunData.baseSize * 1.8 * coronaBreath, this.sunData.baseSize * 1.8 * coronaBreath, 1);
            this.sunCorona.material.opacity = 0.4 + Math.sin(this.sunData.pulseTimer * 1.2) * 0.1;
            this.sunCorona.material.rotation -= 0.0005; // Slow counter-rotation for depth
        }

        // Halo Pulse (Intensity)
        if (this.sunHalo) {
            const haloBreath = Math.sin(this.sunData.pulseTimer * 1.5) * 0.05 + 0.95;
            this.sunHalo.scale.set(this.sunData.baseSize * 1.2 * haloBreath, this.sunData.baseSize * 1.2 * haloBreath, 1);
            this.sunHalo.material.opacity = 0.3 + Math.sin(this.sunData.pulseTimer * 2.0) * 0.1;
        }

        // 3. Update Solar Flare Particles (Disabled)
        // 4. Calculate Screen Position of Sun (-1 to 1) for Lens Flare Ghosts
        const sunWorldPos = this.sunSprite.position.clone();
        const screenPos = sunWorldPos.clone().project(this.camera);

        // 5. Update Flare Ghosts (Existing logic remains valid for the new sun)
        const isOnScreen = Math.abs(screenPos.x) < 1.5 && Math.abs(screenPos.y) < 1.5;
        
        if (isOnScreen) {
            const flareVec = new THREE.Vector2(-screenPos.x, -screenPos.y);
            const distFromCenter = Math.sqrt(screenPos.x * screenPos.x + screenPos.y * screenPos.y);
            const brightness = Math.max(0, 1.0 - (distFromCenter * 0.4));

            this.flareGhosts.forEach(ghost => {
                const config = ghost.config;
                const ghostScreenPos = new THREE.Vector2(
                    screenPos.x + flareVec.x * config.dist,
                    screenPos.y + flareVec.y * config.dist
                );
                const ghostWorldPos = new THREE.Vector3(ghostScreenPos.x, ghostScreenPos.y, 0.5).unproject(this.camera);
                ghost.sprite.position.set(ghostWorldPos.x, ghostWorldPos.y, 10);
                const baseScale = 200 * config.scale * (this.cameraDistance / 1400);
                ghost.sprite.scale.set(baseScale, baseScale, 1);
                ghost.sprite.material.opacity = config.alpha * brightness;
                ghost.sprite.material.rotation += 0.005; 
                ghost.sprite.visible = true;
            });
        } else {
            this.flareGhosts.forEach(ghost => {
                ghost.sprite.visible = false;
            });
        }

        // 6. Update Ship Lens Flare (Reflection when flying over sun)
        if (this.shipFlare && this.ship.sprite) {
            const isShipActive = this.stats.hp > 0 && this.ship.sprite.visible && !this.isDocked;
            
            if (!isShipActive) {
                this.shipFlare.visible = false;
            } else {
                const sunRenderedPos = new THREE.Vector2(sunX, sunY);
                const shipWorldPos = new THREE.Vector2(this.ship.sprite.position.x, this.ship.sprite.position.y);
                const dist = shipWorldPos.distanceTo(sunRenderedPos);

                const flareRange = 250;
                const intensity = Math.max(0, 1.0 - (dist / flareRange));
                
                if (intensity > 0.01) {
                    this.shipFlare.visible = true;
                    this.shipFlare.position.copy(this.ship.sprite.position);
                    this.shipFlare.position.z = 2; // Above ship
                    this.shipFlare.material.opacity = intensity * 0.8;
                    
                    const pulse = 1.0 + Math.sin(Date.now() * 0.01) * 0.1;
                    const baseSize = 150 * (0.4 + intensity * 0.6) * pulse;
                    this.shipFlare.scale.set(baseSize, baseSize, 1);
                    this.shipFlare.material.rotation += 0.02; // Slow shimmer spin
                } else {
                    this.shipFlare.visible = false;
                }
            }
        }
    }

    updateBackgroundLayers(dt = 0.016) {
        if (this.isBattlegroundInstance) {
            if (this.nebulaLayers) {
                this.nebulaLayers.forEach((layer) => {
                    if (layer?.mesh) layer.mesh.visible = false;
                });
            }
            if (this.nebulaMeshes) {
                this.nebulaMeshes.forEach((mesh) => { if (mesh) mesh.visible = false; });
            }
            if (this.planetLayers) {
                this.planetLayers.forEach((layer) => { if (layer?.mesh) layer.mesh.visible = false; });
            }
        } else {
            if (this.nebulaLayers) {
                this.nebulaLayers.forEach((layer) => { if (layer?.mesh) layer.mesh.visible = true; });
            }
            if (this.nebulaMeshes) {
                this.nebulaMeshes.forEach((mesh) => { if (mesh) mesh.visible = true; });
            }
            if (this.planetLayers) {
                this.planetLayers.forEach((layer) => { if (layer?.mesh) layer.mesh.visible = true; });
            }
        }

        // Multi-layered Parallax Stars
        if (this.starLayers) {
            this.starLayers.forEach(layer => {
                layer.mesh.position.x = this.camera.position.x * layer.factor;
                layer.mesh.position.y = this.camera.position.y * layer.factor;
            });
        }

        // Multi-layered Parallax Nebulae
        if (this.nebulaLayers) {
            this.nebulaLayers.forEach(layer => {
                // Apply independent drift to the base position
                if (layer.drift) {
                    layer.basePos.x += layer.drift.x;
                    layer.basePos.y += layer.drift.y;
                }

                layer.mesh.position.x = this.camera.position.x * layer.factor + layer.basePos.x;
                layer.mesh.position.y = this.camera.position.y * layer.factor + layer.basePos.y;


                // Recycle nebulas that wander too far so the background doesn't feel static after long travel/jumps
                const wrapR = 14000; // radius around camera
                const dx = layer.mesh.position.x - this.camera.position.x;
                const dy = layer.mesh.position.y - this.camera.position.y;
                if ((dx * dx + dy * dy) > (wrapR * wrapR)) {
                    // Teleport basePos near camera with new offsets
                    layer.basePos.x = (this.rng.next() - 0.5) * wrapR * 1.6;
                    layer.basePos.y = (this.rng.next() - 0.5) * wrapR * 1.6;

                    // Re-roll texture/color occasionally for variety (uses system palette)
                    const pal = (this._activeNebulaPalette && this._activeNebulaPalette.length) ? this._activeNebulaPalette : ["blue","gold","purple"];
                    const colorKey = pal[Math.floor(this.rng.next() * pal.length)];
                    layer.color = colorKey;

                    const list = this.nebulaTextureMap?.[colorKey];
                    let texPick = null;
                    if (Array.isArray(list) && list.length) {
                        texPick = list[Math.floor(this.rng.next() * list.length)];
                    } else if (this.nebulaTextureMap && this.nebulaTextureMap[colorKey]) {
                        texPick = this.nebulaTextureMap[colorKey];
                    } else if (this.nebulaTextures && this.nebulaTextures.length) {
                        texPick = this.nebulaTextures[Math.floor(this.rng.next() * this.nebulaTextures.length)];
                    }
                    if (texPick && layer.mesh.material?.uniforms?.tDiffuse) {
                        layer.mesh.material.uniforms.tDiffuse.value = texPick;
                    }

                    // Re-roll size/opacity subtly so shapes change over time
                    const baseSize = 900 + this.rng.next() * 1600;
                    layer.baseScale = baseSize * (0.85 + this.rng.next() * 0.6);
                    layer.baseOpacity = (0.18 + this.rng.next() * 0.18) * (colorKey === "blue" ? 0.85 : 1.0);

                    // Refresh phases
                    layer.colorPhase = this.rng.next() * Math.PI * 2;
                    layer.shimmerPhase = this.rng.next() * Math.PI * 2;
                }
                // Subtle rotation
                layer.mesh.rotation.z += layer.rotationSpeed;

                // Subtle color/brightness shifting
                layer.colorPhase += 0.003;
                layer.shimmerPhase += layer.shimmerSpeed;

                const colorPulse = Math.sin(layer.colorPhase) * 0.1 + 0.9;
                const shimmerPulse = Math.sin(layer.shimmerPhase);
                
                // Gaseous Shimmer: Pulsing opacity and scale
                const opacityMod = 0.9 + (shimmerPulse * 0.1); // +/- 10% opacity
                const scaleMod = 1.0 + (shimmerPulse * 0.02);  // +/- 2% scale
                
                layer.mesh.material.uniforms.uOpacity.value = layer.baseOpacity * opacityMod;
                layer.mesh.material.uniforms.uShimmer.value = layer.shimmerPhase;
                const currentScale = layer.baseScale * scaleMod;
                layer.mesh.scale.set(currentScale, currentScale, 1);

                // For gold nebulas, we maintain the golden tint but allow the shimmer to play over it
                const r = 0.95 + Math.sin(layer.colorPhase * 0.8) * 0.05;
                const g = 0.95 + Math.sin(layer.colorPhase * 0.7) * 0.05;
                const b = 0.95 + Math.sin(layer.colorPhase * 0.9) * 0.05;
                
                // Mix the dynamic pulse with the base color (which might be golden)
                const baseColor = layer.mesh.material.uniforms.uColor.value;
                baseColor.r = (baseColor.r > 1.0 ? baseColor.r : 1.0) * colorPulse * r;
                baseColor.g = (baseColor.g > 1.0 ? baseColor.g : 1.0) * colorPulse * g;
                baseColor.b = (baseColor.b > 1.0 ? baseColor.b : 1.0) * colorPulse * b;
            });
        }

        // Multi-layered Parallax Planets
        if (this.planetLayers) {
            this.planetLayers.forEach(layer => {
                layer.mesh.position.x = this.camera.position.x * layer.factor + layer.basePos.x;
                layer.mesh.position.y = this.camera.position.y * layer.factor + layer.basePos.y;

                // Axial rotation stopped by command
            });
        }
    }


    getInstanceBoundaryVisualProfile() {
        const isArenaInstance = String(this.currentSystemId || '').startsWith('arena:');
        const isBattlegroundInstance = String(this.currentSystemId || '').startsWith('bg:pve:');
        if (!isArenaInstance && !isBattlegroundInstance) return null;

        return {
            key: isBattlegroundInstance ? 'battleground' : 'arena',
            centerX: 0,
            centerY: 0,
            safeRadius: isBattlegroundInstance ? 1200 : 700,
            softRadius: isBattlegroundInstance ? 1450 : 900,
            hardRadius: isBattlegroundInstance ? 1750 : 1100,
            textureUrl: isBattlegroundInstance
                ? DEFAULT_BATTLEGROUND_BOUNDARY_TEXTURE_URL
                : ((ASSETS?.nebulaByType?.blue && ASSETS.nebulaByType.blue[ASSETS.nebulaByType.blue.length - 1]) || ASSETS?.nebulae?.[0] || DEFAULT_BATTLEGROUND_BOUNDARY_TEXTURE_URL),
            tint: isBattlegroundInstance ? 0xcaffbf : 0xbdd7ff,
            topTint: isBattlegroundInstance ? 0xe6ffd8 : 0xffffff,
            lowerCount: isBattlegroundInstance ? 54 : 24,
            upperCount: isBattlegroundInstance ? 34 : 16,
            underlayOpacity: isBattlegroundInstance ? 0.24 : 0.11,
            overlayOpacity: isBattlegroundInstance ? 0.1 : 0.07,
            localHazeOpacity: isBattlegroundInstance ? 0.0 : 0.22,
            spriteScaleMin: isBattlegroundInstance ? 560 : 420,
            spriteScaleMax: isBattlegroundInstance ? 980 : 720,
            localHazeScale: isBattlegroundInstance ? 420 : 320,
            centerGlowOpacity: isBattlegroundInstance ? 0.0 : 0.04,
            ambientFieldCount: isBattlegroundInstance ? 0 : 0,
            ambientFieldOpacity: isBattlegroundInstance ? 0.0 : 0,
            ambientFieldRadius: isBattlegroundInstance ? 0 : 0,
            ambientFieldScaleMin: isBattlegroundInstance ? 0 : 0,
            ambientFieldScaleMax: isBattlegroundInstance ? 0 : 0,
            outerFogCount: isBattlegroundInstance ? 42 : 0,
            outerFogOpacity: isBattlegroundInstance ? 0.34 : 0,
            outerFogRadiusMin: isBattlegroundInstance ? 1600 : 0,
            outerFogRadiusMax: isBattlegroundInstance ? 3600 : 0,
            outerFogScaleMin: isBattlegroundInstance ? 1300 : 0,
            outerFogScaleMax: isBattlegroundInstance ? 2600 : 0,
            alwaysOnUpperHaze: false
        };
    }

    loadInstanceBoundaryTexture(url) {
        if (!url || typeof url !== 'string') return Promise.reject(new Error('Missing instance boundary texture URL'));
        if (!this.instanceBoundaryTextureCache) this.instanceBoundaryTextureCache = new Map();
        if (!this.instanceBoundaryTextureCache.has(url)) {
            const loader = new THREE.TextureLoader();
            if (typeof loader.setCrossOrigin === 'function') loader.setCrossOrigin('anonymous');
            this.instanceBoundaryTextureCache.set(url, new Promise((resolve, reject) => {
                loader.load(url, (texture) => {
                    texture.wrapS = THREE.ClampToEdgeWrapping;
                    texture.wrapT = THREE.ClampToEdgeWrapping;
                    texture.colorSpace = THREE.SRGBColorSpace;
                    resolve(texture);
                }, undefined, reject);
            }));
        }
        return this.instanceBoundaryTextureCache.get(url);
    }

    clearInstanceBoundaryVisuals() {
        const visuals = this.instanceBoundaryVisuals;
        if (!visuals) return;
        const disposeMaterial = (mat) => {
            if (!mat) return;
            if (Array.isArray(mat)) {
                mat.forEach(disposeMaterial);
                return;
            }
            if (typeof mat.dispose === 'function') mat.dispose();
        };
        [visuals.root, visuals.playerHazeGroup].forEach((group) => {
            if (!group) return;
            group.traverse?.((obj) => disposeMaterial(obj.material));
            if (group.parent) group.parent.remove(group);
        });
        this.instanceBoundaryVisuals = null;
        this.instanceBoundaryProfileKey = null;
    }

    async refreshInstanceBoundaryVisualsForCurrentSystem() {
        const profile = this.getInstanceBoundaryVisualProfile();
        if (!profile || !this.scene) {
            this.clearInstanceBoundaryVisuals();
            return;
        }
        const targetKey = `${profile.key}:${profile.textureUrl}`;
        if (this.instanceBoundaryVisuals && this.instanceBoundaryProfileKey === targetKey) return;

        let texture = null;
        try {
            texture = await this.loadInstanceBoundaryTexture(profile.textureUrl);
        } catch (error) {
            console.warn('[BoundaryClouds] Failed to load texture', profile.textureUrl, error);
            return;
        }

        if (this.instanceBoundaryProfileKey === targetKey && this.instanceBoundaryVisuals) return;
        this.clearInstanceBoundaryVisuals();

        const root = new THREE.Group();
        root.name = 'InstanceBoundaryCloudRing';
        const playerHazeGroup = new THREE.Group();
        playerHazeGroup.name = 'InstanceBoundaryPlayerHaze';
        playerHazeGroup.visible = false;

        const lowerSprites = [];
        const upperSprites = [];
        const ambientSprites = [];
        const outerFogSprites = [];
        const playerHazeSprites = [];
        const bandWidth = Math.max(120, profile.hardRadius - profile.softRadius);
        const isBattlegroundProfile = profile.key === 'battleground';
        const ringMid = profile.softRadius + bandWidth * (isBattlegroundProfile ? 0.6 : 0.5);
        const ringJitter = bandWidth * (isBattlegroundProfile ? 0.78 : 0.42);

        const makeSprite = ({ angle, radius, z, opacity, baseScale, tint, layerKey }) => {
            const material = new THREE.SpriteMaterial({
                map: texture,
                color: tint,
                transparent: true,
                opacity,
                depthWrite: false,
                depthTest: false
            });
            const sprite = new THREE.Sprite(material);
            sprite.position.set(
                profile.centerX + Math.cos(angle) * radius,
                profile.centerY + Math.sin(angle) * radius,
                z
            );
            sprite.scale.set(baseScale, baseScale, 1);
            sprite.renderOrder = z > 0 ? 15 : -2;
            sprite.material.rotation = Math.random() * Math.PI * 2;
            sprite.userData.boundaryCloud = {
                angle,
                baseRadius: radius,
                radiusAmp: 18 + Math.random() * 28,
                phase: Math.random() * Math.PI * 2,
                pulseSpeed: 0.35 + Math.random() * 0.45,
                driftSpeed: 0.2 + Math.random() * 0.18,
                baseOpacity: opacity,
                baseScale,
                rotationSpeed: (Math.random() - 0.5) * 0.04,
                layerKey
            };
            return sprite;
        };

        const addRingSprites = (count, z, opacityBase, tint, collector) => {
            for (let i = 0; i < count; i += 1) {
                const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * (isBattlegroundProfile ? 0.34 : 0.18);
                const radius = ringMid + (Math.random() - 0.5) * ringJitter * 2 + (isBattlegroundProfile ? Math.sin((i / Math.max(1, count)) * Math.PI * 6) * bandWidth * 0.18 : 0);
                const baseScale = profile.spriteScaleMin + Math.random() * (profile.spriteScaleMax - profile.spriteScaleMin);
                const sprite = makeSprite({
                    angle,
                    radius,
                    z,
                    opacity: opacityBase * (0.82 + Math.random() * 0.34),
                    baseScale,
                    tint,
                    layerKey: z > 0 ? 'upper' : 'lower'
                });
                collector.push(sprite);
                root.add(sprite);
            }
        };

        const addFieldSprites = (count, radiusMin, radiusMax, scaleMin, scaleMax, z, opacityBase, tint, collector, layerKey) => {
            for (let i = 0; i < count; i += 1) {
                const angle = Math.random() * Math.PI * 2;
                const radius = radiusMin + Math.random() * Math.max(1, (radiusMax - radiusMin));
                const baseScale = scaleMin + Math.random() * Math.max(1, (scaleMax - scaleMin));
                const sprite = makeSprite({
                    angle,
                    radius,
                    z,
                    opacity: opacityBase * (0.78 + Math.random() * 0.44),
                    baseScale,
                    tint,
                    layerKey
                });
                sprite.userData.boundaryCloud.radiusAmp *= 2.8;
                sprite.userData.boundaryCloud.driftSpeed *= 0.55;
                sprite.userData.boundaryCloud.pulseSpeed *= 0.42;
                collector.push(sprite);
                root.add(sprite);
            }
        };

        if (profile.ambientFieldCount > 0) {
            addFieldSprites(
                profile.ambientFieldCount,
                0,
                profile.ambientFieldRadius,
                profile.ambientFieldScaleMin,
                profile.ambientFieldScaleMax,
                4.2,
                profile.ambientFieldOpacity,
                profile.topTint,
                ambientSprites,
                'ambient'
            );
        }

        addRingSprites(profile.lowerCount, -1.2, profile.underlayOpacity, profile.tint, lowerSprites);
        addRingSprites(profile.upperCount, 7.0, profile.overlayOpacity, profile.topTint, upperSprites);

        if (profile.outerFogCount > 0) {
            addFieldSprites(
                profile.outerFogCount,
                profile.outerFogRadiusMin,
                profile.outerFogRadiusMax,
                profile.outerFogScaleMin,
                profile.outerFogScaleMax,
                8.6,
                profile.outerFogOpacity,
                profile.tint,
                outerFogSprites,
                'outer'
            );
        }

        let centerGlow = null;
        if (profile.centerGlowOpacity > 0) {
            centerGlow = new THREE.Mesh(
                new THREE.RingGeometry(profile.safeRadius * 0.95, profile.safeRadius * 1.03, 96),
                new THREE.MeshBasicMaterial({
                    color: profile.tint,
                    transparent: true,
                    opacity: profile.centerGlowOpacity,
                    depthWrite: false,
                    depthTest: false,
                    side: THREE.DoubleSide
                })
            );
            centerGlow.position.set(profile.centerX, profile.centerY, -2.5);
            centerGlow.renderOrder = -4;
            root.add(centerGlow);
        }

        for (let i = 0; i < 3; i += 1) {
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: texture,
                color: profile.topTint,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                depthTest: false
            }));
            const scale = profile.localHazeScale * (0.72 + i * 0.18);
            sprite.scale.set(scale, scale, 1);
            sprite.position.set(0, 0, 9 + i * 0.2);
            sprite.renderOrder = 24 + i;
            sprite.userData.boundaryCloud = {
                orbitRadius: 65 + i * 38,
                orbitSpeed: 0.16 + i * 0.08,
                phase: Math.random() * Math.PI * 2,
                baseOpacity: profile.localHazeOpacity * (1 - i * 0.18),
                baseScale: scale
            };
            playerHazeSprites.push(sprite);
            playerHazeGroup.add(sprite);
        }

        this.scene.add(root);
        this.scene.add(playerHazeGroup);
        this.instanceBoundaryVisuals = { root, playerHazeGroup, lowerSprites, upperSprites, ambientSprites, outerFogSprites, playerHazeSprites, centerGlow, profile };
        this.instanceBoundaryProfileKey = targetKey;
    }

    getCurrentBoundaryZoneData() {
        const visuals = this.instanceBoundaryVisuals;
        const shipPos = this.ship?.sprite?.position;
        const profile = visuals?.profile || this.getInstanceBoundaryVisualProfile();
        if (!shipPos || !profile) return null;
        const distance = new THREE.Vector2(shipPos.x - profile.centerX, shipPos.y - profile.centerY).length();
        const zone = distance >= profile.hardRadius ? 'hard' : (distance >= profile.softRadius ? 'soft' : 'safe');
        return { ...profile, distance, zone };
    }

    updateInstanceBoundaryVisuals(dt = 0.016) {
        const profile = this.getInstanceBoundaryVisualProfile();
        const targetKey = profile ? `${profile.key}:${profile.textureUrl}` : null;

        if (!profile) {
            if (this.instanceBoundaryVisuals) this.clearInstanceBoundaryVisuals();
            return;
        }

        if (!this.instanceBoundaryVisuals || this.instanceBoundaryProfileKey !== targetKey) {
            if (!this.instanceBoundaryRefreshPending) {
                this.instanceBoundaryRefreshPending = true;
                Promise.resolve(this.refreshInstanceBoundaryVisualsForCurrentSystem())
                    .catch((error) => console.warn('[BoundaryClouds] Refresh failed', error))
                    .finally(() => { this.instanceBoundaryRefreshPending = false; });
            }
            return;
        }

        const visuals = this.instanceBoundaryVisuals;
        const now = performance.now() * 0.001;
        const shipPos = this.ship?.sprite?.position || null;
        const zoneData = this.getCurrentBoundaryZoneData();

        const animateRingSprite = (sprite, isUpperLayer) => {
            const data = sprite.userData?.boundaryCloud;
            if (!data || !sprite.material) return;
            const radius = data.baseRadius + Math.sin(now * data.driftSpeed + data.phase) * data.radiusAmp;
            sprite.position.x = visuals.profile.centerX + Math.cos(data.angle) * radius;
            sprite.position.y = visuals.profile.centerY + Math.sin(data.angle) * radius;
            const pulse = 0.94 + Math.sin(now * data.pulseSpeed + data.phase) * 0.08;
            const scale = data.baseScale * pulse;
            sprite.scale.set(scale, scale, 1);
            sprite.material.rotation += data.rotationSpeed * dt;
            let opacity = data.baseOpacity * (0.92 + Math.sin(now * (data.pulseSpeed * 0.9) + data.phase) * 0.08);
            if (shipPos) {
                const nearFactor = Math.max(0, 1 - sprite.position.distanceTo(shipPos) / Math.max(260, data.baseScale * 0.72));
                opacity += nearFactor * (isUpperLayer ? 0.11 : 0.04);
            }
            sprite.material.opacity = opacity;
        };

        visuals.lowerSprites.forEach((sprite) => animateRingSprite(sprite, false));
        visuals.upperSprites.forEach((sprite) => animateRingSprite(sprite, true));
        visuals.ambientSprites?.forEach((sprite) => animateRingSprite(sprite, true));
        visuals.outerFogSprites?.forEach((sprite) => animateRingSprite(sprite, true));
        if (visuals.centerGlow?.material) {
            visuals.centerGlow.material.opacity = visuals.profile.centerGlowOpacity * (0.88 + Math.sin(now * 0.4) * 0.12);
        }

        if (!shipPos || !zoneData) {
            visuals.playerHazeGroup.visible = false;
            return;
        }

        const band = Math.max(1, zoneData.hardRadius - zoneData.softRadius);
        const depthFactor = THREE.MathUtils.clamp((zoneData.distance - zoneData.softRadius) / band, 0, 1);
        const isBattlegroundProfile = visuals.profile?.key === 'battleground';
        const baseZoneFactor = zoneData.zone === 'hard' ? 0.72 + depthFactor * 0.28 : (zoneData.zone === 'soft' ? 0.28 + depthFactor * 0.42 : 0);
        const zoneFactor = isBattlegroundProfile && visuals.profile.alwaysOnUpperHaze
            ? Math.max(0.16, baseZoneFactor)
            : baseZoneFactor;
        if (zoneFactor <= 0) {
            visuals.playerHazeGroup.visible = false;
            return;
        }
        visuals.playerHazeGroup.visible = true;
        visuals.playerHazeGroup.position.set(shipPos.x, shipPos.y, 0);
        visuals.playerHazeSprites.forEach((sprite, index) => {
            const data = sprite.userData?.boundaryCloud;
            if (!data || !sprite.material) return;
            const orbitAngle = now * data.orbitSpeed + data.phase;
            const orbitRadius = data.orbitRadius * (isBattlegroundProfile ? 1.1 : 0.8 + zoneFactor * 0.35);
            sprite.position.set(Math.cos(orbitAngle) * orbitRadius, Math.sin(orbitAngle * 0.92) * orbitRadius, 9 + index * 0.2);
            const scale = data.baseScale * (0.95 + zoneFactor * 0.16 + Math.sin(now * 0.7 + data.phase) * 0.03);
            sprite.scale.set(scale, scale, 1);
            sprite.material.rotation += dt * 0.012 * (index % 2 === 0 ? 1 : -1);
            sprite.material.opacity = data.baseOpacity * zoneFactor * (isBattlegroundProfile ? 0.55 : 1);
        });
    }

    updateModules(fittings, dt = 0.016, isThrusting = false) {
        let totalSpeedBoost = 0;
        let totalSigPenalty = 0;
        let totalShieldCapacity = 0;
        let totalShieldRegen = 0;
        let totalHullIntegrity = 0;
        let totalReactorRecovery = 0;
        let totalArmorBoost = 0;
        let totalResistances = { kinetic: 0, thermal: 0, blast: 0 };

        for (const slotId in fittings) {
            const module = fittings[slotId];
            if (!module) continue;

            // Apply modifiers from module
            if (module.modifiers) {
                module.modifiers.forEach(mod => {
                    if (mod.tag === 'speed') totalSpeedBoost += mod.currentRoll;
                    if (mod.tag === 'shield_regen') totalShieldRegen += mod.currentRoll;
                    if (mod.tag === 'hp') totalHullIntegrity += mod.currentRoll;
                    if (mod.tag === 'armor') totalArmorBoost += mod.currentRoll;
                    if (mod.tag === 'energy_regen') totalReactorRecovery += mod.currentRoll;
                    if (mod.tag === 'res_kinetic') totalResistances.kinetic += mod.currentRoll;
                    if (mod.tag === 'res_thermal') totalResistances.thermal += mod.currentRoll;
                    if (mod.tag === 'res_blast') totalResistances.blast += mod.currentRoll;
                });
            }

            // --- 1. Flux Weapon Heat Logic ---
            const nameLower = (module.name || '').toLowerCase();
            const idLower = (module.item_id || module.id || '').toLowerCase();
            const isFlux = nameLower.includes('flux') || idLower.includes('flux');
            
            if (isFlux) {
                if (!this.weaponStates[slotId]) {
                    this.weaponStates[slotId] = { heat: 0, overheated: false };
                }
                const state = this.weaponStates[slotId];
                const sizeKey = (module.weaponsize || module.size || 'S').toUpperCase();
                const config = FLUX_LASER_CONFIGS[sizeKey] || FLUX_LASER_CONFIGS['S'];
                
                const mods = FLUX_RARITY_MODS[module.rarity || 'common'] || FLUX_RARITY_MODS.common;
                const heatCapacity = module.heatCapacity || config.heatCapacity || 100;
                const coolingRate = heatCapacity / (config.cooldownTime || 3);
                
                // Heat builds up if weapon is active (toggled on) or the respective mouse button is held
                const group1 = module.weaponGroup1 && this.mouseButtons[0];
                const group2 = module.weaponGroup2 && this.mouseButtons[2];
                let isFiring = (this.activeWeapons[slotId] || group1 || group2);

                // Arc check: weapon only heats up if pointing within its tracking arc
                if (isFiring && this.ship.sprite) {
                    const shipPos = this.ship.sprite.position;
                    const aimPoint = (this.locking.state === 'Locked' && this.target) ? this.target.sprite.position : this.mouseWorldPos;
                    const toAim = new THREE.Vector2(aimPoint.x - shipPos.x, aimPoint.y - shipPos.y).normalize();
                    const forward = new THREE.Vector2(-Math.sin(this.ship.rotation), Math.cos(this.ship.rotation)).normalize();
                    const dot = forward.dot(toAim);
                    const angleDeg = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
                    if (angleDeg > (config.hitArc || 45)) isFiring = false;
                }
                
                if (isFiring && !state.overheated) {
                    const heatIncrease = (config.heatPerSecond / (1 + mods.heatEff)) * dt;
                    state.heat += heatIncrease;

                    if (state.heat >= heatCapacity) {
                        state.heat = heatCapacity;
                        state.overheated = true;
                        this.showNotification(`WEAPON OVERHEAT: ${slotId.toUpperCase()}`, "error");
                    }
                } else {
                    // --- Heat Dissipation (Cooling) ---
                    // Passive cooling is slower than active recovery from overheat.
                    const passiveCoolingMult = state.overheated ? 1.0 : 0.35;
                    state.heat = Math.max(0, state.heat - (coolingRate * passiveCoolingMult) * dt);
                    
                    if (state.overheated && state.heat <= 0) {
                        state.heat = 0;
                        state.overheated = false;
                        this.showNotification(`WEAPON READY: ${slotId.toUpperCase()}`, "info");
                    }
                }
            }

            // --- 2. Ion Thruster Logic ---
            if (module.type === 'thruster') {
                const isActive = this.activeWeapons[slotId];
                const stats = getIonThrusterStats(module);

                // CONSTANT PROPULSION DRAIN: Energy is consumed whenever the module is active, regardless of movement.
                if (isActive && stats) {
                    // Energy Check
                    if (this.stats.energy < stats.energyDrain * dt) {
                        // Auto-shutdown on energy depletion
                        this.activeWeapons[slotId] = false;
                        this.showNotification(`THRUSTER SHUTDOWN: LOW ENERGY`, "error");
                        // Sync back to state
                        this.setGameState(prev => ({
                            ...prev,
                            activeWeapons: { ...prev.activeWeapons, [slotId]: false }
                        }));
                    } else {
                        // Consume Energy (Constant drain when on)
                        this.stats.energy -= stats.energyDrain * dt;
                        
                        // Apply Boosts (Signature penalty removed to make sig static)
                        totalSpeedBoost += stats.speedBoost;
                    }
                }
            }

            // --- 3. Shield Logic ---
            if (module.type === 'shield') {
                const stats = getShieldModuleStats(module);
                if (stats) {
                    totalShieldCapacity += stats.capacity;
                    totalShieldRegen += stats.regen;
                }
            }

            // --- 4. Drone Module Logic ---
            if (module.type === 'drone-module' || (module.name || '').toLowerCase().includes('drone')) {
                const isActive = this.activeWeapons[slotId];
                if (isActive) {
                    const { energyDrain } = getAuthoritativeDroneModuleProfile(module);
                    const drain = Number(energyDrain || 0);
                    
                    // Energy Check
                    if (this.stats.energy < drain * dt) {
                        // Auto-shutdown on energy depletion
                        this.activeWeapons[slotId] = false;
                        this.showNotification(`DRONE CONTROL SHUTDOWN: LOW ENERGY`, "error");
                        // Sync back to state
                        this.setGameState(prev => ({
                            ...prev,
                            activeWeapons: { ...prev.activeWeapons, [slotId]: false }
                        }));
                    } else {
                        // Consume Energy
                        this.stats.energy -= drain * dt;
                    }
                }
            }
        }

        // Apply Module Boosts to Ship
        const boostFactor = 1 + (totalSpeedBoost / 100);
        this.ship.maxSpeed = this.ship.baseMaxSpeed * boostFactor;
        // Ship thrust is now derived from the dynamic thrustImpulse stat and dt
        this.ship.thrust = (this.stats.thrustImpulse || 3.0) * dt * boostFactor;
        
        const baseSig = this.baseShipConfig?.baseSigRadius || 22;
        this.stats.sigRadius = baseSig + totalSigPenalty;

        this.stats.maxShields = totalShieldCapacity;
        this.stats.shieldRegen = totalShieldRegen; // Per second
        
        // Handle Hull Integrity boost
        const baseMaxHp = Number.isFinite(this.baseShipConfig?.authoritativeBaseHp) ? this.baseShipConfig.authoritativeBaseHp : (SHIP_REGISTRY[this.stats.name]?.hp || 900);
        const hpBonus = totalHullIntegrity / 100;
        const nextMaxHp = baseMaxHp * (1 + hpBonus);
        this.currentHpBonus = hpBonus; // Store for un-scaling during sync
        if (this.stats.maxHp !== nextMaxHp) {
            const ratio = this.stats.hp / this.stats.maxHp;
            this.stats.maxHp = nextMaxHp;
            this.stats.hp = this.stats.maxHp * ratio;
        }

        // Handle Reactor Recovery boost
        const baseEnergyRecharge = SHIP_REGISTRY[this.stats.name]?.baseEnergyRecharge || 1.0;
        this.stats.reactorRecovery = baseEnergyRecharge * (1 + totalReactorRecovery / 100);
        this.stats.energyRegen = this.stats.reactorRecovery;

        // Handle Armor boost (Clamped at 75%)
        const authoritativeResists = this.baseShipConfig?.authoritativeResistances || {};
        const baseArmor = Number.isFinite(this.baseShipConfig?.authoritativeBaseArmor) ? this.baseShipConfig.authoritativeBaseArmor : (SHIP_REGISTRY[this.stats.name]?.armor || 0);
        this.stats.armor = Math.min(0.75, baseArmor + (totalArmorBoost / 100));

        // Handle Resistances (Clamped at 75%)
        const baseConfig = SHIP_REGISTRY[this.stats.name];
        this.stats.kineticRes = Math.min(0.75, (Number.isFinite(authoritativeResists.kinetic) ? authoritativeResists.kinetic : (baseConfig?.kineticRes || 0)) + (totalResistances.kinetic / 100));
        this.stats.thermalRes = Math.min(0.75, (Number.isFinite(authoritativeResists.thermal) ? authoritativeResists.thermal : (baseConfig?.thermalRes || 0)) + (totalResistances.thermal / 100));
        this.stats.blastRes = Math.min(0.75, (Number.isFinite(authoritativeResists.blast) ? authoritativeResists.blast : (baseConfig?.blastRes || 0)) + (totalResistances.blast / 100));

        // Clamp shields to new max
        if (this.stats.shields > this.stats.maxShields) {
            this.stats.shields = this.stats.maxShields;
        }
    }

    repairShip(hpToAdd) {
        if (!this.stats) return;
        // hpToAdd is base HP (un-scaled). We must scale it if it's applied to stats.hp which is scaled.
        const scaledHpToAdd = hpToAdd * (1 + (this.currentHpBonus || 0));
        this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + scaledHpToAdd);
        this.showNotification(`HULL INTEGRITY RESTORED: +${hpToAdd.toFixed(0)} UNITS`, "success");
    }

    createTrackingArcVisual(slotId) {
        if (!this.trackingArcs) this.trackingArcs = {};
        
        const group = new THREE.Group();
        
        const createPart = (color, opacity) => {
            const geometry = new THREE.BufferGeometry();
            const material = new THREE.MeshBasicMaterial({ 
                color: color, 
                transparent: true, 
                opacity: opacity, 
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.renderOrder = 2;
            return mesh;
        };

        const hitZone = createPart(0x00ff00, 0.1);
        group.add(hitZone);
        
        this.scene.add(group);
        this.trackingArcs[slotId] = { group, hitZone };
    }

    updateTrackingArcs(fittings) {
        if (!this.ship.sprite) return;
        if (!this.trackingArcs) this.trackingArcs = {};

        Object.keys(this.hardpoints).forEach(slotId => {
            if (!slotId.startsWith('weapon')) return;
            const module = fittings ? fittings[slotId] : null;
            const isFlux = module && (module.name || '').toLowerCase().includes('flux');
            
            if (!isFlux) {
                if (this.trackingArcs[slotId]) this.trackingArcs[slotId].group.visible = false;
                return;
            }

            if (!this.trackingArcs[slotId]) {
                this.createTrackingArcVisual(slotId);
            }

            const arcData = this.trackingArcs[slotId];
            arcData.group.visible = true;
            arcData.group.position.copy(this.ship.sprite.position);
            arcData.group.rotation.z = this.ship.rotation;

            const config = FLUX_LASER_CONFIGS[module.weaponsize || 'S'];
            const mods = FLUX_RARITY_MODS[module.rarity || 'common'];
            const hitArcDeg = config.hitArc || 45;
            const range = config.falloffRange * mods.range;

            const updateMesh = (mesh, degrees) => {
                const segments = 32;
                const vertices = [0, 0, 0];
                const indices = [];
                const angleRad = degrees * (Math.PI / 180);
                
                for (let i = 0; i <= segments; i++) {
                    const t = i / segments;
                    // Our forward is "Up" (0 rad), arcs go left and right
                    const currentAngle = -angleRad + (angleRad * 2 * t);
                    const x = Math.sin(currentAngle) * range;
                    const y = Math.cos(currentAngle) * range;
                    vertices.push(x, y, 0);
                    
                    if (i > 0) {
                        indices.push(0, i, i + 1);
                    }
                }
                
                mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
                mesh.geometry.setIndex(indices);
                mesh.geometry.computeBoundingSphere();
            };

            updateMesh(arcData.hitZone, hitArcDeg);
        });
    }

    updateHoverTargeting() {
        if (this.isDocked || !this.ship || !this.ship.sprite) return;
        if (this.locking.state === 'Cooldown') return;

        // Optimized proximity check: find valid target closest to mouse
        let closestEntity = null;
        let minMouseDist = Infinity;

        // Use current camera zoom to scale the "magnetic" hover radius
        const scaleFactor = Math.sqrt(this.cameraDistance / 1400);
        const magneticBuffer = 40 * scaleFactor;

        const hostileHoverCandidates = [
            ...this.entities,
            ...Array.from(this.remotePlayers.values())
        ];

        hostileHoverCandidates.forEach(entity => {
            if (!entity?.sprite || entity.static || entity.id === 'player-ship') return;
            
            // EXPLICIT SELECTION RULE: Asteroids no longer auto-target on hover to prevent accidental lock-switching
            // in dense fields. They require a click or tab-cycle to select.
            const isAsteroid = ASTEROID_TYPES.some(t => t.name === entity.type);
            if (isAsteroid) return;

            const mouseDist = this.mouseWorldPos.distanceTo(entity.sprite.position);
            const targetRadius = entity.radius || entity.collisionRadius || 20;
            const hoverThreshold = targetRadius + magneticBuffer;

            if (mouseDist < hoverThreshold) {
                if (mouseDist < minMouseDist) {
                    minMouseDist = mouseDist;
                    closestEntity = entity;
                }
            }
        });

        if (closestEntity) {
            // Check if we are already priming or locked to this specific entity
            const isTargetingThis = (this.locking.entity?.id === closestEntity.id) || (this.target?.id === closestEntity.id);
            if (!isTargetingThis) {
                // Only automatically switch via hover if we don't have an active lock or priming sequence.
                // This prevents accidental lock loss while firing/maneuvering.
                if (this.locking.state === 'Idle' || this.locking.state === 'Cooldown') {
                    this.setTarget(closestEntity);
                }
            }
        }
    }

    updateHoverVisual() {
        // Track hover state for logic, but removed visual blue bracket feedback per user request
        const currentHoveredId = this.hoveredEntity ? this.hoveredEntity.id : null;
        const hoverChanged = currentHoveredId !== this.lastHoveredId;

        if (hoverChanged) {
            this.lastHoveredId = currentHoveredId;
            if (this.hoverReticle) {
                this.scene.remove(this.hoverReticle);
                this.hoverReticle = null;
            }
        }
    }

    cycleTarget() {
        const validTargets = [
            ...this.entities.filter(e => 
                e.sprite && !e.static && e.id !== 'player-ship' && 
                (e.type === 'NPC' || e.type === 'BIO' || ASTEROID_TYPES.some(t => t.name === e.type))
            ),
            ...Array.from(this.remotePlayers.values()).filter(player => player?.sprite && player.id !== 'player-ship')
        ];

        if (validTargets.length === 0) return;

        // Sort by distance to player
        const playerPos = this.ship.sprite.position;
        validTargets.sort((a, b) => playerPos.distanceTo(a.sprite.position) - playerPos.distanceTo(b.sprite.position));

        let nextIndex = 0;
        if (this.target) {
            const currentIndex = validTargets.findIndex(t => t.id === this.target.id);
            if (currentIndex !== -1) {
                nextIndex = (currentIndex + 1) % validTargets.length;
            }
        } else if (this.locking.entity) {
            const currentIndex = validTargets.findIndex(t => t.id === this.locking.entity.id);
            if (currentIndex !== -1) {
                nextIndex = (currentIndex + 1) % validTargets.length;
            }
        }

        this.setTarget(validTargets[nextIndex]);

        if (this.synth) {
            try {
                this.synth.triggerAttackRelease("G4", "32n", Tone.now());
            } catch (e) {}
        }
    }

    performManualReload() {
        if (!this.fittings) return;
        Object.keys(this.fittings).forEach(slotId => {
            const module = this.fittings[slotId];
            if (!module || !module.name.toLowerCase().includes('pulse cannon')) return;
            
            const ammo = this.weaponAmmo[slotId];
            const config = PULSE_CANNON_CONFIGS[(module.weaponsize || module.size || 'S').toUpperCase()] || PULSE_CANNON_CONFIGS['S'];
            
            if (ammo && !ammo.reloading && ammo.current < config.magazine) {
                ammo.reloading = true;
                ammo.reloadStartTime = Date.now();
                this.showNotification(`RELOADING ${slotId.toUpperCase()}...`, "warning");
            }
        });
    }

    update(fittings = null, activeWeapons = null, dt = 0.016) {
        const effectiveFittings = (fittings && typeof fittings === 'object')
            ? fittings
            : ((this.fittings && typeof this.fittings === 'object') ? this.fittings : {});

        // Essential background/world updates that don't depend on the player ship
        this.updateSunAndFlares();
        this.updateShootingStars();
        this.updateBackgroundLayers(dt);
        this.updateInstanceBoundaryVisuals(dt);
        this.updateAnomalyRespawning(dt);
        this.updateNpcs(dt); 
        this.updateEngineParticles(); // Ensure existing particles fade out even if ship is missing/docked
        
        // Authority Guard: Completely bypass ship-dependent logic if identity is PENDING or sprite is missing
        if (!this.ship || !this.ship.sprite || this.ship.type === 'PENDING') {
            this.updateUi(dt);
            return;
        }

        this.updateMouseWorldPos();
        this.updateHoverTargeting();
        this.updateHoverVisual();

        // 1. Audio Interaction & Bio-Acoustics
        if (this.isAudioStarted) {
            if (!this.bioAudio.isInitialized) {
                this.bioAudio.hum.start();
                this.bioAudio.isInitialized = true;
            }
            
            // Calculate proximity to the nearest Star-Eater
            let minBioDist = 5000;
            const playerPos = this.ship.sprite.position;
            this.spaceSquids.forEach(squid => {
                const d = squid.sprite.position.distanceTo(playerPos);
                if (d < minBioDist) minBioDist = d;
            });
            
            // Map distance to volume: -60dB (far) to -10dB (close)
            const vol = THREE.MathUtils.mapLinear(THREE.MathUtils.clamp(minBioDist, 300, 3000), 300, 3000, -10, -60);
            this.bioAudio.hum.volume.rampTo(vol, 0.5);
            
            // Map distance to frequency (low pitch shift)
            const freq = THREE.MathUtils.mapLinear(THREE.MathUtils.clamp(minBioDist, 300, 3000), 300, 3000, 42, 32);
            this.bioAudio.hum.frequency.rampTo(freq, 0.5);
        }

        // Stop looping flux laser if it hasn't been fired recently
        if (this.fluxPlayer && this.fluxPlayer.state === 'started') {
            if (Date.now() - this.lastFluxFireTime > 150) {
                try { this.fluxPlayer.stop(Tone.now()); } catch (e) {}
            }
        }

        // Update Multiplayer
        this.updateRemotePlayers(dt);
        const nowTime = Date.now();
        if (nowTime - this.lastBroadcastTime > this.broadcastInterval) {
            const telemetry = this.getTelemetry();
            if (telemetry) {
                cloudService.broadcastTelemetry(telemetry);
                this.lastBroadcastTime = nowTime;
            }
        }

        // Authority Persistence Loop (Debounced to 5s)
        if (nowTime - this.lastPersistTime > this.persistInterval) {
            this.persistShipState();
            this.lastPersistTime = nowTime;
        }

        // Update custom cursor
        if (this.cursorSprite) {
            if (this.isDocked || this.isMenuOpen) {
                this.cursorSprite.visible = false;
                this.container.style.cursor = 'auto';
            } else {
                this.cursorSprite.visible = true;
                this.cursorSprite.position.copy(this.mouseWorldPos);
                this.cursorSprite.position.z = 5; // In front of most gameplay elements (Z=0) but behind camera (Z=10)
                this.container.style.cursor = 'none';
                
                // Pulsing cursor
                const pulse = 1.0 + Math.sin(Date.now() * 0.01) * 0.1;
                const scaleFactor = Math.sqrt(this.cameraDistance / 1400);
                this.cursorSprite.scale.set(40 * pulse * scaleFactor, 40 * pulse * scaleFactor, 1);
            }
        }

        // Weapon Cooldown Update (Every frame, decoupled from UI throttle)
        this.updateWeaponCooldowns(dt);

        // Update Starport Rotation
        const starport = this.entities.find(e => e.type === 'Starport');
        if (starport && starport.sprite) {
            starport.sprite.material.rotation += 0.0005;
        }

        const animatedBeacons = this.entities.filter(e => e.type === 'ArenaBeacon' || e.type === 'BattlegroundBeacon');
        if (animatedBeacons.length > 0) {
            const t = Date.now() * 0.001;
            animatedBeacons.forEach((beacon) => {
                if (beacon.sprite?.material) beacon.sprite.material.rotation += 0.004;
                if (beacon.ring) {
                    beacon.ring.material.opacity = 0.46 + Math.sin(t * 2.0) * 0.14;
                    beacon.ring.rotation.z -= 0.01;
                }
                if (beacon.core) {
                    beacon.core.rotation.z += 0.006;
                    const pulse = 1 + Math.sin(t * 2.4) * 0.08;
                    beacon.core.scale.set(92 * pulse, 92 * pulse, 1);
                }
            });
        }

        // Update Space Squids
        const playerPos = this.ship.sprite ? this.ship.sprite.position : null;
        const playerVelocity = this.ship ? this.ship.velocity : new THREE.Vector2(0, 0);

        for (let i = this.spaceSquids.length - 1; i >= 0; i--) {
            const squid = this.spaceSquids[i];
            if (squid.isDestroyed || squid.stats.hp <= 0) {
                // If it died but wasn't cleaned up yet
                if (!squid.isDestroyed) {
                    this.createExplosionEffect(squid.sprite.position, 0x00ff88);
                    
                    // Specialized Bio-Loot Spawning
                    const dropConfig = LOOT_TABLES.Bio_Material_Drops[squid.classId || 'Small Bio-Creature'];
                    if (dropConfig) {
                        const count = dropConfig.min + Math.floor(this.rng.next() * (dropConfig.max - dropConfig.min + 1));
                        const allMaterials = Object.keys(BIO_MATERIAL_REGISTRY);
                        for (let j = 0; j < count; j++) {
                            const materialId = allMaterials[Math.floor(this.rng.next() * allMaterials.length)];
                            const materialData = BIO_MATERIAL_REGISTRY[materialId];
                            this.spawnLoot({
                                ...materialData,
                                type: 'bio-material',
                                materialKey: materialId
                            }, squid.sprite.position);
                        }
                    }
                    
                    // Singleton Broodmother Logic
                    if (squid.creatureType === 'Star-Eater Broodmother') {
                        this.showNotification("TACTICAL VICTORY: Star-Eater Broodmother neutralized!", "success");
                        this.speak("Target signature eradicated. Massive biological threat cleared from sector.");
                        if (this.onBroodmotherDestroyed) {
                            this.onBroodmotherDestroyed(this.currentSystemId);
                        }
                    }

                    squid.destroy();
                }
                this.spaceSquids.splice(i, 1);
                continue;
            }
            
            const playerIsAimingAtMe = this.target && this.target.id === squid.id;
            squid.update(dt, playerPos, playerVelocity, playerIsAimingAtMe);
        }

        // Update Projectiles
        this.updateMissiles(dt, nowTime);
        this.worldObjects.update(dt, nowTime);
        this.updateProjectiles(dt, nowTime);
        this.updateAmmo(effectiveFittings, nowTime);
        if (this.droneManager) this.droneManager.update(dt, nowTime);

        // Remote players (authoritative / EC2)
        // Use GameManager's internal remote-player system (THREE meshes, name tags, shields)
        // rather than the legacy websocket remotePlayers interpolator.
        this.updateRemotePlayers(dt);

        // Process Auction Expirations
        this.processExpiredAuctions(nowTime);
        this.processExpiredContracts(nowTime);

        // Update Quantum Gate Animation
        if (this.warpGateMaterial) {
            this.warpGateMaterial.uniforms.uTime.value += dt;
            this.warpGateSprite.rotation.z += 0.002; // Slow rotation of the ring
        }

        if (!this.ship || !this.ship.sprite) {
            // Update UI even if ship is destroyed
            this.updateUi(dt);
            return;
        }
        
        this.fittings = effectiveFittings; // Store for lock time calculations

                const isDead = (Number(this.stats?.hp ?? 0) <= 0);
const joyInput = this.joystick.getVector();
        
        if (isDead) {
            // Hard-lock local ship controls while dead, but keep the world sim running.
            if (this.ship?.velocity?.set) this.ship.velocity.set(0, 0);
            // Prevent joystick thrust from being treated as input.
            joyInput.x = 0;
            joyInput.y = 0;
        }

        // Newtonian Directional Thrust (WASD / Arrows)
        let accelX = 0;
        let accelY = 0;
        if (!isDead && (this.keys['KeyW'] || this.keys['ArrowUp']) && !this.isDocked) accelY += this.ship.thrust;
        if (!isDead && (this.keys['KeyS'] || this.keys['ArrowDown']) && !this.isDocked) accelY -= this.ship.thrust;
        if (!isDead && this.keys['KeyA'] && !this.isDocked) accelX -= this.ship.thrust;
        if (!isDead && this.keys['KeyD'] && !this.isDocked) accelX += this.ship.thrust;

        const isThrusting = (accelX !== 0 || accelY !== 0 || joyInput.y > 0.1) && !this.isDocked;

        // Cache input-derived values so they can be serialized in getAnimationState()
        // (remote clients use these to animate thruster flares).
        this._netAnim = {
            accelX,
            accelY,
            joyX: joyInput?.x || 0,
            joyY: joyInput?.y || 0,
            thrustPower: (isThrusting && (this.stats?.hp ?? 1) > 0) ? (joyInput.y > 0.1 ? joyInput.y : 1) : 0
        };

        // --- Thruster & Flare Update (Authority: Visual-only, must NOT modify ship physics/state) ---
        const isShipActive = this.stats.hp > 0 && this.ship.sprite && this.ship.sprite.visible && !this.isDocked;
        if (isShipActive && isThrusting) {
            const thrustPower = joyInput.y > 0.1 ? joyInput.y : 1;
            this.emitParticles(thrustPower, accelX, accelY, joyInput);
            this.updateEngineFlare(thrustPower, accelX, accelY, joyInput);
            
            // Visual scale adjustment for thrust effect - DO NOT reset base stats
            const scale = this.ship.baseVisualScale || 64;
            const thrustScale = scale * 1.02;
            this.ship.sprite.scale.set(thrustScale, thrustScale, 1);
        } else if (this.ship.sprite) {
            // Only update visuals if ship exists
            this.updateEngineFlare(0, 0, 0, joyInput);
            const scale = this.ship.baseVisualScale || 64;
            this.ship.sprite.scale.set(scale, scale, 1);
        }
        
        // Independent particle update (allows trails to finish their lifecycle)
        this.updateEngineParticles();

        // Run module logic even when docked to ensure ship statistics remain accurate for UI
        this.updateModules(effectiveFittings, dt, isThrusting);
        
        // Stats Regen
        // Apply Global Modifiers for Regen (Calculated in updateModules but used here with dt)
        const shieldRegenMod = 1 + (this._getModifierSum('shield_regen') / 100);

        if (this.isDocked) {
            // Rapidly recharge to full while docked at a starport
            this.stats.energy = this.stats.maxEnergy;
            this.stats.shields = this.stats.maxShields;
        } else {
            if (this.stats.energy < this.stats.maxEnergy) {
                this.stats.energy = Math.min(this.stats.maxEnergy, this.stats.energy + (this.stats.energyRegen * dt));
            }
            if (this.stats.shields < this.stats.maxShields) {
                const baseRegen = this.stats.shieldRegen || 0;
                this.stats.shields = Math.min(this.stats.maxShields, this.stats.shields + (baseRegen * shieldRegenMod * dt));
            }
        }

        // Update UI after stats have been recalculated
        this.updateUi(dt);

        if (this.isDocked) {
            // Update camera and backgrounds for a stable docked view
            this.camera.position.x += (this.ship.sprite.position.x - this.camera.position.x) * 0.1;
            this.camera.position.y += (this.ship.sprite.position.y - this.camera.position.y) * 0.1;
            return;
        }

        this.updateJumpDrive();
        this.updateWeaponVisuals(effectiveFittings);
        this.updateTrackingArcs(effectiveFittings);
        
        // Sync active weapons state before module logic
        if (activeWeapons) {
            this.activeWeapons = activeWeapons;
        }

        // Weapon Group Firing (LMB/Space = Group 1, RMB = Group 2)
        if (!isDead && !this.isDocked && fittings) {
            Object.keys(fittings).forEach(slotId => {
                const module = fittings[slotId];
                if (!module || (module.type !== 'weapon' && module.type !== 'mining')) return;
                
                const fireG1 = (this.mouseButtons[0] || this.keys['Space']) && module.weaponGroup1;
                const fireG2 = this.mouseButtons[2] && module.weaponGroup2;

                if (fireG1 || fireG2) {
                    // Similar to auto-fire but triggered by mouse/keyboard
                    let safetyLimit = 0;
                    while (this.weaponCooldowns[slotId] <= 0 && safetyLimit < 5) {
                        this.fireWeapon(slotId, module);
                        safetyLimit++;
                    }
                }
            });
        }
        
        // Handle Belt Respawning
        this.asteroidBelts.forEach(belt => {
            if (belt.depleted && belt.respawnTime && nowTime >= belt.respawnTime) {
                belt.depleted = false;
                belt.respawnTime = null;
                const system = resolveSystemDefinition(this.currentSystemId);
                const tier = system?.tier || 1;
                const config = TIER_CONFIGS[tier];
                const count = Math.floor(config.count[0] + this.rng.next() * (config.count[1] - config.count[0] + 1));
                
                const beltAsteroidIds = [];
                for (let i = 0; i < count; i++) {
                    const angle = this.rng.next() * Math.PI * 2;
                    const dist = 150 + this.rng.next() * 600; 
                    const x = belt.center.x + Math.cos(angle) * dist;
                    const y = belt.center.y + Math.sin(angle) * dist;
                    const size = 100 + this.rng.next() * 120;
                    const radius = size * 0.52; // Increased from 0.45 for accurate collision edge

                    const roll = this.rng.next();
                    let cumulative = 0;
                    let typeIndex = 0;
                    for (let j = 0; j < config.weights.length; j++) {
                        cumulative += config.weights[j];
                        if (roll < cumulative) { typeIndex = j; break; }
                    }
                    const asteroidType = ASTEROID_TYPES[typeIndex] || ASTEROID_TYPES[0];
                    const minQL = config.qlRange[0];
                    const maxQL = config.qlRange[1];
                    let rolledQL = Math.floor(minQL + this.rng.next() * (maxQL - minQL + 1));
                    const finalQL = Math.min(rolledQL, maxQL);
                    const qlBand = getQLBand(finalQL);

                    const spriteMaterial = new THREE.SpriteMaterial({ 
                        map: this.asteroidTexture,
                        color: asteroidType.color
                    });
                    const sprite = new THREE.Sprite(spriteMaterial);
                    sprite.scale.set(size, size, 1);
                    sprite.material.rotation = this.rng.next() * Math.PI * 2;
                    sprite.position.set(x, y, 0);
                    this.scene.add(sprite);
                    sprite.renderOrder = 10;

                    const asteroidId = `asteroid-${belt.id}-${i}-${Date.now()}`;
                    this.entities.push({
                        id: asteroidId, beltId: belt.id, x: x, y: y, radius: radius,
                        color: asteroidType.color, type: asteroidType.name, oreType: asteroidType.ore,
                        ql: finalQL, qlBand: qlBand, oreAmount: 100 + Math.floor(this.rng.next() * 150),
                        sprite: sprite
                    });
                    beltAsteroidIds.push(asteroidId);
                }
                belt.asteroidIds = new Set(beltAsteroidIds);
                this.showNotification(`New asteroid formation detected in ${belt.name}.`, "info");
                this.setGameState(prev => ({ ...prev, asteroidBelts: [...this.asteroidBelts] }));
            }
        });

        this.handleCollisions();
        if (!this.ship.sprite) return;
        
        this.updateAsteroidProximity(dt);
        this.updateScanning();
        this.updateLocking();

        // Handle Auto-Firing
        if (this.target && this.target.sprite && fittings) {
            Object.keys(fittings).forEach(slotId => {
                const module = fittings[slotId];
                if (!module) return;

                const nameLower = (module.name || '').toLowerCase();
                const idLower = (module.item_id || module.id || '').toLowerCase();
                const isFlux = nameLower.includes('flux') || idLower.includes('flux');
                const isMining = module.type === 'mining';
                
                // Auto-mining logic: mining lasers automatically fire at asteroids when locked
                const isAsteroid = this.target && ASTEROID_TYPES.some(t => t.name === this.target.type);
                const isLocked = this.locking.state === 'Locked';
                const shouldAutoFire = isMining && isAsteroid && isLocked;

                if ((this.activeWeapons[slotId] || shouldAutoFire) && this.target) {
                    // Safety check: shut off if target is too far or out of arc
                    if (isFlux || isMining) {
                        if (!this.canWeaponHit(slotId, module, this.target)) {
                            // Weapon is active but suspended due to arc/range
                            return; 
                        }
                    }

                    // Allow multiple firing ticks if the cooldown accumulator is negative.
                    // This ensures DPS remains consistent even at lower frame rates.
                    let safetyLimit = 0;
                    while (this.weaponCooldowns[slotId] <= 0 && safetyLimit < 5) {
                        this.fireWeapon(slotId, module);
                        safetyLimit++;
                    }
                }
            });
        }
        
        if (!this.ship.sprite) return;
        
        // Rotation logic (Mouse Look)
        if (!isDead && this.ship.sprite && !this.isDocked) {
            const shipPos = this.ship.sprite.position;
            const targetAngle = Math.atan2(
                this.mouseWorldPos.x - shipPos.x,
                this.mouseWorldPos.y - shipPos.y
            );
            
            // Normalize targetAngle to match Three.js sprite rotation (0 is up)
            // But ship rotation in the engine seems to be -Math.sin/Math.cos based.
            // Let's check how rotation is used in fireWeapon:
            // forward = new THREE.Vector2(-Math.sin(this.ship.rotation), Math.cos(this.ship.rotation))
            // This means 0 is up, and it's clockwise? No, -sin for x and cos for y means:
            // 0 -> (0, 1)
            // PI/2 -> (-1, 0)
            // So it's counter-clockwise?
            // Actually, Math.atan2(x, y) gives the angle from the positive y axis.
            
            const currentRotation = this.ship.rotation;
            let diff = -targetAngle - currentRotation;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            
            const step = this.ship.turnSpeed * (dt * 60);
            if (Math.abs(diff) < step) {
                this.ship.rotation = -targetAngle;
            } else {
                this.ship.rotation += Math.sign(diff) * step;
            }
        }
        // Apply Newtonian Thrust (WASD / Arrows already calculated as accelX/accelY)
        if (!isDead && isThrusting) {
            this.ship.velocity.x += accelX;
            this.ship.velocity.y += accelY;
            
            // Joystick still provides relative forward thrust for intuitive control
            if (joyInput.y > 0.1) {
                const thrustPower = joyInput.y;
                const thrustDir = new THREE.Vector2(
                    -Math.sin(this.ship.rotation),
                    Math.cos(this.ship.rotation)
                );
                this.ship.velocity.add(thrustDir.multiplyScalar(this.ship.thrust * thrustPower));
            }
        else if (isDead) {
            // Ensure we don't drift while spectating.
            if (this.ship?.velocity?.set) this.ship.velocity.set(0, 0);
        }
        }

        if (!this.ship.sprite) return;

        // Update Ship Material Shader Uniforms
        if (this.ship.sprite.isMesh && this.ship.sprite.material.uniforms) {
            const uniforms = this.ship.sprite.material.uniforms;
            uniforms.uTime.value += dt;
            
            // Damage pulse effect
            const timeSinceHit = Date.now() - (this.lastHitTime || 0);
            if (timeSinceHit < 1000) {
                uniforms.uDamage.value = 1.0 - (timeSinceHit / 1000);
            } else {
                uniforms.uDamage.value = 0;
            }
        }

        if (this.ship.sprite.isMesh) {
            this.ship.sprite.rotation.z = this.ship.rotation;
        } else {
            this.ship.sprite.material.rotation = this.ship.rotation;
        }

        // Apply velocity
        this.ship.sprite.position.x += this.ship.velocity.x;
        this.ship.sprite.position.y += this.ship.velocity.y;
// ⭐ SEND TELEMETRY ⭐ 
this.backendSocket.sendTelemetry({
    type: "TELEMETRY",

    player_id: this.playerId,          // or game.localPlayerId
    ship_id: this.ship.id,
    system_id: this.currentSystemId,

    x: this.ship.sprite.position.x,
    y: this.ship.sprite.position.y,
    rot: this.ship.rotation,

    vx: this.ship.velocity.x,
    vy: this.ship.velocity.y,

    hp: this.stats.hp,
    maxHp: this.stats.maxHp,

    shields: this.stats.shields,
    maxShields: this.stats.maxShields,

    energy: this.stats.energy,
    maxEnergy: this.stats.maxEnergy,

    timestamp: Date.now()
});

        // Update Shield Visuals
        if (this.shieldMesh && this.ship.sprite) {
            this.shieldMesh.position.copy(this.ship.sprite.position);
            this.shieldMesh.rotation.z = this.ship.rotation;
            
            this.shieldPulseTimer += 0.016; // Faster, more noticeable sweep
            
            // Sweep progress cycles from 0 to 1
            const sweepProgress = (Math.sin(this.shieldPulseTimer) * 0.5 + 0.5);
            
            // Decelerate hit flare
            this.shieldHitAlpha = Math.max(0, this.shieldHitAlpha - 0.03);
            
            // Update uniforms
            this.shieldMesh.material.uniforms.uTime.value = nowTime / 1000.0;
            this.shieldMesh.material.uniforms.uProgress.value = sweepProgress;
            this.shieldMesh.material.uniforms.uHitAlpha.value = this.shieldHitAlpha;
            const localShieldRatio = this.stats.maxShields > 0 ? (this.stats.shields / this.stats.maxShields) : 0;
            this.shieldMesh.material.uniforms.uShieldRatio.value = localShieldRatio;
            
            // Scale pulse synchronized with sweep center
            const shipScale = this.ship.baseVisualScale || 64;
            
            // Look up multiplier from registry for ship-specific spacing
            const shipType = this.ship.type || 'OMNI SCOUT';
            const normalizedType = shipType.toString().trim().toUpperCase();
            const shipConfig = SHIP_REGISTRY[normalizedType];
            const multiplier = shipConfig?.shieldScale || 1.25;
            
            const scaleBase = shipScale * multiplier; 
            
            const pulseImpact = Math.max(0, 1.0 - Math.abs(sweepProgress - 0.5) * 2.0);
            const scaleBonus = (pulseImpact * (shipScale * 0.02)) + (this.shieldHitAlpha * (shipScale * 0.15));
            this.shieldMesh.scale.set(scaleBase + scaleBonus, scaleBase + scaleBonus, 1);
            this.shieldMesh.visible = !this.isDocked && ((Number(this.stats?.maxShields ?? 0) > 0) || this.shieldHitAlpha > 0.01);
        }

        // Position name sprite under ship
        if (this.nameSprite && this.ship.sprite) {
            this.nameSprite.position.x = this.ship.sprite.position.x;
            
            // Adjust offset based on ship class size
            const shipScale = this.ship.baseVisualScale || 64;
            let labelOffset = Math.max(shipScale * 0.65, 75); // Moved slightly up for Sovereign (65%) while keeping Scout floor at 75
            
            this.nameSprite.position.y = this.ship.sprite.position.y - labelOffset; 
            
            // Dynamic scaling based on camera distance (zoom level)
            // We use a baseline distance of 1400. Square root damping ensures it stays 
            // readable when zoomed out without becoming massive when zoomed in.
            const baseScaleX = 180; 
            const baseScaleY = 45;
            const scaleFactor = Math.sqrt(this.cameraDistance / 1400);
            this.nameSprite.scale.set(baseScaleX * scaleFactor, baseScaleY * scaleFactor, 1);
        }

        // Apply friction and automatic braking (Inertial Dampeners)
        if (this.ship.inertialDampeners && !isThrusting) {
            // Braking force applied as a percentage of velocity reduction per second
            const brakeMult = Math.max(0, 1 - (this.stats.brakingForce || 1.5) * dt);
            this.ship.velocity.multiplyScalar(brakeMult);
            if (this.ship.velocity.length() < 0.01) this.ship.velocity.set(0, 0);
        } else {
            // Pure Newtonian drift (friction is 1.0)
            this.ship.velocity.multiplyScalar(this.ship.friction);
        }

        // Limit speed
        if (this.ship.velocity.length() > this.ship.maxSpeed) {
            this.ship.velocity.setLength(this.ship.maxSpeed);
        }

        // Camera follow with slight smoothing
        if (this.ship.sprite) {
            this.camera.position.x += (this.ship.sprite.position.x - this.camera.position.x) * 0.1;
            this.camera.position.y += (this.ship.sprite.position.y - this.camera.position.y) * 0.1;
        }
    }

    animate() {
        this.frameId = requestAnimationFrame(() => this.animate());
        
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000); // cap to 100ms
        this.lastFrameTime = now;

        // Pass the current fittings and active weapons to the update loop
        let currentFittings = null;
        let currentActiveWeapons = null;
        
        this.setGameState(prev => {
            currentFittings = prev.fittings;
            currentActiveWeapons = prev.activeWeapons;
            return prev;
        });

        this.update(currentFittings, currentActiveWeapons, dt);
        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        cancelAnimationFrame(this.frameId);
        window.removeEventListener('keydown', (e) => this.keys[e.code] = true);
        window.removeEventListener('keyup', (e) => this.keys[e.code] = false);
        window.removeEventListener('resize', () => this.onResize());
        this.renderer.dispose();
    }

    spawnBroodmother(position) {
        const squid = new SpaceSquid(this.scene, 'https://rosebud.ai/assets/squidhd.jpg?U7BK', {
            position: position,
            size: 800 + Math.random() * 200, // Reduced from 1500
            bobSpeed: 0.015, 
            bobAmplitude: 15 + Math.random() * 10, 
            fps: 2, 
            tilesX: 4, 
            tilesY: 5, 
            totalFrames: 8,
            blending: THREE.NormalBlending, 
            classId: 'Large Bio-Creature',
            hp: 15000, 
            maxSpeed: 8,
            turnSpeed: 0.04,
            isPassiveUntilAttacked: true
        });

        // Rename the identity for registry matching
        squid.creatureType = 'Star-Eater Broodmother';

        // Initialize AI for the squid
        squid.ai = new NPCAI(squid, this);
        // Passive role until aggravated
        squid.ai.role = { preferredDistance: 1500, aggression: 0.0, movement: 'orbit', firingRange: 0 };
        
        this.spaceSquids.push(squid);
        this.npcs.push(squid);
        this.entities.push(squid);
        
        return squid;
    }

    spawnCartelPatrol(minDist = 1500, maxDist = 2200, silent = false) {
        const system = resolveSystemDefinition(this.currentSystemId);
        if (!system) return;

        const security = system.securityValue;
        let minShips, maxShips, gunshipChance;
        
        // Define patrol size and composition based on security rating
        if (security >= 0.7) { // Secure
            minShips = 1; maxShips = 2; gunshipChance = 0.0;
        } else if (security >= 0.5) { // Mid Sec
            minShips = 2; maxShips = 4; gunshipChance = 0.2;
        } else if (security >= 0.2) { // Low Sec
            minShips = 3; maxShips = 5; gunshipChance = 0.35;
        } else { // Null Sec
            minShips = 4; maxShips = 6; gunshipChance = 0.5;
        }

        const shipCount = minShips + Math.floor(Math.random() * (maxShips - minShips + 1));
        const patrolId = `patrol-cartel-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        const npcIds = new Set();
        
        // REACTIVE SPAWNING: Find a random spawn position near the player
        const playerPos = this.ship.sprite ? this.ship.sprite.position : new THREE.Vector3(0, 0, 0);
        let spawnPos = new THREE.Vector2();
        let valid = false;
        let attempts = 0;
        const restricted = this.entities.filter(e => e.type === 'Starport' || e.type === 'WarpGate');

        while (!valid && attempts < 15) {
            // Reactive distance: 1500-2200 units (just outside standard scan range, but close enough to be a threat)
            const angle = Math.random() * Math.PI * 2;
            const dist = minDist + Math.random() * (maxDist - minDist);
            spawnPos.set(playerPos.x + Math.cos(angle) * dist, playerPos.y + Math.sin(angle) * dist);
            
            // Ensure we don't spawn inside a starport or warp gate's exclusion zone
            valid = restricted.every(r => spawnPos.distanceTo(new THREE.Vector2(r.x, r.y)) > r.radius + 1000);
            attempts++;
        }

        // Create the warp effect at the central spawn point
        this.createWarpInEffect(new THREE.Vector3(spawnPos.x, spawnPos.y, 0));
        
        if (!silent) {
            this.showNotification("CRITICAL: Hyperspace signatures detected near your position!", "warning");
        }

        // Patrol Path (wandering logic)
        const patrolPath = [];
        for (let i = 0; i < 4; i++) {
            patrolPath.push(new THREE.Vector2(
                spawnPos.x + (Math.random() - 0.5) * 4000,
                spawnPos.y + (Math.random() - 0.5) * 4000
            ));
        }

        const patrol = {
            id: patrolId,
            npcIds: npcIds,
            path: patrolPath,
            pathIndex: 0,
            isHostile: false,
            center: spawnPos.clone(),
            timeAwayFromPlayer: 0, // Track time spent away from player
            isJumpingOut: false    // Track if currently in warp-out sequence
        };

        const textureLoader = new THREE.TextureLoader();
        const __origLoadAsync = textureLoader.loadAsync.bind(textureLoader);
textureLoader.loadAsync = (url) => {
  console.log("[TextureLoader] loadAsync url =", url);
  if (!url || typeof url !== "string") {
    console.warn("[TextureLoader] INVALID URL (will crash):", url);
  }
  return __origLoadAsync(url);
};
        const load = (url) => new Promise(resolve => textureLoader.load(url, resolve));

        const npcDefs = [];
        for (let i = 0; i < shipCount; i++) {
            const isGunship = Math.random() < gunshipChance;
            npcDefs.push(createNpcShipProfile(isGunship ? 'cartel_patrol_gunship' : 'cartel_patrol_scout', { security }));
        }

        Promise.all(npcDefs.map(def => load(def.spriteUrl))).then((textures) => {
            textures.forEach((texture) => { texture.magFilter = THREE.NearestFilter; });

            for (let i = 0; i < shipCount; i++) {
                const profile = npcDefs[i];
                const texture = textures[i];
                const npcId = `${patrolId}-ship-${i}`;
                const offset = new THREE.Vector2((Math.random()-0.5)*300, (Math.random()-0.5)*300);
                const pos = spawnPos.clone().add(offset);
                
                const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0 });
                const sprite = new THREE.Sprite(spriteMaterial);
                sprite.scale.set(profile.visualScale, profile.visualScale, 1);
                sprite.position.set(pos.x, pos.y, 0);
                sprite.renderOrder = 5;
                this.scene.add(sprite);

                const fadeInStart = Date.now();
                const fadeInDuration = 1000;
                const animateFade = () => {
                    const elapsed = Date.now() - fadeInStart;
                    const t = Math.min(1, elapsed / fadeInDuration);
                    if (sprite.material) sprite.material.opacity = t;
                    if (t < 1) requestAnimationFrame(animateFade);
                };
                animateFade();

                const npc = {
                    id: npcId,
                    type: 'NPC',
                    faction: profile.faction,
                    shipType: profile.shipType,
                    ship_id: profile.shipId,
                    x: pos.x,
                    y: pos.y,
                    radius: profile.radius,
                    sigRadius: profile.sigRadius,
                    sprite: sprite,
                    velocity: new THREE.Vector2(0, 0),
                    rotation: Math.random() * Math.PI * 2,
                    stats: profile.stats,
                    fittings: profile.fittings,
                    locking: {
                        state: 'Idle',
                        entity: null,
                        startTime: 0,
                        progress: 0,
                        requiredTime: 0
                    },
                    weaponCooldowns: profile.weaponCooldowns,
                    target: null,
                    patrolId: patrolId,
                    combatPhase: 'orbit',
                    phaseTimer: 5 + Math.random() * 5
                };

                npc.ai = new NPCAI(npc, this);
                this.npcs.push(npc);
                this.entities.push(npc);
                npcIds.add(npcId);
            }
        });

        this.patrols.push(patrol);
    }

    spawnCartelMiningShip() {
        const system = resolveSystemDefinition(this.currentSystemId);
        if (!system || system.securityValue >= 1.0) return;

        // Find a random belt
        const activeBelts = this.asteroidBelts.filter(b => !b.depleted);
        if (activeBelts.length === 0) return;
        const belt = activeBelts[Math.floor(Math.random() * activeBelts.length)];

        const shipId = `mining-cartel-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        
        // Spawn near the belt center
        const angle = Math.random() * Math.PI * 2;
        const dist = 800 + Math.random() * 400;
        const pos = new THREE.Vector2(
            belt.center.x + Math.cos(angle) * dist,
            belt.center.y + Math.sin(angle) * dist
        );

        const textureLoader = new THREE.TextureLoader();
        const __origLoadAsync = textureLoader.loadAsync.bind(textureLoader);
textureLoader.loadAsync = (url) => {
  console.log("[TextureLoader] loadAsync url =", url);
  if (!url || typeof url !== "string") {
    console.warn("[TextureLoader] INVALID URL (will crash):", url);
  }
  return __origLoadAsync(url);
};
        const profile = createNpcShipProfile('cartel_mining_scout');
        textureLoader.load(profile.spriteUrl, (texture) => {
            texture.magFilter = THREE.NearestFilter;
            const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(profile.visualScale, profile.visualScale, 1);
            sprite.position.set(pos.x, pos.y, 0);
            sprite.renderOrder = 5;
            this.scene.add(sprite);

            const npc = {
                id: shipId,
                type: 'NPC',
                faction: profile.faction,
                shipType: profile.shipType,
                ship_id: profile.shipId,
                behavior: profile.behavior,
                miningState: profile.miningState,
                cargo: profile.cargo ?? 0,
                maxCargo: profile.maxCargo ?? 60,
                x: pos.x,
                y: pos.y,
                radius: profile.radius,
                sigRadius: profile.sigRadius,
                sprite: sprite,
                velocity: new THREE.Vector2(0, 0),
                rotation: Math.random() * Math.PI * 2,
                stats: profile.stats,
                fittings: profile.fittings,
                locking: {
                    state: 'Idle',
                    entity: null,
                    startTime: 0,
                    progress: 0,
                    requiredTime: 0
                },
                weaponCooldowns: profile.weaponCooldowns,
                target: null
            };

            this.npcs.push(npc);
            this.entities.push(npc);
        });
    }

    handlePatrolJumpOut(patrol) {
        if (patrol.isJumpingOut) return;
        patrol.isJumpingOut = true;

        const activeNpcs = this.npcs.filter(n => patrol.npcIds.has(n.id));
        activeNpcs.forEach(npc => {
            if (!npc.sprite) return;
            
            // Visual warp out
            this.createWarpOutEffect(npc.sprite.position.clone());
            
            // Fade out the ship before removal
            const fadeOutStart = Date.now();
            const fadeOutDuration = 1000;
            const animateFadeOut = () => {
                const elapsed = Date.now() - fadeOutStart;
                const t = Math.max(0, 1 - (elapsed / fadeOutDuration));
                if (npc.sprite && npc.sprite.material) {
                    npc.sprite.material.opacity = t;
                    npc.sprite.scale.set(npc.sprite.scale.x * 0.95, npc.sprite.scale.y * 0.95, 1);
                }
                
                if (t > 0) {
                    requestAnimationFrame(animateFadeOut);
                } else {
                    // Final cleanup of the individual NPC
                    this.scene.remove(npc.sprite);
                    if (npc.sprite.material) npc.sprite.material.dispose();
                    this.npcs = this.npcs.filter(n => n.id !== npc.id);
                    this.entities = this.entities.filter(e => e.id !== npc.id);
                }
            };
            animateFadeOut();
        });

        // Remove patrol from tracking after a delay to allow animations to play
        setTimeout(() => {
            this.patrols = this.patrols.filter(p => p.id !== patrol.id);
        }, 1200);
    }

    updateNpcs(delta) {
        if (!this.initialized) return;
        if (this.isArenaInstance) return;

        const playerPos = this.ship.sprite ? this.ship.sprite.position : null;
        if (this.isBattlegroundInstance) {
            if (this.isDocked) return;
            this.npcs.filter(n => n && n.behavior === 'battleground').forEach(npc => {
                this.updateNpcBehavior(npc, null, playerPos);
            });
            return;
        }

        const system = resolveSystemDefinition(this.currentSystemId);
        if (!system || this.isDocked) return;

        // Security based patrol limit
        const security = system.securityValue;
        let maxPatrols = 0;
        // Allow patrols in all systems below 1.0 security
        if (security < 1.0) {
            maxPatrols = Math.floor((1.0 - security) * 8) + 1;
        }

        // --- Threat-Based Spawning Logic ---
        // Increase threat level if traveling fast or mining
        let threatGain = 0;
        
        if (this.threatCooldown > 0) {
            this.threatCooldown -= delta;
        }

        if (this.threatCooldown <= 0) {
            // 1. Travel Threat
            if (playerPos) {
                const distTravelled = playerPos.distanceTo(this.lastPlayerPosForTravelThreat);
                this.lastPlayerPosForTravelThreat.copy(playerPos);
                
                // Gain threat proportional to movement
                // 1.0 threat per 100,000 units of travel (approx 7 mins at max speed)
                threatGain += (distTravelled / 100000);
            }

            // 2. Mining Threat
            // Check if any weapon beam is active and its type is mining
            const isMining = Object.values(this.activeBeams).some(b => b.type === 'mining');
            if (isMining) {
                // 1.0 threat per 50 seconds of continuous mining
                threatGain += delta * 0.02; 
            }

            // Apply multiplier based on system risk (lower security = higher detection)
            // riskMult: 1.0 @ 1.0 sec, 2.0 @ 0.5 sec, 3.0 @ 0.0 sec
            const riskMult = 1.0 + (1.0 - security) * 2;
            this.threatLevel += threatGain * riskMult;
        } else {
            // Keep tracking position even during cooldown to avoid jump-gain after cooldown ends
            if (playerPos) {
                this.lastPlayerPosForTravelThreat.copy(playerPos);
            }
        }

        // Reset threat slowly over time if not doing anything suspicious (stationary and not mining)
        if (threatGain <= 0) {
            this.threatLevel = Math.max(0, this.threatLevel - delta * 0.005);
        }

        // Trigger Patrol Jump-In
        // Threshold: 0.25 for low-sec (0.3), approx 0.8 for high-sec (0.9)
        const spawnThreshold = security <= 0.6 ? 0.20 : 0.7; 
        if (this.threatLevel >= spawnThreshold && this.patrols.length < maxPatrols) {
            // Check random chance for jump-in (approx every 4-5 seconds once threshold is reached)
            if (Math.random() < delta * 0.2) {
                this.spawnCartelPatrol(1500, 2500, false); // Jump in near player
                this.threatLevel = 0; // Reset threat after engagement
                this.threatCooldown = 120 + Math.random() * 180; // 2-5 minute cooldown before new threat accumulates
                this.showNotification("TACTICAL ALERT: Hostile signatures detected jumping into sector!", "error");
                this.speak("Hyperspace resonance detected. Pirate interceptors on intercept course.");
            }
        }

        // Spawn Cartel Mining Ships near belts (Only if security is low)
        const maxMiningShips = maxPatrols > 0 ? Math.max(1, Math.floor(maxPatrols / 2)) : 0;
        const currentMiningShips = this.npcs.filter(n => n.behavior === 'mining').length;
        
        if (currentMiningShips === 0 && maxMiningShips > 0) {
            if (this.miningShipSpawnTimer <= 0) {
                // Last one was destroyed or system just loaded, start the long respawn timer
                // Between 2.5 and 5 minutes (150-300 seconds)
                this.miningShipSpawnTimer = 150 + Math.random() * 150;
            } else {
                this.miningShipSpawnTimer -= delta;
                if (this.miningShipSpawnTimer <= 0) {
                    this.spawnCartelMiningShip();
                }
            }
        } else if (currentMiningShips < maxMiningShips && Math.random() < 0.002) {
            // If some exist but we're below the cap, keep spawning them with a small chance
            this.spawnCartelMiningShip();
        }

        this.patrols.forEach(patrol => {
            const activeNpcs = this.npcs.filter(n => patrol.npcIds.has(n.id) && n.sprite);
            if (activeNpcs.length > 0) {
                const avgX = activeNpcs.reduce((sum, n) => sum + n.sprite.position.x, 0) / activeNpcs.length;
                const avgY = activeNpcs.reduce((sum, n) => sum + n.sprite.position.y, 0) / activeNpcs.length;
                patrol.center.set(avgX, avgY);

                if (playerPos) {
                    const distToPlayer = patrol.center.distanceTo(playerPos);

                    // Track time away from player for jump out logic
                    if (distToPlayer > 1500) {
                        patrol.timeAwayFromPlayer += delta;
                    } else {
                        patrol.timeAwayFromPlayer = 0;
                    }

                    // Jump out if too far for 1 minute
                    if (patrol.timeAwayFromPlayer > 60 && !patrol.isJumpingOut) {
                        this.handlePatrolJumpOut(patrol);
                        return; // Skip further updates for this patrol
                    }

                    if (!patrol.isHostile) {
                        if (distToPlayer < 1200) {
                            patrol.isHostile = true;
                            this.showNotification("TACTICAL ALERT: Crimson Rift Cartel Patrol Hostile!", "error");
                            this.speak("Hostile pirate patrol detected. Shields up.");
                        }
                    }
                }

                const targetPoint = patrol.path[patrol.pathIndex];
                if (patrol.center.distanceTo(targetPoint) < 500) {
                    patrol.pathIndex = (patrol.pathIndex + 1) % patrol.path.length;
                }

                activeNpcs.forEach(npc => {
                    this.updateNpcBehavior(npc, patrol, playerPos);
                });
            }
        });

        // Update independent mining ships
        this.npcs.filter(n => n.behavior === 'mining').forEach(npc => {
            this.updateMiningNpcBehavior(npc);
        });

        // Update battleground NPCs that are not part of world patrol groups
        this.npcs.filter(n => n.behavior === 'battleground').forEach(npc => {
            this.updateNpcBehavior(npc, null, playerPos);
        });

        // Update bio creatures
        this.npcs.filter(n => n.type === 'BIO' || n.isBio).forEach(npc => {
            if (npc instanceof SpaceSquid) return; // Already handled in spaceSquids loop
            this.updateNpcBehavior(npc, null, playerPos);
        });
    }

    updateMiningNpcBehavior(npc) {
        if (!npc.sprite) return;
        const npcPos = new THREE.Vector2(npc.sprite.position.x, npc.sprite.position.y);
        const steerForce = new THREE.Vector2(0, 0);

        // State Machine
        if (npc.miningState === 'find_asteroid') {
            const asteroids = this.entities.filter(e => ASTEROID_TYPES.some(t => t.name === e.type) && e.oreAmount > 0);
            if (asteroids.length > 0) {
                // Find nearest asteroid
                asteroids.sort((a, b) => {
                    const distA = npcPos.distanceTo(new THREE.Vector2(a.x, a.y));
                    const distB = npcPos.distanceTo(new THREE.Vector2(b.x, b.y));
                    return distA - distB;
                });
                npc.target = asteroids[0];
                npc.miningState = 'move_to_asteroid';
            }
        }

        if (npc.miningState === 'move_to_asteroid') {
            if (!npc.target || npc.target.oreAmount <= 0) {
                npc.miningState = 'find_asteroid';
                npc.target = null;
            } else {
                const targetPos = new THREE.Vector2(npc.target.x, npc.target.y);
                const dist = npcPos.distanceTo(targetPos);
                const optimalRange = 150;

                if (dist < optimalRange) {
                    npc.miningState = 'extracting';
                    npc.velocity.multiplyScalar(0.5); // Slow down
                } else {
                    const dir = new THREE.Vector2().subVectors(targetPos, npcPos).normalize();
                    const targetRotation = Math.atan2(-dir.x, dir.y);
                    let diff = targetRotation - npc.rotation;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    npc.rotation += Math.max(-npc.stats.turnSpeed, Math.min(npc.stats.turnSpeed, diff));
                    
                    const forward = new THREE.Vector2(-Math.sin(npc.rotation), Math.cos(npc.rotation));
                    steerForce.add(forward.multiplyScalar(0.1));
                }
            }
        }

        if (npc.miningState === 'extracting') {
            if (!npc.target || npc.target.oreAmount <= 0) {
                npc.miningState = 'find_asteroid';
                npc.target = null;
                npc.locking.state = 'Idle';
            } else if (npc.cargo >= npc.maxCargo) {
                npc.miningState = 'full_cargo';
                npc.jumpStartTime = Date.now();
                npc.locking.state = 'Idle';
                npc.target = null;
            } else {
                const targetPos = new THREE.Vector2(npc.target.x, npc.target.y);
                const dist = npcPos.distanceTo(targetPos);
                
                // Rotation to face target
                const dir = new THREE.Vector2().subVectors(targetPos, npcPos).normalize();
                const targetRotation = Math.atan2(-dir.x, dir.y);
                let diff = targetRotation - npc.rotation;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                npc.rotation += Math.max(-npc.stats.turnSpeed, Math.min(npc.stats.turnSpeed, diff));

                // Maintain range
                if (dist > 200) {
                    const forward = new THREE.Vector2(-Math.sin(npc.rotation), Math.cos(npc.rotation));
                    steerForce.add(forward.multiplyScalar(0.05));
                } else if (dist < 100) {
                    const forward = new THREE.Vector2(-Math.sin(npc.rotation), Math.cos(npc.rotation));
                    steerForce.add(forward.multiplyScalar(-0.05));
                }

                // Lock and Fire
                this.updateNpcLocking(npc, npc.target);
                if (npc.locking.state === 'Locked') {
                    this.npcFireMiningLaser(npc, 'weapon1', npc.target);
                }
            }
        }

        if (npc.miningState === 'full_cargo') {
            const elapsed = (Date.now() - npc.jumpStartTime) / 1000;
            if (elapsed >= 10) {
                npc.miningState = 'jumping';
                this.destroyTarget(npc); // Jump away
            } else {
                // Just drift or slow down
                npc.velocity.multiplyScalar(0.95);
            }
        }

        // Final physics apply
        npc.velocity.add(steerForce);
        npc.velocity.multiplyScalar(0.98);
        const speed = npc.velocity.length();
        if (speed > npc.stats.maxSpeed) npc.velocity.setLength(npc.stats.maxSpeed);
        
        npc.sprite.position.x += npc.velocity.x;
        npc.sprite.position.y += npc.velocity.y;
        if (npc.sprite.isMesh) {
            npc.sprite.rotation.z = npc.rotation;
        } else {
            npc.sprite.material.rotation = npc.rotation;
        }
        npc.x = npc.sprite.position.x;
        npc.y = npc.sprite.position.y;

        if (npc.weaponCooldowns && npc.weaponCooldowns.weapon1 > 0) {
            npc.weaponCooldowns.weapon1 = Math.max(0, npc.weaponCooldowns.weapon1 - 0.016);
        }
    }

    npcFireMiningLaser(npc, slotId, target) {
        if (!npc.weaponCooldowns || npc.weaponCooldowns[slotId] > 0) return;
        if (!target || !target.sprite) return;
        if (!npc.locking || npc.locking.state !== 'Locked') return;

        const module = npc.fittings ? npc.fittings[slotId] : null;
        if (!module) return;
        
        // AUTHORITATIVE HYDRATION: Ensure NPC modules also use calculated stats
        const effectiveModule = module.final_stats ? module : hydrateItem(module);
        const fStats = effectiveModule.final_stats;

        const size = (module.weaponsize || module.size || 'S').toUpperCase();
        const miningConfig = MINING_LASER_CONFIGS[size] || MINING_LASER_CONFIGS['S'];
        const maxRange = fStats.falloffRange || miningConfig.falloffRange || 400;
        
        const npcPos = new THREE.Vector2(npc.sprite.position.x, npc.sprite.position.y);
        const targetPosVec = new THREE.Vector2(target.x, target.y);
        const dist = npcPos.distanceTo(targetPosVec);
        
        if (dist > maxRange) return; // Strictly enforced falloff limit

        // Authoritative tick rate
        npc.weaponCooldowns[slotId] = fStats.fireRate || fStats.cycle_time || miningConfig.fireRate || 1.0;

        // Visual Effect
        const start = npc.sprite.position.clone();
        const end = target.sprite.position.clone();
        if (target.radius) {
            const dir = new THREE.Vector3().subVectors(start, end).normalize();
            end.add(dir.multiplyScalar(target.radius));
        }

        const laserGeom = new THREE.BufferGeometry().setFromPoints([start, end]);
        const laserMat = new THREE.LineBasicMaterial({ color: 0xccffff, transparent: true, opacity: 0.8, linewidth: 4 });
        const laser = new THREE.Line(laserGeom, laserMat);
        laser.renderOrder = 30;
        this.scene.add(laser);

        let op = 0.8;
        const f = () => {
            op -= 0.05;
            laser.material.opacity = op;
            if (op > 0) requestAnimationFrame(f);
            else {
                this.scene.remove(laser);
                laser.geometry.dispose();
                laser.material.dispose();
            }
        };
        f();

        // Mining logic using authoritative stats
        const oreExtracted = Number((fStats.mining_yield || fStats.baseExtraction || 1.0).toFixed(2));
        const actualExtraction = Math.min(target.oreAmount, oreExtracted);
        
        target.oreAmount -= actualExtraction;
        npc.cargo += actualExtraction;
        npc.cargoType = target.oreType || target.type; // Track what's being mined
        npc.cargoQL = target.ql || 1;
        npc.cargoQLBand = target.qlBand || getQLBand(npc.cargoQL);

        if (target.oreAmount <= 0) {
            this.destroyTarget(target);
        }
    }

    updateAsteroidProximity(dt) {
        if (!this.ship || !this.ship.sprite) return;
        const playerPos = new THREE.Vector2(this.ship.sprite.position.x, this.ship.sprite.position.y);
        const system = resolveSystemDefinition(this.currentSystemId);
        if (!system) return;

        // Biological entities only spawn in non-secure space (security <= 0.9)
        if (system.securityValue > 0.9) return;

        this.entities.forEach(entity => {
            // Check if it's an asteroid
            const isAsteroid = ASTEROID_TYPES.some(t => t.name === entity.type);
            if (!isAsteroid || entity.disturbed) return;

            const dist = playerPos.distanceTo(new THREE.Vector2(entity.x, entity.y));
            const triggerRange = 350; // Distance to trigger a swarm

            if (dist < triggerRange) {
                entity.disturbed = true;
                
                // Base spawn chance increases with lower security
                const baseChance = 0.08; // 8% base
                const securityBonus = (1.0 - system.securityValue) * 0.15; // Up to +15% in nullsec
                const spawnChance = baseChance + securityBonus;

                if (Math.random() < spawnChance) {
                    // Determine creature type based on security and tier
                    let creatureType = 'Star-Eater Larva';
                    this.spawnBioSwarm(entity, creatureType);
                }
            }
        });
    }

    createBioPulseEffect(position, radius) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(200, 255, 200, 0.8)');
        grad.addColorStop(0.6, 'rgba(100, 255, 100, 0.3)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        const pulse = new THREE.Sprite(material);
        pulse.position.copy(position);
        pulse.scale.set(10, 10, 1);
        pulse.renderOrder = 35;
        this.scene.add(pulse);
        
        const duration = 1000;
        const start = Date.now();
        const animate = () => {
            const t = (Date.now() - start) / duration;
            if (t >= 1) {
                this.scene.remove(pulse);
                texture.dispose();
                material.dispose();
                return;
            }
            pulse.scale.set(radius * 2 * t, radius * 2 * t, 1);
            pulse.material.opacity = 1 - t;
            requestAnimationFrame(animate);
        };
        animate();
    }

    spawnSingleBioCreature(creatureType, posX, posY, angle = 0, powerMult = 1.0, options = {}) {
        if (creatureType === 'Star-Eater Broodmother') {
            const boss = this.spawnBroodmother(new THREE.Vector3(posX, posY, 0));
            if (boss && options.isAggravated) boss.isAggravated = true;
            return boss;
        }
        const config = BIO_CREATURE_REGISTRY[creatureType];
        if (!config) return;

        const textureLoader = new THREE.TextureLoader();
        const __origLoadAsync = textureLoader.loadAsync.bind(textureLoader);
textureLoader.loadAsync = (url) => {
  console.log("[TextureLoader] loadAsync url =", url);
  if (!url || typeof url !== "string") {
    console.warn("[TextureLoader] INVALID URL (will crash):", url);
  }
  return __origLoadAsync(url);
};
        textureLoader.load(config.spriteUrl, (loadedTexture) => {
            const img = loadedTexture.image;
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const threshold = 35; // Remove black background
            for (let i = 0; i < data.length; i += 4) {
                const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
                if (brightness < threshold) {
                    data[i+3] = 0;
                }
            }
            ctx.putImageData(imageData, 0, 0);
            
            const texture = new THREE.CanvasTexture(canvas);
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.LinearFilter;
            
            const frames = config.frames || 1;
            const frameAspect = (img.width / frames) / img.height;

            if (config.frames) {
                texture.repeat.set(1 / frames, 1);
                texture.offset.set(0, 0);
            }
            
            const bioId = `bio-${creatureType}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
            
            const spriteMaterial = new THREE.SpriteMaterial({ 
                map: texture, 
                transparent: true, 
                opacity: 0,
                color: 0xffffff, // Pure white to preserve original asset colors
                rotation: angle + Math.PI / 2 // Offset for horizontal spritesheet
            });
            
            const sprite = new THREE.Sprite(spriteMaterial);
            
            let visualScale = 185; // Increased from 140 for Larvae
            if (config.classId === 'Medium Bio-Creature') visualScale = 220; 
            if (config.classId === 'Large Bio-Creature') visualScale = 280; 
            if (config.classId === 'Stationary Bio-Creature') visualScale = 500; 
            
            sprite.scale.set(visualScale * frameAspect, visualScale, 1);
            sprite.position.set(posX, posY, 0);
            sprite.renderOrder = 6;
            this.scene.add(sprite);

            const start = Date.now();
            const animateFade = () => {
                const t = Math.min(1, (Date.now() - start) / 500);
                sprite.material.opacity = t;
                if (t < 1) requestAnimationFrame(animateFade);
            };
            animateFade();

            const npc = {
                id: bioId,
                type: 'BIO',
                creatureType: creatureType,
                classId: config.classId,
                x: posX,
                y: posY,
                radius: config.collisionRadius || (visualScale * 0.4),
                sigRadius: config.baseSigRadius,
                sprite: sprite,
                velocity: new THREE.Vector2(0, 0),
                rotation: angle,
                isBio: true,
                isGasCloud: true, // Biological entities are squishy and permeable, releasing corrosive gas
                frameCount: frames,
                currentFrame: 0,
                animTimer: 0,
                fps: config.fps || 0,
                noLockOn: config.noLockOn,
                targetingType: config.targetingType,
                isPassiveUntilAttacked: config.isPassiveUntilAttacked || false,
                isAggravated: options.isAggravated || false,
                canSpawn: config.canSpawn || false,
                canDash: config.canDash !== undefined ? config.canDash : true,
                stationary: config.stationary || false,
                forcedRole: config.forcedRole || null,
                stats: {
                    hp: config.hp * powerMult,
                    maxHp: config.hp * powerMult,
                    shields: (config.maxShields || 0) * powerMult,
                    maxShields: (config.maxShields || 0) * powerMult,
                    armor: config.armor,
                    maxSpeed: config.maxSpeed,
                    turnSpeed: config.turnSpeed,
                    damageMultiplier: powerMult
                },
                abilities: JSON.parse(JSON.stringify(config.abilities)),
                cooldowns: {},
                target: null,
                combatPhase: 'stalk',
                animTimer: 0,
                currentFrame: 0,
                frameCount: config.frames || 1
            };

            npc.ai = new NPCAI(npc, this);
            this.npcs.push(npc);
            this.entities.push(npc);
        });
    }

    spawnLarvaeFromParent(parent) {
        if (!parent || !parent.sprite) return;
        const config = BIO_CREATURE_REGISTRY[parent.creatureType];
        if (!config || !config.abilities.spawn) return;

        const spawnCount = config.abilities.spawn.count || 3;
        const system = resolveSystemDefinition(this.currentSystemId);
        const security = system?.securityValue || 1.0;
        const powerMult = 1.0 + (1.0 - security) * 0.8;

        for (let i = 0; i < spawnCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = parent.radius + 30 + Math.random() * 50;
            const px = parent.x + Math.cos(angle) * dist;
            const py = parent.y + Math.sin(angle) * dist;
            this.spawnSingleBioCreature('Star-Eater Larva', px, py, angle, powerMult, { isAggravated: true });
        }

        this.createBioPulseEffect(parent.sprite.position, parent.radius * 2);
    }

    spawnBioSwarm(sourceEntity, creatureType) {
        const config = BIO_CREATURE_REGISTRY[creatureType];
        if (!config) return;

        const system = resolveSystemDefinition(this.currentSystemId);
        const security = system?.securityValue || 1.0;
        
        // Swarm size depends on security
        let minCount = 2, maxCount = 3;
        if (security < 0.5) { minCount = 3; maxCount = 5; }
        if (security < 0.2) { minCount = 4; maxCount = 6; }

        const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));
        
        this.showNotification("BIOLOGICAL ALERT: High-energy organic signatures emerging from asteroid!", "warning");
        this.speak("Organic life detected in proximity. Hostile intent confirmed.");

        const powerMult = 1.0 + (1.0 - security) * 0.8;
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const offsetDist = sourceEntity.radius + 20 + Math.random() * 40;
            const posX = sourceEntity.x + Math.cos(angle) * offsetDist;
            const posY = sourceEntity.y + Math.sin(angle) * offsetDist;
            this.spawnSingleBioCreature(creatureType, posX, posY, angle, powerMult, { isAggravated: true });
        }
    }

    updateNpcBehavior(npc, patrol, playerPos) {
        if (!npc.sprite) return;
        
        const playerIsAimingAtMe = this.target && this.target.id === npc.id;
        const playerVelocity = this.ship ? this.ship.velocity : new THREE.Vector2(0, 0);

        if (npc.ai) {
            npc.ai.update(0.016, playerPos, playerVelocity, playerIsAimingAtMe);
        } else {
            // Fallback to legacy behavior if AI not initialized
            // ... original code if needed, but we'll ensure ai is initialized
        }
    }

    npcFireWeapon(npc, slotId, playerTarget) {
        if (!npc.weaponCooldowns || npc.weaponCooldowns[slotId] > 0) return;
        if (!playerTarget || !playerTarget.sprite) return;
        
        // LOCK DISCIPLINE: NPC must be locked on to fire
        if (!npc.locking || npc.locking.state !== 'Locked') return;

        const module = npc.fittings ? npc.fittings[slotId] : null;
        if (!module) return;

        const nameLower = (module.name || '').toLowerCase();
        const isMissile = nameLower.includes('seeker pod');
        const isFlux = nameLower.includes('laser');
        const isPulse = nameLower.includes('pulse cannon');

        if (isFlux) {
            const config = FLUX_LASER_CONFIGS[module.weaponsize || 'S'];
            
            // FIRING ARC AND RANGE DISCIPLINE
            const npcPos = new THREE.Vector2(npc.sprite.position.x, npc.sprite.position.y);
            const playerPos = new THREE.Vector2(playerTarget.sprite.position.x, playerTarget.sprite.position.y);
            const dist = npcPos.distanceTo(playerPos);
            const toPlayer = new THREE.Vector2().subVectors(playerPos, npcPos).normalize();
            const forward = new THREE.Vector2(-Math.sin(npc.rotation), Math.cos(npc.rotation));
            
            const dot = forward.dot(toPlayer);
            const angleToTarget = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
            
            // Discipline: Only fire within firing arc AND (optimal + falloff) range
            if (angleToTarget > (config.hitArc || 22.5)) return;
            const maxRange = config.optimalRange + config.falloffRange;
            if (dist > maxRange) return;

            // Energy Cost Check
            if (npc.stats.energy < 1) return; 

            npc.weaponCooldowns[slotId] = 1.0 / config.fireRate;
            npc.stats.energy -= 0.5;

            // Visual Effect: Laser Beam
            const start = npc.sprite.position.clone();
            const end = playerTarget.sprite.position.clone();
            
            // Audio
            if (this.weaponSynth) {
                try {
                    if (this.fluxPlayer && this.fluxPlayer.loaded) {
                        this.playFluxLaserSound();
                    } else {
                        this.weaponSynth.triggerAttackRelease("E3", "16n", Tone.now());
                    }
                } catch (e) {}
            }

            const laserGeom = new THREE.BufferGeometry().setFromPoints([start, end]);
            const laserMat = new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.8 });
            const laser = new THREE.Line(laserGeom, laserMat);
            laser.renderOrder = 30;
            this.scene.add(laser);

            let op = 0.8;
            const f = () => {
                op -= 0.1;
                laser.material.opacity = op;
                if (op > 0) requestAnimationFrame(f);
                else {
                    this.scene.remove(laser);
                    laser.geometry.dispose();
                    laser.material.dispose();
                }
            };
            f();

            // Accuracy and Falloff Check
            const playerSig = this.stats.finalSigRadius || this.stats.sigRadius || 22;
            const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
            const rarityIndex = rarityTiers.indexOf(module.rarity || 'common');
            const trackingBonus = Math.max(0, rarityIndex); 

            const baseAccuracy = config.baseAccuracy || 0.85;
            const tracking = (config.tracking || 28) + trackingBonus;
            
            let rangeFactor = 1.0;
            if (dist > config.optimalRange) {
                rangeFactor = Math.max(0, 1.0 - (dist - config.optimalRange) / config.falloffRange);
            }

            const distFactor = Math.max(0.5, 1.0 - Math.max(0, dist - config.optimalRange) / 1000);
            const hitChance = Math.min(0.92, Math.max(0.0, baseAccuracy * Math.pow(tracking / playerSig, 1.2) * distFactor));
            const isMiss = Math.random() > hitChance;
            
            if (!isMiss) {
                const baseDmg = config.damagePerTick * (npc.stats.damageMultiplier || 1.0) * rangeFactor;
                const dmgResult = this.takeDamage(baseDmg, 'thermal');
                if (dmgResult.shieldDamage > 0) {
                    this.showDamageNumber(playerTarget, dmgResult.shieldDamage, false, false, 'shield', 'player-ship');
                }
                if (dmgResult.hullDamage > 0) {
                    this.showDamageNumber(playerTarget, dmgResult.hullDamage, false, false, 'hull', 'player-ship');
                }
            } else if (playerTarget.sprite) {
                this.showDamageNumber(playerTarget, 0, false, true, 'standard', 'player-ship');
            }
        } else if (isPulse) {
            const config = PULSE_CANNON_CONFIGS[module.weaponsize || 'S'];
            
            // Ammo Management
            if (!npc.ammo) npc.ammo = {};
            if (!npc.ammo[slotId]) npc.ammo[slotId] = { current: config.magazine, reloading: false, reloadStartTime: 0 };
            const ammo = npc.ammo[slotId];

            if (ammo.reloading) {
                if (Date.now() - ammo.reloadStartTime > (module.reload || config.reload) * 1000) {
                    ammo.current = config.magazine;
                    ammo.reloading = false;
                }
                return;
            }

            if (ammo.current <= 0) {
                ammo.reloading = true;
                ammo.reloadStartTime = Date.now();
                return;
            }

            // ARC AND RANGE
            const npcPos = new THREE.Vector2(npc.sprite.position.x, npc.sprite.position.y);
            const playerPos = new THREE.Vector2(playerTarget.sprite.position.x, playerTarget.sprite.position.y);
            const dist = npcPos.distanceTo(playerPos);
            const toPlayer = new THREE.Vector2().subVectors(playerPos, npcPos).normalize();
            const forward = new THREE.Vector2(-Math.sin(npc.rotation), Math.cos(npc.rotation));
            const angleToTarget = Math.acos(Math.min(1, Math.max(-1, forward.dot(toPlayer)))) * (180 / Math.PI);

            if (angleToTarget > 25) return;
            if (dist > config.optimalRange * 1.5) return;
            if (npc.stats.energy < 2) return;

            npc.weaponCooldowns[slotId] = 1.0 / config.fireRate;
            npc.stats.energy -= 1.5;
            ammo.current--;

            const playerSig = this.stats.finalSigRadius || this.stats.sigRadius || 22;
            const hitChance = Math.min(1.0, Math.max(0.0, (config.baseAccuracy || 0.7) * (config.tracking / playerSig)));
            
            const startPos = npc.sprite.position.clone();
            const speed = (module.projectileSpeed || config.projectileSpeed) * 2.0;

            // Apply slight spread for NPC kinetic fire
            const npcSpread = 15;
            const npcAimPoint = new THREE.Vector2(
                playerPos.x + (Math.random() - 0.5) * npcSpread,
                playerPos.y + (Math.random() - 0.5) * npcSpread
            );
            const finalToPlayer = new THREE.Vector2().subVectors(npcAimPoint, npcPos).normalize();

            const relativeVelocity = new THREE.Vector3(finalToPlayer.x, finalToPlayer.y, 0).multiplyScalar(speed);
            
            // Add NPC's current velocity so projectiles inherit NPC momentum
            const velocity = new THREE.Vector3(
                relativeVelocity.x + (npc.velocity.x || 0),
                relativeVelocity.y + (npc.velocity.y || 0),
                0
            );
            
            const projectile = new PulseProjectile(
                this.scene, slotId, module, startPos, velocity, config.damage * (npc.stats.damageMultiplier || 1.0), hitChance, this, speed
            );
            projectile.isPlayerTarget = true; // Mark as targeting player
            this.projectiles.push(projectile);

            // Audio
            if (this.weaponSynth) {
                try {
                    if (this.pulsePlayer && this.pulsePlayer.loaded) {
                        this.pulsePlayer.start(Tone.now());
                    } else {
                        this.weaponSynth.triggerAttackRelease("C3", "16n", Tone.now());
                    }
                } catch (e) {}
            }
        } else if (isMissile) {
            const config = MISSILE_CONFIGS[(module.weaponsize || 'S').toUpperCase()];
            const mods = MISSILE_RARITY_MODS[module.rarity || 'common'];
            
            const npcPos = new THREE.Vector2(npc.sprite.position.x, npc.sprite.position.y);
            const playerPos = new THREE.Vector2(playerTarget.sprite.position.x, playerTarget.sprite.position.y);
            const dist = npcPos.distanceTo(playerPos);
            
            if (dist > config.optimalRange * 1.2) return;
            if (npc.stats.energy < 5) return;

            npc.weaponCooldowns[slotId] = config.reload * mods.reload;
            npc.stats.energy -= 5;

            // Accuracy and Tracking Check
            const playerSig = this.stats.finalSigRadius || this.stats.sigRadius || 22;
            const baseAccuracy = 0.85;
            const attackerTracking = config.tracking * mods.tracking;
            const hitChance = Math.min(1.0, Math.max(0.0, baseAccuracy * (attackerTracking / playerSig)));

            // Missile asset texture (reusing player missile texture if possible or creating a placeholder)
            if (!this._npcMissileTexture) {
                const canvas = document.createElement('canvas');
                canvas.width = 32; canvas.height = 32;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ff4444';
                ctx.beginPath();
                ctx.arc(16, 16, 8, 0, Math.PI * 2);
                ctx.fill();
                this._npcMissileTexture = new THREE.CanvasTexture(canvas);
            }

            // Spawn missile projectile
            const startPos = npc.sprite.position.clone();
            const missile = new MissileProjectile(
                this.scene, slotId, module, startPos, playerTarget,
                config.tracking * mods.tracking, config.missileSpeed * mods.speed, config.flightTime * mods.speed,
                config.damage * mods.dmg, config.aoeRadius * mods.aoe, hitChance,
                this, this._npcMissileTexture
            );
            
            // Set missile to hit player
            missile.isPlayerTarget = true;
            this.missiles.push(missile);

            // Audio
            if (this.weaponSynth) {
                try {
                    this.weaponSynth.triggerAttackRelease("G2", "4n", Tone.now());
                } catch (e) {}
            }
        }
    }

    getNpcConfig(type) {
        return SHIP_REGISTRY[type] || BIO_CREATURE_REGISTRY[type] || null;
    }

    updateNpcLocking(npc, playerTarget) {
        if (!playerTarget || !playerTarget.sprite) {
            npc.locking.state = 'Idle';
            npc.locking.entity = null;
            return;
        }

        const npcPos = new THREE.Vector2(npc.sprite.position.x, npc.sprite.position.y);
        const playerPos = new THREE.Vector2(playerTarget.sprite.position.x, playerTarget.sprite.position.y);
        const dist = npcPos.distanceTo(playerPos);
        
        // Use the lock-on range from the ship registry or default to 700
        const shipConfig = this.getNpcConfig(npc.shipType);
        if (!shipConfig) return;
        
        const lockRange = shipConfig.lockOnRange || 700;

        // BIO-CREATURE OVERRIDE: Instant lock for proximity-based creatures
        if (shipConfig.noLockOn) {
            if (dist <= lockRange) {
                npc.locking.state = 'Locked';
                npc.locking.entity = playerTarget;
            } else {
                npc.locking.state = 'Idle';
                npc.locking.entity = null;
            }
            return;
        }

        // Handle active lock
        if (npc.locking.state === 'Locked') {
            if (dist > lockRange) {
                npc.locking.state = 'Idle';
                npc.locking.entity = null;
            }
            return;
        }

        // Handle priming
        if (npc.locking.state === 'Priming') {
            if (dist > lockRange) {
                npc.locking.state = 'Idle';
                npc.locking.entity = null;
                return;
            }

            const now = Date.now();
            const elapsed = now - npc.locking.startTime;
            if (elapsed >= npc.locking.requiredTime) {
                npc.locking.state = 'Locked';
            }
            return;
        }

        // Handle starting a lock
        if (npc.locking.state === 'Idle') {
            if (dist <= lockRange) {
                const baseLockTime = this.calculateFinalLockTime(npc.fittings);
                // NPC is attacker, player is target
                // computeLockTime(attackerConfig, targetStats, baseLockTime)
                const calculatedLockTime = this.computeLockTime(shipConfig, this.stats, baseLockTime);
                
                npc.locking.state = 'Priming';
                npc.locking.startTime = Date.now();
                npc.locking.requiredTime = calculatedLockTime;
                npc.locking.entity = playerTarget;
            }
        }
    }

    // --- TRADE SYSTEM METHODS ---

    getReferencePrice(itemId) {
        if (!itemId) return 100;
        const idLower = itemId.toLowerCase();
        if (idLower.includes('silicite')) return TRADE_CONFIG.ORE_RP * 1.0;
        if (idLower.includes('ferronite')) return TRADE_CONFIG.ORE_RP * 2.5;
        if (idLower.includes('aurellite')) return TRADE_CONFIG.ORE_RP * 8.0;
        if (idLower.includes('xenotite')) return TRADE_CONFIG.ORE_RP * 25.0;
        if (idLower.includes('blueprint')) return TRADE_CONFIG.BLUEPRINT_RP;
        if (idLower.includes('ship')) return TRADE_CONFIG.SMALL_SHIP_RP;
        if (idLower.includes('catalyst')) return 500;
        if (idLower.includes('bio-material')) return 300;
        return 100; // Default reference price
    }

    listTradeItem(item, price, quantity, systemId, tradeType = 'limit_order', duration = 86400000) {
        const rp = this.getReferencePrice(item.id || item.blueprintId || item.materialKey || item.catalystId);
        const minPrice = rp * TRADE_CONFIG.PRICE_BAND_MIN;
        const maxPrice = rp * TRADE_CONFIG.PRICE_BAND_MAX;

        if (price < minPrice || price > maxPrice) {
            return { 
                success: false, 
                error: `REGULATORY VIOLATION: Price for ${item.name} must be between ${minPrice.toFixed(2)} and ${maxPrice.toFixed(2)} Cr.` 
            };
        }

        // Apply Interstellar Economics Skill: -0.5% fee per level (max 50% reduction at level 100)
        const economicsSkill = this.stats.commanderStats?.interstellarEconomics || 0;
        const feeReduction = 1 - (economicsSkill * 0.005);
        const listingFee = price * quantity * TRADE_CONFIG.LISTING_FEE_PERCENT * feeReduction;
        
        const listing = {
            id: `listing-${uuid()}`,
            sellerId: cloudService.user?.id || 'local',
            sellerName: cloudService.user?.name || 'Commander',
            item: { ...item, amount: quantity }, // Ensure listing knows its specific quantity
            price: parseFloat(price),
            quantity: parseInt(quantity),
            originSystemId: systemId,
            type: tradeType,
            timestamp: Date.now(),
            expiresAt: Date.now() + duration,
            bids: [], // For auctions
            highBidderId: null,
            highBidderName: null
        };

        return { success: true, listing, fee: listingFee };
    }

    buyTradeItem(listingId, buyerId, requestedQuantity = null) {
        let foundListing = null;
        let foundSystemId = null;
        let marketType = null;

        // Search across all systems and all market types for the listing
        for (const sysId in this.globalMarkets) {
            const market = this.globalMarkets[sysId];
            
            // Check commodities
            const commIdx = market.commodities.findIndex(l => l.id === listingId);
            if (commIdx !== -1) {
                foundListing = market.commodities[commIdx];
                foundSystemId = sysId;
                marketType = 'commodities';
                break;
            }

            // Check auctions (buyout is not currently implemented but listing check should be robust)
            const aucIdx = market.auctions?.findIndex(l => l.id === listingId);
            if (aucIdx !== -1) {
                foundListing = market.auctions[aucIdx];
                foundSystemId = sysId;
                marketType = 'auctions';
                break;
            }
        }

        if (!foundListing) return { success: false, error: "Listing expired or no longer available." };

        const buyQuantity = requestedQuantity !== null ? Math.min(requestedQuantity, foundListing.quantity) : foundListing.quantity;

        // Apply Interstellar Economics Skill: -0.5% tax per level (max 50% reduction at level 100)
        const economicsSkill = this.stats.commanderStats?.interstellarEconomics || 0;
        const taxReduction = 1 - (economicsSkill * 0.005);
        const tax = foundListing.price * buyQuantity * TRADE_CONFIG.SALES_TAX_PERCENT * taxReduction;

        // Record for price history
        this.recordTradeHistory(foundListing.item, foundListing.price, buyQuantity, foundSystemId);

        // Update listing quantity or remove it
        let listingToRemove = null;
        if (!foundListing.sellerId.startsWith('NPC_')) {
            if (buyQuantity < foundListing.quantity) {
                foundListing.quantity -= buyQuantity;
            } else {
                // Filter it out in the next step or return a flag
                this.globalMarkets[foundSystemId][marketType] = this.globalMarkets[foundSystemId][marketType].filter(l => l.id !== listingId);
                listingToRemove = listingId;
            }
        }

        return { 
            success: true, 
            listing: { ...foundListing, quantity: buyQuantity }, 
            systemId: foundSystemId, 
            tax,
            listingToRemove,
            remainingQuantity: foundListing.sellerId.startsWith('NPC_') ? foundListing.quantity : (foundListing.quantity - buyQuantity)
        };
    }

    cancelTradeItem(listingId, userId) {
        let foundListing = null;
        let foundSystemId = null;
        let foundType = null;

        for (const sysId in this.globalMarkets) {
            const market = this.globalMarkets[sysId];
            
            const commIdx = market.commodities.findIndex(l => l.id === listingId);
            if (commIdx !== -1) {
                foundListing = market.commodities[commIdx];
                foundSystemId = sysId;
                foundType = 'commodities';
                break;
            }

            const aucIdx = market.auctions?.findIndex(l => l.id === listingId);
            if (aucIdx !== -1) {
                foundListing = market.auctions[aucIdx];
                foundSystemId = sysId;
                foundType = 'auctions';
                break;
            }
        }

        if (!foundListing) return { success: false, error: "Listing not found." };
        if (foundListing.sellerId !== userId) return { success: false, error: "Unauthorized: You do not own this listing." };
        if (foundListing.type === 'auction' && foundListing.bids?.length > 0) return { success: false, error: "Cannot cancel auction with active bids." };

        // Return item to seller's regional storage
        if (!this.regionalStorage[foundSystemId]) this.regionalStorage[foundSystemId] = {};
        if (!this.regionalStorage[foundSystemId][userId]) this.regionalStorage[foundSystemId][userId] = [];
        this.regionalStorage[foundSystemId][userId].push(foundListing.item);

        // Remove from market
        this.globalMarkets[foundSystemId][foundType] = this.globalMarkets[foundSystemId][foundType].filter(l => l.id !== listingId);

        return { success: true, item: foundListing.item, systemId: foundSystemId };
    }

    recordTradeHistory(item, price, quantity, systemId) {
        const itemId = item.id || item.blueprintId || item.materialKey || item.catalystId;
        if (!this.marketHistory[itemId]) {
            this.marketHistory[itemId] = {
                history: [] // { price, quantity, timestamp, systemId }
            };
        }
        
        this.marketHistory[itemId].history.push({
            price,
            quantity,
            timestamp: Date.now(),
            systemId
        });

        // Limit history to last 200 entries for more data points
        if (this.marketHistory[itemId].history.length > 200) {
            this.marketHistory[itemId].history.shift();
        }
    }

    getMarketTrendData(itemId) {
        if (!this.marketHistory[itemId]) return [];
        
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const history = this.marketHistory[itemId].history;
        
        // Group by day for the last 7 days
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = now - (i + 1) * oneDay;
            const dayEnd = now - i * oneDay;
            const entries = history.filter(h => h.timestamp >= dayStart && h.timestamp < dayEnd);
            
            if (entries.length > 0) {
                const avgPrice = entries.reduce((sum, e) => sum + e.price, 0) / entries.length;
                days.push({ day: 6 - i, price: avgPrice, volume: entries.reduce((sum, e) => sum + e.quantity, 0) });
            } else {
                // If no trades, use the last known price or a default (like 0)
                const lastPrice = history.length > 0 ? history[history.length - 1].price : 0;
                days.push({ day: 6 - i, price: lastPrice, volume: 0 });
            }
        }
        return days;
    }

    getRegionalDemandData(itemId) {
        // Returns volume per system for the last 7 days
        const now = Date.now();
        const lookback = 7 * 24 * 60 * 60 * 1000;
        const history = (this.marketHistory[itemId]?.history || []).filter(h => h.timestamp > now - lookback);
        
        const demand = {}; // systemId -> volume
        history.forEach(h => {
            if (h.systemId) {
                demand[h.systemId] = (demand[h.systemId] || 0) + h.quantity;
            }
        });
        
        return demand;
    }

    collectTradeItem(storageItemId, collectorId, systemId) {
        if (!this.regionalStorage[systemId] || !this.regionalStorage[systemId][collectorId]) {
            return { success: false, error: "No storage records found at this coordinate." };
        }

        const items = this.regionalStorage[systemId][collectorId];
        const itemIdx = items.findIndex(i => (i.id || i.blueprintId || i.materialKey) === storageItemId);
        
        if (itemIdx === -1) return { success: false, error: "Item verification failed. Record mismatch." };

        const item = items[itemIdx];
        
        // Weight check
        const itemWeight = (parseFloat(item.weight) || 0.1) * (item.amount || 1);
        if (this.stats.currentCargoWeight + itemWeight > this.stats.cargoHold) {
            return { success: false, error: "Cargo Hold Capacity Exceeded." };
        }

        items.splice(itemIdx, 1);
        return { success: true, item };
    }

    depositTradeItem(item, userId, systemId) {
        if (!this.regionalStorage[systemId]) this.regionalStorage[systemId] = {};
        if (!this.regionalStorage[systemId][userId]) this.regionalStorage[systemId][userId] = [];
        
        const storage = this.regionalStorage[systemId][userId];
        
        // Try to stack if it's a stackable resource/ore
        const stackableTypes = ['resource', 'material', 'bio-material', 'ore'];
        const isStackable = stackableTypes.includes(item.type);
        
        if (isStackable) {
            const existingIdx = storage.findIndex(i => 
                (i.id === item.id || i.blueprintId === item.blueprintId || i.materialKey === item.materialKey)
            );
            
            if (existingIdx !== -1) {
                storage[existingIdx].amount = (storage[existingIdx].amount || 1) + (item.amount || 1);
                return { success: true };
            }
        }

        storage.push({
            ...item,
            acquiredAt: Date.now(),
            originSystemId: systemId,
            originSystemName: SYSTEMS_REGISTRY[systemId]?.name || "Local Starport"
        });

        return { success: true };
    }

    getGlobalRegionalStorage(userId) {
        const globalStorage = [];
        for (const [systemId, users] of Object.entries(this.regionalStorage || {})) {
            if (users[userId]) {
                users[userId].forEach(item => {
                    globalStorage.push({
                        ...item,
                        systemId,
                        systemName: SYSTEMS_REGISTRY[systemId]?.name || systemId
                    });
                });
            }
        }
        return globalStorage;
    }

    processExpiredAuctions(nowTime) {
        for (const systemId in this.globalMarkets) {
            const market = this.globalMarkets[systemId];
            if (!market.auctions) continue;

            for (let i = market.auctions.length - 1; i >= 0; i--) {
                const auction = market.auctions[i];
                if (nowTime > auction.expiresAt) {
                    console.log(`[Trade] Auction ${auction.id} expired.`);
                    
                    // Resolve auction
                    const winnerId = auction.highBidderId;
                    const sellerId = auction.sellerId;

                    if (winnerId) {
                        // Winner gets the item in regional storage
                        if (!this.regionalStorage[systemId]) this.regionalStorage[systemId] = {};
                        if (!this.regionalStorage[systemId][winnerId]) this.regionalStorage[systemId][winnerId] = [];
                        
                        this.regionalStorage[systemId][winnerId].push({
                            ...auction.item,
                            amount: auction.quantity,
                            acquiredAt: Date.now(),
                            originSystemId: systemId,
                            originSystemName: SYSTEMS_REGISTRY[systemId]?.name || "Unknown System"
                        });
                        
                        // Update Market History
                        this.recordTradeHistory(auction.item, auction.currentBid, auction.quantity, systemId);

                        // Seller gets the credits (if seller is local player, we need to handle this in App)
                        // For simplicity in this buildless env, we'll return metadata for App to process
                        if (this.onAuctionResolved) {
                            this.onAuctionResolved(auction);
                        }
                    } else {
                        // No winner: item returns to seller's regional storage
                        if (!this.regionalStorage[systemId]) this.regionalStorage[systemId] = {};
                        if (!this.regionalStorage[systemId][sellerId]) this.regionalStorage[systemId][sellerId] = [];
                        
                        this.regionalStorage[systemId][sellerId].push({
                            ...auction.item,
                            amount: auction.quantity,
                            acquiredAt: Date.now(),
                            originSystemId: systemId,
                            originSystemName: SYSTEMS_REGISTRY[systemId]?.name || "Unknown System"
                        });

                        if (this.onAuctionResolved) {
                            this.onAuctionResolved(auction, true); // true = failed/no-bid
                        }
                    }

                    // Remove from market
                    market.auctions.splice(i, 1);
                }
            }
        }
    }

    // --- Courier Contract System Methods ---

    createCourierContract(ownerId, ownerName, storageItemId, originSystemId, destinationSystemId, reward, collateral, durationMs) {
        if (!this.regionalStorage[originSystemId] || !this.regionalStorage[originSystemId][ownerId]) {
            return { success: false, error: "Source inventory not found." };
        }

        const items = this.regionalStorage[originSystemId][ownerId];
        const itemIdx = items.findIndex(i => (i.id || i.blueprintId || i.materialKey) === storageItemId);
        
        if (itemIdx === -1) return { success: false, error: "Item record missing from origin storage." };

        const item = items[itemIdx];
        
        // Remove item from storage (it's now "in escrow" for the contract)
        items.splice(itemIdx, 1);

        const contract = {
            id: `courier-${uuid()}`,
            ownerId,
            ownerName,
            item: item,
            originSystemId,
            destinationSystemId,
            reward: parseFloat(reward),
            collateral: parseFloat(collateral),
            expiresAt: Date.now() + durationMs,
            haulerId: null,
            status: 'available',
            createdAt: Date.now()
        };

        this.courierContracts.push(contract);
        console.log(`[Courier] Contract created: ${contract.id} to move ${item.name}`);
        return { success: true, contract };
    }

    cancelCourierContract(contractId, userId) {
        const idx = this.courierContracts.findIndex(c => c.id === contractId);
        if (idx === -1) return { success: false, error: "Contract not found." };
        
        const contract = this.courierContracts[idx];
        if (contract.ownerId !== userId) return { success: false, error: "Unauthorized." };
        if (contract.status !== 'available') return { success: false, error: "Contract is already active or completed." };

        // Return item to owner's regional storage at origin
        const sysId = contract.originSystemId;
        if (!this.regionalStorage[sysId]) this.regionalStorage[sysId] = {};
        if (!this.regionalStorage[sysId][userId]) this.regionalStorage[sysId][userId] = [];
        this.regionalStorage[sysId][userId].push(contract.item);

        this.courierContracts.splice(idx, 1);
        return { success: true, rewardRefund: contract.reward };
    }

    acceptCourierContract(contractId, haulerId, haulerName) {
        const contract = this.courierContracts.find(c => c.id === contractId);
        if (!contract) return { success: false, error: "Contract no longer available." };
        if (contract.status !== 'available') return { success: false, error: "Contract already claimed." };
        if (contract.ownerId === haulerId) return { success: false, error: "Cannot accept your own contract." };

        contract.haulerId = haulerId;
        contract.haulerName = haulerName;
        contract.status = 'active';
        contract.acceptedAt = Date.now();

        console.log(`[Courier] Player ${haulerName} accepted contract ${contractId}`);
        return { success: true, contract };
    }

    pickupCourierPackage(contractId, haulerId) {
        const contract = this.courierContracts.find(c => c.id === contractId);
        if (!contract) return { success: false, error: "Contract not found." };
        if (contract.haulerId !== haulerId) return { success: false, error: "Unauthorized pickup." };
        if (contract.status !== 'active') return { success: false, error: "Contract is not in active state." };
        if (this.currentSystemId !== contract.originSystemId) return { success: false, error: "Not at origin starport." };

        // Create the "Package" item for the hauler's cargo
        const packageItem = {
            id: `package-${contract.id}`,
            name: `COURIER PACKAGE (${contract.item.name})`,
            type: 'courier-package',
            contractId: contract.id,
            weight: contract.item.weight || 2.0, // Packages might be slightly heavier due to crates?
            rarity: 'special',
            description: `A sealed shipping crate addressed to ${SYSTEMS_REGISTRY[contract.destinationSystemId]?.name}. Do not open.`
        };

        // Add to hauler's cargo (handled by App logic, but check weight here)
        if (this.stats.currentCargoWeight + packageItem.weight > this.stats.cargoHold) {
            return { success: false, error: "Cargo Hold Capacity Exceeded." };
        }

        contract.status = 'in-transit';
        console.log(`[Courier] Package picked up for contract ${contractId}`);
        return { success: true, packageItem };
    }

    deliverCourierPackage(contractId, haulerId) {
        const contract = this.courierContracts.find(c => c.id === contractId);
        if (!contract) return { success: false, error: "Contract not found." };
        if (contract.haulerId !== haulerId) return { success: false, error: "Unauthorized delivery." };
        if (contract.status !== 'in-transit') return { success: false, error: "Package not picked up yet." };
        if (this.currentSystemId !== contract.destinationSystemId) return { success: false, error: "Not at destination starport." };

        contract.status = 'completed';
        contract.completedAt = Date.now();

        // Move the original item to the owner's regional storage at the destination
        if (!this.regionalStorage[contract.destinationSystemId]) this.regionalStorage[contract.destinationSystemId] = {};
        if (!this.regionalStorage[contract.destinationSystemId][contract.ownerId]) this.regionalStorage[contract.destinationSystemId][contract.ownerId] = [];
        
        this.regionalStorage[contract.destinationSystemId][contract.ownerId].push({
            ...contract.item,
            acquiredAt: Date.now(),
            originSystemId: contract.destinationSystemId,
            originSystemName: SYSTEMS_REGISTRY[contract.destinationSystemId]?.name || "Unknown System"
        });

        console.log(`[Courier] Contract ${contractId} completed. Reward: ${contract.reward} Cr.`);
        return { success: true, reward: contract.reward, collateral: contract.collateral };
    }

    processExpiredContracts(nowTime) {
        for (let i = this.courierContracts.length - 1; i >= 0; i--) {
            const contract = this.courierContracts[i];
            if (nowTime > contract.expiresAt && contract.status !== 'completed') {
                console.log(`[Courier] Contract ${contract.id} expired.`);
                
                if (contract.status === 'available') {
                    // Return item to owner's regional storage at origin
                    const sysId = contract.originSystemId;
                    if (!this.regionalStorage[sysId]) this.regionalStorage[sysId] = {};
                    if (!this.regionalStorage[sysId][contract.ownerId]) this.regionalStorage[sysId][contract.ownerId] = [];
                    this.regionalStorage[sysId][contract.ownerId].push(contract.item);
                    this.courierContracts.splice(i, 1);
                } else {
                    // Contract was active or in-transit: it's now 'failed'
                    // Collateral is kept by the owner (handled in App logic)
                    contract.status = 'failed';
                    if (this.onContractFailed) this.onContractFailed(contract);
                }
            }
        }
    }
}
// Compatibility re-export
export { FLARE_URLS };