/**
 * AUTO-EXTRACTED from GameManager_refactored.js
 * Purpose: keep GameManager lean; pure data exports.
 */

export const MINOR_MODIFIER_POOL = [
    { name: "Damage Boost", tag: "damage", minRoll: 3, maxRoll: 8 },
    { name: "Tracking Boost", tag: "tracking", minRoll: 4, maxRoll: 10 },
    { name: "Heat Dissipation", tag: "heat", minRoll: 5, maxRoll: 12 },
    { name: "Reload Speed", tag: "reload", minRoll: 3, maxRoll: 7 },
    { name: "Shield Recharge", tag: "shield_regen", minRoll: 4, maxRoll: 9 },
    { name: "Hull Integrity", tag: "hp", minRoll: 5, maxRoll: 10 },
    { name: "Reactor Recovery", tag: "energy_regen", minRoll: 5, maxRoll: 10 },
    { name: "Kinetic Resistance", tag: "res_kinetic", minRoll: 2, maxRoll: 4 },
    { name: "Thermal Resistance", tag: "res_thermal", minRoll: 2, maxRoll: 4 },
    { name: "Blast Resistance", tag: "res_blast", minRoll: 2, maxRoll: 4 },
    { name: "Agility Drive", tag: "agility", minRoll: 3, maxRoll: 12 },
    { name: "Grid Expansion", tag: "pg_boost", minRoll: 4, maxRoll: 10 },
    { name: "Optimal Range", tag: "range", minRoll: 5, maxRoll: 15 },
    { name: "Projectile Velocity", tag: "projectile_speed", minRoll: 5, maxRoll: 15 },
    { name: "Accuracy Calibration", tag: "accuracy", minRoll: 4, maxRoll: 10 },
    { name: "Shield Restoration", tag: "shield_regen", minRoll: 5, maxRoll: 12 },
    { name: "Recharge Delay Optimization", tag: "shield_delay", minRoll: 5, maxRoll: 15 },
    { name: "Sensor Resolution", tag: "scan_range", minRoll: 10, maxRoll: 25 },
    { name: "Lock-on Optimization", tag: "lock_speed", minRoll: 10, maxRoll: 25 },
    { name: "Cargo Expansion", tag: "cargo_capacity", minRoll: 5, maxRoll: 15 },
    { name: "Docking Protocol Speed", tag: "docking_speed", minRoll: 10, maxRoll: 30 },
    { name: "Mining Yield Boost", tag: "mining_yield", minRoll: 5, maxRoll: 15 }
];

export const MAJOR_MODIFIER_POOL = [
    { name: "Damage vs Shields", tag: "damage_shield", minRoll: 12, maxRoll: 25 },
    { name: "Damage vs Hull", tag: "damage_hull", minRoll: 12, maxRoll: 25 },
    { name: "Max Forward Velocity", tag: "speed", minRoll: 15, maxRoll: 30 }
];

export const PERK_POOL = [
    { name: "Quantum Precision", description: "Critical hits deal 50% more damage." },
    { name: "Void Siphon", description: "Destroying a target restores 10% energy." },
    { name: "Aegis Protocol", description: "When shields break, gain 50% resistance for 5s." }
];

export const MODIFIER_LIMITS = {
    common: { minor: 1, major: 0 },
    uncommon: { minor: 2, major: 0 },
    rare: { minor: 3, major: 1 },
    epic: { minor: 4, major: 1 },
    legendary: { minor: 4, major: 2 },
    mythic: { minor: 5, major: 3 }
};