/**
 * AUTO-EXTRACTED from GameManager_refactored.js
 * Purpose: keep GameManager lean; pure data exports.
 */

export const BIO_CREATURE_REGISTRY = {
    'Star-Eater Larva': {
        classId: 'Small Bio-Creature',
        spriteUrl: 'https://rosebud.ai/assets/larva4x1.jpg?mAYc',
        frames: 4,
        fps: 2,
        baseSigRadius: 25,
        collisionRadius: 45, // Reduced from 75 to prevent excessive blocking/gas area
        hp: 250,
        maxShields: 0,
        armor: 0.05,
        kineticRes: 0.0,
        thermalRes: -0.10,
        blastRes: 0.0,
        maxSpeed: 4.5, 
        turnSpeed: 0.1, // Increased from 0.07 to help alignment
        isBio: true,
        noLockOn: true,
        targetingType: 'proximity',
        lockOnRange: 600,
        abilities: {
            dash: { damage: 140, type: 'kinetic', cooldown: 4000, speedMult: 2.5, duration: 800 },
            pulse: { damage: 65, type: 'energy', cooldown: 3000, radius: 150 }
        }
    },
    'Star-Eater Broodmother': {
        classId: 'Large Bio-Creature',
        spriteUrl: 'https://rosebud.ai/assets/squidhd.jpg?U7BK',
        frames: 8,
        tilesX: 4,
        tilesY: 5,
        fps: 2,
        baseSigRadius: 150,
        collisionRadius: 140,
        hp: 15000,
        maxShields: 0,
        armor: 0.40,
        kineticRes: 0.30,
        thermalRes: 0.25,
        blastRes: 0.20,
        maxSpeed: 12, 
        turnSpeed: 0.018, 
        isBio: true,
        targetingType: 'standard',
        lockOnRange: 3000,
        abilities: {
            dash: { damage: 500, type: 'kinetic', cooldown: 6000, speedMult: 3.0, duration: 1200 },
            pulse: { damage: 250, type: 'energy', cooldown: 8000, radius: 400 }
        }
    }
};