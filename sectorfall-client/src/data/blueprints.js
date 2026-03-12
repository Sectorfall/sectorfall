/**
 * blueprints.js
 * Extracted blueprint registry from GameManager.
 */

import { ITEM_CATALOG } from "./items/catalog.js";
import { resolveShipId } from "./ships/catalog.js";

export const BLUEPRINT_REGISTRY = {
    // Ships
    'omni-scout-chassis': {
        id: 'omni-scout-chassis',
        name: 'OMNI SCOUT Chassis Blueprint',
        outputType: 'ship',
        outputId: 'OMNI SCOUT',
        outputShipId: 'ship_omni_scout',
        outputItemId: 'ship_omni_scout',
        outputItemKey: 'ship_omni_scout',
        requirements: [
            { resource: 'Refined Ferronite', amount: 50 },
            { resource: 'Refined Silicite', amount: 100 }
        ],
        allowedModStats: ['kineticRes', 'thermalRes', 'blastRes', 'armor', 'maxEnergy', 'shieldRegen', 'reactorRecovery', 'maxSpeed', 'lockMultiplier', 'basePG', 'baseCPU', 'hp']
    },
    // Flux Lasers
    'blueprint-common-flux-laser-s': {
        id: 'bp-flux-s-common',
        name: 'Common Flux Laser Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Flux Laser S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 150 },
            { resource: 'Refined Ferronite', amount: 80 },
            { resource: 'Refined Aurellite', amount: 50 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'common-flux-laser-s': {
        id: 'bp-flux-s-common',
        name: 'Common Flux Laser Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Flux Laser S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 150 },
            { resource: 'Refined Ferronite', amount: 80 },
            { resource: 'Refined Aurellite', amount: 50 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'uncommon-flux-laser-s': {
        id: 'bp-flux-s-uncommon',
        name: 'Uncommon Flux Laser Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Flux Laser S',
        rarity: 'uncommon',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 165 },
            { resource: 'Refined Ferronite', amount: 88 },
            { resource: 'Refined Aurellite', amount: 55 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'rare-flux-laser-s': {
        id: 'bp-flux-s-rare',
        name: 'Rare Flux Laser Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Flux Laser S',
        rarity: 'rare',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 180 },
            { resource: 'Refined Ferronite', amount: 96 },
            { resource: 'Refined Aurellite', amount: 60 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'epic-flux-laser-s': {
        id: 'bp-flux-s-epic',
        name: 'Epic Flux Laser Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Flux Laser S',
        rarity: 'epic',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 195 },
            { resource: 'Refined Ferronite', amount: 104 },
            { resource: 'Refined Aurellite', amount: 65 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'legendary-flux-laser-s': {
        id: 'bp-flux-s-legendary',
        name: 'Legendary Flux Laser Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Flux Laser S',
        rarity: 'legendary',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 210 },
            { resource: 'Refined Ferronite', amount: 112 },
            { resource: 'Refined Aurellite', amount: 70 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'common-flux-laser-m': {
        id: 'bp-flux-m-common',
        name: 'Common Flux Laser Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Flux Laser M',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 300 },
            { resource: 'Refined Ferronite', amount: 160 },
            { resource: 'Refined Aurellite', amount: 100 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'uncommon-flux-laser-m': {
        id: 'bp-flux-m-uncommon',
        name: 'Uncommon Flux Laser Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Flux Laser M',
        rarity: 'uncommon',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 330 },
            { resource: 'Refined Ferronite', amount: 176 },
            { resource: 'Refined Aurellite', amount: 110 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'rare-flux-laser-m': {
        id: 'bp-flux-m-rare',
        name: 'Rare Flux Laser Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Flux Laser M',
        rarity: 'rare',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 360 },
            { resource: 'Refined Ferronite', amount: 192 },
            { resource: 'Refined Aurellite', amount: 120 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'epic-flux-laser-m': {
        id: 'bp-flux-m-epic',
        name: 'Epic Flux Laser Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Flux Laser M',
        rarity: 'epic',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 390 },
            { resource: 'Refined Ferronite', amount: 208 },
            { resource: 'Refined Aurellite', amount: 130 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'legendary-flux-laser-m': {
        id: 'bp-flux-m-legendary',
        name: 'Legendary Flux Laser Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Flux Laser M',
        rarity: 'legendary',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 420 },
            { resource: 'Refined Ferronite', amount: 224 },
            { resource: 'Refined Aurellite', amount: 140 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'common-flux-laser-l': {
        id: 'bp-flux-l-common',
        name: 'Common Flux Laser Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Flux Laser L',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 600 },
            { resource: 'Refined Ferronite', amount: 320 },
            { resource: 'Refined Aurellite', amount: 200 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'uncommon-flux-laser-l': {
        id: 'bp-flux-l-uncommon',
        name: 'Uncommon Flux Laser Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Flux Laser L',
        rarity: 'uncommon',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 660 },
            { resource: 'Refined Ferronite', amount: 352 },
            { resource: 'Refined Aurellite', amount: 220 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'rare-flux-laser-l': {
        id: 'bp-flux-l-rare',
        name: 'Rare Flux Laser Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Flux Laser L',
        rarity: 'rare',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 720 },
            { resource: 'Refined Ferronite', amount: 384 },
            { resource: 'Refined Aurellite', amount: 240 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'epic-flux-laser-l': {
        id: 'bp-flux-l-epic',
        name: 'Epic Flux Laser Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Flux Laser L',
        rarity: 'epic',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 780 },
            { resource: 'Refined Ferronite', amount: 416 },
            { resource: 'Refined Aurellite', amount: 260 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'legendary-flux-laser-l': {
        id: 'bp-flux-l-legendary',
        name: 'Legendary Flux Laser Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Flux Laser L',
        rarity: 'legendary',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 840 },
            { resource: 'Refined Ferronite', amount: 448 },
            { resource: 'Refined Aurellite', amount: 280 }
        ],
        allowedModStats: ['baseAccuracy', 'tracking', 'optimalRange', 'falloffRange', 'heatCapacity', 'fireRate', 'damagePerTick'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    // Shield Modules
    'blueprint-common-shield-module-s': {
        id: 'bp-shield-s-common',
        name: 'Common Shield Blueprint (S)',
        outputType: 'shield',
        outputId: 'Small Shield Array',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Ferronite', amount: 120 },
            { resource: 'Refined Silicite', amount: 200 }
        ],
        allowedModStats: ['baseCapacity', 'baseRegen']
    },
    'small-shield-bp': {
        id: 'bp-shield-s',
        name: 'Small Shield Blueprint',
        outputType: 'shield',
        outputId: 'Small Shield Array',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Ferronite', amount: 120 },
            { resource: 'Refined Silicite', amount: 200 }
        ],
        allowedModStats: ['baseCapacity', 'baseRegen']
    },
    // Ion Thrusters
    'blueprint-common-ion-thruster-s': {
        id: 'bp-ion-thruster-s-common',
        name: 'Common Ion Thruster Blueprint (S)',
        outputType: 'thruster',
        outputId: 'Ion Thruster S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Ferronite', amount: 100 },
            { resource: 'Refined Silicite', amount: 150 }
        ],
        allowedModStats: ['speedBoost', 'sigPenalty', 'energyDrain']
    },
    'medium-shield-bp': {
        id: 'bp-shield-m',
        name: 'Medium Shield Blueprint',
        outputType: 'shield',
        outputId: 'Medium Shield Array',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Ferronite', amount: 240 },
            { resource: 'Refined Silicite', amount: 400 }
        ],
        allowedModStats: ['baseCapacity', 'baseRegen']
    },
    'large-shield-bp': {
        id: 'bp-shield-l',
        name: 'Large Shield Blueprint',
        outputType: 'shield',
        outputId: 'Large Shield Array',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Ferronite', amount: 480 },
            { resource: 'Refined Silicite', amount: 800 }
        ],
        allowedModStats: ['baseCapacity', 'baseRegen']
    },
    // Pulse Cannon Blueprints
    'blueprint-common-pulse-cannon-s': {
        id: 'bp-pulse-s-common',
        name: 'Common Pulse Cannon Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 100 },
            { resource: 'Refined Ferronite', amount: 120 },
            { resource: 'Refined Aurellite', amount: 30 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'common-pulse-cannon-s': {
        id: 'bp-pulse-s-common',
        name: 'Common Pulse Cannon Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 100 },
            { resource: 'Refined Ferronite', amount: 120 },
            { resource: 'Refined Aurellite', amount: 30 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'uncommon-pulse-cannon-s': {
        id: 'bp-pulse-s-uncommon',
        name: 'Uncommon Pulse Cannon Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon S',
        rarity: 'uncommon',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 110 },
            { resource: 'Refined Ferronite', amount: 132 },
            { resource: 'Refined Aurellite', amount: 33 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'rare-pulse-cannon-s': {
        id: 'bp-pulse-s-rare',
        name: 'Rare Pulse Cannon Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon S',
        rarity: 'rare',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 120 },
            { resource: 'Refined Ferronite', amount: 144 },
            { resource: 'Refined Aurellite', amount: 36 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'epic-pulse-cannon-s': {
        id: 'bp-pulse-s-epic',
        name: 'Epic Pulse Cannon Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon S',
        rarity: 'epic',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 130 },
            { resource: 'Refined Ferronite', amount: 156 },
            { resource: 'Refined Aurellite', amount: 39 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'legendary-pulse-cannon-s': {
        id: 'bp-pulse-s-legendary',
        name: 'Legendary Pulse Cannon Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon S',
        rarity: 'legendary',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 140 },
            { resource: 'Refined Ferronite', amount: 168 },
            { resource: 'Refined Aurellite', amount: 42 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'common-pulse-cannon-m': {
        id: 'bp-pulse-m-common',
        name: 'Common Pulse Cannon Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon M',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 200 },
            { resource: 'Refined Ferronite', amount: 240 },
            { resource: 'Refined Aurellite', amount: 60 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'uncommon-pulse-cannon-m': {
        id: 'bp-pulse-m-uncommon',
        name: 'Uncommon Pulse Cannon Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon M',
        rarity: 'uncommon',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 220 },
            { resource: 'Refined Ferronite', amount: 264 },
            { resource: 'Refined Aurellite', amount: 66 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'rare-pulse-cannon-m': {
        id: 'bp-pulse-m-rare',
        name: 'Rare Pulse Cannon Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon M',
        rarity: 'rare',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 240 },
            { resource: 'Refined Ferronite', amount: 288 },
            { resource: 'Refined Aurellite', amount: 72 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'epic-pulse-cannon-m': {
        id: 'bp-pulse-m-epic',
        name: 'Epic Pulse Cannon Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon M',
        rarity: 'epic',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 260 },
            { resource: 'Refined Ferronite', amount: 312 },
            { resource: 'Refined Aurellite', amount: 78 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'legendary-pulse-cannon-m': {
        id: 'bp-pulse-m-legendary',
        name: 'Legendary Pulse Cannon Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon M',
        rarity: 'legendary',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 280 },
            { resource: 'Refined Ferronite', amount: 336 },
            { resource: 'Refined Aurellite', amount: 84 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'common-pulse-cannon-l': {
        id: 'bp-pulse-l-common',
        name: 'Common Pulse Cannon Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon L',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 400 },
            { resource: 'Refined Ferronite', amount: 480 },
            { resource: 'Refined Aurellite', amount: 120 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'uncommon-pulse-cannon-l': {
        id: 'bp-pulse-l-uncommon',
        name: 'Uncommon Pulse Cannon Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon L',
        rarity: 'uncommon',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 440 },
            { resource: 'Refined Ferronite', amount: 528 },
            { resource: 'Refined Aurellite', amount: 132 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'rare-pulse-cannon-l': {
        id: 'bp-pulse-l-rare',
        name: 'Rare Pulse Cannon Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon L',
        rarity: 'rare',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 480 },
            { resource: 'Refined Ferronite', amount: 576 },
            { resource: 'Refined Aurellite', amount: 144 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'epic-pulse-cannon-l': {
        id: 'bp-pulse-l-epic',
        name: 'Epic Pulse Cannon Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon L',
        rarity: 'epic',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 520 },
            { resource: 'Refined Ferronite', amount: 624 },
            { resource: 'Refined Aurellite', amount: 156 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    'legendary-pulse-cannon-l': {
        id: 'bp-pulse-l-legendary',
        name: 'Legendary Pulse Cannon Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Pulse Cannon L',
        rarity: 'legendary',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 560 },
            { resource: 'Refined Ferronite', amount: 672 },
            { resource: 'Refined Aurellite', amount: 168 }
        ],
        allowedModStats: ['damage', 'projectileSpeed', 'fireRate', 'reload', 'magazine', 'optimalRange']
    },
    // Seeker Pod Missiles
    'common-seeker-pod-s': {
        id: 'bp-seeker-s-common',
        name: 'Common Seeker Pod Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Seeker Pod S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 120 },
            { resource: 'Refined Ferronite', amount: 100 },
            { resource: 'Refined Aurellite', amount: 40 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius'],
        optionalSlotA: null,
        optionalSlotB: null
    },
    'uncommon-seeker-pod-s': {
        id: 'bp-seeker-s-uncommon',
        name: 'Uncommon Seeker Pod Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Seeker Pod S',
        rarity: 'uncommon',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 132 },
            { resource: 'Refined Ferronite', amount: 110 },
            { resource: 'Refined Aurellite', amount: 44 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'rare-seeker-pod-s': {
        id: 'bp-seeker-s-rare',
        name: 'Rare Seeker Pod Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Seeker Pod S',
        rarity: 'rare',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 144 },
            { resource: 'Refined Ferronite', amount: 120 },
            { resource: 'Refined Aurellite', amount: 48 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'epic-seeker-pod-s': {
        id: 'bp-seeker-s-epic',
        name: 'Epic Seeker Pod Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Seeker Pod S',
        rarity: 'epic',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 156 },
            { resource: 'Refined Ferronite', amount: 130 },
            { resource: 'Refined Aurellite', amount: 52 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'legendary-seeker-pod-s': {
        id: 'bp-seeker-s-legendary',
        name: 'Legendary Seeker Pod Blueprint (S)',
        outputType: 'weapon',
        outputId: 'Seeker Pod S',
        rarity: 'legendary',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 168 },
            { resource: 'Refined Ferronite', amount: 140 },
            { resource: 'Refined Aurellite', amount: 56 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'common-seeker-pod-m': {
        id: 'bp-seeker-m-common',
        name: 'Common Seeker Pod Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Seeker Pod M',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 240 },
            { resource: 'Refined Ferronite', amount: 200 },
            { resource: 'Refined Aurellite', amount: 80 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'uncommon-seeker-pod-m': {
        id: 'bp-seeker-m-uncommon',
        name: 'Uncommon Seeker Pod Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Seeker Pod M',
        rarity: 'uncommon',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 264 },
            { resource: 'Refined Ferronite', amount: 220 },
            { resource: 'Refined Aurellite', amount: 88 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'rare-seeker-pod-m': {
        id: 'bp-seeker-m-rare',
        name: 'Rare Seeker Pod Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Seeker Pod M',
        rarity: 'rare',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 288 },
            { resource: 'Refined Ferronite', amount: 240 },
            { resource: 'Refined Aurellite', amount: 96 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'epic-seeker-pod-m': {
        id: 'bp-seeker-m-epic',
        name: 'Epic Seeker Pod Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Seeker Pod M',
        rarity: 'epic',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 312 },
            { resource: 'Refined Ferronite', amount: 260 },
            { resource: 'Refined Aurellite', amount: 104 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'legendary-seeker-pod-m': {
        id: 'bp-seeker-m-legendary',
        name: 'Legendary Seeker Pod Blueprint (M)',
        outputType: 'weapon',
        outputId: 'Seeker Pod M',
        rarity: 'legendary',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 336 },
            { resource: 'Refined Ferronite', amount: 280 },
            { resource: 'Refined Aurellite', amount: 112 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'common-seeker-pod-l': {
        id: 'bp-seeker-l-common',
        name: 'Common Seeker Pod Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Seeker Pod L',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 480 },
            { resource: 'Refined Ferronite', amount: 400 },
            { resource: 'Refined Aurellite', amount: 160 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'uncommon-seeker-pod-l': {
        id: 'bp-seeker-l-uncommon',
        name: 'Uncommon Seeker Pod Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Seeker Pod L',
        rarity: 'uncommon',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 528 },
            { resource: 'Refined Ferronite', amount: 440 },
            { resource: 'Refined Aurellite', amount: 176 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'rare-seeker-pod-l': {
        id: 'bp-seeker-l-rare',
        name: 'Rare Seeker Pod Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Seeker Pod L',
        rarity: 'rare',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 576 },
            { resource: 'Refined Ferronite', amount: 480 },
            { resource: 'Refined Aurellite', amount: 192 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'epic-seeker-pod-l': {
        id: 'bp-seeker-l-epic',
        name: 'Epic Seeker Pod Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Seeker Pod L',
        rarity: 'epic',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 624 },
            { resource: 'Refined Ferronite', amount: 520 },
            { resource: 'Refined Aurellite', amount: 208 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    'legendary-seeker-pod-l': {
        id: 'bp-seeker-l-legendary',
        name: 'Legendary Seeker Pod Blueprint (L)',
        outputType: 'weapon',
        outputId: 'Seeker Pod L',
        rarity: 'legendary',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 672 },
            { resource: 'Refined Ferronite', amount: 560 },
            { resource: 'Refined Aurellite', amount: 224 }
        ],
        allowedModStats: ['damage', 'missileSpeed', 'reload', 'tracking', 'aoeRadius']
    },
    // Mining Lasers
    'blueprint-common-mining-laser-s': {
        id: 'bp-mining-s-common',
        name: 'Common Mining Laser Blueprint (S)',
        outputType: 'mining',
        outputId: 'Mining Laser S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 150 },
            { resource: 'Refined Ferronite', amount: 50 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'common-mining-laser-s': {
        id: 'bp-mining-s-common',
        name: 'Common Mining Laser Blueprint (S)',
        outputType: 'mining',
        outputId: 'Mining Laser S',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 150 },
            { resource: 'Refined Ferronite', amount: 50 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'uncommon-mining-laser-s': {
        id: 'bp-mining-s-uncommon',
        name: 'Uncommon Mining Laser Blueprint (S)',
        outputType: 'mining',
        outputId: 'Mining Laser S',
        rarity: 'uncommon',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 165 },
            { resource: 'Refined Ferronite', amount: 55 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'rare-mining-laser-s': {
        id: 'bp-mining-s-rare',
        name: 'Rare Mining Laser Blueprint (S)',
        outputType: 'mining',
        outputId: 'Mining Laser S',
        rarity: 'rare',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 180 },
            { resource: 'Refined Ferronite', amount: 60 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'epic-mining-laser-s': {
        id: 'bp-mining-s-epic',
        name: 'Epic Mining Laser Blueprint (S)',
        outputType: 'mining',
        outputId: 'Mining Laser S',
        rarity: 'epic',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 195 },
            { resource: 'Refined Ferronite', amount: 65 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'legendary-mining-laser-s': {
        id: 'bp-mining-s-legendary',
        name: 'Legendary Mining Laser Blueprint (S)',
        outputType: 'mining',
        outputId: 'Mining Laser S',
        rarity: 'legendary',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 210 },
            { resource: 'Refined Ferronite', amount: 70 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'common-mining-laser-m': {
        id: 'bp-mining-m-common',
        name: 'Common Mining Laser Blueprint (M)',
        outputType: 'mining',
        outputId: 'Mining Laser M',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 300 },
            { resource: 'Refined Ferronite', amount: 100 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'uncommon-mining-laser-m': {
        id: 'bp-mining-m-uncommon',
        name: 'Uncommon Mining Laser Blueprint (M)',
        outputType: 'mining',
        outputId: 'Mining Laser M',
        rarity: 'uncommon',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 330 },
            { resource: 'Refined Ferronite', amount: 110 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'rare-mining-laser-m': {
        id: 'bp-mining-m-rare',
        name: 'Rare Mining Laser Blueprint (M)',
        outputType: 'mining',
        outputId: 'Mining Laser M',
        rarity: 'rare',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 360 },
            { resource: 'Refined Ferronite', amount: 120 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'epic-mining-laser-m': {
        id: 'bp-mining-m-epic',
        name: 'Epic Mining Laser Blueprint (M)',
        outputType: 'mining',
        outputId: 'Mining Laser M',
        rarity: 'epic',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 390 },
            { resource: 'Refined Ferronite', amount: 130 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'legendary-mining-laser-m': {
        id: 'bp-mining-m-legendary',
        name: 'Legendary Mining Laser Blueprint (M)',
        outputType: 'mining',
        outputId: 'Mining Laser M',
        rarity: 'legendary',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 420 },
            { resource: 'Refined Ferronite', amount: 140 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'common-mining-laser-l': {
        id: 'bp-mining-l-common',
        name: 'Common Mining Laser Blueprint (L)',
        outputType: 'mining',
        outputId: 'Mining Laser L',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 600 },
            { resource: 'Refined Ferronite', amount: 200 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'uncommon-mining-laser-l': {
        id: 'bp-mining-l-uncommon',
        name: 'Uncommon Mining Laser Blueprint (L)',
        outputType: 'mining',
        outputId: 'Mining Laser L',
        rarity: 'uncommon',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 660 },
            { resource: 'Refined Ferronite', amount: 220 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'rare-mining-laser-l': {
        id: 'bp-mining-l-rare',
        name: 'Rare Mining Laser Blueprint (L)',
        outputType: 'mining',
        outputId: 'Mining Laser L',
        rarity: 'rare',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 720 },
            { resource: 'Refined Ferronite', amount: 240 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'epic-mining-laser-l': {
        id: 'bp-mining-l-epic',
        name: 'Epic Mining Laser Blueprint (L)',
        outputType: 'mining',
        outputId: 'Mining Laser L',
        rarity: 'epic',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 780 },
            { resource: 'Refined Ferronite', amount: 260 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    'legendary-mining-laser-l': {
        id: 'bp-mining-l-legendary',
        name: 'Legendary Mining Laser Blueprint (L)',
        outputType: 'mining',
        outputId: 'Mining Laser L',
        rarity: 'legendary',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 840 },
            { resource: 'Refined Ferronite', amount: 280 }
        ],
        allowedModStats: ['baseExtraction', 'fireRate', 'falloffRange']
    },
    // Drone Modules
    'common-combat-drone-s-bp': {
        id: 'bp-combat-drone-s-common',
        name: 'Common Combat Drone Blueprint (S)',
        outputType: 'drone-module',
        outputId: 'Small Combat Drone Module',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 180 },
            { resource: 'Refined Ferronite', amount: 120 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-combat-drone-m-bp': {
        id: 'bp-combat-drone-m-common',
        name: 'Common Combat Drone Blueprint (M)',
        outputType: 'drone-module',
        outputId: 'Medium Combat Drone Module',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 320 },
            { resource: 'Refined Ferronite', amount: 220 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-combat-drone-l-bp': {
        id: 'bp-combat-drone-l-common',
        name: 'Common Combat Drone Blueprint (L)',
        outputType: 'drone-module',
        outputId: 'Large Combat Drone Module',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 580 },
            { resource: 'Refined Ferronite', amount: 380 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-mining-drone-s-bp': {
        id: 'bp-mining-drone-s-common',
        name: 'Common Mining Drone Blueprint (S)',
        outputType: 'drone-module',
        outputId: 'Small Mining Drone Module',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 150 },
            { resource: 'Refined Ferronite', amount: 90 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-mining-drone-m-bp': {
        id: 'bp-mining-drone-m-common',
        name: 'Common Mining Drone Blueprint (M)',
        outputType: 'drone-module',
        outputId: 'Medium Mining Drone Module',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 280 },
            { resource: 'Refined Ferronite', amount: 160 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-mining-drone-l-bp': {
        id: 'bp-mining-drone-l-common',
        name: 'Common Mining Drone Blueprint (L)',
        outputType: 'drone-module',
        outputId: 'Large Mining Drone Module',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 450 },
            { resource: 'Refined Ferronite', amount: 280 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-repair-drone-s-bp': {
        id: 'bp-repair-drone-s-common',
        name: 'Common Repair Drone Blueprint (S)',
        outputType: 'drone-module',
        outputId: 'Small Repair Drone Module',
        rarity: 'common',
        weaponsize: 'S',
        requirements: [
            { resource: 'Refined Silicite', amount: 200 },
            { resource: 'Refined Ferronite', amount: 150 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-repair-drone-m-bp': {
        id: 'bp-repair-drone-m-common',
        name: 'Common Repair Drone Blueprint (M)',
        outputType: 'drone-module',
        outputId: 'Medium Repair Drone Module',
        rarity: 'common',
        weaponsize: 'M',
        requirements: [
            { resource: 'Refined Silicite', amount: 350 },
            { resource: 'Refined Ferronite', amount: 250 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    },
    'common-repair-drone-l-bp': {
        id: 'bp-repair-drone-l-common',
        name: 'Common Repair Drone Blueprint (L)',
        outputType: 'drone-module',
        outputId: 'Large Repair Drone Module',
        rarity: 'common',
        weaponsize: 'L',
        requirements: [
            { resource: 'Refined Silicite', amount: 600 },
            { resource: 'Refined Ferronite', amount: 450 }
        ],
        allowedModStats: ['controlRange', 'energyDrain']
    }
};

// ------------------------------------------------------------
// Output identity normalization (outputItemId/outputItemKey)
//
// - outputId is legacy/human-readable.
// - outputItemId is the stable catalog identifier (item_id / ship_id).
// - outputItemKey is the canonical key used by the "clean items" layer.
//   (Phase 2: itemKey === outputItemId for non-ships.)
// ------------------------------------------------------------
function __bpSizePart(size) {
    const s = String(size || "S").toUpperCase();
    return s === "S" ? "small" : (s === "M" ? "medium" : "large");
}
function __bpNormRarity(rarity) {
    const r = String(rarity || "common").toLowerCase();
    return ["common","uncommon","rare","epic","legendary"].includes(r) ? r : "common";
}
function __bpMkItemId(size, rarity, key) {
    return `${__bpSizePart(size)}-${__bpNormRarity(rarity)}-${key}`;
}

Object.values(BLUEPRINT_REGISTRY).forEach((bp) => {
    if (!bp) return;

    // Ships
    if (String(bp.outputType || "").toLowerCase() === "ship") {
        if (!bp.outputItemId) {
            bp.outputItemId = resolveShipId(bp.id) || resolveShipId(bp.outputId) || null;
        }
        if (!bp.outputItemKey) {
            bp.outputItemKey = bp.outputItemId;
        }
        return;
    }

    const out = String(bp.outputId || "").toLowerCase();
    const outputType = String(bp.outputType || "").toLowerCase();
    const size = String(bp.weaponsize || bp.size || "S").toUpperCase();
    const rarity = __bpNormRarity(bp.rarity);

    if (!bp.outputItemId) {
        // Weapons
        if (outputType === "weapon") {
            if (out.includes("flux") && out.includes("laser")) bp.outputItemId = __bpMkItemId(size, rarity, "flux-laser");
            else if (out.includes("pulse") && out.includes("cannon")) bp.outputItemId = __bpMkItemId(size, rarity, "pulse-cannon");
            else if (out.includes("seeker") || out.includes("pod") || out.includes("missile")) bp.outputItemId = __bpMkItemId(size, rarity, "seeker-pod");
        }

        // Mining lasers
        if (!bp.outputItemId && (outputType === "mining" || (out.includes("mining") && out.includes("laser")))) {
            bp.outputItemId = __bpMkItemId(size, rarity, "mining-laser");
        }

        // Shields
        if (!bp.outputItemId && outputType === "shield") {
            bp.outputItemId = __bpMkItemId(size, rarity, "shield-array");
        }

        // Thrusters
        if (!bp.outputItemId && outputType === "thruster") {
            bp.outputItemId = __bpMkItemId(size, rarity, "ion-thruster");
        }

        // Drone modules
        if (!bp.outputItemId && outputType === "drone-module") {
            if (out.includes("combat")) bp.outputItemId = __bpMkItemId(size, rarity, "combat-drone-module");
            else if (out.includes("mining")) bp.outputItemId = __bpMkItemId(size, rarity, "mining-drone-module");
            else if (out.includes("repair")) bp.outputItemId = __bpMkItemId(size, rarity, "repair-drone-module");
            else bp.outputItemId = __bpMkItemId(size, rarity, "combat-drone-module");
        }
    }

    // Only accept if the derived id exists in the catalog
    if (bp.outputItemId && !ITEM_CATALOG[bp.outputItemId]) {
        bp.outputItemId = null;
    }

    if (!bp.outputItemKey) {
        bp.outputItemKey = bp.outputItemId;
    }
});

// ------------------------------------------------------------
// Canonical backend blueprint aliases (Phase 5 canonical migration)
// Frontend now understands the normalized Supabase blueprint ids
// directly, while still keeping legacy ids working during migration.
// ------------------------------------------------------------
function __registerBlueprintAlias(aliasKey, sourceKey, overrides = {}) {
    if (BLUEPRINT_REGISTRY[aliasKey]) return BLUEPRINT_REGISTRY[aliasKey];
    const source = BLUEPRINT_REGISTRY[sourceKey];
    if (!source) return null;
    BLUEPRINT_REGISTRY[aliasKey] = {
        ...source,
        ...overrides,
        id: aliasKey
    };
    return BLUEPRINT_REGISTRY[aliasKey];
}

const CANONICAL_SHIP_BLUEPRINTS = {
    bp_ship_omni_scout: {
        sourceKey: 'omni-scout-chassis',
        name: 'OMNI SCOUT Blueprint',
        outputId: 'OMNI SCOUT',
        outputShipId: 'ship_omni_scout',
        outputItemId: 'ship_omni_scout',
        outputItemKey: 'ship_omni_scout'
    },
    bp_ship_omni_interceptor: {
        name: 'OMNI INTERCEPTOR Blueprint',
        outputId: 'OMNI INTERCEPTOR',
        outputShipId: 'ship_omni_interceptor_t1',
        outputItemId: 'ship_omni_interceptor_t1',
        outputItemKey: 'ship_omni_interceptor_t1',
        rarity: 'common',
        requirements: [
            { resource: 'resource_refined_ferronite', amount: 90 },
            { resource: 'resource_refined_silicite', amount: 140 },
            { resource: 'resource_refined_aurellite', amount: 20 }
        ]
    },
    bp_ship_omni_gunship: {
        name: 'OMNI GUNSHIP Blueprint',
        outputId: 'OMNI GUNSHIP',
        outputShipId: 'ship_omni_gunship_t1',
        outputItemId: 'ship_omni_gunship_t1',
        outputItemKey: 'ship_omni_gunship_t1',
        rarity: 'common',
        requirements: [
            { resource: 'resource_refined_ferronite', amount: 180 },
            { resource: 'resource_refined_silicite', amount: 220 },
            { resource: 'resource_refined_aurellite', amount: 90 }
        ]
    },
    bp_ship_omni_hauler: {
        name: 'OMNI HAULER Blueprint',
        outputId: 'OMNI HAULER',
        outputShipId: 'ship_omni_hauler_t1',
        outputItemId: 'ship_omni_hauler_t1',
        outputItemKey: 'ship_omni_hauler_t1',
        rarity: 'common',
        requirements: [
            { resource: 'resource_refined_ferronite', amount: 140 },
            { resource: 'resource_refined_silicite', amount: 240 },
            { resource: 'resource_refined_aurellite', amount: 60 }
        ]
    },
    bp_ship_omni_mining: {
        name: 'OMNI MINING SHIP Blueprint',
        outputId: 'OMNI MINING SHIP',
        outputShipId: 'ship_omni_mining_ship_t1',
        outputItemId: 'ship_omni_mining_ship_t1',
        outputItemKey: 'ship_omni_mining_ship_t1',
        rarity: 'common',
        requirements: [
            { resource: 'resource_refined_ferronite', amount: 120 },
            { resource: 'resource_refined_silicite', amount: 180 },
            { resource: 'resource_refined_aurellite', amount: 40 }
        ]
    },
    bp_ship_omni_command: {
        name: 'OMNI COMMAND Blueprint',
        outputId: 'OMNI COMMAND',
        outputShipId: 'ship_omni_command_t1',
        outputItemId: 'ship_omni_command_t1',
        outputItemKey: 'ship_omni_command_t1',
        rarity: 'common',
        requirements: [
            { resource: 'resource_refined_ferronite', amount: 220 },
            { resource: 'resource_refined_silicite', amount: 260 },
            { resource: 'resource_refined_aurellite', amount: 110 }
        ]
    },
    bp_ship_omni_sovereign: {
        name: 'OMNI SOVEREIGN Blueprint',
        outputId: 'OMNI SOVEREIGN',
        outputShipId: 'ship_omni_sovereign_t1',
        outputItemId: 'ship_omni_sovereign_t1',
        outputItemKey: 'ship_omni_sovereign_t1',
        rarity: 'common',
        requirements: [
            { resource: 'resource_refined_ferronite', amount: 520 },
            { resource: 'resource_refined_silicite', amount: 600 },
            { resource: 'resource_refined_aurellite', amount: 240 }
        ]
    }
};

const SHIP_ALLOWED_MOD_STATS = ['kineticRes', 'thermalRes', 'blastRes', 'armor', 'maxEnergy', 'shieldRegen', 'reactorRecovery', 'maxSpeed', 'lockMultiplier', 'basePG', 'baseCPU', 'hp'];

Object.entries(CANONICAL_SHIP_BLUEPRINTS).forEach(([blueprintId, cfg]) => {
    if (cfg.sourceKey) {
        __registerBlueprintAlias(blueprintId, cfg.sourceKey, {
            name: cfg.name,
            outputId: cfg.outputId,
            outputShipId: cfg.outputShipId,
            outputItemId: cfg.outputItemId,
            outputItemKey: cfg.outputItemKey
        });
        return;
    }
    if (!BLUEPRINT_REGISTRY[blueprintId]) {
        BLUEPRINT_REGISTRY[blueprintId] = {
            id: blueprintId,
            name: cfg.name,
            outputType: 'ship',
            outputId: cfg.outputId,
            outputShipId: cfg.outputShipId,
            outputItemId: cfg.outputItemId,
            outputItemKey: cfg.outputItemKey,
            rarity: cfg.rarity || 'common',
            requirements: cfg.requirements,
            allowedModStats: SHIP_ALLOWED_MOD_STATS
        };
    }
});

function __getCanonicalModuleBlueprintId(bp) {
    if (!bp || String(bp.outputType || '').toLowerCase() === 'ship') return null;
    const rarity = __bpNormRarity(bp.rarity);
    const size = String(bp.weaponsize || bp.size || 'S').trim().toLowerCase();
    const outputType = String(bp.outputType || '').toLowerCase();
    const outputId = String(bp.outputId || '').toLowerCase();
    if (outputType === 'weapon') {
        if (outputId.includes('flux') && outputId.includes('laser')) return `bp_module_weapon_flux_laser_${size}_${rarity}`;
        if (outputId.includes('pulse') && outputId.includes('cannon')) return `bp_module_weapon_pulse_cannon_${size}_${rarity}`;
        if (outputId.includes('seeker') || outputId.includes('pod') || outputId.includes('missile')) return `bp_module_weapon_seeker_pod_${size}_${rarity}`;
    }
    if (outputType === 'mining' || (outputId.includes('mining') && outputId.includes('laser'))) {
        return `bp_module_mining_laser_${size}_${rarity}`;
    }
    if (outputType === 'shield') {
        return `bp_module_shield_standard_${size}_${rarity}`;
    }
    if (outputType === 'thruster') {
        return `bp_module_thruster_ion_${size}_${rarity}`;
    }
    if (outputType === 'drone-module') {
        if (outputId.includes('combat')) return `bp_module_drone_combat_bay_${size}_${rarity}`;
        if (outputId.includes('mining')) return `bp_module_drone_mining_bay_${size}_${rarity}`;
        if (outputId.includes('repair')) return `bp_module_drone_repair_bay_${size}_${rarity}`;
    }
    return null;
}

const __blueprintRegistrySnapshot = Object.entries({ ...BLUEPRINT_REGISTRY });
__blueprintRegistrySnapshot.forEach(([sourceKey, bp]) => {
    const canonicalId = __getCanonicalModuleBlueprintId(bp);
    if (!canonicalId) return;
    __registerBlueprintAlias(canonicalId, sourceKey);
});