import React, { useMemo } from 'react';
import { 
    DRONE_MODULE_CONFIGS, DRONE_STATS, MINING_LASER_CONFIGS, MINING_RARITY_MODS,
    PULSE_CANNON_CONFIGS, PULSE_RARITY_MODS, FLUX_LASER_CONFIGS, FLUX_RARITY_MODS,
    MISSILE_CONFIGS, MISSILE_RARITY_MODS, hydrateItem, getModColor
} from '../GameManager.js';
import { SHIP_REGISTRY } from '../shipRegistry.js';

const getAuthoritativeCombatStats = (ship) => (
    ship?.combatStats && typeof ship.combatStats === 'object'
        ? ship.combatStats
        : ((ship?.combat_stats && typeof ship.combat_stats === 'object') ? ship.combat_stats : {})
);

const getAuthoritativeNumber = (combatStats, keys = [], fallback = 0) => {
    for (const key of keys) {
        const value = combatStats?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return fallback;
};

/**
 * Aggregates all ship statistics based on fittings and authoritative backend-fed combat stats.
 * Ship registry is visual-only in Phase 9.
 */
export const aggregateShipStats = (ship, fittings) => {
    if (!ship) return null;
    
    const shipConfig = SHIP_REGISTRY[ship.type] || SHIP_REGISTRY[String(ship.type || '').toLowerCase()] || {};
    const shipFittings = fittings || ship.fittings || {};
    const combatStats = getAuthoritativeCombatStats(ship);
    
    // Tactical Offense & Defensive Global Calculations
    let totalBurstDps = 0;
    let totalSustainedDps = 0;
    let maxRange = 0;
    let avgTracking = 0;
    let avgAccuracy = 0;
    let avgProjectileVelocity = 0;
    let weaponCount = 0;
    
    // Industrial Capacity Calculations
    let totalExtractionRate = 0;
    let maxMiningRange = 0;
    let miningCount = 0;
    
    // Swarm Metrics
    let totalDroneDps = 0;
    let totalDroneMining = 0;
    let totalDroneRepair = 0;
    let droneControlRange = 0;
    let activeDroneCount = 0;
    
    // Defensive & Navigational Accumulators for catalyst-derived bonuses
    let hpBonus = 0;
    let kinResBonus = 0;
    let thermResBonus = 0;
    let blastResBonus = 0;
    let speedBonus = 0;
    let agilityBonus = 0; // Turn speed
    let pgBonus = 0;
    let cpuBonus = 0; // Added for completeness
    let capacitorBonus = 0;
    let shieldRegenBonus = 0;
    let shieldDelayBonus = 0;
    let sensorBonus = 0;
    let lockSpeedBonus = 0;
    let cargoBonus = 0;
    let dockingBonus = 0;

    const groupStats = {
        1: { burst: 0, sustained: 0, weaponCount: 0 },
        2: { burst: 0, sustained: 0, weaponCount: 0 }
    };

    Object.values(shipFittings).forEach(mod => {
        if (!mod) return;

        // Extract ship-wide modifiers from any module
        const getModVal = (tag) => mod.modifiers?.filter(m => m.tag === tag).reduce((s, m) => s + (m.currentRoll / 100), 0) || 0;
        hpBonus += getModVal('hp');
        kinResBonus += getModVal('res_kinetic');
        thermResBonus += getModVal('res_thermal');
        blastResBonus += getModVal('res_blast');
        speedBonus += getModVal('speed');
        agilityBonus += getModVal('agility');
        pgBonus += getModVal('pg_boost');
        cpuBonus += getModVal('cpu_boost');
        capacitorBonus += getModVal('energy_regen');
        shieldRegenBonus += getModVal('shield_regen');
        shieldDelayBonus += getModVal('shield_delay');
        sensorBonus += getModVal('scan_range');
        lockSpeedBonus += getModVal('lock_speed');
        cargoBonus += getModVal('cargo_capacity');
        dockingBonus += getModVal('docking_speed');

        const modType = (mod.type || "").toLowerCase();
        const nameLower = (mod.name || "").toLowerCase();

        // Drone Swarm Statistics Integration
        if (modType === 'drone-module') {
            const effective = mod.final_stats ? mod : hydrateItem(mod);
            const fs = effective.final_stats;
            droneControlRange = Math.max(droneControlRange, fs.controlRange);
            
            if (fs.hydratedDrones) {
                fs.hydratedDrones.forEach(d => {
                    activeDroneCount += d.count;
                    const dStats = d.stats;
                    if (dStats.damagePerTick) {
                        const dBase = DRONE_STATS[d.type];
                        totalDroneDps += (dStats.damagePerTick * dBase.ticksPerSecond * d.count);
                    }
                    if (dStats.miningRate) totalDroneMining += (dStats.miningRate * d.count * 60); // Convert to ore/min
                    if (dStats.repairRate) totalDroneRepair += (dStats.repairRate * d.count);
                });
            }
            return;
        }

        if (modType !== 'weapon' && modType !== 'mining') return;

        const size = mod.weaponsize || mod.size || 'S';
        const rarity = mod.rarity || 'common';
        
        // Extract weapon-specific modifiers
        const getMod = (tag) => 1 + (mod.modifiers?.filter(m => m.tag === tag).reduce((s, m) => s + (m.currentRoll / 100), 0) || 0);
        const dmgMod = getMod('damage');
        const trackingMod = getMod('tracking');
        const reloadMod = getMod('reload');
        const rangeMod = getMod('range');
        const projectileSpeedMod = getMod('projectile_speed');
        const accuracyMod = getMod('accuracy');
        const extractionMod = getMod('mining_yield');

        let modBurst = 0;
        let modSustained = 0;
        let modProjectileSpeed = 0;
        let modAccuracy = 0;

        if (modType === 'mining' || nameLower.includes('mining')) {
            miningCount++;
            const config = MINING_LASER_CONFIGS[size] || MINING_LASER_CONFIGS['S'];
            const rarityMods = MINING_RARITY_MODS[rarity] || MINING_RARITY_MODS.common;
            const yieldPerCycle = (mod.baseExtraction || config.baseExtraction || 1) * rarityMods.extraction * extractionMod;
            const cycleTime = (mod.fireRate || config.fireRate || 1) / rarityMods.fireRate;
            totalExtractionRate += (yieldPerCycle * (60 / cycleTime));
            maxMiningRange = Math.max(maxMiningRange, (mod.falloffRange || config.falloffRange || 400) * rarityMods.range * rangeMod);
        } else {
            weaponCount++;
            const effective = mod.final_stats ? mod : hydrateItem(mod);
            const fs = effective.final_stats;

            if (nameLower.includes('pulse cannon')) {
                modBurst = fs.damage * fs.fireRate;
                const cycleTime = (fs.magazine / fs.fireRate) + fs.reload;
                modSustained = (fs.magazine * fs.damage) / cycleTime;
                maxRange = Math.max(maxRange, fs.optimalRange);
                avgTracking += fs.tracking;
                modProjectileSpeed = fs.projectileSpeed;
                modAccuracy = fs.accuracy;
            } else if (nameLower.includes('flux')) {
                const dps = fs.damagePerTick * fs.fireRate;
                modBurst = dps;
                modSustained = dps;
                maxRange = Math.max(maxRange, fs.optimalRange);
                avgTracking += fs.tracking;
                modProjectileSpeed = 99; // Represents instant/beam
                modAccuracy = fs.accuracy;
            } else if (nameLower.includes('seeker') || nameLower.includes('missile')) {
                modBurst = fs.damage / 0.5;
                modSustained = fs.damage / fs.reload;
                maxRange = Math.max(maxRange, fs.optimalRange);
                avgTracking += fs.tracking;
                modProjectileSpeed = fs.missileSpeed;
                modAccuracy = fs.accuracy;
            }

            totalBurstDps += modBurst;
            totalSustainedDps += modSustained;
            avgProjectileVelocity += modProjectileSpeed;
            avgAccuracy += modAccuracy;

            if (mod.weaponGroup1) {
                groupStats[1].burst += modBurst;
                groupStats[1].sustained += modSustained;
                groupStats[1].weaponCount++;
            }
            if (mod.weaponGroup2) {
                groupStats[2].burst += modBurst;
                groupStats[2].sustained += modSustained;
                groupStats[2].weaponCount++;
            }
        }
    });

    if (weaponCount > 0) {
        avgTracking /= weaponCount;
        avgAccuracy /= weaponCount;
        avgProjectileVelocity /= weaponCount;
    }

    // EHP and Resists with Catalyst Modifiers applied
    const authoritativeRes = (ship.resistances && typeof ship.resistances === 'object')
        ? ship.resistances
        : ((combatStats.resistances && typeof combatStats.resistances === 'object') ? combatStats.resistances : {});
    const baseShipHP = typeof ship.maxHp === 'number'
        ? ship.maxHp
        : getAuthoritativeNumber(combatStats, ['maxHp', 'hull_base'], typeof ship.hp === 'number' ? ship.hp : 0);
    const finalHP = baseShipHP * (1 + hpBonus);
    const shieldCapacity = typeof ship.maxShields === 'number'
        ? ship.maxShields
        : getAuthoritativeNumber(combatStats, ['maxShields', 'shieldCapacity'], typeof ship.shields === 'number' ? ship.shields : 0);
    const finalKinRes = (typeof ship.kineticRes === 'number' ? ship.kineticRes : Number(authoritativeRes.kinetic ?? 0)) + kinResBonus;
    const finalThermRes = (typeof ship.thermalRes === 'number' ? ship.thermalRes : Number(authoritativeRes.thermal ?? 0)) + thermResBonus;
    const finalBlastRes = (typeof ship.blastRes === 'number' ? ship.blastRes : Number(authoritativeRes.blast ?? 0)) + blastResBonus;

    const avgRes = (finalKinRes + finalThermRes + finalBlastRes) / 3;
    const ehp = (finalHP + shieldCapacity) / Math.max(0.01, 1 - avgRes);

    // Shield restoration stats (aggregated from fittings)
    const baseShieldRegen = Object.values(shipFittings).reduce((sum, m) => sum + (m?.type === 'shield' ? (m.rechargeRate || 0) : 0), 0);
    const baseShieldDelay = Object.values(shipFittings).reduce((sum, m) => m?.type === 'shield' ? (m.rechargeDelay || 5) : sum, 5);
    
    const finalShieldRegen = baseShieldRegen * (1 + shieldRegenBonus);
    const finalShieldDelay = Math.max(0.5, baseShieldDelay * (2 - (1 + shieldDelayBonus))); 

    return {
        shipConfig,
        hull: {
            current: finalHP,
            max: getAuthoritativeNumber(combatStats, ['maxHp', 'hull_base'], typeof ship.maxHp === 'number' ? ship.maxHp : 0) * (1 + hpBonus),
            armor: ((typeof ship.armor === 'number' ? ship.armor : getAuthoritativeNumber(combatStats, ['armor'], 0)) * 100),
            ehp
        },
        resists: {
            kinetic: finalKinRes,
            thermal: finalThermRes,
            blast: finalBlastRes,
            average: avgRes
        },
        shields: {
            max: shieldCapacity,
            regen: finalShieldRegen,
            delay: finalShieldDelay
        },
        offense: {
            totalBurstDps,
            totalSustainedDps,
            maxRange,
            avgTracking,
            avgAccuracy,
            avgProjectileVelocity,
            weaponCount,
            groupStats
        },
        industrial: {
            miningCount,
            totalExtractionRate,
            maxMiningRange
        },
        swarm: {
            activeDroneCount,
            totalDroneDps,
            totalDroneMining,
            totalDroneRepair,
            droneControlRange
        },
        flight: {
            maxSpeed: getAuthoritativeNumber(combatStats, ['maxVelocity', 'max_velocity', 'max_velocity_base'], 0) * (1 + speedBonus),
            thrustImpulse: getAuthoritativeNumber(combatStats, ['thrustImpulse', 'thrust_impulse', 'thrust_impulse_base'], 0),
            turnSpeed: getAuthoritativeNumber(combatStats, ['turnSpeed', 'angularMomentum', 'angular_momentum', 'angular_momentum_base'], 0) * (1 + agilityBonus),
            jumpPower: typeof ship.jumpPower === 'number' ? ship.jumpPower : 1.0
        },
        electronics: {
            maxPowerGrid: getAuthoritativeNumber(combatStats, ['maxPowerGrid', 'powergrid', 'powergrid_base'], typeof ship.basePG === 'number' ? ship.basePG : 0) * (1 + pgBonus),
            maxCpu: getAuthoritativeNumber(combatStats, ['maxCpu', 'cpu', 'cpu_base'], typeof ship.baseCPU === 'number' ? ship.baseCPU : 0) * (1 + cpuBonus),
            energyRecharge: getAuthoritativeNumber(combatStats, ['energyRecharge', 'capacitorRecharge', 'capacitor_recharge', 'capacitor_recharge_base'], 0) * (1 + capacitorBonus),
            scanRange: getAuthoritativeNumber(combatStats, ['scanRange', 'scan_range', 'scan_range_base'], 0) * (1 + sensorBonus),
            scanSpeed: getAuthoritativeNumber(combatStats, ['scanSpeed', 'scan_speed'], 1),
            lockOnRange: getAuthoritativeNumber(combatStats, ['lockOnRange', 'lock_on_range', 'lock_on_range_base'], 0),
            targetingStrength: getAuthoritativeNumber(combatStats, ['targetingStrength', 'targeting_strength', 'lockMultiplier', 'lock_multiplier'], 1),
            sigRadius: getAuthoritativeNumber(combatStats, ['signatureRadius', 'signature_radius', 'signature_radius_base'], 0)
        },
        logistics: {
            cargoHold: getAuthoritativeNumber(combatStats, ['cargoCapacity', 'cargo_capacity', 'cargo_capacity_base'], 0) * (1 + cargoBonus),
            dockingBonus: 100 * (1 + dockingBonus)
        },
        bonuses: {
            hpBonus, kinResBonus, thermResBonus, blastResBonus, speedBonus, agilityBonus, 
            pgBonus, cpuBonus, capacitorBonus, shieldRegenBonus, shieldDelayBonus,
            sensorBonus, lockSpeedBonus, cargoBonus, dockingBonus
        }
    };
};

export const ShipStatistics = ({ ship, fittings, title = "TECHNICAL TELEMETRY", children }) => {
    const stats = useMemo(() => aggregateShipStats(ship, fittings), [ship, fittings]);

    if (!stats) return null;

    const { shipConfig, hull, resists, shields, offense, industrial, swarm, flight, electronics, logistics } = stats;

    const statSections = [
        { section: 'STRUCTURAL INTEGRITY', stats: [
            { label: 'HULL HP', value: `${hull.current.toFixed(0)} / ${hull.max.toFixed(0)}`, color: hull.current < hull.max ? '#ff4444' : '#fff' },
            { label: 'ARMOR RATING', value: `${hull.armor.toFixed(1)}%`, color: '#fff' },
            { label: 'SHIELD CAPACITY', value: shields.max > 0 ? `${shields.max.toFixed(0)} units` : 'OFFLINE', color: '#fff' },
            { label: 'SHIELD RECOVERY', value: shields.max > 0 ? `${shields.regen.toFixed(1)} u/s` : 'N/A', color: '#fff' },
            { label: 'RECHARGE DELAY', value: shields.max > 0 ? `${shields.delay.toFixed(1)}s` : 'N/A', color: '#fff' },
            { label: 'ESTIMATED EHP', value: `${hull.ehp.toFixed(0)} units`, color: '#fff' }
        ]},
        { section: 'DEFENSIVE RESISTANCES', stats: [
            { label: 'KINETIC RES', value: `${(resists.kinetic * 100).toFixed(1)}%`, color: '#fff' },
            { label: 'THERMAL RES', value: `${(resists.thermal * 100).toFixed(1)}%`, color: '#fff' },
            { label: 'BLAST RES', value: `${(resists.blast * 100).toFixed(1)}%`, color: '#fff' }
        ]},
        { section: 'TACTICAL OFFENSE', stats: [
            { label: 'TOTAL BURST DPS', value: `${offense.totalBurstDps.toFixed(1)} u/s`, color: '#fff' },
            { label: 'TOTAL SUSTAINED DPS', value: `${offense.totalSustainedDps.toFixed(1)} u/s`, color: '#fff' },
            { label: 'MAX RANGE', value: `${offense.maxRange.toFixed(0)}m`, color: '#fff' },
                        { label: 'ACCURACY RATING', value: `${(offense.avgAccuracy * 100).toFixed(1)}%`, color: '#fff' },
            { label: 'PROJECTILE VELOCITY', value: offense.avgProjectileVelocity >= 99 ? 'INSTANT' : `${offense.avgProjectileVelocity.toFixed(1)} u/s`, color: '#fff' }
        ]}
    ];

    if (industrial.miningCount > 0 || swarm.totalDroneMining > 0) {
        statSections.push({
            section: 'SHIP INDUSTRIAL CAPACITY',
            stats: [
                { label: 'LASER YIELD', value: `${industrial.totalExtractionRate.toFixed(1)} ore/min`, color: '#00ff66' },
                { label: 'SWARM EXTRACTION', value: `${swarm.totalDroneMining.toFixed(1)} ore/min`, color: '#00ff66' },
                { label: 'TOTAL YIELD RATE', value: `${(industrial.totalExtractionRate + swarm.totalDroneMining).toFixed(1)} ore/min`, color: '#00ff66' },
                { label: 'MINING RANGE', value: `${industrial.maxMiningRange.toFixed(0)}m`, color: '#fff' }
            ]
        });
    }

    if (swarm.activeDroneCount > 0) {
        statSections.push({
            section: 'ACTIVE SWARM TELEMETRY',
            stats: [
                { label: 'UNIT COUNT', value: `${swarm.activeDroneCount} UNITS`, color: '#00ccff' },
                { label: 'SWARM COMBAT YIELD', value: `${swarm.totalDroneDps.toFixed(1)} dmg/s`, color: '#fff' },
                { label: 'SWARM REPAIR YIELD', value: `${swarm.totalDroneRepair.toFixed(1)} hp/s`, color: '#00ff66' },
                { label: 'SWARM MINING YIELD', value: `${swarm.totalDroneMining.toFixed(1)} ore/min`, color: '#00ff66' },
                { label: 'CONTROL RADIUS', value: `${swarm.droneControlRange.toFixed(0)}m`, color: '#fff' }
            ]
        });
    }

    statSections.push({
        section: 'FLIGHT DYNAMICS',
        stats: [
            { label: 'MAX VELOCITY', value: `${flight.maxSpeed.toFixed(1)} u/s`, color: '#fff' },
            { label: 'THRUST IMPULSE', value: `${flight.thrustImpulse.toFixed(1)} u/s²`, color: '#fff' },
            { label: 'ANGULAR MOMENTUM', value: `${flight.turnSpeed.toFixed(3)} rad/s`, color: '#fff' },
            { label: 'JUMP POWER', value: `${flight.jumpPower.toFixed(1)} u`, color: '#fff' }
        ]
    });

    statSections.push({
        section: 'ELECTRONICS & PAYLOAD',
        stats: [
            { label: 'POWER GRID', value: `${electronics.maxPowerGrid.toFixed(0)} MW`, color: '#fff' },
            { label: 'CPU BANDWIDTH', value: `${electronics.maxCpu.toFixed(0)} TF`, color: '#fff' },
            { label: 'CAPACITOR RECHARGE', value: `${electronics.energyRecharge.toFixed(1)} u/s`, color: '#fff' },
            { label: 'SCAN RANGE', value: `${electronics.scanRange.toFixed(0)}m`, color: '#fff' },
            { label: 'SCAN SPEED', value: `${electronics.scanSpeed.toFixed(2)}x`, color: '#fff' },
            { label: 'LOCK-ON RANGE', value: `${electronics.lockOnRange.toFixed(0)}m`, color: '#fff' },
            { label: 'TARGETING STRENGTH', value: `${electronics.targetingStrength.toFixed(2)}x`, color: '#fff' },
            { label: 'SIGNATURE RADIUS', value: `${electronics.sigRadius.toFixed(1)}m`, color: '#fff' }
        ]
    });

    statSections.push({
        section: 'LOGISTICS & OPERATIONS',
        stats: [
            { label: 'CARGO CAPACITY', value: `${logistics.cargoHold.toFixed(1)} m³`, color: '#fff' },
            { label: 'DOCKING OVERRIDE', value: `${logistics.dockingBonus.toFixed(0)}%`, color: '#fff' }
        ]
    });

    return React.createElement('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            overflow: 'hidden',
            flex: 1,
            minHeight: 0
        }
    },
        React.createElement('div', { style: { fontSize: '22px', color: '#ffcc00', fontWeight: 'bold', letterSpacing: '4px', borderBottom: '1px solid #333', paddingBottom: '15px', flexShrink: 0 } }, title),
        
        React.createElement('div', {
            onWheel: (e) => e.stopPropagation(),
            style: {
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingRight: '15px',
                minHeight: 0, // Critical for flex-basis scrolling
                scrollbarWidth: 'auto', // Changed from thin for better visibility
                scrollbarColor: '#ffcc00 rgba(0,0,0,0.3)'
            }
        },
            // CSS Injection for custom scrollbar styling
            React.createElement('style', null, `
                div::-webkit-scrollbar {
                    width: 6px;
                }
                div::-webkit-scrollbar-track {
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 10px;
                }
                div::-webkit-scrollbar-thumb {
                    background: #ffcc00;
                    border-radius: 10px;
                }
                div::-webkit-scrollbar-thumb:hover {
                    background: #ffd633;
                }
            `),
            // Visual Component
            React.createElement('div', {
                style: {
                    height: '140px',
                    background: 'radial-gradient(circle at 50% 50%, #111 0%, #000 100%)',
                    border: '1px solid #333',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                    overflow: 'hidden',
                    marginBottom: '10px',
                    flexShrink: 0
                }
            },
                React.createElement('div', {
                    style: {
                        position: 'absolute',
                        width: '100%',
                        height: '100%',
                        background: 'repeating-linear-gradient(90deg, rgba(255,204,0,0.03) 0px, rgba(255,204,0,0.03) 1px, transparent 1px, transparent 40px)',
                        pointerEvents: 'none'
                    }
                }),
                React.createElement('img', {
                    src: shipConfig?.spriteUrl || '/assets/spaceship.png.webp',
                    style: { 
                        width: `${100 * (shipConfig?.uiScale || 1.0)}px`, 
                        transform: 'rotate(-45deg)', 
                        filter: 'drop-shadow(0 0 20px rgba(255,204,0,0.3))' 
                    }
                })
            ),

            statSections.map((group, i) => (
                React.createElement('div', { key: i, style: { marginBottom: '5px' } },
                    React.createElement('div', { style: { fontSize: '10px', color: '#ffcc00', marginBottom: '8px', letterSpacing: '2px', fontWeight: 'bold', opacity: 0.6 } }, group.section),
                    group.stats.map((stat, j) => (
                        React.createElement('div', { key: j, style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '2px' } },
                            React.createElement('span', { style: { color: '#fff', opacity: 0.8 } }, stat.label),
                            React.createElement('span', { style: { color: stat.color || '#fff', fontWeight: 'bold' } }, stat.value)
                        )
                    ))
                )
            )),
            // Bottom spacer for scrolling comfort
            React.createElement('div', { style: { height: '30px', flexShrink: 0 } })
        ),
        children
    );
};