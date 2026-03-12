/**
 * AUTO-EXTRACTED from GameManager_refactored.js
 * Purpose: keep GameManager lean; pure data exports.
 */

export const LOOT_TABLES = {
    Blueprint_Drops: {
        overallChance: {
            secure: 0.25,
            mid: 0.35,
            low: 0.50,
            null: 0.65
        },
        rarityWeights: {
            secure: { common: 0.70, uncommon: 0.20, rare: 0.07, epic: 0.02, legendary: 0.01 },
            mid: { common: 0.55, uncommon: 0.25, rare: 0.12, epic: 0.06, legendary: 0.02 },
            low: { common: 0.40, uncommon: 0.25, rare: 0.15, epic: 0.18, legendary: 0.10 },
            null: { common: 0.25, uncommon: 0.25, rare: 0.20, epic: 0.20, legendary: 0.15 }
        },
        sizeWeights: {
            S: 0.60,
            M: 0.30,
            L: 0.20
        }
    },
    Bio_Material_Drops: {
        'Small Bio-Creature': { min: 1, max: 2 },
        'Medium Bio-Creature': { min: 2, max: 4 },
        'Large Bio-Creature': { min: 4, max: 6 },
        'Boss Bio-Creature': { min: 8, max: 12 }
    }
};