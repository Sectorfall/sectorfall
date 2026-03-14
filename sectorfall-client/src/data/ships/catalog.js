/**
 * ships/catalog.js
 *
 * Ship template catalog with stable ship_id identities.
 *
 * - ship_id is the long-lived identifier used by blueprints and persistence.
 * - registryKey is the legacy SHIP_REGISTRY key (used as an alias for compatibility).
 */

export const SHIP_CATALOG = {
  "ship_cartel_gunship_t1": {
    "armor": 0.3,
    "baseCPU": 140,
    "baseEnergy": 120,
    "baseEnergyRecharge": 4,
    "basePG": 149,
    "baseSigRadius": 45,
    "blastRes": 0.15,
    "brakingForce": 0.8,
    "classId": "CRIMSON RIFT CARTEL GUNSHIP",
    "collisionRadius": 40,
    "fittings": {
      "active1": null,
      "active2": null,
      "passive1": null,
      "passive2": null,
      "rig1": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null,
      "weapon3": null
    },
    "hardpoints": {
      "engineL": {
        "size": 18,
        "x": -18,
        "y": -30
      },
      "engineR": {
        "size": 18,
        "x": 18,
        "y": -30
      },
      "weapon1": {
        "size": 28,
        "x": -28,
        "y": 10
      },
      "weapon2": {
        "size": 28,
        "x": 28,
        "y": 10
      },
      "weapon3": {
        "size": 32,
        "x": 0,
        "y": 35
      }
    },
    "hp": 1800,
    "jumpPower": 1,
    "kineticRes": 0.25,
    "legacyKeys": [
      "CartelGunship"
    ],
    "lockMultiplier": 2,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 2.6,
    "name": "CRIMSON RIFT CARTEL GUNSHIP",
    "recommendedWeaponSizes": [
      "S",
      "M"
    ],
    "registryKey": "CartelGunship",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_cartel_gunship_t1",
    "spriteUrl": "/assets/pirate-gunship2.webp",
    "thermalRes": 0.2,
    "thrustImpulse": 2.2,
    "turnSpeed": 0.04
  },
  "ship_cartel_scout_t1": {
    "armor": 0.15,
    "baseCPU": 70,
    "baseEnergy": 100,
    "baseEnergyRecharge": 5,
    "basePG": 55,
    "baseSigRadius": 28,
    "blastRes": 0.05,
    "brakingForce": 1.2,
    "classId": "CRIMSON RIFT CARTEL SCOUT",
    "collisionRadius": 25,
    "fittings": {
      "active1": null,
      "passive1": null,
      "passive2": null,
      "rig1": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null
    },
    "hardpoints": {
      "engineL": {
        "size": 14,
        "x": -12,
        "y": -18
      },
      "engineR": {
        "size": 14,
        "x": 12,
        "y": -18
      },
      "weapon1": {
        "size": 24,
        "x": -18,
        "y": 15
      },
      "weapon2": {
        "size": 24,
        "x": 18,
        "y": 15
      }
    },
    "hp": 900,
    "jumpPower": 1,
    "kineticRes": 0.1,
    "legacyKeys": [
      "CartelScout"
    ],
    "lockMultiplier": 1,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 3.5,
    "name": "CRIMSON RIFT CARTEL SCOUT",
    "recommendedWeaponSizes": [
      "S"
    ],
    "registryKey": "CartelScout",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_cartel_scout_t1",
    "spriteUrl": "/assets/pirate-interceptor.png.webp",
    "thermalRes": 0.1,
    "thrustImpulse": 3.5,
    "turnSpeed": 0.05
  },
  "ship_omni_command_t1": {
    "armor": 0.25,
    "baseCPU": 129,
    "baseEnergy": 140,
    "baseEnergyRecharge": 6,
    "basePG": 119,
    "baseSigRadius": 40,
    "blastRes": 0.1,
    "brakingForce": 2,
    "cargoHold": 65,
    "classId": "SUPPORT SHIP",
    "collisionRadius": 35,
    "fittings": {
      "active1": null,
      "active2": null,
      "active3": null,
      "passive1": null,
      "passive2": null,
      "rig1": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null
    },
    "hardpoints": {
      "engineL": {
        "size": 14,
        "x": -8,
        "y": -24
      },
      "engineR": {
        "size": 14,
        "x": 8,
        "y": -24
      },
      "thrusterBack": {
        "size": 10,
        "x": 0,
        "y": -24
      },
      "thrusterFront": {
        "size": 10,
        "x": 0,
        "y": 24
      },
      "thrusterLeft": {
        "size": 10,
        "x": -24,
        "y": 0
      },
      "thrusterRight": {
        "size": 10,
        "x": 24,
        "y": 0
      },
      "weapon1": {
        "size": 28,
        "x": -14,
        "y": 14
      },
      "weapon2": {
        "size": 28,
        "x": 14,
        "y": 14
      }
    },
    "hp": 2000,
    "jumpPower": 1,
    "jumpWarmupTime": 7000,
    "kineticRes": 0.2,
    "legacyKeys": [
      "OMNI COMMAND"
    ],
    "lockMultiplier": 1,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 3.5,
    "name": "OMNI COMMAND",
    "recommendedWeaponSizes": [
      "S",
      "M"
    ],
    "registryKey": "OMNI COMMAND",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_omni_command_t1",
    "spriteUrl": "/assets/Command2.png",
    "thermalRes": 0.15,
    "thrustImpulse": 4,
    "turnSpeed": 0.045,
    "visualScale": 190
  },
  "ship_omni_gunship_t1": {
    "armor": 0.3,
    "baseCPU": 140,
    "baseEnergy": 120,
    "baseEnergyRecharge": 4,
    "basePG": 149,
    "baseSigRadius": 45,
    "blastRes": 0.15,
    "brakingForce": 0.8,
    "cargoHold": 75,
    "classId": "GUNSHIP",
    "collisionRadius": 58,
    "fittings": {
      "active1": null,
      "active2": null,
      "passive1": null,
      "passive2": null,
      "passive3": null,
      "rig1": null,
      "rig2": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null,
      "weapon3": null
    },
    "hardpoints": {
      "engineL": {
        "size": 12,
        "x": -21,
        "y": -21
      },
      "engineR": {
        "size": 12,
        "x": 21,
        "y": -21
      },
      "thrusterNE": {
        "size": 10,
        "x": 21,
        "y": 21
      },
      "thrusterNW": {
        "size": 10,
        "x": -21,
        "y": 21
      },
      "thrusterSE": {
        "size": 10,
        "x": 21,
        "y": -21
      },
      "thrusterSW": {
        "size": 10,
        "x": -21,
        "y": -21
      },
      "weapon1": {
        "size": 28,
        "x": -19,
        "y": 19
      },
      "weapon2": {
        "size": 28,
        "x": 19,
        "y": 19
      },
      "weapon3": {
        "size": 32,
        "x": 0,
        "y": 28
      }
    },
    "hp": 1800,
    "jumpEnergyCost": 40,
    "jumpPower": 1,
    "jumpWarmupTime": 10000,
    "kineticRes": 0.25,
    "legacyKeys": [
      "OMNI GUNSHIP"
    ],
    "lockMultiplier": 2,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 2.6,
    "name": "OMNI GUNSHIP",
    "recommendedWeaponSizes": [
      "S",
      "M"
    ],
    "registryKey": "OMNI GUNSHIP",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_omni_gunship_t1",
    "spriteUrl": "/assets/gunship2.webp",
    "thermalRes": 0.2,
    "thrustImpulse": 2.2,
    "turnSpeed": 0.04,
    "visualScale": 164
  },
  "ship_omni_hauler_t1": {
    "armor": 0.2,
    "baseCPU": 120,
    "baseEnergy": 110,
    "baseEnergyRecharge": 5,
    "basePG": 130,
    "baseSigRadius": 68,
    "blastRes": 0.1,
    "brakingForce": 0.5,
    "cargoHold": 300,
    "classId": "LOGISTICS SHIP",
    "collisionRadius": 85,
    "fittings": {
      "active1": null,
      "active2": null,
      "passive1": null,
      "passive2": null,
      "passive3": null,
      "passive4": null,
      "rig1": null,
      "rig2": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null
    },
    "hardpoints": {
      "engineL": {
        "size": 18,
        "x": -20,
        "y": -28
      },
      "engineR": {
        "size": 18,
        "x": 20,
        "y": -28
      },
      "thrusterNE_1": {
        "size": 10,
        "x": 16,
        "y": 28
      },
      "thrusterNE_2": {
        "size": 10,
        "x": 25,
        "y": 19
      },
      "thrusterNW_1": {
        "size": 10,
        "x": -25,
        "y": 19
      },
      "thrusterNW_2": {
        "size": 10,
        "x": -16,
        "y": 28
      },
      "thrusterSE_1": {
        "size": 10,
        "x": 16,
        "y": -28
      },
      "thrusterSE_2": {
        "size": 10,
        "x": 25,
        "y": -19
      },
      "thrusterSW_1": {
        "size": 10,
        "x": -25,
        "y": -19
      },
      "thrusterSW_2": {
        "size": 10,
        "x": -16,
        "y": -28
      },
      "weapon1": {
        "size": 32,
        "x": 0,
        "y": 10
      }
    },
    "hp": 1350,
    "jumpPower": 1,
    "jumpWarmupTime": 8000,
    "kineticRes": 0.15,
    "legacyKeys": [
      "OMNI HAULER"
    ],
    "lockMultiplier": 1.25,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 2,
    "name": "OMNI HAULER",
    "recommendedWeaponSizes": [
      "S",
      "M"
    ],
    "registryKey": "OMNI HAULER",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_omni_hauler_t1",
    "spriteUrl": "/assets/titan (1).png",
    "thermalRes": 0.15,
    "thrustImpulse": 2,
    "turnSpeed": 0.025,
    "visualScale": 235
  },
  "ship_omni_interceptor_t1": {
    "armor": 0.2,
    "baseCPU": 110,
    "baseEnergy": 110,
    "baseEnergyRecharge": 5,
    "basePG": 100,
    "baseSigRadius": 30,
    "blastRes": 0.1,
    "boostSpeed": 4.2,
    "brakingForce": 1.8,
    "cargoHold": 60,
    "cargoMaxVolume": 120,
    "classId": "INTERCEPTOR",
    "collisionRadius": 42,
    "fittings": {
      "active1": null,
      "passive1": null,
      "rig1": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null
    },
    "hardpoints": {
      "thrusterN": {
        "size": 10,
        "x": 0,
        "y": 32
      },
      "thrusterSE": {
        "size": 10,
        "x": 28,
        "y": -16
      },
      "thrusterSW": {
        "size": 10,
        "x": -28,
        "y": -16
      },
      "weapon1": {
        "size": 24,
        "x": -15,
        "y": 12
      },
      "weapon2": {
        "size": 24,
        "x": 15,
        "y": 12
      }
    },
    "hp": 1300,
    "jumpEnergyCost": 30,
    "jumpPower": 1,
    "jumpWarmupTime": 5000,
    "kineticRes": 0.15,
    "legacyKeys": [
      "OMNI INTERCEPTOR"
    ],
    "lockMultiplier": 1,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 4,
    "name": "OMNI INTERCEPTOR",
    "recommendedWeaponSizes": [
      "S"
    ],
    "registryKey": "OMNI INTERCEPTOR",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_omni_interceptor_t1",
    "spriteUrl": "/assets/omniinterceptor2.png",
    "thermalRes": 0.1,
    "thrustImpulse": 4.5,
    "turnSpeed": 0.065,
    "visualScale": 120
  },
  "ship_omni_mining_ship_t1": {
    "armor": 0.2,
    "baseCPU": 110,
    "baseEnergy": 110,
    "baseEnergyRecharge": 4,
    "basePG": 120,
    "baseSigRadius": 40,
    "blastRes": 0.05,
    "brakingForce": 0.7,
    "cargoHold": 180,
    "classId": "MINING SHIP",
    "collisionRadius": 45,
    "fittings": {
      "active1": null,
      "passive1": null,
      "passive2": null,
      "rig1": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null
    },
    "hardpoints": {
      "engineL": {
        "size": 14,
        "x": -18,
        "y": -30
      },
      "engineR": {
        "size": 14,
        "x": 18,
        "y": -30
      },
      "weapon1": {
        "size": 28,
        "x": 0,
        "y": 35
      }
    },
    "hp": 1100,
    "jumpPower": 1,
    "jumpWarmupTime": 8000,
    "kineticRes": 0.15,
    "legacyKeys": [
      "OMNI MINING SHIP"
    ],
    "lockMultiplier": 1,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 2,
    "name": "OMNI MINING SHIP",
    "recommendedWeaponSizes": [
      "S",
      "M"
    ],
    "registryKey": "OMNI MINING SHIP",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_omni_mining_ship_t1",
    "spriteUrl": "/assets/miner2.png",
    "thermalRes": 0.1,
    "thrustImpulse": 2,
    "turnSpeed": 0.035,
    "visualScale": 180
  },
  "ship_omni_scout_t1": {
    "armor": 0.12,
    "baseCPU": 75,
    "baseEnergy": 110,
    "baseEnergyRecharge": 6,
    "basePG": 60,
    "baseSigRadius": 20,
    "blastRes": 0.05,
    "brakingForce": 2.2,
    "cargoHold": 55,
    "cargoMaxVolume": 100,
    "classId": "SCOUT",
    "collisionRadius": 22,
    "fittings": {
      "active1": null,
      "passive1": null,
      "passive2": null,
      "rig1": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null
    },
    "hardpoints": {
      "engineL": {
        "size": 14,
        "x": -14,
        "y": -20
      },
      "engineR": {
        "size": 14,
        "x": 14,
        "y": -20
      },
      "thrusterBack": {
        "size": 8,
        "x": 0,
        "y": -25
      },
      "thrusterFront": {
        "size": 8,
        "x": 0,
        "y": 25
      },
      "thrusterLeft": {
        "size": 8,
        "x": -22,
        "y": 0
      },
      "thrusterRight": {
        "size": 8,
        "x": 22,
        "y": 0
      },
      "weapon1": {
        "size": 24,
        "x": -28,
        "y": 12
      },
      "weapon2": {
        "size": 24,
        "x": 28,
        "y": 12
      }
    },
    "hp": 850,
    "jumpEnergyCost": 25,
    "jumpPower": 1,
    "jumpWarmupTime": 6000,
    "kineticRes": 0.1,
    "legacyKeys": [
      "OMNI SCOUT"
    ],
    "lockMultiplier": 1.1,
    "targetingStrength": 1,
    "lockOnRange": 1800,
    "name": "OMNI SCOUT",
    "recommendedWeaponSizes": [
      "S"
    ],
    "registryKey": "OMNI SCOUT",
    "scanRange": 1000,
    "scanSpeed": 1,
    "shieldScale": 2.1,
    "ship_id": "ship_omni_scout_t1",
    "spriteUrl": "/assets/white-omni-scout.png.webp",
    "thermalRes": 0.15,
    "thrustImpulse": 4.8,
    "turnSpeed": 0.065,
    "visualScale": 64
  },
  "ship_omni_sovereign_t1": {
    "armor": 0.5,
    "baseCPU": 260,
    "baseEnergy": 180,
    "baseEnergyRecharge": 3,
    "basePG": 350,
    "baseSigRadius": 75,
    "blastRes": 0.3,
    "brakingForce": 0.4,
    "cargoHold": 120,
    "classId": "SOVEREIGN",
    "collisionRadius": 95,
    "fittings": {
      "active1": null,
      "active2": null,
      "active3": null,
      "active4": null,
      "passive1": null,
      "passive2": null,
      "passive3": null,
      "passive4": null,
      "rig1": null,
      "rig2": null,
      "rig3": null,
      "synapse1": null,
      "synapse2": null,
      "synapse3": null,
      "weapon1": null,
      "weapon2": null,
      "weapon3": null
    },
    "hardpoints": {
      "engineL": {
        "size": 14,
        "x": -13,
        "y": -17
      },
      "engineR": {
        "size": 14,
        "x": 13,
        "y": -17
      },
      "thrusterNE": {
        "size": 10,
        "x": 15,
        "y": 20
      },
      "thrusterNW": {
        "size": 10,
        "x": -15,
        "y": 20
      },
      "thrusterSE": {
        "size": 10,
        "x": 13,
        "y": -17
      },
      "thrusterSW": {
        "size": 10,
        "x": -13,
        "y": -17
      },
      "weapon1": {
        "size": 36,
        "x": -28,
        "y": 12
      },
      "weapon2": {
        "size": 36,
        "x": 28,
        "y": 12
      },
      "weapon3": {
        "size": 42,
        "x": 0,
        "y": 28
      }
    },
    "hp": 4500,
    "jumpEnergyCost": 60,
    "jumpPower": 1,
    "jumpWarmupTime": 15000,
    "kineticRes": 0.35,
    "legacyKeys": [
      "OMNI SOVEREIGN"
    ],
    "lockMultiplier": 2.5,
    "targetingStrength": 1,
    "lockOnRange": 1500,
    "maxSpeed": 1.8,
    "name": "OMNI SOVEREIGN",
    "recommendedWeaponSizes": [
      "M",
      "L"
    ],
    "registryKey": "OMNI SOVEREIGN",
    "scanRange": 1000,
    "scanSpeed": 1,
    "ship_id": "ship_omni_sovereign_t1",
    "spriteUrl": "/assets/hauler2.png",
    "thermalRes": 0.3,
    "thrustImpulse": 1.2,
    "turnSpeed": 0.03,
    "visualScale": 260
  }
};

/**
 * Map legacy strings (registry keys, blueprint output ids, etc.) -> ship_id.
 */
export const SHIP_ID_ALIASES = {
  "CartelGunship": "ship_cartel_gunship_t1",
  "CartelScout": "ship_cartel_scout_t1",
  "OMNI COMMAND": "ship_omni_command_t1",
  "OMNI GUNSHIP": "ship_omni_gunship_t1",
  "OMNI HAULER": "ship_omni_hauler_t1",
  "OMNI INTERCEPTOR": "ship_omni_interceptor_t1",
  "OMNI MINING SHIP": "ship_omni_mining_ship_t1",
  "OMNI SCOUT": "ship_omni_scout_t1",
  "OMNI SOVEREIGN": "ship_omni_sovereign_t1",
  "omni-scout-chassis": "ship_omni_scout_t1",
  "ship_omni_scout": "ship_omni_scout_t1",
  "ship_omni_interceptor": "ship_omni_interceptor_t1",
  "ship_omni_gunship": "ship_omni_gunship_t1",
  "ship_omni_hauler": "ship_omni_hauler_t1",
  "ship_omni_mining": "ship_omni_mining_ship_t1",
  "ship_omni_command": "ship_omni_command_t1",
  "ship_omni_sovereign": "ship_omni_sovereign_t1",
  "bp_ship_omni_scout": "ship_omni_scout_t1",
  "bp_ship_omni_interceptor": "ship_omni_interceptor_t1",
  "bp_ship_omni_gunship": "ship_omni_gunship_t1",
  "bp_ship_omni_hauler": "ship_omni_hauler_t1",
  "bp_ship_omni_mining": "ship_omni_mining_ship_t1",
  "bp_ship_omni_command": "ship_omni_command_t1",
  "bp_ship_omni_sovereign": "ship_omni_sovereign_t1"
};

const CANONICAL_PLAYER_SHIP_IDS = new Set([
  "ship_omni_scout",
  "ship_omni_interceptor",
  "ship_omni_gunship",
  "ship_omni_hauler",
  "ship_omni_mining",
  "ship_omni_command",
  "ship_omni_sovereign"
]);

const CANONICAL_TEMPLATE_BY_SHIP_ID = {
  ship_omni_scout: "ship_omni_scout_t1",
  ship_omni_interceptor: "ship_omni_interceptor_t1",
  ship_omni_gunship: "ship_omni_gunship_t1",
  ship_omni_hauler: "ship_omni_hauler_t1",
  ship_omni_mining: "ship_omni_mining_ship_t1",
  ship_omni_command: "ship_omni_command_t1",
  ship_omni_sovereign: "ship_omni_sovereign_t1"
};

export function resolveShipId(input) {
  if (!input) return null;
  const key = String(input);
  if (CANONICAL_PLAYER_SHIP_IDS.has(key)) return key;
  if (SHIP_CATALOG[key]) return key;
  if (SHIP_ID_ALIASES[key]) return SHIP_ID_ALIASES[key];
  return null;
}

export function resolveShipTemplate(input) {
  const shipId = resolveShipId(input);
  if (!shipId) return null;
  if (SHIP_CATALOG[shipId]) return SHIP_CATALOG[shipId] || null;
  const templateId = CANONICAL_TEMPLATE_BY_SHIP_ID[shipId] || shipId;
  return SHIP_CATALOG[templateId] || null;
}

/**
 * Resolve any legacy identifier or ship_id -> legacy registry key.
 * Use this when you still need SHIP_REGISTRY[...] lookups.
 */
export function resolveShipRegistryKey(input) {
  const tpl = resolveShipTemplate(input);
  if (tpl?.registryKey) return tpl.registryKey;
  return null;
}