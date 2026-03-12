import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { 
    GameManager, SYSTEMS_REGISTRY, ASTEROID_TYPES, TIER_CONFIGS, FLUX_LASER_CONFIGS, FLUX_RARITY_MODS, 
    MISSILE_CONFIGS, MISSILE_RARITY_MODS, PULSE_CANNON_CONFIGS, MINING_LASER_CONFIGS, MINING_RARITY_MODS,
    getIonThrusterStats, getShieldModuleStats, BLUEPRINT_REGISTRY, calculateQLModifier, getModColor, applyCraftingModifications, applyCatalystToItem, getItemResourceRequirements,
    IMPLANT_REGISTRY, calculateImplantRequirement, LEVEL_REQUIREMENTS, getRequiredExp, DRONE_MODULE_CONFIGS, DRONE_STATS, getQLBand, hydrateItem, PULSE_RARITY_MODS,
    STARPORT_TO_SYSTEM, SYSTEM_TO_STARPORT
} from './GameManager.js';
import { SHIP_REGISTRY } from './shipRegistry.js';
import { ITEM_CATALOG } from './data/items/catalog.js';
import { createItemInstance, deriveItemIdFromBlueprint } from './data/items/items.helpers.js';
import { validateItemBlueprintIntegrity } from './data/items/validate.js';
import { resolveShipId, resolveShipRegistryKey } from './data/ships/catalog.js';
import { cloudService } from './CloudService.js';
import { supabase } from './supabaseClient.js';
import { chatService } from './chat/ChatService.js';
import { initMultiplayer, disconnectMultiplayer, multiplayerEnabled } from './multiplayer.js';
import { backendSocket } from './websocket.js';
import { uuid } from './utils.js';
import MarketSystem from './marketSystem.js';
import { ShipStatistics } from './components/ShipStatistics.js';
import { SocialMenu } from './components/SocialMenu.js';
import PortraitPicker from './components/PortraitPicker.js';
import { useDraggable } from './hooks/useDraggable.js';
import { GameStateProvider, useGameState } from './state/GameState.js';
import { ArenaMenu } from './arena/ArenaMenu.js';
import { PveBattlegroundMenu } from './battlegrounds/PveBattlegroundMenu.js';
function numOr(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

// -----------------------------------------------------
// SHIP DISPLAY NAME (ship_id -> human name)
// -----------------------------------------------------
const prettifyShipId = (value) => {
  const s = String(value || '').trim();
  if (!s) return 'UNKNOWN SHIP';
  // ship_omni_scout_t1 -> OMNI SCOUT
  const cleaned = s
    .replace(/^ship_/, '')
    .replace(/_t\d+$/i, '')
    .replace(/_/g, ' ')
    .trim();
  return cleaned ? cleaned.toUpperCase() : s.toUpperCase();
};

const getShipDisplayName = (shipTypeOrId) => {
  const sid = resolveShipId(shipTypeOrId) || shipTypeOrId;
  const regKey = resolveShipRegistryKey(sid) || sid;
  const cfg = SHIP_REGISTRY[regKey] || SHIP_REGISTRY[sid] || SHIP_REGISTRY[shipTypeOrId];
  return cfg?.name || cfg?.displayName || cfg?.label || prettifyShipId(shipTypeOrId);
};

// More conservative: class label should never fall back to a raw ship_id.
const getShipClassLabel = (shipTypeOrId) => {
  const sid = resolveShipId(shipTypeOrId) || shipTypeOrId;
  const regKey = resolveShipRegistryKey(sid) || sid;
  const cfg = SHIP_REGISTRY[regKey] || SHIP_REGISTRY[sid] || SHIP_REGISTRY[shipTypeOrId];
  const candidate = cfg?.classLabel || cfg?.className || cfg?.hullClass || cfg?.role || cfg?.classId;
  if (!candidate) return 'VESSEL';
  // If the "class" is actually a ship id, don't show it.
  if (String(candidate).toLowerCase().startsWith('ship_')) return 'VESSEL';
  return String(candidate).toUpperCase();
};

const STACKABLE_TRANSFER_TYPES = new Set(['resource', 'material', 'blueprint', 'bio-material', 'ore']);

const canItemsStackForTransfer = (a, b) => {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (!STACKABLE_TRANSFER_TYPES.has(a.type)) return false;

  if (a.type === 'blueprint') {
    return a.blueprintId === b.blueprintId && a.rarity === b.rarity;
  }

  const sameIdentity =
    (a.id && b.id && a.id === b.id) ||
    (a.materialKey && b.materialKey && a.materialKey === b.materialKey) ||
    (a.name && b.name && a.name === b.name);

  return sameIdentity && a.qlBand === b.qlBand && Boolean(a.isRefined) === Boolean(b.isRefined);
};

const mergeTransferredItemIntoList = (items, rawItem) => {
  const item = hydrateItem(rawItem);
  const nextItems = [...(items || [])];
  const existingIndex = nextItems.findIndex(existing => canItemsStackForTransfer(existing, item));

  if (existingIndex === -1) {
    nextItems.push(item);
    return nextItems;
  }

  const existing = { ...nextItems[existingIndex] };
  existing.amount = Number(existing.amount || 1) + Number(item.amount || 1);

  if (existing.weight != null || item.weight != null) {
    existing.weight = Number((parseFloat(existing.weight) || 0) + (parseFloat(item.weight) || 0)).toFixed(1);
  }
  if (existing.volume != null || item.volume != null) {
    existing.volume = Number((parseFloat(existing.volume) || 0) + (parseFloat(item.volume) || 0)).toFixed(1);
  }

  nextItems[existingIndex] = existing;
  return nextItems;
};

const removeSingleTransferredItemFromList = (items, rawItem) => {
  const nextItems = [...(items || [])];
  const exactIndex = nextItems.findIndex(existing => existing === rawItem);
  if (exactIndex !== -1) {
    nextItems.splice(exactIndex, 1);
    return nextItems;
  }

  const matchIndex = nextItems.findIndex(existing => {
    if (existing.id && rawItem.id && existing.id === rawItem.id && existing.type === rawItem.type) {
      if (canItemsStackForTransfer(existing, rawItem)) return true;
      if (!STACKABLE_TRANSFER_TYPES.has(existing.type)) return true;
    }
    return canItemsStackForTransfer(existing, rawItem);
  });

  if (matchIndex !== -1) nextItems.splice(matchIndex, 1);
  return nextItems;
};

const calculateCargoTotals = (items) => {
  return (items || []).reduce((totals, item) => {
    totals.weight += parseFloat(item?.weight) || 0;
    totals.volume += parseFloat(item?.volume) || (parseFloat(item?.weight) * 1.5) || 0;
    return totals;
  }, { weight: 0, volume: 0 });
};

const FleetHUD = ({ fleet, remotePlayers, userId, onTargetMember, onLeaveFleet, onKickMember }) => {
    const { offset, isDragging, dragProps } = useDraggable();

    if (!fleet || fleet.length === 0) return null;

    const leaderId = fleet.find(m => m.isLeader)?.id;
    const isLeader = userId === leaderId;

    return React.createElement('div', {
        style: {
            position: 'absolute',
            right: '380px',
            bottom: '20px',
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            width: '220px',
            pointerEvents: 'none',
            zIndex: 1005,
            transition: isDragging ? 'none' : 'transform 0.15s ease-out'
        }
    },
        React.createElement('div', {
            ...dragProps,
            style: {
                ...dragProps.style,
                pointerEvents: 'auto',
                alignSelf: 'stretch',
                padding: '6px 10px',
                background: 'rgba(0, 10, 20, 0.9)',
                border: '1px solid rgba(0, 204, 255, 0.35)',
                borderRadius: '4px',
                color: '#73d5ff',
                fontFamily: 'monospace',
                fontSize: '10px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
                userSelect: 'none'
            }
        }, 'FLEET'),
        fleet.map(member => {
            const isMe = member.id === userId;
            const remoteData = !isMe ? remotePlayers.get(member.id) : null;
            const statsSource = isMe ? member : (remoteData?.stats || member || {});
            const stats = {
                hp: Number.isFinite(statsSource?.hp) ? statsSource.hp : 0,
                maxHp: Number.isFinite(statsSource?.maxHp) ? statsSource.maxHp : 100,
                shields: Number.isFinite(statsSource?.shields) ? statsSource.shields : 0,
                maxShields: Number.isFinite(statsSource?.maxShields) ? statsSource.maxShields : 0,
                energy: Number.isFinite(statsSource?.energy) ? statsSource.energy : 0,
                maxEnergy: Number.isFinite(statsSource?.maxEnergy) ? statsSource.maxEnergy : 100
            };
            
            const hpPercent = (stats.hp / stats.maxHp) * 100 || 0;
            const shieldPercent = (stats.shields / stats.maxShields) * 100 || 0;
            const energyPercent = (stats.energy / stats.maxEnergy) * 100 || 0;

            return React.createElement('div', {
                key: member.id,
                style: {
                    background: 'rgba(0,0,0,0.85)',
                    border: `1px solid ${member.isLeader ? '#ffcc0044' : '#00ff6644'}`,
                    borderRadius: '4px',
                    padding: '8px',
                    fontFamily: 'monospace',
                    boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'transform 0.1s'
                },
                onClick: () => onTargetMember(member.id),
                onMouseDown: (e) => e.currentTarget.style.transform = 'scale(0.98)',
                onMouseUp: (e) => e.currentTarget.style.transform = 'scale(1)',
            },
                React.createElement('div', { 
                    style: { 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '6px'
                    } 
                },
                    React.createElement('div', { 
                        style: { 
                            color: member.isLeader ? '#ffcc00' : '#00ff66', 
                            fontSize: '11px', 
                            fontWeight: 'bold', 
                            whiteSpace: 'nowrap', 
                            overflow: 'hidden', 
                            textOverflow: 'ellipsis',
                            maxWidth: '120px'
                        } 
                    }, (isMe ? 'YOU' : member.name).toUpperCase()),
                    member.isLeader && React.createElement('div', {
                        style: {
                            fontSize: '8px',
                            background: '#ffcc00',
                            color: '#000',
                            padding: '1px 4px',
                            borderRadius: '2px',
                            fontWeight: 'bold'
                        }
                    }, 'LEAD')
                ),
                
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    stats.maxShields > 0 && React.createElement('div', { style: { height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '1px', overflow: 'hidden' } },
                        React.createElement('div', { style: { width: `${shieldPercent}%`, height: '100%', background: '#00ccff', transition: 'width 0.3s ease' } })
                    ),
                    React.createElement('div', { style: { height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '1px', overflow: 'hidden' } },
                        React.createElement('div', { style: { width: `${hpPercent}%`, height: '100%', background: '#ff4444', transition: 'width 0.3s ease' } })
                    ),
                    React.createElement('div', { style: { height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '1px', overflow: 'hidden' } },
                        React.createElement('div', { style: { width: `${energyPercent}%`, height: '100%', background: '#00ff66', transition: 'width 0.3s ease' } })
                    )
                ),

                React.createElement('div', {
                    style: {
                        marginTop: '8px',
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: '5px'
                    }
                },
                    isMe ? React.createElement('button', {
                        onClick: (e) => { e.stopPropagation(); onLeaveFleet(); },
                        style: { background: 'none', border: '1px solid #ff444488', color: '#ff4444', fontSize: '9px', padding: '2px 6px', cursor: 'pointer', borderRadius: '2px' }
                    }, 'LEAVE') : (isLeader && React.createElement('button', {
                        onClick: (e) => { e.stopPropagation(); onKickMember(member.id); },
                        style: { background: 'none', border: '1px solid #ff444488', color: '#ff4444', fontSize: '9px', padding: '2px 6px', cursor: 'pointer', borderRadius: '2px' }
                    }, 'KICK'))
                )
            );
        })
    );
};

const ContextMenu = ({ x, y, entity, onInspect, onInvite, onMessage, onClose }) => {
    return React.createElement('div', {
        style: {
            position: 'fixed',
            left: `${x}px`,
            top: `${y}px`,
            background: 'rgba(0,0,0,0.95)',
            border: '1px solid #00ccff88',
            borderRadius: '4px',
            padding: '4px',
            zIndex: 1000,
            minWidth: '150px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.8)',
            fontFamily: 'monospace'
        },
        onClick: (e) => e.stopPropagation()
    },
        React.createElement('div', { style: { padding: '8px', borderBottom: '1px solid #333', color: '#888', fontSize: '10px' } }, (entity.name || entity.type)?.toUpperCase()),
        React.createElement('div', {
            style: { padding: '10px', color: '#fff', fontSize: '13px', cursor: 'pointer', transition: 'background 0.2s' },
            onMouseEnter: (e) => e.currentTarget.style.background = 'rgba(0,204,255,0.2)',
            onMouseLeave: (e) => e.currentTarget.style.background = 'transparent',
            onClick: () => { onInspect(entity); onClose(); }
        }, 'INSPECT'),
        React.createElement('div', {
            style: { padding: '10px', color: '#fff', fontSize: '13px', cursor: 'pointer', transition: 'background 0.2s' },
            onMouseEnter: (e) => e.currentTarget.style.background = 'rgba(0,204,255,0.2)',
            onMouseLeave: (e) => e.currentTarget.style.background = 'transparent',
            onClick: () => { onMessage(entity); onClose(); }
        }, 'MESSAGE'),
        React.createElement('div', {
            style: { padding: '10px', color: '#fff', fontSize: '13px', cursor: 'pointer', transition: 'background 0.2s' },
            onMouseEnter: (e) => e.currentTarget.style.background = 'rgba(0,204,255,0.2)',
            onMouseLeave: (e) => e.currentTarget.style.background = 'transparent',
            onClick: () => { onInvite(entity); onClose(); }
        }, 'INVITE TO FLEET')
    );
};

const MarketHistoryGraph = ({ data, color = '#00ccff' }) => {
    if (!data || data.length < 2) return React.createElement('div', { style: { height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: '10px', border: '1px solid #222', borderRadius: '4px' } }, 'INSUFFICIENT MARKET DATA');

    const maxPrice = Math.max(...data.map(d => d.price));
    const minPrice = Math.min(...data.map(d => d.price));
    const range = maxPrice - minPrice || 1;
    
    const width = 240;
    const height = 60;
    const padding = 5;
    
    const points = data.map((d, i) => {
        const x = (i / (data.length - 1)) * (width - padding * 2) + padding;
        const y = height - ((d.price - minPrice) / range) * (height - padding * 2) - padding;
        return `${x},${y}`;
    }).join(' ');

    return React.createElement('div', { style: { position: 'relative', height: '80px', marginTop: '10px' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#666', marginBottom: '4px' } },
            React.createElement('span', null, '7-DAY PRICE TREND'),
            React.createElement('span', { style: { color: '#aaa' } }, `${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)} Cr`)
        ),
        React.createElement('svg', { width: '100%', height: height, style: { background: 'rgba(0,0,0,0.3)', borderRadius: '4px', border: '1px solid #222' } },
            // Grid lines
            [0.25, 0.5, 0.75].map(p => React.createElement('line', { key: p, x1: 0, y1: height * p, x2: '100%', y2: height * p, stroke: '#111', strokeWidth: 1 })),
            // The Trend Line
            React.createElement('polyline', {
                fill: 'none',
                stroke: color,
                strokeWidth: '2',
                points: points,
                strokeLinecap: 'round',
                strokeLinejoin: 'round'
            }),
            // Points
            data.map((d, i) => {
                const x = (i / (data.length - 1)) * (width - padding * 2) + padding;
                const y = height - ((d.price - minPrice) / range) * (height - padding * 2) - padding;
                return React.createElement('circle', { key: i, cx: x, cy: y, r: 2, fill: color });
            })
        )
    );
};

const ItemSpecificationList = ({ item }) => {
    if (!item) return null;
    
    // Always hydrate the item if it hasn't been yet, to ensure we have final_stats
    const effectiveItem = item.final_stats ? item : hydrateItem(item);
    const { final_stats, rarity = 'common', quality = 120 } = effectiveItem;

    const isBlueprint = effectiveItem.type === 'blueprint';
    const bpRegistryData = isBlueprint ? BLUEPRINT_REGISTRY[effectiveItem.blueprintId] : null;
    const itemForType = bpRegistryData ? { ...bpRegistryData, ...effectiveItem } : effectiveItem;

    const effectiveType = isBlueprint ? (itemForType.outputType || itemForType.type) : itemForType.type;
    const nameLower = (itemForType.name || '').toLowerCase();
    const idLower = (itemForType.id || '').toLowerCase();
    
    const isFlux = nameLower.includes('flux') || idLower.includes('flux');
    const isMining = effectiveType === 'mining' || nameLower.includes('mining');
    const isMissile = nameLower.includes('seeker pod') || idLower.includes('seeker pod') || nameLower.includes('missile');
    const isPulse = nameLower.includes('pulse') || idLower.includes('pulse');
    const isThruster = effectiveType === 'thruster' || nameLower.includes('thruster');
    const isShield = effectiveType === 'shield' || nameLower.includes('shield');
    const isDroneModule = effectiveType === 'drone-module' || nameLower.includes('drone');
    const isImplant = effectiveType === 'implant' || nameLower.includes('implant');
    
    const size = effectiveItem.weaponsize || effectiveItem.size || 'S';

    let stats = [];

    if (isImplant) {
        const implantData = IMPLANT_REGISTRY[effectiveItem.id] || effectiveItem;
        const reqValue = calculateImplantRequirement(quality);
        
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'quality', label: 'QUALITY RATING', value: `QL ${quality}`, color: getModColor(calculateQLModifier(quality) * 100) },
            { id: 'slot', label: 'NEURAL SLOT', value: (implantData.slot || 'BRAIN').toUpperCase() },
            { id: 'reqStat', label: 'REQUIRED INTERFACE', value: (implantData.requiredStatType || 'Neural Stability').toUpperCase(), color: '#ffcc00' },
            { id: 'reqValue', label: 'MIN QUALIFICATION', value: `LEVEL ${reqValue}` },
            { label: '---', value: '---' },
            { label: 'INTERFACE BONUSES', value: 'ACTIVE', color: '#00ccff' }
        ];

        // Map internal stat tags to readable labels
        const statLabels = {
            tracking: 'TRACKING CALIBRATION',
            baseAccuracy: 'TARGETING PRECISION',
            scanRange: 'SENSOR RESOLUTION',
            lockOnRange: 'SIGNAL LOCK RANGE',
            baseEnergyRecharge: 'REACTOR REGULATION',
            reactorRegulation: 'ENERGY RECOVERY SPEED',
            cpu: 'NEURAL PROCESSING (CPU)',
            nanoProgramming: 'NANITE COHESION',
            kineticCannonProficiency: 'KINETIC PROFICIENCY'
        };

        if (implantData.stats) {
            Object.entries(implantData.stats).forEach(([key, val]) => {
                const label = statLabels[key] || key.toUpperCase().replace(/_/g, ' ');
                const isPercent = key === 'baseAccuracy' || key.toLowerCase().includes('proficiency');
                stats.push({ 
                    label, 
                    value: isPercent ? `+${(val * 100).toFixed(1)}%` : `+${val.toFixed(1)} u`
                });
            });
        }
    } else if (isDroneModule) {
        const droneName = effectiveItem.outputId || effectiveItem.name || "";
        const moduleConfig = DRONE_MODULE_CONFIGS ? DRONE_MODULE_CONFIGS[droneName] : null;
        const baseConfig = moduleConfig || { drones: [], controlRange: 650, energyDrain: 5 };
        const controlRange = final_stats.controlRange ?? baseConfig.controlRange ?? 0;
        const energyDrain = final_stats.energyDrain ?? baseConfig.energyDrain ?? 0;
        
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'quality', label: 'QUALITY RATING', value: `QL ${quality}`, color: getModColor(calculateQLModifier(quality) * 100) },
            { id: 'size', label: 'MODULE SIZE', value: `CLASS ${size}` },
            { id: 'drones', label: 'DRONE COMPLEMENT', value: baseConfig.drones.map(d => `${d.count}x ${d.type}`).join(', ') },
            { id: 'controlRange', label: 'SIGNAL RANGE', value: `${Number(controlRange).toFixed(0)}m` },
            { id: 'energyDrain', label: 'PEAK ENERGY DRAIN', value: `${Number(energyDrain).toFixed(1)} u/s` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` }
        ];

        // Display hydrated drone unit stats if available
        const droneRefs = final_stats.hydratedDrones || baseConfig.drones;
        droneRefs.forEach(d => {
            const dBase = DRONE_STATS[d.type];
            const dStats = d.stats || dBase;
            if (dStats) {
                stats.push({ label: '---', value: '---' });
                stats.push({ label: `${d.type.toUpperCase()} UNIT`, value: 'SPECIFICATIONS', color: '#00ccff' });
                stats.push({ label: 'HULL / SHIELD', value: `${(dStats.hull || dBase.hull).toFixed(0)} / ${(dStats.shield || dBase.shield || 0).toFixed(0)}` });
                stats.push({ label: 'MAX VELOCITY', value: `${(dStats.speed || dBase.speed).toFixed(0)} u/s` });
                
                if (dBase.damagePerTick) {
                    const finalDamage = dStats.damagePerTick || dBase.damagePerTick;
                    stats.push({ label: 'ATTACK YIELD', value: `${(finalDamage * dBase.ticksPerSecond).toFixed(1)} dmg/s` });
                    stats.push({ label: 'ACCURACY', value: `${(dBase.accuracy * 100).toFixed(0)}%` });
                }
                if (dBase.miningRate) {
                    const finalRate = dStats.miningRate || dBase.miningRate;
                    stats.push({ label: 'MINING YIELD', value: `${finalRate.toFixed(1)} u/tick` });
                    stats.push({ label: 'ORE CAPACITY', value: `${dBase.capacity} units` });
                }
                if (dBase.repairRate) {
                    const finalRepair = dStats.repairRate || dBase.repairRate;
                    stats.push({ label: 'REPAIR RATE', value: `${finalRepair.toFixed(1)} hp/s` });
                }
                stats.push({ label: 'REBUILD CYCLE', value: `${dBase.rebuildTime}s` });
            }
        });
    } else if (isFlux) {
        const damagePerTick = final_stats.damagePerTick || 0;
        const fireRate = final_stats.fireRate || 0;
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'quality', label: 'QUALITY RATING', value: `QL ${quality}`, color: getModColor(calculateQLModifier(quality) * 100) },
            { id: 'weaponsize', label: 'WEAPON SIZE', value: `CLASS ${size}` },
            { id: 'damageType', label: 'DAMAGE TYPE', value: 'THERMAL FLUX' },
            { id: 'damagePerTick', label: 'TICK DAMAGE', value: `${damagePerTick.toFixed(1)} u` },
            { id: 'fireRate', label: 'CYCLE FREQUENCY', value: `${fireRate.toFixed(0)} Hz` },
            { id: 'dps', label: 'BURST YIELD (DPS)', value: `${(damagePerTick * fireRate).toFixed(1)} dmg/s` },
            { id: 'accuracy', label: 'BASE ACCURACY', value: `${((final_stats.accuracy || 0) * 100).toFixed(0)}%` },
            { id: 'tracking', label: 'BEAM TRACKING', value: `${(final_stats.tracking || 0).toFixed(0)}` },
            { id: 'optimalRange', label: 'OPTIMAL RANGE', value: `${(final_stats.optimalRange || 0).toFixed(0)}m` },
            { id: 'falloffRange', label: 'FALLOFF RANGE', value: `${(final_stats.falloffRange || 0).toFixed(0)}m` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` },
        ];
    } else if (isMining) {
        const extraction = final_stats.baseExtraction || 0;
        const cycle = final_stats.fireRate || 1;
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'quality', label: 'QUALITY RATING', value: `QL ${quality}`, color: getModColor(calculateQLModifier(quality) * 100) },
            { id: 'weaponsize', label: 'WEAPON SIZE', value: `CLASS ${size}` },
            { id: 'baseExtraction', label: 'EXTRACTION YIELD', value: `${extraction.toFixed(1)} u/tick` },
            { id: 'extractionRate', label: 'EXTRACTION RATE', value: `${(extraction / cycle).toFixed(1)} u/s` },
            { id: 'fireRate', label: 'CYCLE DURATION', value: `${cycle.toFixed(1)}s` },
            { id: 'falloffRange', label: 'MAX REACH', value: `${(final_stats.falloffRange || 0).toFixed(0)}m` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` },
        ];
    } else if (isMissile) {
        const reloadTime = final_stats.reload || 0;
        const damage = final_stats.damage || 0;
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'quality', label: 'QUALITY RATING', value: `QL ${quality}`, color: getModColor(calculateQLModifier(quality) * 100) },
            { id: 'weaponsize', label: 'WEAPON SIZE', value: `CLASS ${size}` },
            { id: 'damageType', label: 'DAMAGE TYPE', value: 'BLAST (AOE)' },
            { id: 'damage', label: 'ALPHA DAMAGE', value: `${damage.toFixed(0)} u` },
            { id: 'reload', label: 'RELOAD DELAY', value: `${reloadTime.toFixed(1)}s` },
            { id: 'dps', label: 'SUSTAINED DPS', value: `${(damage / Math.max(0.1, reloadTime)).toFixed(1)} dmg/s` },
            { id: 'accuracy', label: 'BASE ACCURACY', value: `${((final_stats.accuracy || 0) * 100).toFixed(0)}%` },
            { id: 'aoeRadius', label: 'BLAST RADIUS', value: `${(final_stats.aoeRadius || 0).toFixed(0)}m` },
            { id: 'optimalRange', label: 'OPTIMAL RANGE', value: `${(final_stats.optimalRange || 0).toFixed(0)}m` },
            { id: 'missileSpeed', label: 'FLIGHT VELOCITY', value: `${(final_stats.missileSpeed || 0).toFixed(1)} u/s` },
            { id: 'tracking', label: 'GUIDANCE SENSITIVITY', value: `${(final_stats.tracking || 0).toFixed(1)}` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` },
        ];
    } else if (isPulse) {
        const reloadTime = final_stats.reload || 0;
        const damage = final_stats.damage || 0;
        const fireRate = final_stats.fireRate || 1;
        const magSize = final_stats.magazine || 1;
        const cycleTime = (magSize / fireRate) + reloadTime;
        const sustainedDps = (damage * magSize) / Math.max(0.1, cycleTime);
        const burstDps = damage * fireRate;
        
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'quality', label: 'QUALITY RATING', value: `QL ${quality}`, color: getModColor(calculateQLModifier(quality) * 100) },
            { id: 'weaponsize', label: 'WEAPON SIZE', value: `CLASS ${size}` },
            { id: 'damageType', label: 'DAMAGE TYPE', value: 'KINETIC PULSE' },
            { id: 'damage', label: 'ALPHA DAMAGE', value: `${damage.toFixed(0)} u` },
            { id: 'burstDps', label: 'BURST YIELD (DPS)', value: `${burstDps.toFixed(1)} dmg/s` },
            { id: 'sustainedDps', label: 'SUSTAINED DPS', value: `${sustainedDps.toFixed(1)} dmg/s` },
            { id: 'reload', label: 'MAGAZINE RELOAD', value: `${reloadTime.toFixed(1)}s` },
            { id: 'fireRate', label: 'CYCLE RATE', value: `${fireRate.toFixed(1)} rnd/s` },
            { id: 'magazine', label: 'MAGAZINE SIZE', value: `${magSize} rnd` },
            { id: 'optimalRange', label: 'OPTIMAL RANGE', value: `${(final_stats.optimalRange || 0).toFixed(0)}m` },
            { id: 'projectileSpeed', label: 'MUZZLE VELOCITY', value: `${(final_stats.projectileSpeed || 0).toFixed(1)} u/s` },
            { id: 'accuracy', label: 'BASE ACCURACY', value: `${((final_stats.accuracy || 0) * 100).toFixed(0)}%` },
            { id: 'tracking', label: 'TURRET TRACKING', value: `${(final_stats.tracking || 0).toFixed(1)}` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` },
        ];
    } else if (isThruster) {
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'size', label: 'MODULE SIZE', value: `CLASS ${size}` },
            { id: 'speedBoost', label: 'VELOCITY BOOST', value: `+${(final_stats.speedBoost || 0).toFixed(1)}%` },
            { id: 'sigPenalty', label: 'SIGNATURE PENALTY', value: `+${(final_stats.sigPenalty || 0).toFixed(1)}m` },
            { id: 'energyDrain', label: 'ENERGY DRAIN', value: `${(final_stats.energyDrain || 0).toFixed(1)} u/s` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` }
        ];
    } else if (isShield) {
        stats = [
            { id: 'rarity', label: 'GRADE', value: RARITY_LABELS[rarity], color: RARITY_COLORS[rarity] },
            { id: 'size', label: 'MODULE SIZE', value: `CLASS ${size}` },
            { id: 'capacity', label: 'SHIELD CAPACITY', value: `${(final_stats.capacity || 0).toFixed(0)} u` },
            { id: 'regen', label: 'REGEN RATE', value: `${(final_stats.regen || 0).toFixed(1)} u/s` },
            { id: 'power', label: 'POWER GRID', value: `${(final_stats.power || 0).toFixed(1)} MW` },
            { id: 'cpu', label: 'CPU LOAD', value: `${(final_stats.cpu || 0).toFixed(1)} TF` }
        ];
    } else if (effectiveItem.type === 'resource') {
        stats = [
            { label: 'TYPE', value: 'RAW MATERIAL' },
            { label: 'QUALITY BAND', value: effectiveItem.qlBand || (effectiveItem.quality ? getQLBand(effectiveItem.quality) : 'UNSTABLE'), color: '#ffcc00' },
            { label: 'QUANTITY', value: `${Number(effectiveItem.amount || 0).toFixed(1)} UNITS` },
            { label: 'TOTAL MASS', value: `${Number(effectiveItem.weight || 0).toFixed(1)} m³` }
        ];
    } else {
        stats = [
            { label: 'TYPE', value: effectiveItem.type?.toUpperCase() || 'UNKNOWN' },
            { id: 'rarity', label: 'GRADE', value: (effectiveItem.rarity || 'common').toUpperCase(), color: effectiveItem.customColor || RARITY_COLORS[effectiveItem.rarity || 'common'] },
            { label: 'WEIGHT', value: `${Number(effectiveItem.weight || 0).toFixed(1)} units` }
        ];
    }

    return React.createElement('div', { style: { marginTop: '10px' } },
        stats.map((stat, i) => {
            const modData = effectiveItem.modifiedStats?.[stat.id];
            const displayValue = stat.value;
            let color = '#fff';
            
            if (stat.label === 'GRADE' || stat.label === 'QUALITY RATING' || stat.color) {
                color = stat.color || '#fff';
            } else if (modData) {
                color = getModColor(modData.percent);
            }

            return React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' } },
                React.createElement('span', { style: { color: '#666' } }, stat.label),
                React.createElement('span', { style: { color: color, fontWeight: 'bold' } }, displayValue)
            );
        }),
        // Add Installed Modifiers section if present
        (effectiveItem.modifiers && effectiveItem.modifiers.length > 0) && React.createElement('div', { 
            style: { 
                marginTop: '12px', 
                borderTop: '1px solid rgba(255,255,255,0.1)', 
                paddingTop: '10px' 
            } 
        },
            React.createElement('div', { style: { fontSize: '10px', color: '#aaa', marginBottom: '8px', letterSpacing: '1px', fontWeight: 'bold' } }, 'INSTALLED MODIFIERS:'),
            effectiveItem.modifiers.map((mod, i) => (
                React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' } },
                    React.createElement('span', { style: { color: '#888' } }, mod.name.toUpperCase()),
                    React.createElement('span', { style: { color: '#00ccff', fontWeight: 'bold' } }, `+${mod.currentRoll}%`)
                )
            ))
        )
    );
};

// Security Rating Definitions
const SECURITY_CATEGORIES = {
    FULL: { label: 'Full Security', color: '#ffffff' },
    SECURE: { label: 'Secure', color: '#ffffff' },
    MID: { label: 'Mid Security', color: '#ffff00' },
    LOW: { label: 'Low Security', color: '#ff9900' },
    NONE: { label: 'No Security', color: '#ff4444' }
};

const getSecurityInfo = (value) => {
    if (value >= 1.0) return SECURITY_CATEGORIES.FULL;
    if (value >= 0.7) return SECURITY_CATEGORIES.SECURE;
    if (value >= 0.5) return SECURITY_CATEGORIES.MID;
    if (value >= 0.1) return SECURITY_CATEGORIES.LOW;
    return SECURITY_CATEGORIES.NONE;
};

const getModuleResourceUsage = (module) => {
    if (!module) return { power: 0, cpu: 0 };
    const finalStats = (module.final_stats && typeof module.final_stats === 'object') ? module.final_stats : null;
    if (!finalStats) return { power: 0, cpu: 0 };
    return {
        power: Number(finalStats.power || 0),
        cpu: Number(finalStats.cpu || 0)
    };
};

const getLiveShipResources = (fittings) => {
    let power = 0;
    let cpu = 0;
    Object.values(fittings).forEach(mod => {
        if (!mod) return;
        const usage = getModuleResourceUsage(mod);
        power += usage.power;
        cpu += usage.cpu;
    });
    return { power, cpu };
};

// -----------------------------------------------------
// FITTING RULES (Step 3: Slot typing + PG/CPU gating)
// -----------------------------------------------------
const getSlotClass = (slotId) => {
    const id = String(slotId || '').toLowerCase();
    if (id.startsWith('weapon')) return 'weapon';
    if (id.startsWith('rig')) return 'rig';
    if (id.startsWith('synapse')) return 'synapse';
    if (id.startsWith('active')) return 'core';
    if (id.startsWith('passive')) return 'utility';
    // default: treat as utility-ish
    return 'utility';
};

const getItemSlotClass = (item) => {
    if (!item) return null;
    const t = String(item.type || '').toLowerCase();
    const st = String(item.subtype || '').toLowerCase();
    const n = String(item.name || '').toLowerCase();

    // Disallow non-fittables
    if (t === 'blueprint' || t === 'resource' || t === 'bio-material' || t === 'catalyst') return null;

    // Drone modules must always be utility before any weapon keyword checks.
    if (t === 'drone-module' || n.includes('drone')) return 'utility';

    // Weapons
    if (t === 'weapon' || t === 'mining' || st.includes('laser') || st.includes('cannon') || st.includes('missile') || n.includes('flux') || n.includes('pulse') || n.includes('seeker') || n.includes('mining')) {
        return 'weapon';
    }

    // Core modules
    if (t === 'shield' || n.includes('shield')) return 'core';

    // Utility modules
    if (t === 'thruster' || n.includes('thruster')) return 'utility';

    // Rigs
    if (t === 'rig' || n.includes('rig')) return 'rig';

    // Synapses (ship ability modifiers)
    if (t === 'synapse' || st.includes('synapse') || n.includes('synapse')) return 'synapse';

    // Default modules fall under utility
    return 'utility';
};

const normalizeModuleFamilyKey = (value = '') => {
    const compact = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!compact) return '';
    if (compact.includes('shield')) return 'shield_standard';
    if (compact.includes('ion') && compact.includes('thruster')) return 'thruster_ion';
    if (compact.includes('flux') && compact.includes('laser')) return 'weapon_flux_laser';
    if (compact.includes('pulse') && compact.includes('cannon')) return 'weapon_pulse_cannon';
    if ((compact.includes('seeker') && compact.includes('pod')) || compact.includes('missile_launcher')) return 'weapon_seeker_pod';
    if (compact.includes('mining') && compact.includes('laser')) return 'mining_laser';
    if (compact.includes('combat') && compact.includes('drone')) return 'drone_combat_bay';
    if (compact.includes('mining') && compact.includes('drone')) return 'drone_mining_bay';
    if (compact.includes('repair') && compact.includes('drone')) return 'drone_repair_bay';
    return compact;
};

const normalizeModuleSizeKey = (value = '') => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 's' || raw === 'small') return 's';
    if (raw === 'm' || raw === 'medium') return 'm';
    if (raw === 'l' || raw === 'large') return 'l';
    return raw ? raw.slice(0, 1) : '';
};

const normalizeModuleRarityKey = (value = '') => {
    const raw = String(value || '').trim().toLowerCase();
    for (const rarity of ['legendary', 'epic', 'rare', 'uncommon', 'common']) {
        if (raw === rarity || raw.includes(rarity)) return rarity;
    }
    return raw;
};

const deriveCanonicalModuleId = (item = null) => {
    if (!item || typeof item !== 'object') return '';
    if (item.module_id) return item.module_id;
    const family = normalizeModuleFamilyKey(item.subtype || item.type || item.itemKey || item.item_id || item.name || '');
    const size = normalizeModuleSizeKey(item.size || item.weaponsize || '');
    const rarity = normalizeModuleRarityKey(item.rarity || '');
    if (!family || !size || !rarity) return '';
    return `module_${family}_${size}_${rarity}`;
};

const normalizeFittedModuleIdentity = (item = null) => {
    if (!item || typeof item !== 'object') return item;
    const canonicalModuleId = deriveCanonicalModuleId(item);
    if (!canonicalModuleId) return item;
    return {
        ...item,
        module_id: canonicalModuleId,
        canonical_output_id: item.canonical_output_id || canonicalModuleId
    };
};

const hydrateFittedModule = (item = null) => {
    if (!item || typeof item !== 'object') return item;
    return normalizeFittedModuleIdentity(hydrateItem({ ...item }));
};

const canFit = ({ item, slotId, shipConfig, currentFittings, maxPG = 0, maxCPU = 0 }) => {
    if (!item || !slotId) return { ok: false, reason: 'No module/slot selected.' };

    const slotClass = getSlotClass(slotId);
    const itemClass = getItemSlotClass(item);

    if (!itemClass) {
        return { ok: false, reason: 'That item cannot be fitted to a ship.' };
    }

    // Slot class enforcement
    if (slotClass !== itemClass) {
        return { ok: false, reason: `Slot mismatch: ${slotClass.toUpperCase()} slot cannot accept ${itemClass.toUpperCase()} modules.` };
    }

    // Weapon size guidance (warn only for now)
    const size = item.size || item.weaponsize;
    if (slotClass === 'weapon' && shipConfig?.recommendedWeaponSizes && size) {
        const rec = shipConfig.recommendedWeaponSizes;
        if (Array.isArray(rec) && rec.length && !rec.includes(size)) {
            // Allow oversize/undersize, but warn (penalties handled elsewhere)
        }
    }

    // PG/CPU gating
    const nextFittings = { ...(currentFittings || {}) };
    nextFittings[slotId] = hydrateFittedModule(item);
    const usage = getLiveShipResources(nextFittings);
    if (usage.power > maxPG) {
        return { ok: false, reason: `Insufficient POWER GRID (needs ${usage.power.toFixed(0)} / ${Number(maxPG).toFixed(0)}).` };
    }
    if (usage.cpu > maxCPU) {
        return { ok: false, reason: `Insufficient CPU (needs ${usage.cpu.toFixed(0)} / ${Number(maxCPU).toFixed(0)}).` };
    }

    return { ok: true };
};

const ShipDestroyedOverlay = ({ summary, onRespawn }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            // Keep battle visible underneath while still readable
            background: 'rgba(20, 0, 0, 0.75)',
            zIndex: 10000, // Highest priority
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            color: '#fff',
            pointerEvents: 'auto',
            animation: 'destructionFadeIn 1s ease-out'
        }
    },
        React.createElement('style', null, `
	            @keyframes destructionFadeIn {
	                from { opacity: 0; background: rgba(255, 0, 0, 0.35); }
	                to { opacity: 1; background: rgba(20, 0, 0, 0.75); }
	            }
        `),
        React.createElement('div', { 
            style: { 
                fontSize: '32px', 
                fontWeight: 'bold', 
                color: '#ff4444', 
                marginBottom: '20px',
                letterSpacing: '4px',
                textShadow: '0 0 20px rgba(255, 0, 0, 0.5)'
            } 
        }, 'YOUR SHIP HAS BEEN DESTROYED'),
        
        React.createElement('div', {
            style: {
                width: '400px',
                background: 'rgba(0,0,0,0.65)',
                border: '1px solid #ff4444',
                padding: '20px',
                borderRadius: '4px',
                marginBottom: '40px',
                boxShadow: 'inset 0 0 20px rgba(255,0,0,0.1)'
            }
        },
            React.createElement('div', { style: { fontSize: '14px', color: '#ffaaaa', marginBottom: '15px', fontWeight: 'bold' } }, 'LOSS SUMMARY:'),
            
            React.createElement('div', { style: { marginBottom: '10px' } },
                React.createElement('div', { style: { fontSize: '12px', color: '#888' } }, 'VESSEL HULL:'),
                React.createElement('div', { style: { fontSize: '14px', color: '#fff', fontWeight: 'bold' } }, summary?.shipName?.toUpperCase() || 'UNKNOWN SHIP')
            ),
            
            React.createElement('div', { style: { marginBottom: '10px' } },
                React.createElement('div', { style: { fontSize: '12px', color: '#888' } }, 'INSTALLED MODULES:'),
                summary?.modules?.length > 0 ? summary.modules.map((m, i) => (
                    React.createElement('div', { key: i, style: { fontSize: '12px', color: '#ff6666' } }, `- ${m.toUpperCase()}`)
                )) : React.createElement('div', { style: { fontSize: '12px', color: '#555' } }, 'NONE')
            ),
            
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '12px', color: '#888' } }, 'CARGO MANIFEST:'),
                React.createElement('div', { style: { fontSize: '14px', color: '#ff6666' } }, summary?.cargoCount > 0 ? `${summary.cargoCount} ITEMS PERISHED` : 'NO CARGO LOST')
            )
        ),

        React.createElement('button', {
            onClick: onRespawn,
            style: {
                background: 'transparent',
                border: '2px solid #ff4444',
                color: '#ff4444',
                padding: '15px 40px',
                fontSize: '18px',
                fontWeight: 'bold',
                cursor: 'pointer',
                letterSpacing: '4px',
                transition: 'all 0.2s',
                boxShadow: '0 0 20px rgba(255,0,0,0.2)'
            },
            onMouseEnter: (e) => {
                e.target.style.background = '#ff4444';
                e.target.style.color = '#fff';
                e.target.style.boxShadow = '0 0 40px rgba(255,0,0,0.5)';
            },
            onMouseLeave: (e) => {
                e.target.style.background = 'transparent';
                e.target.style.color = '#ff4444';
                e.target.style.boxShadow = '0 0 20px rgba(255,0,0,0.2)';
            }
        }, 'RESPAWN')
    )
);

const BattlegroundFailOverlay = ({ state, onRespawn }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: 'rgba(0, 0, 0, 0.92)',
            zIndex: 10002,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            color: '#fff',
            pointerEvents: 'auto',
            animation: 'battlegroundFailFade 0.7s ease-out'
        }
    },
        React.createElement('style', null, `
            @keyframes battlegroundFailFade {
                from { opacity: 0; background: rgba(40, 0, 0, 0.55); }
                to { opacity: 1; background: rgba(0, 0, 0, 0.92); }
            }
        `),
        React.createElement('div', { style: { color: '#ff6666', fontSize: '18px', letterSpacing: '4px', marginBottom: '14px' } }, 'BATTLEGROUND FAILED'),
        React.createElement('div', { style: { color: '#ffffff', fontSize: '36px', fontWeight: 'bold', letterSpacing: '2px', marginBottom: '16px', textShadow: '0 0 18px rgba(255, 80, 80, 0.35)' } }, state?.lostBank ? 'REWARD BANK LOST' : 'RUN TERMINATED'),
        React.createElement('div', { style: { color: '#9cc7d9', fontSize: '14px', marginBottom: '8px' } }, `WAVE ${Number(state?.waveNumber || 0) || '?'} FAILURE`),
        React.createElement('div', { style: { color: '#cfd9df', fontSize: '13px', letterSpacing: '2px', marginBottom: '28px' } }, `RESPAWNING AT ${(state?.respawnLocationName || 'HOME STARPORT').toUpperCase()}`),
        React.createElement('button', {
            onClick: onRespawn,
            style: {
                background: 'transparent',
                border: '2px solid #ff6666',
                color: '#ff6666',
                padding: '14px 36px',
                fontSize: '17px',
                fontWeight: 'bold',
                cursor: 'pointer',
                letterSpacing: '4px',
                transition: 'all 0.2s',
                boxShadow: '0 0 18px rgba(255,80,80,0.22)'
            },
            onMouseEnter: (e) => {
                e.target.style.background = '#ff6666';
                e.target.style.color = '#fff';
                e.target.style.boxShadow = '0 0 36px rgba(255,80,80,0.45)';
            },
            onMouseLeave: (e) => {
                e.target.style.background = 'transparent';
                e.target.style.color = '#ff6666';
                e.target.style.boxShadow = '0 0 18px rgba(255,80,80,0.22)';
            }
        }, 'RESPAWN')
    )
);

const BattlegroundBlackoutOverlay = ({ active, opaque }) => {
    if (!active) return null;
    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: '#000',
            opacity: opaque ? 1 : 0,
            zIndex: 10004,
            pointerEvents: 'none',
            transition: 'opacity 0.45s ease'
        }
    });
};

const CLUSTER_GALAXY_POSITIONS = {
    alpha: { x: -240, y: -120 },
    beta: { x: 20, y: -220 },
    gamma: { x: 140, y: 60 },
    delta: { x: 300, y: 200 }
};

const StarMap = ({ currentSystemId, isLeapMode, onJump, onClose, initialView = 'sector' }) => {
    const [selectedSystem, setSelectedSystem] = useState(null);
    const [mapView, setMapView] = useState(initialView); // 'sector' or 'galaxy'
    const [zoomScale, setZoomScale] = useState(1);
    const [mapOffset, setMapOffset] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0, offset: { x: 0, y: 0 } });
    const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });
    const [hoveredCluster, setHoveredCluster] = useState(null);
    const [hoveredSyndicate, setHoveredSyndicate] = useState(null);
    const isArenaInstance = typeof currentSystemId === 'string' && currentSystemId.startsWith('arena:');
    const isBattlegroundInstance = typeof currentSystemId === 'string' && currentSystemId.startsWith('bg:pve:');
    const currentSystem = isArenaInstance ? null : SYSTEMS_REGISTRY[currentSystemId];
    const [activeClusterId, setActiveClusterId] = useState(currentSystem?.cluster || 'alpha');
    
    // In normal mode, we can only see the current cluster systems in sector view
    // In leap mode, we can browse other clusters via galaxy view
    const systems = Object.entries(SYSTEMS_REGISTRY).filter(([id, data]) => data.cluster === activeClusterId);

    const SYNDICATE_COLORS = {
        'OMNI DIRECTORATE': '#00ccff',
        'CRIMSON RIFT CARTEL': '#ff4444',
        'VOIDBORNE COVENANT': '#a335ee',
        'FERRON INDUSTRIAL GUILD': '#ffcc00'
    };

    const SYNDICATE_DATA = {
        'OMNI DIRECTORATE': {
            description: 'The established authority of the core sectors, maintaining order through absolute bureaucratic precision and advanced surveillance technology.',
            ethos: 'ORDER / STABILITY / PROGRESS',
            specialty: 'Electronic Warfare & Shield Tech'
        },
        'CRIMSON RIFT CARTEL': {
            description: 'A vast underworld network of smugglers, pirates, and renegade miners who thrive in the lawless fringes of the galaxy.',
            ethos: 'FREEDOM / PROFIT / SURVIVAL',
            specialty: 'High-Alpha Strike Weapons'
        },
        'VOIDBORNE COVENANT': {
            description: 'A reclusive sect of transhumanist scientists and explorers obsessed with the precursor technology found in high-energy anomalies.',
            ethos: 'KNOWLEDGE / EVOLUTION / SECRECY',
            specialty: 'Exotic Particle Beam Tech'
        },
        'FERRON INDUSTRIAL GUILD': {
            description: 'The galaxy\'s premier manufacturing and mining conglomerate, treating entire star systems as mere logistics units in their pursuit of efficiency.',
            ethos: 'PRODUCTION / EFFICIENCY / SCALE',
            specialty: 'Industrial Hull & Mining Tech'
        }
    };

    const getResources = (systemData) => {
        const tier = systemData.tier || 1;
        const config = TIER_CONFIGS[tier];
        if (!config) return 'UNKNOWN';
        
        return ASTEROID_TYPES
            .map((type, index) => ({ 
                name: type.name.toUpperCase(), 
                weight: config.weights[index] || 0 
            }))
            .filter(item => item.weight > 0)
            .sort((a, b) => b.weight - a.weight)
            .map(item => item.name)
            .join(', ');
    };

    const getClusterInfo = (clusterId) => {
        const clusterSystems = Object.values(SYSTEMS_REGISTRY).filter(s => s.cluster === clusterId);
        const systemCount = clusterSystems.length;
        const securityRange = {
            min: Math.min(...clusterSystems.map(s => s.securityValue)),
            max: Math.max(...clusterSystems.map(s => s.securityValue))
        };
        const tiers = [...new Set(clusterSystems.map(s => s.tier))].sort();
        
        // Resource profile - most common across cluster
        const resourceMap = {};
        clusterSystems.forEach(s => {
            const config = TIER_CONFIGS[s.tier || 1];
            if (config) {
                ASTEROID_TYPES.forEach((type, idx) => {
                    if (config.weights[idx] > 0) {
                        resourceMap[type.name] = (resourceMap[type.name] || 0) + config.weights[idx];
                    }
                });
            }
        });
        const resources = Object.entries(resourceMap)
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0].toUpperCase())
            .slice(0, 3)
            .join(', ');

        // Syndicate Control
        const syndicateStats = {};
        clusterSystems.forEach(s => {
            if (s.controlledBy) {
                syndicateStats[s.controlledBy] = (syndicateStats[s.controlledBy] || 0) + 1;
            } else {
                syndicateStats['UNCONTROLLED'] = (syndicateStats['UNCONTROLLED'] || 0) + 1;
            }
        });

        const syndicates = Object.entries(syndicateStats)
            .map(([name, count]) => ({
                name,
                percent: Math.round((count / systemCount) * 100)
            }))
            .sort((a, b) => b.percent - a.percent);

        const descriptions = {
            alpha: "Secure core territory under Omni Directorate administration. High security and stable economy.",
            beta: "Industrial transition zone. Balanced security with moderate pirate activity.",
            gamma: "Fringe territories. Low security, rich in exotic resources but high risk.",
            delta: "Anomalous space. Zero security presence. Uncharted biological threats detected."
        };

        const secLabel = securityRange.min === securityRange.max 
            ? securityRange.min.toFixed(1) 
            : `${securityRange.min.toFixed(1)} - ${securityRange.max.toFixed(1)}`;

        return {
            id: clusterId.toUpperCase(),
            count: systemCount,
            security: secLabel,
            tier: tiers.length > 1 ? `${tiers[0]} - ${tiers[tiers.length-1]}` : tiers[0],
            resources: resources || 'NONE',
            syndicates: syndicates,
            description: descriptions[clusterId] || ""
        };
    };

    const handleSystemClick = (e, id, data) => {
        // Calculate position for the popup
        const yOffset = data.coords.y > 50 ? -20 : 20;
        setPopupPos({ 
            x: data.coords.x, 
            y: data.coords.y + yOffset,
            isAbove: data.coords.y > 50
        });
        setSelectedSystem(id);
    };

    const handleClusterSelect = (clusterId) => {
        setActiveClusterId(clusterId);
        setMapView('sector');
        setZoomScale(1);
        setMapOffset({ x: 0, y: 0 });
        setSelectedSystem(null);
    };

    const handleWheel = (e) => {
        const zoomSpeed = 0.001;
        let nextZoom = zoomScale - e.deltaY * zoomSpeed;
        
        // Clamp zoom within current view
        nextZoom = Math.max(0.4, Math.min(2.5, nextZoom));
        setZoomScale(nextZoom);

        if (e.deltaY > 0) { // Zoom OUT (Scroll Down)
            if (mapView === 'sector' && nextZoom < 0.6) {
                setMapView('galaxy');
                setZoomScale(1.8); // Start galaxy view zoomed in
                // Center on the cluster we were just in
                const pos = CLUSTER_GALAXY_POSITIONS[activeClusterId] || { x: 0, y: 0 };
                setMapOffset({ x: -pos.x, y: -pos.y });
                setSelectedSystem(null);
            }
        } else { // Zoom IN (Scroll Up)
            if (mapView === 'galaxy' && nextZoom > 2.0) {
                setMapView('sector');
                setZoomScale(0.7); // Start sector view zoomed out
                setMapOffset({ x: 0, y: 0 });
            }
        }
    };

    const handlePointerDown = (e) => {
        if (e.button !== 0) return; // Only left click
        // Store starting position, but don't capture yet
        setDragStart({
            x: e.clientX,
            y: e.clientY,
            offset: { ...mapOffset }
        });
    };

    const handlePointerMove = (e) => {
        if (!dragStart.x) return;
        
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        const dist = Math.sqrt(dx*dx + dy*dy);

        // Movement threshold: Only start dragging if moved more than 5px
        if (!isDragging && dist > 5) {
            setIsDragging(true);
            e.currentTarget.setPointerCapture(e.pointerId);
        }

        if (isDragging) {
            const scaledDx = dx / zoomScale;
            const scaledDy = dy / zoomScale;
            setMapOffset({
                x: dragStart.offset.x + scaledDx,
                y: dragStart.offset.y + scaledDy
            });
        }
    };

    const handlePointerUp = (e) => {
        setIsDragging(false);
        setDragStart({ x: 0, y: 0, offset: { x: 0, y: 0 } });
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    return React.createElement('div', {
        onWheel: handleWheel,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: 'rgba(0, 5, 10, 0.98)',
            zIndex: 3000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            color: '#fff',
            animation: 'fadeIn 0.5s ease-out',
            pointerEvents: 'auto',
            overflow: 'hidden',
            cursor: isDragging ? 'grabbing' : 'auto' // Use auto to let children define their cursor
        }
    },
        React.createElement('style', null, `
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes ping {
                0% { transform: scale(1); opacity: 0.8; }
                100% { transform: scale(2); opacity: 0; }
            }
            @keyframes pulse {
                0% { transform: scale(1); opacity: 0.8; box-shadow: 0 0 10px #00ccff; }
                100% { transform: scale(1.2); opacity: 1; box-shadow: 0 0 30px #00ccff; }
            }
            @keyframes fluidGlow {
                0% { transform: translate(-50%, -50%) scale(1); opacity: 0.7; border-radius: 45% 55% 50% 50% / 50% 50% 55% 45%; }
                33% { transform: translate(-50%, -50%) scale(1.05); opacity: 0.9; border-radius: 55% 45% 50% 50% / 50% 50% 45% 55%; }
                66% { transform: translate(-50%, -50%) scale(0.98); opacity: 0.8; border-radius: 50% 50% 45% 55% / 55% 45% 50% 50%; }
                100% { transform: translate(-50%, -50%) scale(1); opacity: 0.7; border-radius: 45% 55% 50% 50% / 50% 50% 55% 45%; }
            }
        `),
        // Star Map Background (Grid)
        React.createElement('div', {
            style: {
                position: 'absolute',
                width: '100%',
                height: '100%',
                backgroundImage: `
                    linear-gradient(rgba(0, 204, 255, 0.05) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(0, 204, 255, 0.05) 1px, transparent 1px)
                `,
                backgroundSize: '50px 50px',
                backgroundPosition: 'center',
                pointerEvents: 'none',
                transform: `scale(${zoomScale}) translate(${mapOffset.x}px, ${mapOffset.y}px)`,
                transition: 'transform 0.1s ease-out'
            }
        }),

        // Zoom Button
        React.createElement('div', {
            onClick: () => {
                const isSector = mapView === 'sector';
                setMapView(isSector ? 'galaxy' : 'sector');
                setZoomScale(1);
                if (isSector) {
                    const pos = CLUSTER_GALAXY_POSITIONS[activeClusterId] || { x: 0, y: 0 };
                    setMapOffset({ x: -pos.x, y: -pos.y });
                    setSelectedSystem(null);
                } else {
                    setMapOffset({ x: 0, y: 0 });
                }
            },
            style: {
                position: 'absolute',
                top: '40px',
                left: '60px',
                cursor: 'pointer',
                color: '#fff',
                fontSize: '12px',
                zIndex: 10,
                transition: 'all 0.2s',
                border: '1px solid #00ccff',
                padding: '10px 20px',
                borderRadius: '2px',
                background: 'rgba(0, 204, 255, 0.1)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                letterSpacing: '1px',
                fontWeight: 'bold'
            },
            onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(0, 204, 255, 0.3)'; },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'rgba(0, 204, 255, 0.1)'; }
        }, 
            mapView === 'sector' ? '🔍 ZOOM OUT TO GALAXY' : '🔍 RETURN TO CLUSTER'
        ),

        // Close Button
        React.createElement('button', {
            onClick: onClose,
            style: {
                position: 'absolute',
                top: '40px',
                right: '60px',
                cursor: 'pointer',
                color: '#fff',
                fontSize: '28px',
                zIndex: 10,
                transition: 'color 0.2s',
                background: 'none',
                border: 'none',
                padding: 0,
                fontFamily: 'inherit'
            },
            onMouseEnter: (e) => e.target.style.color = '#00ccff'
        }, '✕'),

        // Header
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: '60px',
                textAlign: 'center',
                zIndex: 10
            }
        },
            React.createElement('div', { style: { fontSize: '32px', fontWeight: 'bold', letterSpacing: '12px', color: '#00ccff' } }, mapView === 'sector' ? `CLUSTER ${activeClusterId.toUpperCase()}` : 'GALAXY VIEW'),
            React.createElement('div', { style: { fontSize: '16px', color: '#fff', marginTop: '12px', letterSpacing: '4px', opacity: 0.8 } }, 
                mapView === 'sector' ? 'SECTOR MAP' : 'MILKY WAY QUADRANT // INTER-CLUSTER CARTOGRAPHY'
            )
        ),

        // Map Area
        React.createElement('div', {
            style: {
                position: 'relative',
                width: '1100px',
                height: '750px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: `scale(${zoomScale}) translate(${mapOffset.x}px, ${mapOffset.y}px)`,
                transition: 'transform 0.1s ease-out'
            }
        },
            mapView === 'galaxy' ? (
                // Galaxy View Content
                React.createElement(React.Fragment, null,
                    // Galaxy Center (Subtle glow)
                    React.createElement('div', {
                        style: {
                            position: 'absolute',
                            width: '400px',
                            height: '400px',
                            background: 'radial-gradient(circle, rgba(255, 255, 255, 0.05) 0%, transparent 70%)',
                            pointerEvents: 'none'
                        }
                    }),
                    // Cluster Nodes
                    Object.entries(CLUSTER_GALAXY_POSITIONS).map(([id, pos]) => (
                        React.createElement('div', {
                            key: id,
                            onClick: () => handleClusterSelect(id),
                            onMouseEnter: () => setHoveredCluster(id),
                            onMouseLeave: () => setHoveredCluster(null),
                            style: {
                                position: 'absolute',
                                left: `calc(50% + ${pos.x}px)`,
                                top: `calc(50% + ${pos.y}px)`,
                                width: '30px',
                                height: '30px',
                                background: 'radial-gradient(circle, #00ccff 0%, transparent 80%)',
                                borderRadius: '50%',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                boxShadow: '0 0 20px #00ccff',
                                animation: 'pulse 2s infinite alternate',
                                transform: `translate(-50%, -50%) scale(${1 / zoomScale})`,
                                transformOrigin: 'center center',
                                zIndex: 20
                            }
                        },
                            React.createElement('div', {
                                style: {
                                    position: 'absolute',
                                    top: '40px',
                                    whiteSpace: 'nowrap',
                                    fontSize: '12px',
                                    color: '#00ccff',
                                    fontWeight: 'bold',
                                    letterSpacing: '2px',
                                    textShadow: '0 0 10px #000'
                                }
                            }, `CLUSTER ${id.toUpperCase()}`)
                        )
                    )),
                    // Cluster Info Popup
                    hoveredCluster && (() => {
                        const info = getClusterInfo(hoveredCluster);
                        const pos = CLUSTER_GALAXY_POSITIONS[hoveredCluster];
                        const isAbove = pos.y > -50; // Threshold to decide positioning
                        
                        return React.createElement('div', {
                            style: {
                                position: 'absolute',
                                left: `calc(50% + ${pos.x}px)`,
                                top: `calc(50% + ${pos.y}px)`,
                                transform: `${isAbove ? 'translate(-50%, -100%) translateY(-40px)' : 'translate(-50%, 40px)'} scale(${1 / zoomScale})`,
                                transformOrigin: isAbove ? 'bottom center' : 'top center',
                                width: '320px',
                                background: 'rgba(0, 10, 20, 0.98)',
                                border: '1px solid #00ccff',
                                padding: '24px',
                                borderRadius: '4px',
                                zIndex: 100,
                                boxShadow: '0 10px 40px rgba(0,0,0,0.9), 0 0 20px rgba(0,204,255,0.2)',
                                pointerEvents: 'none',
                                animation: 'fadeIn 0.2s ease-out',
                                boxSizing: 'border-box'
                            }
                        },
                            React.createElement('div', { style: { color: '#00ccff', fontSize: '22px', fontWeight: 'bold', letterSpacing: '2px', marginBottom: '10px' } }, info.id),
                            React.createElement('div', { style: { fontSize: '13px', color: '#fff', marginBottom: '18px', letterSpacing: '1px', lineHeight: '1.4', opacity: 0.9 } }, info.description),
                            
                            // Syndicate Header
                            React.createElement('div', { style: { fontSize: '13px', color: '#888', borderTop: '1px solid #333', paddingTop: '12px', marginBottom: '10px', letterSpacing: '2px', fontWeight: 'bold' } }, 'SYNDICATE CONTROL'),
                            info.syndicates.map((syn, i) => (
                                React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '8px' } },
                                    React.createElement('span', { style: { color: syn.name === 'UNCONTROLLED' ? '#666' : '#ffcc00', fontWeight: 'bold' } }, syn.name),
                                    React.createElement('span', { style: { color: '#fff' } }, `${syn.percent}%`)
                                )
                            )),
                            React.createElement('div', { style: { height: '12px' } }), // Spacer

                            [
                                { label: 'SECURITY PROFILE', value: info.security, color: '#00ccff' },
                                { label: 'SYSTEM NODES', value: `${info.count} DETECTED`, color: '#fff' },
                                { label: 'TECHNOLOGY TIER', value: `LEVEL ${info.tier}`, color: '#ffcc00' },
                                { label: 'PRIMARY RESOURCES', value: info.resources, color: '#fff' }
                            ].map((stat, i) => (
                                React.createElement('div', { key: i, style: { display: 'flex', flexDirection: 'column', fontSize: '13px', marginBottom: '12px' } },
                                    React.createElement('span', { style: { color: '#aaa', marginBottom: '4px', fontSize: '11px' } }, stat.label),
                                    React.createElement('span', { style: { color: stat.color, fontWeight: 'bold', fontSize: '14px' } }, stat.value)
                                )
                            ))
                        );
                    })(),
                    // Nebula Clouds (Distant representation)
                    [
                        { x: -240, y: -120, color: 'rgba(0, 100, 255, 0.05)' },
                        { x: 220, y: 130, color: 'rgba(255, 100, 0, 0.05)' },
                        { x: 20, y: -220, color: 'rgba(100, 0, 255, 0.05)' }
                    ].map((cloud, i) => (
                        React.createElement('div', {
                            key: i,
                            style: {
                                position: 'absolute',
                                left: `calc(50% + ${cloud.x}px)`,
                                top: `calc(50% + ${cloud.y}px)`,
                                width: '300px',
                                height: '300px',
                                background: `radial-gradient(circle, ${cloud.color} 0%, transparent 70%)`,
                                transform: 'translate(-50%, -50%)',
                                pointerEvents: 'none'
                            }
                        })
                    ))
                )
            ) : (
                // Sector View Content (Existing systems logic)
                React.createElement(React.Fragment, null,
                    // --- SYNDICATE TERRITORY LAYER ---
                    (() => {
                        const groups = {};
                        systems.forEach(([id, data]) => {
                            if (!data.controlledBy) return;
                            // Only Cygnus Prime keeps its territory bubble in Cluster Alpha
                            if (data.cluster === 'alpha' && id !== 'cygnus-prime') return;
                            
                            if (!groups[data.controlledBy]) groups[data.controlledBy] = [];
                            groups[data.controlledBy].push({ id, ...data });
                        });

                        return Object.entries(groups).map(([syndicate, clusterSystems]) => {
                            const color = SYNDICATE_COLORS[syndicate] || '#888';
                            
                            // Calculate internal connections for merging effect
                            const connections = [];
                            for (let i = 0; i < clusterSystems.length; i++) {
                                for (let j = i + 1; j < clusterSystems.length; j++) {
                                    const s1 = clusterSystems[i];
                                    const s2 = clusterSystems[j];
                                    const dx = s2.coords.x - s1.coords.x;
                                    const dy = s2.coords.y - s1.coords.y;
                                    const dist = Math.sqrt(dx*dx + dy*dy);
                                    if (dist < 280) { // If systems are close, join them with a gel connector
                                        connections.push({ s1, s2, dist, angle: Math.atan2(dy, dx) });
                                    }
                                }
                            }

                            return React.createElement('div', {
                                key: `territory-${syndicate}`,
                                style: {
                                    position: 'absolute',
                                    width: '100%',
                                    height: '100%',
                                    pointerEvents: 'none',
                                    zIndex: 0
                                }
                            },
                                // Render connections first (behind markers)
                                connections.map((conn, idx) => (
                                    React.createElement('div', {
                                        key: `conn-${idx}`,
                                        style: {
                                            position: 'absolute',
                                            left: `calc(50% + ${conn.s1.coords.x}px)`,
                                            top: `calc(50% + ${conn.s1.coords.y}px)`,
                                            width: `${conn.dist}px`,
                                            height: '160px', // Thick bridge for liquid feel
                                            // Matches bubble look for seamless merging
                                            background: `linear-gradient(90deg, transparent 5%, ${color}44 20%, ${color}66 50%, ${color}44 80%, transparent 95%)`,
                                            transform: `translate(0, -50%) rotate(${conn.angle}rad)`,
                                            filter: 'blur(8px)',
                                            borderRadius: '80px',
                                            opacity: 0.8,
                                            animation: 'fluidGlow 12s infinite ease-in-out alternate',
                                            zIndex: -1
                                        }
                                    })
                                )),
                                // Render individual system bubbles
                                clusterSystems.map(system => {
                                    let repulsionScaleX = 1.0;
                                    let repulsionScaleY = 1.0;
                                    let offsetX = 0;
                                    let offsetY = 0;
                                    const baseSize = 220; 
                                    
                                    // Calculate repulsion and DIRECTIONAL squish from DIFFERENT syndicates
                                    systems.forEach(([otherId, otherData]) => {
                                        if (!otherData.controlledBy || otherData.controlledBy === syndicate) return;
                                        const dx = system.coords.x - otherData.coords.x;
                                        const dy = system.coords.y - otherData.coords.y;
                                        const dist = Math.sqrt(dx*dx + dy*dy);
                                        
                                        const threshold = baseSize * 1.5; // Slightly larger for "solid" boundary
                                        if (dist < threshold) {
                                            const force = (threshold - dist) / threshold;
                                            const nx = dx / dist;
                                            const ny = dy / dist;

                                            // Directional squish: flatten the bubble along the collision axis
                                            const squishAmount = force * 0.7;
                                            repulsionScaleX *= (1.0 - Math.abs(nx) * squishAmount);
                                            repulsionScaleY *= (1.0 - Math.abs(ny) * squishAmount);

                                            // Push away proportionally to force
                                            offsetX += nx * force * 70;
                                            offsetY += ny * force * 70;
                                        }
                                    });

                                    repulsionScaleX = Math.max(0.5, repulsionScaleX);
                                    repulsionScaleY = Math.max(0.5, repulsionScaleY);

                                    return React.createElement('div', {
                                        key: system.id,
                                        onMouseEnter: () => setHoveredSyndicate(syndicate),
                                        onMouseLeave: () => setHoveredSyndicate(null),
                                        style: {
                                            position: 'absolute',
                                            left: `calc(50% + ${system.coords.x}px)`,
                                            top: `calc(50% + ${system.coords.y}px)`,
                                            width: '1px',
                                            height: '1px',
                                            transform: `translate(${offsetX}px, ${offsetY}px)`,
                                            zIndex: 0,
                                            pointerEvents: 'auto' // Enable interaction on the bubbles
                                        }
                                    },
                                        // The original bubble look is preserved here
                                        React.createElement('div', {
                                            style: {
                                                width: `${baseSize}px`,
                                                height: `${baseSize}px`,
                                                background: `radial-gradient(circle, ${color}${hoveredSyndicate === syndicate ? 'bb' : '99'} 0%, ${color}33 50%, transparent 80%)`,
                                                border: `3px solid ${color}${hoveredSyndicate === syndicate ? 'ff' : 'aa'}`,
                                                boxShadow: `${hoveredSyndicate === syndicate ? '0 0 60px ' + color + '77, ' : ''}0 0 40px ${color}55, inset 0 0 30px ${color}44`,
                                                animation: 'fluidGlow 8s infinite ease-in-out',
                                                position: 'absolute',
                                                transform: `translate(-50%, -50%) scale(${repulsionScaleX}, ${repulsionScaleY})`,
                                                filter: 'blur(2px)',
                                                transition: 'all 0.3s ease-out',
                                                cursor: 'help'
                                            }
                                        })
                                    );
                                })
                            );
                        });
                    })(),

                    systems.map(([id, data]) => {
                        const isCurrent = id === currentSystemId;
                        const isSelected = selectedSystem === id;
                        
                        return React.createElement(React.Fragment, { key: id },
                            // Connection Lines (relative to cluster origin)
                            activeClusterId === 'alpha' && id !== 'cygnus-prime' && React.createElement('div', {
                                style: {
                                    position: 'absolute',
                                    width: Math.sqrt(data.coords.x ** 2 + data.coords.y ** 2) + 'px',
                                    height: '1px',
                                    background: `linear-gradient(90deg, rgba(0, 204, 255, 0.4) 0%, transparent 100%)`,
                                    left: '50%',
                                    top: '50%',
                                    transformOrigin: '0 0',
                                    transform: `rotate(${Math.atan2(data.coords.y, data.coords.x)}rad)`,
                                    pointerEvents: 'none',
                                    opacity: 0.3
                                }
                            }),

                                // Syndicate Control Glow (Fluid Gel style)
                                // Now handled by a separate layer for interaction effects
                                null,

                            // System Node
                            React.createElement('div', {
                                onClick: (e) => handleSystemClick(e, id, data),
                                style: {
                                    position: 'absolute',
                                    left: `calc(50% + ${data.coords.x}px)`,
                                    top: `calc(50% + ${data.coords.y}px)`,
                                    width: '12px',
                                    height: '12px',
                                    background: isCurrent ? '#fff' : (isSelected ? '#ffcc00' : '#00ccff'),
                                    borderRadius: '50%',
                                    cursor: 'pointer',
                                    transform: `translate(-50%, -50%) scale(${1 / zoomScale})`,
                                    boxShadow: `0 0 ${isSelected ? '20px' : '10px'} ${isCurrent ? '#fff' : (isSelected ? '#ffcc00' : '#00ccff')}`,
                                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                                    zIndex: isSelected ? 100 : 1
                                }
                            },
                                // Label
                                React.createElement('div', {
                                    style: {
                                        position: 'absolute',
                                        top: '20px',
                                        left: '50%',
                                        transform: 'translateX(-50%)',
                                        whiteSpace: 'nowrap',
                                        fontSize: '11px',
                                        fontWeight: 'bold',
                                        color: isCurrent ? '#fff' : '#fff',
                                        letterSpacing: '1px',
                                        textShadow: '0 0 10px rgba(0,0,0,0.8)',
                                        opacity: isCurrent || isSelected ? 1 : 0.8,
                                        transition: 'all 0.3s'
                                    }
                                }, data.name.toUpperCase()),

                                // Selection Ring
                                isCurrent && React.createElement('div', {
                                    style: {
                                        position: 'absolute',
                                        width: '24px',
                                        height: '24px',
                                        border: '1px solid #fff',
                                        borderRadius: '50%',
                                        top: '-7px',
                                        left: '-7px',
                                        animation: 'ping 2s infinite'
                                    }
                                }),

                                // Tactical Icons (Starport/Gate)
                                React.createElement('div', {
                                    style: {
                                        position: 'absolute',
                                        top: '-15px',
                                        left: '8px',
                                        display: 'flex',
                                        gap: '3px',
                                        pointerEvents: 'none',
                                        zIndex: 5
                                    }
                                },
                                    data.hasStarport && React.createElement(IconMapStarport, { size: 10 }),
                                    data.hasWarpGate && React.createElement(IconMapGate, { size: 10 })
                                )
                            )
                        );
                    }),

                    // Selection Info Popup (Enhanced and Positioned contextually)
                    selectedSystem && React.createElement('div', {
                        style: {
                            position: 'absolute',
                            top: `calc(50% + ${popupPos.y}px)`,
                            left: `calc(50% + ${popupPos.x}px)`,
                            transform: `${popupPos.isAbove ? 'translate(-50%, -100%)' : 'translateX(-50%)'} scale(${1 / zoomScale})`,
                            transformOrigin: popupPos.isAbove ? 'bottom center' : 'top center',
                            width: '320px',
                            background: 'rgba(0, 10, 20, 0.95)',
                            border: '1px solid #00ccff',
                            padding: '24px',
                            borderRadius: '4px',
                            zIndex: 200,
                            boxShadow: '0 10px 30px rgba(0,0,0,0.8), 0 0 15px rgba(0,204,255,0.2)',
                            animation: 'fadeIn 0.2s ease-out',
                            boxSizing: 'border-box'
                        }
                    },
                        React.createElement('div', {
                            onClick: () => setSelectedSystem(null),
                            style: { position: 'absolute', top: '8px', right: '12px', cursor: 'pointer', color: '#fff', opacity: 0.6, fontSize: '16px' }
                        }, '✕'),
                        React.createElement('div', { style: { color: '#00ccff', fontSize: '22px', fontWeight: 'bold', marginBottom: '10px', letterSpacing: '2px' } }, SYSTEMS_REGISTRY[selectedSystem].name.toUpperCase()),
                        React.createElement('div', { style: { fontSize: '13px', color: '#fff', marginBottom: '18px', letterSpacing: '1px', opacity: 0.8 } }, `SECTOR ${SYSTEMS_REGISTRY[selectedSystem].sector} // SYSTEM NODE`),
                        
                        // Syndicate Header
                        React.createElement('div', { style: { fontSize: '13px', color: '#888', borderTop: '1px solid #333', paddingTop: '12px', marginBottom: '10px', letterSpacing: '2px', fontWeight: 'bold' } }, 'SYNDICATE CONTROL'),
                        React.createElement('div', { style: { fontSize: '14px', marginBottom: '18px' } },
                            React.createElement('span', { style: { color: SYSTEMS_REGISTRY[selectedSystem].controlledBy ? '#ffcc00' : '#666', fontWeight: 'bold' } }, SYSTEMS_REGISTRY[selectedSystem].controlledBy || 'UNCLAIMED')
                        ),

                        [
                            { label: 'SECURITY', value: SYSTEMS_REGISTRY[selectedSystem].security, color: getSecurityInfo(SYSTEMS_REGISTRY[selectedSystem].securityValue).color },
                            { label: 'RESOURCES', value: getResources(SYSTEMS_REGISTRY[selectedSystem]), color: '#fff' },
                            { label: 'STARPORT', value: SYSTEMS_REGISTRY[selectedSystem].hasStarport ? 'ACTIVE' : 'NONE', color: SYSTEMS_REGISTRY[selectedSystem].hasStarport ? '#00ff00' : '#666' },
                            { label: 'QUANTUM GATE', value: SYSTEMS_REGISTRY[selectedSystem].hasWarpGate ? 'STABLE' : 'NONE', color: SYSTEMS_REGISTRY[selectedSystem].hasWarpGate ? '#00ff00' : '#666' }
                        ].map((stat, i) => (
                            React.createElement('div', { key: i, style: { display: 'flex', flexDirection: 'column', fontSize: '13px', marginBottom: '12px' } },
                                React.createElement('span', { style: { color: '#aaa', marginBottom: '4px', fontSize: '11px' } }, stat.label),
                                React.createElement('span', { style: { color: stat.color, fontWeight: 'bold', fontSize: '14px', lineHeight: '1.2' } }, stat.value)
                            )
                        )),
                        
                        selectedSystem !== currentSystemId ? (() => {
                            const targetSystem = SYSTEMS_REGISTRY[selectedSystem];
                            const isSameCluster = !!targetSystem && !!currentSystem && targetSystem.cluster === currentSystem.cluster;
                            
                            if (isSameCluster) {
                                return React.createElement('button', {
                                    onClick: () => onJump(selectedSystem),
                                    style: {
                                        marginTop: '12px',
                                        width: '100%',
                                        background: '#004466',
                                        border: '1px solid #00ccff',
                                        color: '#00ccff',
                                        padding: '12px',
                                        fontSize: '13px',
                                        fontWeight: 'bold',
                                        cursor: 'pointer',
                                        letterSpacing: '2px',
                                        transition: 'all 0.2s'
                                    },
                                    onMouseEnter: (e) => { e.target.style.background = '#00ccff'; e.target.style.color = '#000'; },
                                    onMouseLeave: (e) => { e.target.style.background = '#004466'; e.target.style.color = '#00ccff'; }
                                }, 'INITIATE JUMP');
                            } else if (isLeapMode && targetSystem.hasWarpGate) {
                                return React.createElement('button', {
                                    onClick: () => onJump(selectedSystem),
                                    style: {
                                        marginTop: '12px',
                                        width: '100%',
                                        background: '#004466',
                                        border: '1px solid #00ccff',
                                        color: '#00ccff',
                                        padding: '12px',
                                        fontSize: '13px',
                                        fontWeight: 'bold',
                                        cursor: 'pointer',
                                        letterSpacing: '2px',
                                        transition: 'all 0.2s'
                                    },
                                    onMouseEnter: (e) => { e.target.style.background = '#00ccff'; e.target.style.color = '#000'; },
                                    onMouseLeave: (e) => { e.target.style.background = '#004466'; e.target.style.color = '#00ccff'; }
                                }, 'QUANTUM LEAP');
                            } else {
                                return React.createElement('div', {
                                    style: {
                                        marginTop: '12px',
                                        width: '100%',
                                        background: 'rgba(255, 0, 0, 0.05)',
                                        border: '1px solid #551111',
                                        color: '#884444',
                                        padding: '12px',
                                        fontSize: '12px',
                                        fontWeight: 'bold',
                                        textAlign: 'center',
                                        letterSpacing: '1px',
                                        borderRadius: '2px',
                                        boxSizing: 'border-box'
                                    }
                                }, isLeapMode ? 'GATE REQUIRED FOR LEAP' : 'OUT OF JUMP RANGE');
                            }
                        })() : React.createElement('div', {
                            style: {
                                marginTop: '12px',
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid #555',
                                color: '#888',
                                padding: '12px',
                                fontSize: '13px',
                                fontWeight: 'bold',
                                textAlign: 'center',
                                letterSpacing: '2px',
                                borderRadius: '2px',
                                boxSizing: 'border-box'
                            }
                        }, 'CURRENT LOCATION')
                    )
                )
            )
        ),

            // Syndicate Info Panel (Sector View)
            mapView === 'sector' && hoveredSyndicate && SYNDICATE_DATA[hoveredSyndicate] && (
                React.createElement('div', {
                    style: {
                        position: 'absolute',
                        bottom: '100px',
                        right: '60px',
                        width: '360px',
                        background: 'rgba(0, 5, 10, 0.95)',
                        border: `1px solid ${SYNDICATE_COLORS[hoveredSyndicate]}`,
                        borderRadius: '4px',
                        padding: '24px',
                        boxShadow: `0 0 30px ${SYNDICATE_COLORS[hoveredSyndicate]}33`,
                        zIndex: 1000,
                        animation: 'fadeIn 0.2s ease-out',
                        pointerEvents: 'none'
                    }
                },
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' } },
                        React.createElement(IconSyndicate, { color: SYNDICATE_COLORS[hoveredSyndicate], size: 22 }),
                        React.createElement('div', { style: { color: SYNDICATE_COLORS[hoveredSyndicate], fontSize: '20px', fontWeight: 'bold', letterSpacing: '2px' } }, hoveredSyndicate)
                    ),
                    React.createElement('div', { style: { fontSize: '14px', color: '#fff', fontWeight: 'bold', marginBottom: '10px', letterSpacing: '1px' } }, 
                        `ETHOS: ${SYNDICATE_DATA[hoveredSyndicate].ethos}`
                    ),
                    React.createElement('div', { style: { fontSize: '13px', color: '#aaa', lineHeight: '1.5', marginBottom: '18px' } }, 
                        SYNDICATE_DATA[hoveredSyndicate].description
                    ),
                    React.createElement('div', { style: { borderTop: '1px solid #222', paddingTop: '12px' } },
                        React.createElement('div', { style: { fontSize: '12px', color: '#555', marginBottom: '6px', fontWeight: 'bold' } }, 'TECHNOLOGICAL FOCUS:'),
                        React.createElement('div', { style: { fontSize: '13px', color: SYNDICATE_COLORS[hoveredSyndicate], fontWeight: 'bold' } }, 
                            SYNDICATE_DATA[hoveredSyndicate].specialty
                        )
                    )
                )
            ),

            // Footer Info
            React.createElement('div', {
            style: {
                position: 'absolute',
                bottom: '40px',
                fontSize: '12px',
                color: '#fff',
                opacity: 0.4,
                textAlign: 'center',
                letterSpacing: '1px'
            }
        }, `NAVIGATIONAL DATA PROVIDED BY OMNI DIRECTORATE CARTOGRAPHY BUREAU // CLUSTER ${activeClusterId.toUpperCase()} RELAY`)
    );
};

// Retro Metallic Style Constants
const HUD_BG = 'linear-gradient(180deg, #999 0%, #666 50%, #333 100%)';
const HUD_BORDER = '1px solid #777';
const HUD_SHADOW = '2px 2px 10px rgba(0,0,0,0.8)';

// Rarity Color and Bonus Definitions
const RARITY_COLORS = {
    common: '#ffffff',
    uncommon: '#00ff00',
    rare: '#00ccff',
    epic: '#a335ee',
    legendary: '#ffcc00',
    mythic: '#ffcc00'
};

const RARITY_MULTIPLIERS = {
    common: 1.0,
    uncommon: 1.25,
    rare: 1.5,
    epic: 2.0,
    mythic: 3.0
};

const RARITY_LABELS = {
    common: 'STANDARD GRADE',
    uncommon: 'OPTIMIZED GRADE',
    rare: 'SUPERIOR GRADE',
    epic: 'ELITE PROTOTYPE',
    legendary: 'LEGENDARY PROTOTYPE',
    mythic: 'MYTHIC CALIBRATION'
};

const IconHP = () => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', style: { marginLeft: '8px' } },
        React.createElement('path', { d: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z', fill: '#ff0000' })
    )
);

const IconShield = () => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', style: { marginLeft: '8px' } },
        React.createElement('path', { d: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z', fill: '#00ccff' })
    )
);

const IconEnergy = () => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', style: { marginLeft: '8px' } },
        React.createElement('path', { d: 'M7 2v11h3v9l7-12h-4l4-8z', fill: '#00ff00' })
    )
);

const BarRow = ({ color, percent, icon, value = 0, isFlashing = false }) => (
    React.createElement('div', {
        style: {
            display: 'flex',
            alignItems: 'center',
            height: '30px',
            marginBottom: '6px',
            background: 'rgba(0,0,0,0.6)',
            borderRadius: '15px',
            paddingLeft: '12px',
            paddingRight: '12px',
            border: isFlashing ? '1px solid #ff0000' : '1px solid #444',
            userSelect: 'none',
            cursor: 'default',
            animation: isFlashing ? 'warningFlash 0.5s infinite ease-in-out' : 'none'
        }
    },
        React.createElement('div', {
            style: {
                flex: 1,
                height: '12px',
                background: '#111',
                borderRadius: '6px',
                overflow: 'hidden',
                border: '1px solid #333'
            }
        }, 
            React.createElement('div', {
                style: {
                    width: `${percent}%`,
                    height: '100%',
                    background: color,
                    boxShadow: `0 0 8px ${color}`
                }
            })
        ),
        icon,
        React.createElement('div', {
            style: {
                color: '#fff',
                fontSize: '14px',
                fontFamily: 'monospace',
                width: '60px',
                textAlign: 'right',
                marginLeft: '6px',
                fontWeight: 'bold'
            }
        }, (value || 0).toFixed(1))
    )
);

const IconSearch = ({ color = '#00ccff' }) => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('circle', { cx: '11', cy: '11', r: '8' }),
        React.createElement('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })
    )
);

const IconCargo = ({ color = '#00ccff' }) => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M21 8V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8' }),
        React.createElement('path', { d: 'M16 5L12 2 8 5' }),
        React.createElement('line', { x1: '3', y1: '8', x2: '21', y2: '8' }),
        React.createElement('line', { x1: '12', y1: '22', x2: '12', y2: '8' })
    )
);

const IconShipSub = ({ color = '#00ccff' }) => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M12 2L14 8L20 10L21 16L14 15L14 22L10 22L10 15L3 16L4 10L10 8Z' })
    )
);

const IconShop = ({ color = '#00ccff' }) => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('circle', { cx: '9', cy: '21', r: '1' }),
        React.createElement('circle', { cx: '20', cy: '21', r: '1' }),
        React.createElement('path', { d: 'M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6' })
    )
);

const IconGalaxy = () => (
    React.createElement('svg', { width: '32', height: '32', viewBox: '0 0 24 24', fill: 'none', stroke: '#00ccff', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M12 2a10 10 0 1 0 10 10', opacity: '0.3' }),
        React.createElement('path', { d: 'M12 22a10 10 0 1 0-10-10', opacity: '0.3' }),
        React.createElement('path', { d: 'M12 6a6 6 0 1 0 6 6', opacity: '0.6' }),
        React.createElement('path', { d: 'M12 18a6 6 0 1 0-6-6', opacity: '0.6' }),
        React.createElement('circle', { cx: '12', cy: '12', r: '2', fill: '#00ccff' })
    )
);

const IconMapStarport = ({ size = 10, color = '#00ff00' }) => (
    React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '3', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
        React.createElement('polyline', { points: '9 22 9 12 15 12 15 22' })
    )
);

const IconMapGate = ({ size = 10, color = '#00ccff' }) => (
    React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '3', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('circle', { cx: '12', cy: '12', r: '9' }),
        React.createElement('circle', { cx: '12', cy: '12', r: '4' })
    )
);

const IconSyndicate = ({ color = '#00ccff' }) => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }),
        React.createElement('circle', { cx: '9', cy: '7', r: '4' }),
        React.createElement('path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }),
        React.createElement('path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' })
    )
);

const FittingSlot = ({ type, label, position, equipped, onClick }) => {
    const rarityColors = {
        common: '#eee',
        uncommon: '#00ff00',
        rare: '#00ccff',
        epic: '#a335ee',
        legendary: '#ff8000'
    };
    
    // Default color for empty slots is now a consistent blue
    const defaultColor = '#00ccff';
    const color = equipped ? (rarityColors[equipped.rarity] || rarityColors.common) : defaultColor;
    
    // Determine icon or letter based on slot type
    const getSlotIcon = () => {
        if (equipped) return equipped.name.substring(0, 1).toUpperCase();
        switch(type) {
            case 'weapon': return 'W';
            case 'active': return 'A';
            case 'passive': return 'P';
            case 'rig': return 'R';
            default: return label;
        }
    };

    return React.createElement('button', {
        onClick: onClick,
        onPointerDown: (e) => e.stopPropagation(),
        style: {
            position: 'absolute',
            left: position.x,
            top: position.y,
            width: '32px',
            height: '32px',
            background: equipped ? 'rgba(0,0,0,0.9)' : 'rgba(0, 30, 45, 0.85)',
            border: equipped ? `2px solid ${color}` : `1.5px solid ${color}cc`, // More solid for empty
            borderRadius: '6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: equipped ? `0 0 15px ${color}` : '0 0 5px rgba(0, 204, 255, 0.2)',
            zIndex: 10,
            pointerEvents: 'auto',
            transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            transform: 'translate(-50%, -50%)', // Center on the position
            animation: 'none', // Removed fading animation
            opacity: equipped ? 1 : 0.95, // Stable high visibility
            padding: 0,
            fontFamily: 'inherit',
            outline: 'none',
            color: 'inherit'
        },
        onMouseEnter: (e) => {
            e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.1)';
            e.currentTarget.style.boxShadow = `0 0 25px ${color}`;
            e.currentTarget.style.borderColor = color; // Brighter border on hover
            e.currentTarget.style.opacity = '1';
        },
        onMouseLeave: (e) => {
            e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.0)';
            e.currentTarget.style.borderColor = equipped ? color : `${color}cc`;
            e.currentTarget.style.boxShadow = equipped ? `0 0 15px ${color}` : '0 0 5px rgba(0, 204, 255, 0.2)';
            e.currentTarget.style.opacity = equipped ? '1' : '0.95';
        }
    },
        React.createElement('div', {
            style: {
                fontSize: equipped ? '12px' : '10px',
                color: equipped ? color : `${color}aa`,
                fontWeight: 'bold',
                textAlign: 'center',
                textShadow: equipped ? `0 0 5px ${color}` : 'none'
            }
        }, getSlotIcon())
    );
};

const SynapseSlot = ({ id, equipped, onClick }) => {
    const color = '#00ccff'; // Synapses are Directorate Blue by default
    
    return React.createElement('button', {
        onClick: onClick,
        onPointerDown: (e) => e.stopPropagation(),
        style: {
            width: '24px',
            height: '24px',
            background: equipped ? 'rgba(0,0,0,0.9)' : 'rgba(0, 30, 45, 0.85)',
            border: equipped ? `2px solid ${color}` : `1.5px solid ${color}cc`,
            borderRadius: '50%', // Circle as requested
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: equipped ? `0 0 15px ${color}` : '0 0 5px rgba(0, 204, 255, 0.2)',
            transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            opacity: equipped ? 1 : 0.95,
            padding: 0,
            fontFamily: 'inherit',
            outline: 'none',
            color: 'inherit'
        },
        onMouseEnter: (e) => {
            e.currentTarget.style.transform = 'scale(1.15)';
            e.currentTarget.style.boxShadow = `0 0 20px ${color}`;
            e.currentTarget.style.borderColor = color;
            e.currentTarget.style.opacity = '1';
        },
        onMouseLeave: (e) => {
            e.currentTarget.style.transform = 'scale(1.0)';
            e.currentTarget.style.borderColor = equipped ? color : `${color}cc`;
            e.currentTarget.style.boxShadow = equipped ? `0 0 15px ${color}` : '0 0 5px rgba(0, 204, 255, 0.2)';
            e.currentTarget.style.opacity = equipped ? '1' : '0.95';
        }
    },
        React.createElement('div', {
            style: {
                fontSize: '8px',
                color: equipped ? color : `${color}aa`,
                fontWeight: 'bold',
                textAlign: 'center'
            }
        }, 'SYN')
    );
};

const NavButton = ({ label, icon, style, onClick, progress = 0, progressColor = '#ffcc00', size = 42 }) => (
    React.createElement('div', {
        onClick: onClick,
        style: {
            position: 'absolute',
            width: `${size}px`,
            height: `${size}px`,
            background: 'radial-gradient(circle at 30% 30%, #444 0%, #111 85%, #000 100%)',
            border: '1.5px solid #666',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 4px 10px rgba(0,0,0,0.8), inset 0 0 10px rgba(255,255,255,0.1)',
            pointerEvents: 'auto',
            transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            overflow: 'hidden',
            ...style
        },
        onMouseEnter: (e) => {
            e.currentTarget.style.transform = 'scale(1.15)';
            e.currentTarget.style.borderColor = '#00ccff';
            e.currentTarget.style.boxShadow = '0 0 15px rgba(0,204,255,0.4), inset 0 0 10px rgba(0,204,255,0.2)';
        },
        onMouseLeave: (e) => {
            e.currentTarget.style.transform = 'scale(1.0)';
            e.currentTarget.style.borderColor = style?.borderColor || '#888';
            e.currentTarget.style.boxShadow = style?.boxShadow || '0 4px 10px rgba(0,0,0,0.8)';
        }
    },
        // Progress Fill Layer
        progress > 0 && React.createElement('div', {
            style: {
                position: 'absolute',
                bottom: 0,
                left: 0,
                width: '100%',
                height: `${progress}%`,
                background: progressColor,
                opacity: 0.3,
                pointerEvents: 'none',
                transition: 'height 0.3s ease'
            }
        }),
        // Icon/Label Layer
        React.createElement('div', { 
            style: { 
                position: 'relative', 
                zIndex: 2, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                transform: `scale(${size/38})` // Scale icon content to match button
            } 
        },
            icon 
                ? (typeof icon === 'function' ? icon(style?.animation?.includes('warningFlash') ? '#ff4444' : '#00ccff') : icon)
                : React.createElement('div', {
                    style: { color: '#fff', fontSize: '7px', fontWeight: 'bold', pointerEvents: 'none', textAlign: 'center' }
                }, label)
        )
    )
);

const IconWeaponPlaceholder = ({ color = '#444', opacity = 0.4 }) => (
    React.createElement('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '1.5', style: { opacity } },
        React.createElement('circle', { cx: '12', cy: '12', r: '9' }),
        React.createElement('line', { x1: '12', y1: '1', x2: '12', y2: '5' }),
        React.createElement('line', { x1: '12', y1: '19', x2: '12', y2: '23' }),
        React.createElement('line', { x1: '1', y1: '12', x2: '5', y2: '12' }),
        React.createElement('line', { x1: '19', y1: '12', x2: '23', y2: '12' }),
        React.createElement('circle', { cx: '12', cy: '12', r: '2', fill: color })
    )
);

const IconWeaponLaser = ({ color = '#ff4444' }) => (
    React.createElement('svg', { width: '26', height: '26', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2', strokeLinecap: 'round' },
        React.createElement('path', { d: 'M3 12h18M12 3v18', opacity: '0.3' }),
        React.createElement('path', { d: 'M8 8l8 8M16 8l-8 8' }),
        React.createElement('circle', { cx: '12', cy: '12', r: '4', strokeWidth: '1' })
    )
);

const IconEngine = ({ color = '#aaa' }) => (
    React.createElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' })
    )
);

const IconShieldSlot = ({ color = '#aaa' }) => (
    React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' })
    )
);

const ActionButton = ({ module, slotId, cooldown, active, weaponState, onTrigger, onToggleGroup, size = 64, iconSize = 32 }) => {
    const activeColor = module ? (RARITY_COLORS[module.rarity] || '#ffffff') : '#ffffff';
    const emptyColor = '#444';
    const color = module ? activeColor : emptyColor;
    
    const isWeapon = module && (module.type === 'weapon' || module.type === 'mining');

    const renderIcon = () => {
        if (!module) return React.createElement(IconWeaponPlaceholder, { color: '#555', opacity: 0.3 });
        if (slotId.startsWith('engine')) return React.createElement(IconEngine, { color: color });
        if (slotId.startsWith('active')) return React.createElement(IconShieldSlot, { color: color });
        if (module.name.toLowerCase().includes('laser')) {
            return React.createElement(IconWeaponLaser, { color: color });
        }
        return React.createElement(IconWeaponPlaceholder, { color: color, opacity: 1 });
    };

    const effectiveModule = module ? (module.final_stats ? module : hydrateItem(module)) : null;
    const moduleStats = effectiveModule?.final_stats || null;
    const hasHeat = weaponState && weaponState.heat !== undefined;
    const config = effectiveModule && hasHeat ? FLUX_LASER_CONFIGS[effectiveModule.weaponsize || 'S'] : null;
    const heatCapacity = effectiveModule?.heatCapacity || moduleStats?.heatCapacity || config?.heatCapacity || 100;
    const heatRatio = config ? weaponState.heat / heatCapacity : 0;
    const isOverheated = weaponState?.overheated;

    // Cooldown Normalization for Seeker Pods and standard weapons
    let cooldownPercent = 0;
    let showTimer = false;
    const isMissile = effectiveModule?.name?.toLowerCase().includes('seeker pod');
    if (cooldown > 0) {
        let maxCooldown = 1.0; // Default fallback
        if (isMissile) {
            const mConfig = MISSILE_CONFIGS[effectiveModule.weaponsize || 'S'];
            maxCooldown = moduleStats?.reload || effectiveModule.reload || mConfig.reload;
            showTimer = true;
        } else if (moduleStats?.fireRate || effectiveModule?.fireRate) {
            maxCooldown = moduleStats?.fireRate || effectiveModule.fireRate;
            if (maxCooldown > 0.5) showTimer = true;
        }
        cooldownPercent = Math.min(1, cooldown / Math.max(0.0001, maxCooldown));
    }

    const handlePointerDown = (e) => {
        e.stopPropagation();
        if (!module) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        // Toggle behavior: Trigger on down, ignore release for hold
        if (onTrigger) onTrigger(module);
    };

    const handlePointerUp = (e) => {
        e.stopPropagation();
        if (!module) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    const handlePointerCancel = (e) => {
        if (!module) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    const handleToggleGroup = (e, group) => {
        e.stopPropagation();
        if (onToggleGroup) onToggleGroup(slotId, group);
    };

    return React.createElement('div', {
        style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
            pointerEvents: 'auto'
        }
    },
        React.createElement('div', {
            onPointerDown: handlePointerDown,
            onPointerUp: handlePointerUp,
            onPointerCancel: handlePointerCancel,
            onPointerLeave: handlePointerCancel,
            style: {
                width: `${size}px`,
                height: `${size}px`,
                background: module ? 'radial-gradient(circle at 30% 30%, #333 0%, #111 85%, #000 100%)' : 'rgba(10,10,12,0.6)',
                border: `1.5px solid ${isOverheated ? '#ff4444' : (module ? color : '#333')}`,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: module ? 'pointer' : 'default',
                boxShadow: isOverheated ? '0 0 20px #ff0000, inset 0 0 10px #ff000066' : (active ? `0 0 20px ${color}, inset 0 0 10px ${color}66` : (module ? `0 3px 10px rgba(0,0,0,0.8), 0 0 8px ${color}33` : 'none')),
                transition: 'all 0.1s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                position: 'relative',
                opacity: module ? 1 : 0.6,
                userSelect: 'none',
                WebkitTapHighlightColor: 'transparent',
                overflow: 'hidden',
                transform: active ? 'scale(1.05)' : 'scale(1)'
            }
        },
            // Heat Bar
            hasHeat && React.createElement('div', {
                style: {
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: `${heatRatio * 100}%`,
                    background: isOverheated ? 'rgba(255, 0, 0, 0.4)' : 'rgba(255, 100, 0, 0.3)',
                    pointerEvents: 'none',
                    zIndex: 1,
                    transition: 'height 0.1s ease-out'
                }
            }),
            // Overheat Warning
            isOverheated && React.createElement('div', {
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    background: 'rgba(255, 0, 0, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: '8px',
                    fontWeight: 'bold',
                    zIndex: 3,
                    animation: 'pulse 0.5s infinite alternate'
                }
            }, 'HOT'),
            // Cooldown Overlay
            cooldown > 0 && !isOverheated && React.createElement('div', {
                style: {
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: `${cooldownPercent * 100}%`,
                    background: 'rgba(255, 255, 255, 0.2)',
                    pointerEvents: 'none',
                    zIndex: 1
                }
            }),
            // Cooldown Timer
            cooldown > 0 && !isOverheated && React.createElement('div', {
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    fontFamily: 'monospace',
                    textShadow: '0 0 10px #000, 0 0 5px #000',
                    zIndex: 4,
                    pointerEvents: 'none'
                }
            }, cooldown.toFixed(1)),
            // Icon
            React.createElement('div', { style: { position: 'relative', zIndex: 2 } }, renderIcon()),
            React.createElement('style', null, `
                @keyframes pulse {
                    from { opacity: 0.4; }
                    to { opacity: 1; }
                }
            `)
        ),
        // Weapon Group Selectors
        isWeapon && React.createElement('div', {
            style: {
                display: 'flex',
                gap: '4px',
                pointerEvents: 'auto'
            }
        },
            [1, 2].map(group => {
                const isAssigned = module[`weaponGroup${group}`];
                return React.createElement('div', {
                    key: group,
                    onPointerDown: (e) => handleToggleGroup(e, group),
                    style: {
                        width: '20px',
                        height: '14px',
                        background: isAssigned ? '#00ccff' : 'rgba(0,0,0,0.6)',
                        border: `1px solid ${isAssigned ? '#fff' : '#444'}`,
                        borderRadius: '2px',
                        color: isAssigned ? '#000' : '#888',
                        fontSize: '8px',
                        fontWeight: 'bold',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: isAssigned ? '0 0 8px #00ccff' : 'none'
                    }
                }, `G${group}`);
            })
        )
    );
};

const NavLine = ({ angle, length, left = '30px', top = '30px', opacity = 0.2 }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            width: `${length}px`,
            height: '1px',
            background: `rgba(255,255,255,${opacity})`,
            transformOrigin: '0% 50%',
            transform: `rotate(${angle}deg)`,
            pointerEvents: 'none',
            left: left,
            top: top
        }
    })
);

const SecurityAlert = ({ message, onClose }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '320px',
            background: 'rgba(40, 10, 10, 0.95)',
            border: '2px solid #ff4444',
            borderRadius: '4px',
            boxShadow: '0 0 40px rgba(255,0,0,0.4)',
            padding: '20px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 3200,
            pointerEvents: 'auto',
            textAlign: 'center'
        }
    },
        React.createElement('div', {
            style: {
                fontSize: '16px',
                fontWeight: 'bold',
                color: '#ff4444',
                marginBottom: '15px',
                letterSpacing: '2px'
            }
        }, '⚠️ SECURITY ALERT'),
        React.createElement('div', {
            style: {
                fontSize: '12px',
                lineHeight: '1.5',
                marginBottom: '20px',
                color: '#ffaaaa'
            }
        }, message),
        React.createElement('button', {
            onClick: onClose,
            style: {
                background: '#441111',
                border: '1px solid #ff4444',
                color: '#ff4444',
                padding: '8px 20px',
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontWeight: 'bold',
                borderRadius: '2px'
            }
        }, 'ACKNOWLEDGE')
    )
);

const FittingWarning = ({ warning, onClose }) => {
    if (!warning) return null;
    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '360px',
            background: 'rgba(30, 10, 5, 0.98)',
            border: '2px solid #ff4444',
            borderRadius: '4px',
            boxShadow: '0 0 50px rgba(255,0,0,0.3), inset 0 0 20px rgba(255,0,0,0.1)',
            padding: '25px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 3100,
            pointerEvents: 'auto',
            textAlign: 'center',
            animation: 'fadeIn 0.2s ease-out'
        }
    },
        React.createElement('div', { style: { fontSize: '18px', fontWeight: 'bold', color: '#ff4444', marginBottom: '15px', letterSpacing: '2px' } }, '⚠️ FITTING VIOLATION'),
        React.createElement('div', { style: { fontSize: '12px', color: '#aaa', marginBottom: '20px', lineHeight: '1.6' } }, 
            `Configuration failed for ${warning.moduleName}. Ship systems cannot support the requested resource load.`
        ),
        React.createElement('div', { style: { background: 'rgba(0,0,0,0.4)', padding: '15px', borderRadius: '4px', marginBottom: '25px', border: '1px solid #331111' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '8px' } },
                React.createElement('span', { style: { color: '#888' } }, 'RESOURCE'),
                React.createElement('span', { style: { color: '#888' } }, 'STATUS')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '5px' } },
                React.createElement('span', { style: { color: '#aaa' } }, 'POWER GRID'),
                React.createElement('span', { style: { color: warning.powerDeficit > 0 ? '#ff4444' : '#00ff00', fontWeight: 'bold' } }, 
                    warning.powerDeficit > 0 ? `-${warning.powerDeficit.toFixed(1)} MW` : 'STABLE'
                )
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } },
                React.createElement('span', { style: { color: '#aaa' } }, 'CPU CAPACITY'),
                React.createElement('span', { style: { color: warning.cpuDeficit > 0 ? '#ff4444' : '#00ff00', fontWeight: 'bold' } }, 
                    warning.cpuDeficit > 0 ? `-${warning.cpuDeficit.toFixed(1)} TF` : 'STABLE'
                )
            )
        ),
        React.createElement('button', {
            onClick: onClose,
            style: {
                width: '100%',
                background: '#441111',
                border: '1px solid #ff4444',
                color: '#ff4444',
                padding: '12px',
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '1px'
            }
        }, 'ACKNOWLEDGE SYSTEM LIMITS')
    );
};

const CommanderMenu = ({ gameState, onClose, isEditing, onToggleEdit, onSaveName, cloudUser, onCloudLogin, onCloudLogout, isSyncing, onSelectSlot, setActivePanel, remotePlayer }) => {
    const { commanderData: localCommanderData } = useGameState();
    const commanderData = remotePlayer || localCommanderData;
    const { offset, dragProps } = useDraggable();
    const [activeTab, setActiveTab] = useState('dossier'); // 'dossier', 'outfit', 'implants', 'assets'
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const stats = gameState.commanderStats || {};

    async function resetAccount() {
        try {
            await supabase.auth.signOut();
            console.log("[DEBUG] Signed out. Restarting game...");
            window.location.reload();
        } catch (error) {
            console.error("[DEBUG] Sign out error:", error);
            alert("Reset failed: " + error.message);
        }
    }

    const renderAssets = () => {
        const userId = cloudService.user?.id || 'local';
        const globalAssets = [];
        
        // aggregate all regional storage
        Object.entries(gameState.regionalStorage || {}).forEach(([systemId, users]) => {
            if (users[userId]) {
                users[userId].forEach(item => {
                    globalAssets.push({
                        ...item,
                        systemId,
                        systemName: SYSTEMS_REGISTRY[systemId]?.name || systemId
                    });
                });
            }
        });

        return React.createElement('div', { style: { animation: 'fadeIn 0.3s ease-out', display: 'flex', flexDirection: 'column', height: '100%' } },
            React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '15px', borderBottom: '1px solid #333', paddingBottom: '10px' } }, 'INTERSTELLAR ASSET REGISTRY'),
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { flex: 1, overflowY: 'auto', paddingRight: '10px', scrollbarWidth: 'thin', scrollbarColor: '#ffcc00 rgba(0,0,0,0.3)' } 
            },
                globalAssets.length === 0 ? 
                React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, '--- NO ASSETS DETECTED IN GALACTIC STORAGE ---') :
                globalAssets.map((asset, idx) => (
                    React.createElement('div', {
                        key: idx,
                        style: {
                            padding: '12px',
                            background: 'rgba(255, 255, 255, 0.02)',
                            border: '1px solid #333',
                            borderRadius: '4px',
                            marginBottom: '8px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }
                    },
                        React.createElement('div', null,
                            React.createElement('div', { style: { color: RARITY_COLORS[asset.rarity] || '#fff', fontWeight: 'bold', fontSize: '13px' } }, asset.name.toUpperCase()),
                            React.createElement('div', { style: { fontSize: '10px', color: '#00ccff', marginTop: '2px' } }, `@ ${asset.systemName.toUpperCase()} / ${(asset.starportId || "").toString().toUpperCase()}`)
                        ),
                        React.createElement('div', { style: { textAlign: 'right' } },
                            React.createElement(
  'div',
  { style: { color: '#fff', fontWeight: 'bold', fontSize: '12px' } },
  `${Number.isInteger(asset.amount)
      ? asset.amount
      : Number(asset.amount).toFixed(1)} UNITS`
),
                            React.createElement('div', { style: { fontSize: '9px', color: '#555' } }, 'READY FOR PICKUP')
                        )
                    )
                ))
            )
        );
    };

    const renderContracts = () => {
        const userId = cloudService.user?.id || 'local';
        const myContracts = gameState.courierContracts?.filter(c => c.haulerId === userId) || [];

        return React.createElement('div', { style: { animation: 'fadeIn 0.3s ease-out', display: 'flex', flexDirection: 'column', height: '100%' } },
            React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '15px', borderBottom: '1px solid #333', paddingBottom: '10px' } }, 'ACTIVE SERVICE CONTRACTS'),
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { flex: 1, overflowY: 'auto', paddingRight: '10px', scrollbarWidth: 'thin', scrollbarColor: '#00ccff rgba(0,0,0,0.3)' } 
            },
                myContracts.length === 0 ? 
                React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, '--- NO ACTIVE CONTRACTS ---') :
                myContracts.map((contract, idx) => (
                    React.createElement('div', {
                        key: idx,
                        style: {
                            padding: '12px',
                            background: 'rgba(255, 255, 255, 0.02)',
                            border: `1px solid ${contract.status === 'completed' ? '#00ff0044' : '#333'}`,
                            borderRadius: '4px',
                            marginBottom: '8px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }
                    },
                        React.createElement('div', null,
                            React.createElement('div', { style: { color: '#fff', fontWeight: 'bold', fontSize: '13px' } }, `TRANSPORT: ${contract.item.name.toUpperCase()}`),
                            React.createElement('div', { style: { fontSize: '10px', color: '#00ccff', marginTop: '2px' } }, 
                                `${SYSTEMS_REGISTRY[contract.originSystemId]?.name} ➔ ${SYSTEMS_REGISTRY[contract.destinationSystemId]?.name}`
                            )
                        ),
                        React.createElement('div', { style: { textAlign: 'right' } },
                            React.createElement('div', { style: { color: '#ffcc00', fontWeight: 'bold', fontSize: '12px' } }, `${contract.reward.toFixed(0)} Cr`),
                            React.createElement('div', { style: { fontSize: '9px', color: contract.status === 'in-transit' ? '#ffcc00' : (contract.status === 'completed' ? '#00ff00' : '#888'), fontWeight: 'bold' } }, 
                                contract.status.toUpperCase()
                            )
                        )
                    )
                ))
            )
        );
    };

    const renderDossier = () => React.createElement('div', { style: { animation: 'fadeIn 0.3s ease-out' } },
        React.createElement('div', { style: { display: 'flex', gap: '20px', marginBottom: '10px' } },
            // Portrait
            React.createElement('div', {
                style: {
                    flex: 1,
                    background: 'radial-gradient(circle, #332211 0%, #110a05 100%)',
                    borderRadius: '4px',
                    border: '1px solid #554422',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '170px',
                    overflow: 'hidden'
                }
            },
                React.createElement('img', {
                    src: commanderData?.portrait_url || '/assets/captain-portrait.png.webp',
                    onClick: () => setActivePanel("portraitPicker"),
                    style: { width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated', cursor: 'pointer' }
                })
            ),

            // Basic Info
            React.createElement('div', { style: { flex: 1.2 } },
                React.createElement('div', { 
                    style: { 
                        fontSize: '18px', 
                        fontWeight: 'bold', 
                        fontFamily: 'monospace',
                        color: '#ffcc00', 
                        marginBottom: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: isEditing ? 'rgba(255,200,0,0.1)' : 'rgba(0,0,0,0.3)',
                        padding: '6px 10px',
                        borderRadius: '4px',
                        border: isEditing ? '1px solid #ffcc00' : '1px solid #554422',
                        minHeight: '36px',
                        boxSizing: 'border-box',
                        userSelect: isEditing ? 'auto' : 'none',
                        cursor: isEditing ? 'text' : 'default'
                    } 
                }, 
                    isEditing ? 
                    React.createElement('input', {
                        autoFocus: true,
                        defaultValue: gameState.commanderName,
                        maxLength: 15,
                        onKeyDown: (e) => {
                            if (e.key === 'Enter') onSaveName(e.target.value);
                            if (e.key === 'Escape') onToggleEdit();
                        },
                        style: {
                            background: 'transparent',
                            border: 'none',
                            color: '#ffcc00',
                            fontSize: '16px',
                            fontWeight: 'bold',
                            fontFamily: 'monospace',
                            width: '100%',
                            outline: 'none',
                            textTransform: 'uppercase'
                        },
                        id: 'name-input'
                    }) : gameState.commanderName,
                    
                    React.createElement('button', {
                        onClick: () => {
                            if (isEditing) {
                                const val = document.getElementById('name-input').value;
                                onSaveName(val);
                            } else {
                                onToggleEdit();
                            }
                        },
                        style: {
                            background: '#554422',
                            border: '1px solid #ffcc00',
                            color: '#ffcc00',
                            fontSize: '9px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            borderRadius: '2px',
                            fontFamily: 'monospace',
                            fontWeight: 'bold'
                        }
                    }, isEditing ? 'SAVE' : (gameState.hasRenamed ? 'RE-AUTH' : 'RENAME'))
                ),
                
                [
                    { label: 'RANK', value: 'COMMANDER', color: '#ffcc00' },
                    { label: 'STATUS', value: 'ACTIVE DUTY', color: '#00ff00' },
                    { label: 'LEVEL', value: gameState.level, color: '#fff' },
                    { label: 'EXP', value: `${Number(gameState.experience || 0).toFixed(1)} / ${getRequiredExp(gameState.level)}`, color: '#aaa' },
                    { label: 'SYNDICATE', value: 'NEUTRAL (0)', color: '#888' },
                    { label: 'CREDITS', value: (gameState.credits || 0).toFixed(2) + ' Cr', color: '#ffcc00' },
                    { label: 'BOUNTY', value: 'CLEAN (0 Cr)', color: '#00ff00' }
                ].map((stat, i) => 
                    React.createElement('div', { key: i, style: { marginBottom: '5px', fontSize: '11px' } },
                        React.createElement('span', { style: { color: '#888' } }, `${stat.label}: `),
                        React.createElement('span', { style: { color: stat.color, fontWeight: 'bold' } }, stat.value)
                    )
                )
            )
        ),

        // Faction Standing
        React.createElement('div', {
            style: {
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid #554422',
                padding: '8px 12px',
                borderRadius: '4px',
                marginBottom: '10px'
            }
        },
            React.createElement('div', { style: { fontSize: '10px', color: '#ffcc00', marginBottom: '8px', letterSpacing: '1px', fontWeight: 'bold' } }, 'FACTION STANDING'),
            (() => {
                const standings = gameState.factionStandings || {
                    'OMNI DIRECTORATE': 100,
                    'CRIMSON RIFT CARTEL': 0,
                    'VOIDBORNE COVENANT': 0,
                    'FERRON INDUSTRIAL GUILD': 0
                };
                return Object.entries(standings).map(([faction, value], i) => (
                    React.createElement('div', { key: i, style: { marginBottom: '8px' } },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' } },
                            React.createElement('span', { style: { color: '#aaa' } }, faction),
                            React.createElement('span', { style: { color: '#fff', fontWeight: 'bold' } }, Math.min(100, Math.max(0, value)).toFixed(0))
                        ),
                        React.createElement('div', { style: { height: '4px', background: '#111', borderRadius: '2px', overflow: 'hidden' } },
                            React.createElement('div', { 
                                style: { 
                                    width: `${Math.min(100, Math.max(0, value))}%`, 
                                    height: '100%', 
                                    background: faction === 'OMNI DIRECTORATE' ? '#00ccff' : (faction === 'CRIMSON RIFT CARTEL' ? '#ff4444' : '#888'),
                                    boxShadow: `0 0 8px ${faction === 'OMNI DIRECTORATE' ? '#00ccff' : (faction === 'CRIMSON RIFT CARTEL' ? '#ff4444' : '#888')}`,
                                    transition: 'width 0.5s ease-out'
                                } 
                            })
                        )
                    )
                ));
            })()
        ),

        // Neurological & Biological Interface Stats
        React.createElement('div', {
            style: {
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid #554422',
                padding: '8px 12px',
                borderRadius: '4px'
            }
        },
            React.createElement('div', { style: { fontSize: '10px', color: '#ffcc00', marginBottom: '8px', letterSpacing: '1px', fontWeight: 'bold' } }, 'INTERFACE SYNCHRONIZATION'),
            (() => {
                const stats = getCommanderStats(gameState);
                return [
                    { label: 'Neural Stability', value: stats.neuralStability, color: '#00ccff' },
                    { label: 'Bio-Tolerance', value: stats.bioTolerance, color: '#00ff00' },
                    { label: 'Motor Integration', value: stats.motorIntegration, color: '#ffcc00' }
                ].map((stat, i) => (
                    React.createElement('div', { key: i, style: { marginBottom: '8px' } },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' } },
                            React.createElement('span', { style: { color: '#aaa' } }, stat.label.toUpperCase()),
                            React.createElement('span', { 
                                style: { 
                                    color: stat.value > 100 ? '#fff' : '#fff', 
                                    fontWeight: 'bold',
                                textShadow: stat.value > 100 ? `0 0 10px ${stat.color}` : 'none'
                                } 
                            }, stat.value)
                        ),
                        React.createElement('div', { 
                            style: { 
                                height: '4px', 
                                background: '#111', 
                                borderRadius: '2px', 
                                overflow: 'hidden',
                                border: stat.value > 100 ? `1px solid ${stat.color}44` : 'none'
                            } 
                        },
                            React.createElement('div', { 
                                style: { 
                                    width: `${Math.min(100, (stat.value / 300) * 100)}%`, 
                                    height: '100%', 
                                    background: stat.color, 
                                    boxShadow: stat.value > 100 ? `0 0 12px ${stat.color}, 0 0 20px ${stat.color}44` : `0 0 8px ${stat.color}`,
                                    transition: 'width 0.5s ease-out'
                                } 
                            })
                        )
                    )
                ));
            })()
        )
    );

    const renderOutfit = () => {
        const outfitSlots = [
            { id: 'head', label: 'HEAD', fullName: 'HEAD UNIT', position: { x: '45%', y: '5%' } },
            { id: 'shoulders', label: 'SHLD', fullName: 'SHOULDER PLATING', position: { x: '45%', y: '18%' } },
            { id: 'chest', label: 'CHST', fullName: 'CHEST PIECE', position: { x: '45%', y: '32%' } },
            { id: 'hands', label: 'HNDS', fullName: 'GAUNTLETS', position: { x: '10%', y: '42%' } },
            { id: 'legs', label: 'LEGS', fullName: 'LEG ARMOR', position: { x: '45%', y: '60%' } },
            { id: 'feet', label: 'FEET', fullName: 'BOOTS', position: { x: '45%', y: '80%' } }
        ];

        return React.createElement('div', { 
            style: { 
                animation: 'fadeIn 0.3s ease-out', 
                flex: 1, 
                background: 'radial-gradient(circle, #222 0%, #111 100%)', 
                borderRadius: '4px', 
                border: '1px solid #333', 
                position: 'relative',
                overflow: 'hidden'
            } 
        },
            React.createElement('div', {
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    background: 'repeating-linear-gradient(0deg, rgba(255,200,0,0.02) 0px, rgba(255,200,0,0.02) 1px, transparent 1px, transparent 2px)',
                    pointerEvents: 'none'
                }
            }),
            // Stylized Silhouette
            React.createElement('div', {
                style: {
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '160px',
                    height: '240px',
                    border: '2px solid rgba(255,204,0,0.1)',
                    borderRadius: '40% 40% 10% 10%',
                    opacity: 0.2
                }
            }),
            outfitSlots.map(slot => React.createElement(FittingSlot, {
                key: slot.id,
                ...slot,
                equipped: gameState.commanderOutfit[slot.id],
                onClick: () => onSelectSlot({ ...slot, type: 'outfit' })
            }))
        );
    };

    const renderImplants = () => {
        const implantSlots = [
            { id: 'brain', label: 'BRN', fullName: 'NEURAL LINK', position: { x: '45%', y: '5%' } },
            { id: 'eye', label: 'EYE', fullName: 'OCULAR SYSTEM', position: { x: '30%', y: '12%' } },
            { id: 'ear', label: 'EAR', fullName: 'AUDITORY SENSOR', position: { x: '60%', y: '12%' } },
            { id: 'chest', label: 'CHST', fullName: 'CARDIO CORE', position: { x: '45%', y: '28%' } },
            { id: 'rightArm', label: 'R-A', fullName: 'RIGHT ARM', position: { x: '15%', y: '25%' } },
            { id: 'leftArm', label: 'L-A', fullName: 'LEFT ARM', position: { x: '75%', y: '25%' } },
            { id: 'rightHand', label: 'R-H', fullName: 'RIGHT HAND', position: { x: '5%', y: '42%' } },
            { id: 'leftHand', label: 'L-H', fullName: 'LEFT HAND', position: { x: '85%', y: '42%' } },
            { id: 'waist', label: 'WST', fullName: 'STABILITY COIL', position: { x: '45%', y: '48%' } },
            { id: 'legs', label: 'LEGS', fullName: 'LOWER EXTREMITIES', position: { x: '45%', y: '68%' } },
            { id: 'feet', label: 'FEET', fullName: 'GAIT ASSIST', position: { x: '45%', y: '85%' } }
        ];

        return React.createElement('div', { 
            style: { 
                animation: 'fadeIn 0.3s ease-out', 
                flex: 1, 
                background: 'radial-gradient(circle, #222 0%, #111 100%)', 
                borderRadius: '4px', 
                border: '1px solid #333', 
                position: 'relative',
                overflow: 'hidden'
            } 
        },
            React.createElement('div', {
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    background: 'repeating-linear-gradient(0deg, rgba(0,204,255,0.02) 0px, rgba(0,204,255,0.02) 1px, transparent 1px, transparent 2px)',
                    pointerEvents: 'none'
                }
            }),
            // Stylized Neural Silhouette
            React.createElement('div', {
                style: {
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '140px',
                    height: '220px',
                    border: '1px solid rgba(0,204,255,0.1)',
                    borderRadius: '50% 50% 20% 20%',
                    opacity: 0.15
                }
            }),
            implantSlots.map(slot => React.createElement(FittingSlot, {
                key: slot.id,
                ...slot,
                equipped: gameState.commanderImplants[slot.id],
                onClick: () => onSelectSlot({ ...slot, type: 'implant' })
            }))
        );
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            width: '500px',
            height: '650px',
            background: 'rgba(25, 20, 15, 0.98)',
            border: '2px solid #554422',
            borderRadius: '8px',
            boxShadow: '0 0 30px rgba(50,40,0,0.5), inset 0 0 20px rgba(255,180,0,0.05)',
            padding: '20px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 2500,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
        }
    },
        // Header / Draggable Handle
        React.createElement('div', {
            ...dragProps,
            style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '50px',
                cursor: 'grab',
                zIndex: 5
            }
        }),

        // Close Button
        React.createElement('button', {
            onClick: onClose,
            onPointerDown: (e) => e.stopPropagation(),
            style: {
                position: 'absolute',
                top: '10px',
                right: '10px',
                cursor: 'pointer',
                color: '#888',
                fontSize: '18px',
                zIndex: 10,
                background: 'none',
                border: 'none',
                padding: 0,
                fontFamily: 'inherit'
            }
        }, '✕'),

        // Title
        React.createElement('div', {
            style: {
                fontSize: '18px',
                fontWeight: 'bold',
                color: '#ffcc00',
                marginBottom: '15px',
                borderBottom: '1px solid #554422',
                paddingBottom: '10px',
                letterSpacing: '2px',
                pointerEvents: 'none'
            }
        }, 'COMMANDER INTERFACE'),

        // Tab Navigation
        React.createElement('div', {
            style: {
                display: 'flex',
                gap: '6px',
                marginBottom: '10px'
            }
        },
            [
                { id: 'dossier', label: 'DOSSIER' },
                { id: 'outfit', label: 'OUTFIT' },
                { id: 'implants', label: 'IMPLANTS' },
                { id: 'assets', label: 'ASSETS' }
            ].map(tab => (
                React.createElement('button', {
                    key: tab.id,
                    onClick: () => setActiveTab(tab.id),
                    style: {
                        flex: 1,
                        background: activeTab === tab.id ? '#ffcc00' : 'rgba(0,0,0,0.3)',
                        border: '1px solid #554422',
                        color: activeTab === tab.id ? '#000' : '#fff',
                        padding: '6px 4px',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        borderRadius: '2px',
                        transition: 'all 0.2s'
                    }
                }, tab.label)
            ))
        ),

        // Main Content Area
        React.createElement('div', {
            style: {
                flex: 1,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                position: 'relative'
            }
        },
            activeTab === 'dossier' ? renderDossier() : 
            (activeTab === 'outfit' ? renderOutfit() : (activeTab === 'implants' ? renderImplants() : renderAssets()))
        ),

        // Footer
        React.createElement('div', {
            style: {
                marginTop: '15px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px'
            }
        },
            showResetConfirm ? 
            React.createElement('div', { style: { display: 'flex', gap: '10px' } },
                React.createElement('button', {
                    onClick: (e) => { e.stopPropagation(); resetAccount(); },
                    style: {
                        background: '#ff4444',
                        border: '1px solid #ff4444',
                        color: '#000',
                        padding: '4px 12px',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        cursor: 'pointer',
                        borderRadius: '2px',
                        letterSpacing: '1px',
                        fontFamily: 'monospace'
                    }
                }, 'CONFIRM RESET'),
                React.createElement('button', {
                    onClick: (e) => { e.stopPropagation(); setShowResetConfirm(false); },
                    style: {
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: '1px solid #888',
                        color: '#fff',
                        padding: '4px 12px',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        cursor: 'pointer',
                        borderRadius: '2px',
                        letterSpacing: '1px',
                        fontFamily: 'monospace'
                    }
                }, 'CANCEL')
            ) :
            React.createElement('button', {
                onClick: (e) => { 
                    e.stopPropagation(); 
                    setShowResetConfirm(true); 
                },
                style: {
                    background: 'rgba(255, 68, 68, 0.1)',
                    border: '1px solid #ff4444',
                    color: '#ff4444',
                    padding: '4px 12px',
                    fontSize: '10px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    borderRadius: '2px',
                    letterSpacing: '1px',
                    transition: 'all 0.2s',
                    fontFamily: 'monospace'
                },
                onMouseEnter: (e) => {
                    e.currentTarget.style.background = 'rgba(255, 68, 68, 0.3)';
                    e.currentTarget.style.boxShadow = '0 0 10px rgba(255, 68, 68, 0.2)';
                },
                onMouseLeave: (e) => {
                    e.currentTarget.style.background = 'rgba(255, 68, 68, 0.1)';
                    e.currentTarget.style.boxShadow = 'none';
                }
            }, 'TERMINATE SESSION / RESET ACCOUNT'),
            React.createElement('div', {
                style: {
                    fontSize: '9px',
                    color: '#665533',
                    textAlign: 'center',
                    fontStyle: 'italic'
                }
            }, 'OMNI DIRECTORATE FLIGHT COMMAND // PERSONNEL DATABASE')
        )
    );
};

const FindMenu = ({ gameState, onClose, onJump }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '320px',
            background: 'rgba(15, 20, 30, 0.98)',
            border: '2px solid #00ccff',
            borderRadius: '8px',
            boxShadow: '0 0 30px rgba(0,204,255,0.3)',
            padding: '20px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 2500,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column'
        }
    },
        React.createElement('button', {
            onClick: onClose,
            style: { position: 'absolute', top: '10px', right: '10px', cursor: 'pointer', color: '#888', fontSize: '18px', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit' }
        }, '✕'),
        React.createElement('div', {
            style: { fontSize: '16px', fontWeight: 'bold', color: '#00ccff', marginBottom: '15px', borderBottom: '1px solid #333', paddingBottom: '10px', letterSpacing: '2px' }
        }, 'SYSTEM SCANNER'),
        React.createElement('div', {
            style: { maxHeight: '250px', overflowY: 'auto' }
        },
            gameState.asteroidBelts.length === 0 ? 
            React.createElement('div', { style: { color: '#555', textAlign: 'center', padding: '20px' } }, '--- NO SIGNALS DETECTED ---') :
            gameState.asteroidBelts.map((belt, i) => (
                React.createElement('div', {
                    key: i,
                    style: {
                        padding: '12px',
                        borderBottom: '1px solid #222',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '12px',
                        background: 'rgba(255,255,255,0.02)',
                        marginBottom: '4px',
                        borderRadius: '4px'
                    }
                },
                    React.createElement('div', null,
                        React.createElement('div', { style: { color: belt.isWarpGate ? '#ff00ff' : '#ffcc00', fontWeight: 'bold' } }, belt.name.toUpperCase()),
                        React.createElement('div', { style: { fontSize: '9px', color: '#888' } }, belt.isWarpGate ? 'INTERSTELLAR TRANSIT RELAY' : 'STABLE ASTEROID FORMATION')
                    ),
                    React.createElement('div', {
                        onClick: () => onJump(belt.id),
                        style: { 
                            color: '#00ccff', 
                            fontSize: '10px', 
                            border: '1px solid #00ccff', 
                            padding: '2px 8px', 
                            borderRadius: '2px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            letterSpacing: '1px'
                        }
                    }, 'JUMP')
                )
            ))
        ),
        React.createElement('div', {
            style: { marginTop: '15px', fontSize: '9px', color: '#444', textAlign: 'center' }
        }, 'OMNI DIRECTORATE SENSOR ARRAY // ACTIVE')
    )
);

const JumpOverlay = ({ remaining, progress }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            top: '40%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '300px',
            textAlign: 'center',
            color: '#00ccff',
            fontFamily: 'monospace',
            zIndex: 1000,
            pointerEvents: 'none'
        }
    },
        React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', marginBottom: '8px', textShadow: '0 0 10px rgba(0,204,255,0.5)' } }, 'JUMP DRIVE INITIALIZING'),
        React.createElement('div', { style: { fontSize: '32px', fontWeight: 'bold', textShadow: '0 0 15px rgba(0,204,255,0.6)' } }, `${remaining.toFixed(1)}s`)
    )
);

const SystemMenu = ({ gameState, onClose, inArena = false, onLeaveArena = null, inBattleground = false, onLeaveBattleground = null, battlegroundHud = null }) => {
    const currentSystem = gameState.currentSystem || {};
    const secInfo = getSecurityInfo(currentSystem.securityValue || 0);

    if (inArena || inBattleground) {
        return React.createElement('div', {
            style: {
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '420px',
                background: 'rgba(18, 10, 12, 0.96)',
                border: '2px solid rgba(255, 90, 90, 0.45)',
                borderRadius: '8px',
                boxShadow: '0 0 35px rgba(120,20,20,0.45), inset 0 0 20px rgba(255,90,90,0.05)',
                padding: '20px',
                color: '#fff',
                fontFamily: 'monospace',
                zIndex: 2500,
                pointerEvents: 'auto'
            }
        },
            React.createElement('div', {
                onClick: onClose,
                style: {
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    cursor: 'pointer',
                    color: '#888',
                    fontSize: '18px'
                }
            }, '✕'),

            React.createElement('div', {
                style: {
                    fontSize: '18px',
                    fontWeight: 'bold',
                    color: '#ff6666',
                    marginBottom: '20px',
                    borderBottom: '1px solid rgba(255,90,90,0.25)',
                    paddingBottom: '10px',
                    letterSpacing: '2px'
                }
            }, inArena ? 'ARENA INFORMATION' : 'BATTLEGROUND INFORMATION'),

            React.createElement('div', { style: { display: 'flex', gap: '20px', alignItems: 'center' } },
                React.createElement('div', {
                    style: {
                        width: '100px',
                        height: '100px',
                        background: 'radial-gradient(circle, #2a1115 0%, #0d0608 100%)',
                        borderRadius: '50%',
                        border: '2px solid #ff6666',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '40px',
                        boxShadow: '0 0 15px rgba(255,90,90,0.2)'
                    }
                }, '⚔️'),

                React.createElement('div', { style: { flex: 1 } },
                    React.createElement('div', { style: { fontSize: '20px', fontWeight: 'bold', color: '#ff6666', marginBottom: '10px' } }, inArena ? 'ARENA' : 'BATTLEGROUND'),
                    [
                        { label: 'SECTOR', value: inArena ? 'ARENA INSTANCE' : 'BATTLEGROUND INSTANCE', color: '#aaa' },
                        { label: 'SECURITY', value: inArena ? 'NO SECURITY (0.0)' : 'CONTROLLED COMBAT SPACE', color: inArena ? '#ff6666' : '#66ccff' },
                        { label: 'STATUS', value: inArena ? 'OPEN CONFLICT ENABLED' : (battlegroundHud?.statusLabel || 'WAVE COMBAT ACTIVE'), color: '#ffcc66' },
                        { label: 'EXIT ROUTE', value: 'RETURN TO PREVIOUS SPACE', color: '#00ccff' },
                        ...(!inArena ? [{ label: 'WAVE', value: String(battlegroundHud?.currentWave || 0), color: '#ffffff' }, { label: 'ENEMIES', value: String(battlegroundHud?.enemiesRemaining ?? 0), color: '#ffffff' }] : [])
                    ].map((info, i) =>
                        React.createElement('div', { key: i, style: { marginBottom: '8px', fontSize: '11px' } },
                            React.createElement('span', { style: { color: '#888' } }, `${info.label}: `),
                            React.createElement('span', { style: { color: info.color, fontWeight: 'bold' } }, info.value)
                        )
                    )
                )
            ),

            React.createElement('div', {
                style: {
                    marginTop: '18px',
                    padding: '12px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,90,90,0.16)',
                    borderRadius: '4px',
                    color: '#b7c1c8',
                    fontSize: '11px',
                    lineHeight: '1.6'
                }
            }, inArena ? 'Arena instances use your current ship and fittings. Use the control below to leave the combat instance and return to your previous non-arena system position.' : 'Battleground instances use your current ship and fittings. Wave spawns are server-sequenced and arrive through jump-in points. Use the control below to leave the combat instance and return to your previous non-battleground system position.'),

            inArena && React.createElement('button', {
                onClick: onLeaveArena,
                style: {
                    marginTop: '18px',
                    width: '100%',
                    background: 'linear-gradient(180deg, rgba(255,90,90,0.24), rgba(120,20,20,0.24))',
                    border: '1px solid rgba(255,110,110,0.45)',
                    color: '#fff',
                    padding: '14px',
                    fontSize: '13px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    letterSpacing: '2px',
                    borderRadius: '4px',
                    transition: 'all 0.2s'
                },
                onMouseEnter: (e) => { e.currentTarget.style.background = 'linear-gradient(180deg, rgba(255,110,110,0.35), rgba(150,30,30,0.35))'; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'linear-gradient(180deg, rgba(255,90,90,0.24), rgba(120,20,20,0.24))'; }
            }, 'LEAVE ARENA'),

            React.createElement('div', {
                style: {
                    marginTop: inArena ? '24px' : '18px',
                    fontSize: '9px',
                    color: '#6a4343',
                    textAlign: 'center',
                    fontStyle: 'italic',
                    borderTop: '1px solid rgba(255,90,90,0.14)',
                    paddingTop: '10px'
                }
            }, inArena ? 'COMBAT INSTANCE CONTROL // EXIT AUTHORIZED' : 'BATTLEGROUND EXTRACTION / FAILURE ONLY // MANUAL EXIT DISABLED')
        );
    }

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '400px',
            background: 'rgba(20, 25, 20, 0.95)',
            border: '2px solid #2a4a2a',
            borderRadius: '8px',
            boxShadow: '0 0 30px rgba(0,50,0,0.5), inset 0 0 20px rgba(0,255,0,0.05)',
            padding: '20px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 2500,
            pointerEvents: 'auto'
        }
    },
        React.createElement('div', {
            onClick: onClose,
            style: {
                position: 'absolute',
                top: '10px',
                right: '10px',
                cursor: 'pointer',
                color: '#888',
                fontSize: '18px'
            }
        }, '✕'),

        React.createElement('div', {
            style: {
                fontSize: '18px',
                fontWeight: 'bold',
                color: '#00ff00',
                marginBottom: '20px',
                borderBottom: '1px solid #2a4a2a',
                paddingBottom: '10px',
                letterSpacing: '2px'
            }
        }, 'SYSTEM INFORMATION'),

        React.createElement('div', { style: { display: 'flex', gap: '20px', alignItems: 'center' } },
            React.createElement('div', {
                style: {
                    width: '100px',
                    height: '100px',
                    background: 'radial-gradient(circle, #1a2a1a 0%, #0a0f0a 100%)',
                    borderRadius: '50%',
                    border: '2px solid #00ff00',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '40px',
                    boxShadow: '0 0 15px rgba(0,255,0,0.2)'
                }
            }, '🛡️'),

            React.createElement('div', { style: { flex: 1 } },
                React.createElement('div', { style: { fontSize: '20px', fontWeight: 'bold', color: '#00ff00', marginBottom: '10px' } }, currentSystem?.name?.toUpperCase() || 'UNKNOWN'),
                [
                    { label: 'REGION', value: 'INNER RIM', color: '#aaa' },
                    { label: 'SECTOR', value: 'CLUSTER ALPHA', color: '#aaa' },
                    { label: 'SECURITY', value: `${secInfo.label.toUpperCase()} (${(currentSystem.securityValue || 0).toFixed(1)})`, color: secInfo.color },
                    { label: 'JURISDICTION', value: 'OMNI DIRECTORATE CONTROL', color: '#00ccff' }
                ].map((info, i) =>
                    React.createElement('div', { key: i, style: { marginBottom: '8px', fontSize: '11px' } },
                        React.createElement('span', { style: { color: '#888' } }, `${info.label}: `),
                        React.createElement('span', { style: { color: info.color, fontWeight: 'bold' } }, info.value)
                    )
                )
            )
        ),

        React.createElement('div', {
            style: {
                marginTop: '24px',
                fontSize: '9px',
                color: '#3a5a3a',
                textAlign: 'center',
                fontStyle: 'italic',
                borderTop: '1px solid #2a4a2a',
                paddingTop: '10px'
            }
        }, 'POLICE PATROLS ACTIVE // NO WEAPONS DISCHARGE PERMITTED')
    );
};

const CargoMenu = ({ gameState, onClose }) => {
    const [selectedItem, setSelectedItem] = useState(null);
    const [filter, setFilter] = useState('everything'); // everything, blueprint, module, resource, bio-material
    const cargoItems = gameState.inventory || [];

    const filteredItems = cargoItems.filter(item => {
        if (filter === 'everything') return true;
        if (filter === 'module') {
            return item.type === 'module' || item.type === 'weapon' || item.type === 'shield' || item.type === 'thruster' || item.type === 'mining';
        }
        if (filter === 'bio-material') {
            return item.type === 'bio-material';
        }
        return item.type === filter;
    });

    const filteredWeight = filteredItems.reduce((sum, item) => sum + (item.weight || 0), 0);
    const capacityPercent = (gameState.currentCargoWeight / gameState.cargoHold) * 100;

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '800px', // Increased from 700px to accommodate wider tabs
            background: 'rgba(20, 22, 25, 0.95)',
            border: '2px solid #444',
            borderRadius: '8px',
            boxShadow: '0 0 30px rgba(0,0,0,0.8), inset 0 0 20px rgba(255,255,255,0.02)',
            padding: '20px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 2500,
            pointerEvents: 'auto',
            display: 'flex',
            gap: '20px',
            transition: 'all 0.3s ease'
        }
    },
        // Main Manifest Column
        React.createElement('div', { style: { flex: 1, minWidth: '480px', display: 'flex', flexDirection: 'column' } },
            // Close Button
            React.createElement('div', {
                onClick: onClose,
                style: {
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    cursor: 'pointer',
                    color: '#888',
                    fontSize: '18px'
                }
            }, '✕'),

            // Title
            React.createElement('div', {
                style: {
                    fontSize: '18px',
                    fontWeight: 'bold',
                    color: '#00ccff',
                    marginBottom: '15px',
                    borderBottom: '1px solid #444',
                    paddingBottom: '10px',
                    letterSpacing: '2px'
                }
            }, 'CARGO MANIFEST'),

            // Filter Tabs
            React.createElement('div', {
                style: {
                    display: 'flex',
                    gap: '6px',
                    marginBottom: '18px'
                }
            },
                ['everything', 'blueprint', 'module', 'resource', 'catalyst', 'bio-material'].map(type => (
                    React.createElement('button', {
                        key: type,
                        onClick: () => {
                            setFilter(type);
                            setSelectedItem(null);
                        },
                        style: {
                            flex: '1 0 auto',
                            minWidth: '60px',
                            background: filter === type ? '#00ccff' : 'rgba(0,0,0,0.3)',
                            border: '1px solid #555',
                            color: filter === type ? '#000' : '#fff',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            padding: '8px 6px',
                            cursor: 'pointer',
                            borderRadius: '2px',
                            textTransform: 'uppercase',
                            transition: 'all 0.2s',
                            letterSpacing: '0.5px',
                            whiteSpace: 'nowrap'
                        }
                    }, type.replace('-', ' '))
                ))
            ),

            // Capacity Bar
            React.createElement('div', { style: { marginBottom: '18px' } },
                React.createElement('div', { 
                    style: { 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        fontSize: '13px', 
                        color: '#fff',
                        marginBottom: '8px'
                    } 
                }, 
                    React.createElement('span', null, 'HOLD CAPACITY'),
                    React.createElement('div', { style: { display: 'flex', gap: '12px' } },
                        filter !== 'everything' && React.createElement('span', { style: { color: '#00ccff' } }, 
                            `FILTERED: ${Number(filteredWeight || 0).toFixed(1)} U`
                        ),
                        React.createElement('span', { style: { color: capacityPercent > 90 ? '#ff4444' : '#ffcc00' } }, 
                            `${Number(gameState.currentCargoWeight || 0).toFixed(1)} / ${Number(gameState.cargoHold || 0).toFixed(1)} UNITS`
                        )
                    )
                ),
                React.createElement('div', {
                    style: {
                        width: '100%',
                        height: '10px',
                        background: '#111',
                        borderRadius: '5px',
                        border: '1px solid #333',
                        overflow: 'hidden'
                    }
                },
                    React.createElement('div', {
                        style: {
                            width: `${capacityPercent}%`,
                            height: '100%',
                            background: 'linear-gradient(90deg, #ff9900 0%, #ffcc00 100%)',
                            boxShadow: '0 0 10px rgba(255,204,0,0.3)',
                            transition: 'width 0.3s ease'
                        }
                    })
                )
            ),

            // Items List
            React.createElement('div', {
                onWheel: (e) => e.stopPropagation(),
                style: {
                    height: '240px',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid #333',
                    borderRadius: '4px',
                    padding: '10px',
                    overflowY: 'auto',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff33 transparent',
                    paddingRight: '8px'
                }
            },
                filteredItems.length === 0 ? 
                React.createElement('div', {
                    style: {
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#555',
                        fontSize: '12px',
                        fontStyle: 'italic'
                    }
                }, `--- NO ${filter.toUpperCase()} DETECTED ---`) :
                filteredItems.map((item, i) => 
                    React.createElement('div', {
                        key: i,
                        onClick: () => setSelectedItem(item),
                        style: {
                            padding: '10px',
                            borderBottom: '1px solid #222',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: '12px',
                            cursor: 'pointer',
                            background: selectedItem === item ? 'rgba(0,204,255,0.1)' : 'transparent',
                            borderRadius: '4px',
                            transition: 'background 0.2s'
                        },
                        onMouseEnter: (e) => { if (selectedItem !== item) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; },
                        onMouseLeave: (e) => { if (selectedItem !== item) e.currentTarget.style.background = 'transparent'; }
                    },
                        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                            React.createElement('div', {
                                style: {
                                    width: '32px',
                                    height: '32px',
                                    background: '#222',
                                    border: `1px solid ${item.customColor || RARITY_COLORS[item.rarity] || '#444'}`,
                                    borderRadius: '4px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    boxShadow: `inset 0 0 5px ${item.customColor || RARITY_COLORS[item.rarity]}33`
                                }
                            }, item.type === 'resource' ? '💎' : (item.type === 'blueprint' ? '📋' : (item.type === 'bio-material' ? '🧬' : '📦'))),
                            React.createElement('div', null,
                                React.createElement('div', { style: { color: item.customColor || RARITY_COLORS[item.rarity] || '#fff', fontWeight: 'bold', fontSize: '13px' } }, item.name.toUpperCase()),
                                React.createElement('div', { style: { fontSize: '11px', color: '#fff', opacity: 0.8 } }, `${item.amount > 0 ? `[${Number(item.amount).toFixed(1)}] ` : ''}${item.type === 'resource' ? `QL: ${item.qlBand || (item.quality ? getQLBand(item.quality) : '??')} // ` : ''}${item.qualityTier ? `${item.qualityTier} // ` : ''}${Number(item.weight || 0).toFixed(1)} U`)
                            )
                        ),
                        React.createElement('div', { style: { color: item.qualityColor || '#fff', fontSize: '12px' } }, `${item.amount > 0 ? `x${Number(item.amount).toFixed(1)}` : (item.quality ? `Q${item.quality}` : `${Number(item.weight || 0).toFixed(1)} U`)}`)
                    )
                )
            ),

            // Footer
            React.createElement('div', {
                style: {
                    marginTop: '15px',
                    fontSize: '11px',
                    color: '#fff',
                    opacity: 0.5,
                    textAlign: 'center',
                    fontStyle: 'italic',
                    borderTop: '1px solid #333',
                    paddingTop: '10px'
                }
            }, 'S-CORE CARGO MANAGEMENT SYSTEM // V.8.2.1')
        ),

        // Info Panel Column (Always present)
        React.createElement('div', {
            style: {
                width: '260px', // Slightly wider for stability
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid #444',
                borderRadius: '4px',
                padding: '15px',
                display: 'flex',
                flexDirection: 'column'
            }
        },
            !selectedItem ? 
            React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: '13px', fontStyle: 'italic', textAlign: 'center' } }, 'SELECT AN ITEM TO VIEW SPECIFICATIONS') :
            React.createElement(React.Fragment, null,
                React.createElement('div', { 
                    style: { color: selectedItem.customColor || RARITY_COLORS[selectedItem.rarity], fontSize: '18px', fontWeight: 'bold', marginBottom: '10px', borderBottom: `1px solid ${selectedItem.customColor || RARITY_COLORS[selectedItem.rarity]}44`, paddingBottom: '5px' } 
                }, selectedItem.name.toUpperCase()),
                
                React.createElement('div', { style: { fontSize: '13px', color: '#888', marginBottom: '15px', lineHeight: '1.4' } }, 
                    selectedItem.description || "No tactical documentation provided by manufacturer."
                ),

                // Bio-Material Quality Stats
                (selectedItem.type === 'bio-material' && selectedItem.quality) && React.createElement('div', { style: { marginBottom: '15px', padding: '10px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', border: `1px solid ${selectedItem.qualityColor}44` } },
                    React.createElement('div', { style: { fontSize: '11px', color: '#555', marginBottom: '8px', letterSpacing: '1px' } }, 'BIO-HARVEST QUALITY:'),
                    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' } },
                        React.createElement('span', { style: { color: '#666' } }, 'VALUE'),
                        React.createElement('span', { style: { color: selectedItem.qualityColor, fontWeight: 'bold' } }, `${selectedItem.quality} / 300`)
                    ),
                    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px' } },
                        React.createElement('span', { style: { color: '#666' } }, 'TIER'),
                        React.createElement('span', { style: { color: selectedItem.qualityColor, fontWeight: 'bold' } }, selectedItem.qualityTier)
                    )
                ),

                // Stats Panel
                React.createElement(ItemSpecificationList, { item: selectedItem })
            )
        )
    );
};

const RefineryMenu = ({ gameState, onRefine }) => {
    const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
    const shipCargo = (gameState.inventory || []).filter(i => i.type === 'resource' && !i.isRefined);
    const stationCargo = currentStarportId ? (gameState.storage[currentStarportId] || []).filter(i => i.type === 'resource' && !i.isRefined) : [];

    const handleRefineClick = (item, source, filteredIndex) => {
        onRefine(item, source, filteredIndex);
    };

    const renderOreList = (items, title, source) => (
        React.createElement('div', {
            style: {
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                background: 'rgba(0, 5, 10, 0.9)',
                border: '1px solid #444',
                borderRadius: '4px',
                padding: '30px',
                overflow: 'hidden',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }
        },
            React.createElement('div', { style: { borderBottom: '1px solid #333', paddingBottom: '15px', marginBottom: '15px' } },
                React.createElement('div', { style: { color: '#00ccff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px' } }, title)
            ),
            React.createElement('div', {
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto', 
                    display: 'flex', 
                    flexDirection: 'column', 
                    gap: '12px',
                    paddingRight: '5px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff rgba(0,0,0,0.3)'
                }
            },
                items.length === 0 ? 
                React.createElement('div', { style: { color: '#fff', textAlign: 'center', marginTop: '40px', fontSize: '14px', opacity: 0.6 } }, '--- NO UNREFINED ORE DETECTED ---') :
                items.map((item, idx) => (
                    React.createElement('div', {
                        key: `${item.id}-${idx}`,
                        style: {
                            padding: '14px',
                            background: 'rgba(255,255,255,0.02)',
                            border: '1px solid #333',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            borderRadius: '2px'
                        }
                    },
                        React.createElement('div', null,
                            React.createElement('div', { style: { fontSize: '15px', fontWeight: 'bold', color: '#fff' } }, item.name.toUpperCase()),
                            React.createElement('div', { style: { fontSize: '12px', color: '#fff', opacity: 0.8, marginTop: '4px' } }, `QL BAND: ${item.qlBand || (item.quality ? getQLBand(item.quality) : '??')} // ${Number(item.amount || 0).toFixed(1)} UNITS`)
                        ),
                        React.createElement('button', {
                            onClick: () => handleRefineClick(item, source, idx),
                            style: {
                                padding: '10px 20px',
                                background: 'transparent',
                                border: '1px solid #ff9900',
                                color: '#ff9900',
                                fontSize: '12px',
                                fontWeight: 'bold',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                                letterSpacing: '1px'
                            },
                            onMouseEnter: (e) => { e.target.style.background = '#ff9900'; e.target.style.color = '#000'; },
                            onMouseLeave: (e) => { e.target.style.background = 'transparent'; e.target.style.color = '#ff9900'; }
                        }, 'REFINE')
                    )
                ))
            )
        )
    );

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '160px',
            bottom: '140px',
            left: '300px',
            right: '40px',
            display: 'flex',
            gap: '24px',
            zIndex: 30,
            pointerEvents: 'auto',
            animation: 'fadeIn 0.4s ease-out'
        }
    },
        renderOreList(shipCargo, 'CARGO MANIFEST // UNREFINED ORE', 'ship'),
        renderOreList(stationCargo, 'STATION STORAGE // UNREFINED ORE', 'station'),
        
        // Refinery Information Display
        React.createElement('div', {
            style: { 
                width: '320px', 
                background: 'rgba(0, 5, 10, 0.9)', 
                border: '1px solid #444', 
                borderRadius: '4px', 
                padding: '30px', 
                display: 'flex', 
                flexDirection: 'column',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
                boxSizing: 'border-box'
            }
        },
            React.createElement('div', { style: { color: '#fff', fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '12px', marginBottom: '24px' } }, 'REFINERY DIAGNOSTICS'),
            
            // Skill Information
            React.createElement('div', { style: { marginBottom: '28px' } },
                React.createElement('div', { style: { fontSize: '11px', color: '#00ccff', marginBottom: '12px', letterSpacing: '1px', fontWeight: 'bold' } }, 'OPERATOR PROFICIENCY:'),
                React.createElement('div', { 
                    style: { 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        fontSize: '13px', 
                        marginBottom: '6px',
                        background: 'rgba(0, 204, 255, 0.05)',
                        padding: '10px',
                        borderRadius: '2px',
                        border: '1px solid rgba(0, 204, 255, 0.2)'
                    } 
                },
                    React.createElement('span', { style: { color: '#fff', opacity: 0.8 } }, 'REFINING SKILL'),
                    React.createElement('span', { style: { color: '#fff', fontWeight: 'bold' } }, `LVL ${gameState.commanderStats?.refining || 0}`)
                )
            ),

            // Process Metrics
            React.createElement('div', { style: { marginBottom: '28px' } },
                React.createElement('div', { style: { fontSize: '11px', color: '#fff', opacity: 0.8, marginBottom: '12px', letterSpacing: '1px' } }, 'PROCESS PARAMETERS:'),
                [
                    { label: 'BASE YIELD', value: '75.0%', color: '#00ff00' },
                    { label: 'QL RETENTION', value: '100.0%', color: '#00ccff' },
                    { label: 'WASTE RATIO', value: '25.0%', color: '#ff4444' }
                ].map((stat, i) => (
                    React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '8px' } },
                        React.createElement('span', { style: { color: '#fff', opacity: 0.8 } }, stat.label),
                        React.createElement('span', { style: { color: stat.color, fontWeight: 'bold' } }, stat.value)
                    )
                ))
            ),

            // Help / Overview
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    background: 'rgba(0,0,0,0.3)', 
                    padding: '18px', 
                    paddingRight: '8px', // Match industrial scrollbar spacing
                    borderRadius: '4px', 
                    border: '1px solid #222', 
                    overflowY: 'auto',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff rgba(0,0,0,0.3)'
                } 
            },
                React.createElement('div', { style: { fontSize: '11px', color: '#fff', opacity: 0.5, marginBottom: '12px', fontWeight: 'bold' } }, 'SYSTEM OVERVIEW:'),
                React.createElement('div', { style: { fontSize: '12px', color: '#fff', opacity: 0.9, lineHeight: '1.6' } }, 
                    'Refining converts raw unrefined ore into high-grade materials required for advanced fabrication. The process involves high-intensity thermal cracking and isotopic separation.'
                ),
                React.createElement('div', { style: { fontSize: '11px', color: '#fff', opacity: 0.6, marginTop: '18px', fontStyle: 'italic' } }, 
                    'Note: All refined outputs are stored directly in the Starport Storage Bay to ensure hazardous material containment protocols.'
                )
            ),

            // Footer / Warning
            React.createElement('div', { style: { marginTop: '24px', padding: '10px', borderTop: '1px solid #333', textAlign: 'center' } },
                React.createElement('div', { style: { fontSize: '10px', color: '#ff4444', letterSpacing: '1px' } }, '⚠️ IRREVERSIBLE MOLECULAR ALTERATION')
            )
        )
    );
};

const StorageBay = ({ gameState, onTransferToStation, onTransferToShip }) => {
    const [selectedItem, setSelectedItem] = useState(null);
    const stationCapacity = 1000;
    
    const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
    
    const getWeight = (items) => items.reduce((sum, item) => sum + (parseFloat(item.weight) || 0), 0);
    
    const shipCargo = gameState.inventory || [];
    const stationCargo = currentStarportId ? (gameState.storage[currentStarportId] || []) : [];
    
    const shipWeight = getWeight(shipCargo);
    const stationWeight = getWeight(stationCargo);

    const renderCargoList = (items, title, capacity, weight, onTransfer, buttonLabel) => (
        React.createElement('div', {
            style: {
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
                background: 'rgba(0, 5, 10, 0.9)',
                border: '1px solid #444',
                borderRadius: '4px',
                padding: '30px',
                overflow: 'hidden',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }
        },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid #222', paddingBottom: '10px' } },
                React.createElement('div', { style: { color: '#00ccff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px' } }, title),
                React.createElement('div', { style: { color: weight > capacity ? '#ff4444' : '#888', fontSize: '11px' } }, `${Number(weight || 0).toFixed(1)} / ${Number(capacity || 0).toFixed(1)} units`)
            ),
            React.createElement('div', {
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto', 
                    display: 'flex', 
                    flexDirection: 'column', 
                    gap: '8px', 
                    paddingRight: '5px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff rgba(0,0,0,0.3)'
                }
            },
                items.length === 0 ? 
                React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, '--- EMPTY ---') :
                items.map((item, idx) => (
                    React.createElement('div', {
                        key: `${item.id}-${idx}`,
                        onClick: () => setSelectedItem(item),
                        style: {
                            padding: '10px',
                            background: selectedItem?.id === item.id ? 'rgba(0, 204, 255, 0.1)' : 'rgba(255,255,255,0.03)',
                            border: `1px solid ${selectedItem?.id === item.id ? '#00ccff' : '#222'}`,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                        }
                    },
                        React.createElement('div', null,
                            React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold', color: RARITY_COLORS[item.rarity] || '#fff' } }, String(item?.name || item?.item_type || item?.type || item?.id || 'UNKNOWN ITEM').toUpperCase()),
                            React.createElement('div', { style: { fontSize: '11px', color: '#888' } }, 
                                (item.type === 'resource' || item.type === 'blueprint' || item.type === 'catalyst' || item.type === 'bio-material')
                                    ? `${item.amount > 0 ? `[${Number(item.amount).toFixed(1)}] ` : ''}${item.type === 'resource' ? `QL: ${item.qlBand || (item.quality ? getQLBand(item.quality) : '??')} // ` : ''}${item.qualityTier ? `${item.qualityTier} // ` : ''}${Number(item.weight || 0).toFixed(1)} units`
                                    : `${Number(item.weight || 0).toFixed(1)} units`
                            )
                        ),
                        React.createElement('button', {
                            onClick: (e) => { e.stopPropagation(); onTransfer(item); },
                            style: {
                                padding: '6px 12px',
                                background: 'transparent',
                                border: '1px solid #00ccff',
                                color: '#00ccff',
                                fontSize: '9px',
                                fontWeight: 'bold',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            },
                            onMouseEnter: (e) => { e.target.style.background = '#00ccff'; e.target.style.color = '#000'; },
                            onMouseLeave: (e) => { e.target.style.background = 'transparent'; e.target.style.color = '#00ccff'; }
                        }, (item.type === 'ship' || item.isShip) ? 'ACTIVATE' : buttonLabel)
                    )
                ))
            )
        )
    );

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '160px',
            bottom: '140px',
            left: '300px',
            right: '40px',
            display: 'flex',
            gap: '24px',
            zIndex: 30,
            pointerEvents: 'auto',
            animation: 'fadeIn 0.4s ease-out'
        }
    },
        renderCargoList(shipCargo, 'ACTIVE SHIP CARGO', gameState.cargoHold, shipWeight, onTransferToStation, 'DEPOSIT'),
        renderCargoList(stationCargo, 'STARPORT STORAGE BAY', stationCapacity, stationWeight, onTransferToShip, 'WITHDRAW'),
        
        // Inspector Panel
        React.createElement('div', {
            style: { 
                width: '320px', 
                background: 'rgba(0, 5, 10, 0.9)', 
                border: '1px solid #444', 
                borderRadius: '4px', 
                padding: '30px', 
                display: 'flex', 
                flexDirection: 'column',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
                boxSizing: 'border-box'
            }
        },
            React.createElement('div', { style: { color: '#fff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '10px', marginBottom: '20px' } }, 'ITEM INSPECTOR'),
            
            selectedItem ? React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff rgba(0,0,0,0.3)',
                    paddingRight: '12px' // Add clearance for scrollbar
                } 
            },
                React.createElement('div', { style: { marginBottom: '20px', padding: '10px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', borderLeft: `4px solid ${RARITY_COLORS[selectedItem.rarity] || '#fff'}` } },
                    React.createElement('div', { style: { fontSize: '13px', fontWeight: 'bold', color: '#fff' } }, String(selectedItem?.name || selectedItem?.item_type || selectedItem?.type || selectedItem?.id || 'UNKNOWN ITEM').toUpperCase()),
                    React.createElement('div', { style: { fontSize: '11px', color: RARITY_COLORS[selectedItem.rarity] || '#aaa', marginTop: '2px' } }, (selectedItem.rarity || 'common').toUpperCase()),
                    React.createElement('div', { style: { fontSize: '12px', color: '#888', marginTop: '10px', lineHeight: '1.4' } }, selectedItem.description || 'No description available.')
                ),

                // Bio-Material Quality Stats
                (selectedItem.type === 'bio-material' && selectedItem.quality) && React.createElement('div', { style: { marginBottom: '20px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: `1px solid ${selectedItem.qualityColor}44` } },
                    React.createElement('div', { style: { fontSize: '9px', color: '#555', marginBottom: '10px', letterSpacing: '1px' } }, 'BIO-HARVEST QUALITY:'),
                    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '6px' } },
                        React.createElement('span', { style: { color: '#888' } }, 'VALUE'),
                        React.createElement('span', { style: { color: selectedItem.qualityColor, fontWeight: 'bold' } }, `${selectedItem.quality} / 300`)
                    ),
                    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
                        React.createElement('span', { style: { color: '#888' } }, 'TIER'),
                        React.createElement('span', { style: { color: selectedItem.qualityColor, fontWeight: 'bold' } }, selectedItem.qualityTier)
                    )
                ),

                // Stats Panel
                React.createElement(ItemSpecificationList, { item: selectedItem })
            ) : React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', opacity: 0.4, fontSize: '14px', fontStyle: 'italic', textAlign: 'center' } }, 
                'SELECT AN ITEM TO VIEW DIAGNOSTICS'
            )
        )
    );
};

const FabricationBay = ({ gameState, onFabricate }) => {
    const [selectedBlueprint, setSelectedBlueprint] = useState(null);
    const [selectedIngredients, setSelectedIngredients] = useState({}); // reqIndex -> [{item, amount, source}]
    const [activeSelectionReq, setActiveSelectionReq] = useState(null); // index of requirement being edited
    const [isFabricating, setIsFabricating] = useState(false);
    const [fabricationProgress, setFabricationProgress] = useState(0);

    const starportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];

    // Memoized storage resolution
    const storage = useMemo(() => {
        return starportId ? (gameState.storage?.[starportId] || []) : [];
    }, [gameState.storage, starportId]);

    // Memoized authoritative blueprint list
    const availableBlueprints = useMemo(() => {
        const allItems = [...(gameState.inventory || []), ...storage];
        const blueprintItems = allItems.filter(i => {
            // Robust detection: Explicit type or ID-based prefix/registry check
            const isExplicit = i.type === 'blueprint';
            const idToTest = i.blueprintId || i.item_id || i.id;
            const hasPrefix = String(idToTest).startsWith('blueprint-') || String(idToTest).startsWith('bp-') || String(idToTest).startsWith('bp_');
            const inRegistry = !!BLUEPRINT_REGISTRY[idToTest] || !!Object.values(BLUEPRINT_REGISTRY).find(b => b.id === idToTest);
            return isExplicit || hasPrefix || inRegistry;
        });

        return blueprintItems.map(item => {
            const idToTest = item.blueprintId || item.item_id || item.id;
            // Primary lookup: Registry key
            let definition = BLUEPRINT_REGISTRY[idToTest];
            // Secondary lookup: Registry 'id' property
            if (!definition) definition = Object.values(BLUEPRINT_REGISTRY).find(b => b.id === idToTest);
            // Tertiary lookup: Fuzzy name match (last resort)
            if (!definition && item.name) {
                const searchName = item.name.toLowerCase().replace(' blueprint', '');
                definition = Object.values(BLUEPRINT_REGISTRY).find(b => b.name.toLowerCase().includes(searchName));
            }

            return { ...definition, ...item, type: 'blueprint' }; // Enforce type for downstream logic
        }).filter(bp => bp && bp.requirements);
    }, [gameState.inventory, storage]);

    useEffect(() => {
        console.log('[DEBUG] Fabrication storage:', storage);
        console.log('[DEBUG] Available blueprints:', availableBlueprints);
    }, [storage, availableBlueprints]);

    const handleSelectBlueprint = (bp) => {
        setSelectedBlueprint(bp);
        setSelectedIngredients({});
        setActiveSelectionReq(null);
    };

    const bpData = selectedBlueprint; // Merged blueprint already contains definition data

    const calculateFulfillment = (resourceName) => {
        const shipMatch = (gameState.inventory || []).filter(i => 
            i.isRefined && (i.name.toLowerCase().includes(resourceName.toLowerCase()))
        );
        const stationMatch = storage.filter(i => 
            i.isRefined && (i.name.toLowerCase().includes(resourceName.toLowerCase()))
        );
        
        const shipTotal = shipMatch.reduce((sum, i) => sum + i.amount, 0);
        const stationTotal = stationMatch.reduce((sum, i) => sum + i.amount, 0);
        
        return { shipTotal, stationTotal, shipMatch, stationMatch };
    };

    const parseQL = (item) => {
        if (typeof item.qlBand === 'number') return item.qlBand;
        if (typeof item.qlBand === 'string' && item.qlBand.includes('-')) {
            const parts = item.qlBand.split('-').map(p => parseInt(p.trim()));
            return Math.floor((parts[0] + parts[1]) / 2);
        }
        return parseInt(item.qlBand) || 0;
    };

    const canFabricate = bpData && bpData.requirements.every((req, idx) => {
        const selectedForReq = selectedIngredients[idx] || [];
        const totalSelected = selectedForReq.reduce((sum, s) => sum + s.amount, 0);
        return totalSelected >= req.amount;
    });

    const handleFabricateClick = async () => {
        if (!canFabricate || isFabricating) return;

        let totalQLWeighted = 0;
        let totalAmount = 0;
        const resourcesToConsume = [];

        Object.values(selectedIngredients).forEach(ingredients => {
            ingredients.forEach(({ item, amount, source }) => {
                const itemQL = parseQL(item);
                totalQLWeighted += itemQL * amount;
                totalAmount += amount;
                resourcesToConsume.push({ item, amount, source });
            });
        });

        const avgQL = totalAmount > 0 ? totalQLWeighted / totalAmount : 0;
        setIsFabricating(true);
        try {
            const result = await onFabricate(bpData, resourcesToConsume, avgQL, selectedBlueprint);
            if (result?.ok) {
                setSelectedBlueprint(null);
                setSelectedIngredients({});
                setActiveSelectionReq(null);
            }
        } finally {
            setIsFabricating(false);
        }
    };

    const handleToggleIngredient = (reqIdx, item, source, requiredAmount) => {
        const current = [...(selectedIngredients[reqIdx] || [])];
        const existingIdx = current.findIndex(s => s.item.id === item.id);

        if (existingIdx > -1) {
            current.splice(existingIdx, 1);
        } else {
            // How much do we still need?
            const alreadySelected = current.reduce((sum, s) => sum + s.amount, 0);
            const needed = Math.max(0, requiredAmount - alreadySelected);
            if (needed <= 0) return; // Already full

            const amountToTake = Math.min(item.amount, needed);
            current.push({ item, amount: amountToTake, source });
        }

        setSelectedIngredients({
            ...selectedIngredients,
            [reqIdx]: current
        });
    };

    const renderRequirement = (req, idx) => {
        const { shipTotal, stationTotal } = calculateFulfillment(req.resource);
        const totalAvailable = shipTotal + stationTotal;
        const selected = selectedIngredients[idx] || [];
        const totalSelected = selected.reduce((sum, s) => sum + s.amount, 0);
        const isMet = totalSelected >= req.amount;

        return React.createElement('div', {
            key: idx,
            style: {
                padding: '12px',
                background: activeSelectionReq === idx ? 'rgba(0, 204, 255, 0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isMet ? '#00ff0044' : (activeSelectionReq === idx ? '#00ccff' : '#444')}`,
                borderRadius: '4px',
                marginBottom: '8px',
                display: 'flex',
                flexDirection: 'column',
                cursor: 'pointer'
            },
            onClick: () => setActiveSelectionReq(activeSelectionReq === idx ? null : idx)
        },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                React.createElement('div', null,
                    React.createElement('div', { style: { color: isMet ? '#00ff00' : '#fff', fontSize: '12px', fontWeight: 'bold' } }, req.resource.toUpperCase()),
                    React.createElement('div', { style: { fontSize: '10px', color: '#888' } }, `REQUIRED: ${req.amount} // SELECTED: ${totalSelected}`)
                ),
                React.createElement('div', { style: { textAlign: 'right', fontSize: '10px', color: isMet ? '#00ff00' : '#ffcc00' } }, 
                    isMet ? 'READY' : (totalAvailable >= req.amount ? 'SELECT STACKS' : 'INSUFFICIENT')
                )
            ),
            
            activeSelectionReq === idx && React.createElement('div', {
                style: { marginTop: '10px', borderTop: '1px solid #222', paddingTop: '10px' },
                onClick: (e) => e.stopPropagation()
            },
                React.createElement('div', { style: { fontSize: '9px', color: '#666', marginBottom: '8px' } }, 'AVAILABLE REFINED STACKS (CLICK TO TOGGLE)'),
                (() => {
                    const { shipMatch, stationMatch } = calculateFulfillment(req.resource);
                    const allMatches = [
                        ...shipMatch.map(m => ({ ...m, source: 'ship' })),
                        ...stationMatch.map(m => ({ ...m, source: 'station' }))
                    ];

                    return allMatches.map((match, midx) => {
                        const isSelected = selected.some(s => s.item.id === match.id);
                        return React.createElement('div', {
                            key: midx,
                            onClick: () => handleToggleIngredient(idx, match, match.source, req.amount),
                            style: {
                                padding: '6px',
                                background: isSelected ? 'rgba(0, 255, 0, 0.1)' : 'rgba(0,0,0,0.3)',
                                border: `1px solid ${isSelected ? '#00ff00' : '#333'}`,
                                borderRadius: '2px',
                                marginBottom: '4px',
                                fontSize: '10px',
                                display: 'flex',
                                justifyContent: 'space-between'
                            }
                        },
                            React.createElement('span', { style: { color: isSelected ? '#00ff00' : '#aaa' } }, 
                                `${match.source.toUpperCase()} // QL ${parseQL(match)} // ${match.amount} units`
                            ),
                            isSelected && React.createElement('span', { style: { color: '#00ff00', fontWeight: 'bold' } }, 'SELECTED')
                        );
                    });
                })()
            )
        );
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '160px',
            bottom: '140px',
            left: '300px',
            right: '40px',
            display: 'flex',
            gap: '24px',
            zIndex: 30,
            pointerEvents: 'auto',
            animation: 'fadeIn 0.4s ease-out'
        }
    },
        // Left: Blueprint Selection
        React.createElement('div', {
            style: { 
                flex: 0.8, 
                background: 'rgba(0, 5, 10, 0.9)', 
                border: '1px solid #444', 
                borderRadius: '4px', 
                padding: '30px', 
                display: 'flex', 
                flexDirection: 'column',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }
        },
            React.createElement('div', { style: { color: '#00ccff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #333', paddingBottom: '15px', marginBottom: '15px' } }, 'BLUEPRINT TERMINAL'),
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto',
                    paddingRight: '5px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff rgba(0,0,0,0.3)'
                } 
            },
                availableBlueprints.length === 0 ? 
                React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, '--- NO BLUEPRINTS DETECTED ---') :
                availableBlueprints.map((bp, idx) => (
                    React.createElement('div', {
                        key: idx,
                        onClick: () => handleSelectBlueprint(bp),
                        style: {
                            padding: '12px',
                            background: selectedBlueprint === bp ? 'rgba(0, 204, 255, 0.1)' : 'rgba(255,255,255,0.03)',
                            border: `1px solid ${selectedBlueprint === bp ? (RARITY_COLORS[bp.rarity] || '#00ccff') : '#222'}`,
                            borderRadius: '4px',
                            marginBottom: '8px',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                        }
                    },
                        React.createElement('div', { style: { color: RARITY_COLORS[bp.rarity] || '#fff', fontWeight: 'bold', fontSize: '12px' } }, bp.name.toUpperCase()),
                        React.createElement('div', { style: { color: '#888', fontSize: '10px' } }, `ID: ${bp.blueprintId} // ${bp.rarity.toUpperCase()}`)
                    )
                ))
            )
        ),

        // Right: Requirement Fulfillment & Execution
        React.createElement('div', {
            style: { 
                flex: 1.2, 
                background: 'rgba(0, 5, 10, 0.9)', 
                border: '1px solid #444', 
                borderRadius: '4px', 
                padding: '30px', 
                display: 'flex', 
                flexDirection: 'column',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }
        },
            !selectedBlueprint ? 
            React.createElement('div', { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: '14px', fontStyle: 'italic', letterSpacing: '1px' } }, 'SELECT A BLUEPRINT TO INITIALIZE FABRICATION') :
            React.createElement(React.Fragment, null,
                React.createElement('div', { style: { borderBottom: '1px solid #333', paddingBottom: '15px', marginBottom: '15px' } },
                    React.createElement('div', { style: { color: RARITY_COLORS[selectedBlueprint.rarity] || '#ffcc00', fontSize: '16px', fontWeight: 'bold' } }, bpData.name.toUpperCase()),
                    React.createElement('div', { style: { color: '#888', fontSize: '10px', marginTop: '4px' } }, `FABRICATING: ${bpData.outputType.toUpperCase()} // ${bpData.outputId.toUpperCase()}`)
                ),
                
                React.createElement('div', { 
                    onWheel: (e) => e.stopPropagation(),
                    style: { 
                        flex: 1, 
                        overflowY: 'auto', 
                        marginBottom: '20px',
                        paddingRight: '5px',
                        scrollbarWidth: 'thin',
                        scrollbarColor: '#ffcc00 rgba(0,0,0,0.3)'
                    } 
                },
                    bpData.requirements.map((req, idx) => renderRequirement(req, idx))
                ),

                React.createElement('div', { style: { background: 'rgba(0,0,0,0.4)', padding: '15px', borderRadius: '4px', border: '1px solid #333' } },
                    (() => {
                        // Calculate potential average QL based on current selection
                        let totalQLWeighted = 0;
                        let totalAmount = 0;
                        Object.values(selectedIngredients).forEach(ingredients => {
                            ingredients.forEach(({ item, amount }) => {
                                totalQLWeighted += parseQL(item) * amount;
                                totalAmount += amount;
                            });
                        });
                        const currentAvgQL = totalAmount > 0 ? (totalQLWeighted / totalAmount).toFixed(1) : '0.0';

                        return React.createElement(React.Fragment, null,
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '8px' } },
                                React.createElement('span', { style: { color: '#888' } }, 'PROJECTED BATCH QUALITY'),
                                React.createElement('span', { style: { color: '#fff', fontWeight: 'bold' } }, `QL ${currentAvgQL}`)
                            ),
                            React.createElement('button', {
                                onClick: handleFabricateClick,
                                disabled: !canFabricate,
                                style: {
                                    width: '100%',
                                    padding: '15px',
                                    background: canFabricate ? '#00ccff' : '#222',
                                    border: 'none',
                                    color: canFabricate ? '#000' : '#444',
                                    fontSize: '14px',
                                    fontWeight: 'bold',
                                    letterSpacing: '2px',
                                    cursor: canFabricate ? 'pointer' : 'default',
                                    transition: 'all 0.2s'
                                }
                            }, 'INITIATE FABRICATION')
                        );
                    })()
                )
            )
        )
    );
};

const OptimizationHangar = ({ gameState, onOptimize }) => {
    const [selectedModule, setSelectedModule] = useState(null);
    const [selectedCatalyst, setSelectedCatalyst] = useState(null);

    // Filter inventory/storage for modules and catalysts
    const starportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
    const stationStorage = starportId ? (gameState.storage[starportId] || []) : [];
    const allItems = [...(gameState.inventory || []), ...stationStorage];
    
    // Modules: weapons, shields, thrusters, etc. (basically anything with a rarity and stats)
    const modules = allItems.filter(i => 
        ['weapon', 'shield', 'thruster', 'mining', 'passive', 'active', 'rig'].includes(i.type)
    );

    // Catalysts: items of type 'catalyst'
    const catalysts = allItems.filter(i => i.type === 'catalyst');

    const handleOptimizeClick = () => {
        if (selectedModule && selectedCatalyst) {
            onOptimize(selectedModule, selectedCatalyst);
            setSelectedModule(null);
            setSelectedCatalyst(null);
        }
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '160px',
            bottom: '140px',
            left: '300px',
            right: '40px',
            display: 'flex',
            gap: '24px',
            zIndex: 30,
            pointerEvents: 'auto',
            animation: 'fadeIn 0.4s ease-out'
        }
    },
        // Left: Module Selection
        React.createElement('div', {
            style: { flex: 1, background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }
        },
            React.createElement('div', { style: { color: '#00ccff', fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '12px', marginBottom: '20px' } }, 'SELECT MODULE FOR CALIBRATION'),
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto', 
                    paddingRight: '5px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#00ccff rgba(0,0,0,0.3)'
                } 
            },
                modules.length === 0 ? 
                React.createElement('div', { style: { color: '#fff', opacity: 0.4, textAlign: 'center', marginTop: '40px', fontSize: '14px' } }, '--- NO VALID MODULES DETECTED ---') :
                modules.map((mod, idx) => (
                    React.createElement('div', {
                        key: idx,
                        onClick: () => setSelectedModule(mod),
                        style: {
                            padding: '14px',
                            background: selectedModule === mod ? 'rgba(0, 204, 255, 0.1)' : 'rgba(255,255,255,0.03)',
                            border: `1px solid ${selectedModule === mod ? (RARITY_COLORS[mod.rarity] || '#00ccff') : '#333'}`,
                            borderRadius: '4px',
                            marginBottom: '8px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            position: 'relative'
                        }
                    },
                        React.createElement('div', { style: { color: RARITY_COLORS[mod.rarity] || '#fff', fontWeight: 'bold', fontSize: '14px' } }, mod.name.toUpperCase()),
                        React.createElement('div', { style: { color: '#fff', opacity: 0.6, fontSize: '11px', marginTop: '4px' } }, 
                            `${mod.type.toUpperCase()} // ${mod.rarity.toUpperCase()} GRADE // QL ${mod.avgQL?.toFixed(0) || '??'}`
                        ),
                        selectedModule === mod && React.createElement('div', {
                            style: { position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#00ccff', fontSize: '12px', fontWeight: 'bold' }
                        }, 'SELECTED')
                    )
                ))
            )
        ),

        // Middle: Catalyst Selection
        React.createElement('div', {
            style: { flex: 1, background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }
        },
            React.createElement('div', { style: { color: '#ffcc00', fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '12px', marginBottom: '20px' } }, 'SELECT FLUX CATALYST'),
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto', 
                    paddingRight: '5px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#ffcc00 rgba(0,0,0,0.3)'
                } 
            },
                catalysts.length === 0 ? 
                React.createElement('div', { style: { color: '#fff', opacity: 0.4, textAlign: 'center', marginTop: '40px', fontSize: '14px' } }, '--- NO CATALYSTS IN STORAGE ---') :
                catalysts.map((cat, idx) => (
                    React.createElement('div', {
                        key: idx,
                        onClick: () => setSelectedCatalyst(cat),
                        style: {
                            padding: '14px',
                            background: selectedCatalyst === cat ? 'rgba(255, 204, 0, 0.1)' : 'rgba(255,255,255,0.03)',
                            border: `1px solid ${selectedCatalyst === cat ? (RARITY_COLORS[cat.rarity] || '#ffcc00') : '#333'}`,
                            borderRadius: '4px',
                            marginBottom: '10px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            position: 'relative'
                        }
                    },
                        React.createElement('div', { style: { color: RARITY_COLORS[cat.rarity] || '#fff', fontWeight: 'bold', fontSize: '15px' } }, cat.name.toUpperCase()),
                        React.createElement('div', { style: { color: '#fff', opacity: 0.8, fontSize: '12px', marginTop: '6px', fontStyle: 'italic', lineHeight: '1.4' } }, cat.description),
                        React.createElement('div', { style: { color: '#fff', opacity: 0.6, fontSize: '12px', marginTop: '8px' } }, `QUANTITY: ${cat.amount || 1} // ${cat.rarity.toUpperCase()}`),
                        selectedCatalyst === cat && React.createElement('div', {
                            style: { position: 'absolute', right: '12px', top: '14px', color: '#ffcc00', fontSize: '12px', fontWeight: 'bold' }
                        }, 'READY')
                    )
                ))
            )
        ),

        // Right: Summary & Action
        React.createElement('div', {
            style: { width: '320px', background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }
        },
            React.createElement('div', { style: { color: '#fff', fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '12px', marginBottom: '20px' } }, 'OPTIMIZATION SUMMARY'),
            
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { 
                    flex: 1, 
                    overflowY: 'auto', 
                    paddingRight: '5px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#ffcc00 rgba(0,0,0,0.3)'
                } 
            },
                selectedModule && React.createElement('div', { style: { marginBottom: '24px', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', borderLeft: `4px solid ${RARITY_COLORS[selectedModule.rarity]}` } },
                    React.createElement('div', { style: { fontSize: '13px', color: '#fff', opacity: 0.6, marginBottom: '6px' } }, 'TARGET MODULE:'),
                    React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', color: '#fff' } }, selectedModule.name.toUpperCase()),
                    React.createElement('div', { style: { fontSize: '13px', color: RARITY_COLORS[selectedModule.rarity], marginTop: '4px', marginBottom: '10px' } }, selectedModule.rarity.toUpperCase()),
                    
                    React.createElement(ItemSpecificationList, { item: selectedModule })
                ),

                (!selectedModule || !selectedCatalyst) && React.createElement('div', { style: { color: '#fff', opacity: 0.4, fontSize: '14px', fontStyle: 'italic', textAlign: 'center', marginTop: '40px' } }, 
                    'AWAITING INPUT PARAMETERS...'
                )
            ),

            React.createElement('button', {
                onClick: handleOptimizeClick,
                disabled: !selectedModule || !selectedCatalyst,
                style: {
                    width: '100%',
                    padding: '18px',
                    background: (selectedModule && selectedCatalyst) ? '#00ccff' : '#222',
                    border: 'none',
                    color: (selectedModule && selectedCatalyst) ? '#000' : '#444',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    letterSpacing: '2px',
                    cursor: (selectedModule && selectedCatalyst) ? 'pointer' : 'default',
                    transition: 'all 0.2s',
                    borderRadius: '2px'
                }
            }, 'START OPTIMIZATION')
        )
    );
};

const getCommanderStats = (gameState) => {
    const baseStats = {
        neuralStability: gameState.level || 1,
        bioTolerance: gameState.level || 1,
        motorIntegration: gameState.level || 1
    };
    
    // Add bonuses from equipped implants
    if (gameState.commanderImplants) {
        Object.values(gameState.commanderImplants).forEach(implant => {
            if (implant && implant.sockets) {
                ['core', 'matrix', 'trace'].forEach(socketKey => {
                    const nano = implant.sockets[socketKey]?.installed;
                    if (nano && nano.bonus) {
                        if (nano.id === 'cognition' || nano.id === 'support_stability') {
                            baseStats.neuralStability += nano.bonus;
                        } else if (nano.id === 'vitalis' || nano.id === 'support_bio') {
                            baseStats.bioTolerance += nano.bonus;
                        } else if (nano.id === 'synaptic' || nano.id === 'support_synaptic') {
                            baseStats.motorIntegration += nano.bonus;
                        }
                    }
                });
            }
        });
    }
    
    return baseStats;
};

const BioMedicalMenu = ({ gameState, onCreateImplant }) => {
    const [selectedImplantType, setSelectedImplantType] = useState(null);
    const [ql, setQl] = useState(100);
    const [selectedNanos, setSelectedNanos] = useState({ core: null, matrix: null, trace: null });
    const [selectedModifiers, setSelectedModifiers] = useState({ core: null, matrix: null, trace: null });

    // Slider State
    const sliderTrackRef = React.useRef(null);
    const [isSliderDragging, setIsSliderDragging] = useState(false);

    // Reset nano selections when implant type changes
    useEffect(() => {
        setSelectedNanos({ core: null, matrix: null, trace: null });
        setSelectedModifiers({ core: null, matrix: null, trace: null });
    }, [selectedImplantType]);
    
    // Combine items from both inventory and station storage for viewing
    const allItems = [
        ...(gameState.inventory || []).map(i => ({ ...i, source: 'ship' })),
        ...(gameState.stationStorage || []).map(i => ({ ...i, source: 'station' }))
    ];

    const bioMaterials = allItems.filter(i => i.type === 'bio-material');
    const totalBioCount = bioMaterials.reduce((sum, item) => sum + (item.amount || 1), 0);
    
    // Calculate max possible QL based on bio materials
    // Cost formula: 25 + floor(ql/10)
    // Max QL = (totalBio - 25) * 10, capped at 300
    const maxPossibleQl = Math.max(1, Math.min(300, (totalBioCount - 25) * 10));

    // Keep QL in bounds if bio count changes
    useEffect(() => {
        if (ql > maxPossibleQl) {
            setQl(Math.max(1, maxPossibleQl));
        }
    }, [maxPossibleQl]);

    const updateQlFromPointer = (clientX) => {
        if (!sliderTrackRef.current) return;
        const rect = sliderTrackRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        const percent = x / rect.width;
        const nextQl = Math.max(1, Math.round(1 + percent * (maxPossibleQl - 1)));
        setQl(nextQl);
    };

    const handleSliderPointerDown = (e) => {
        if (e.button !== 0) return;
        setIsSliderDragging(true);
        updateQlFromPointer(e.clientX);
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const handleSliderPointerMove = (e) => {
        if (isSliderDragging) {
            updateQlFromPointer(e.clientX);
        }
    };

    const handleSliderPointerUp = (e) => {
        setIsSliderDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };
    
    const BASIC_IMPLANT_TYPES = [
        { id: 'brain', name: 'Head (Brain)', core: 'Cognition', matrix: 'Support', trace: 'Support / Cognition', stat: 'Neural Stability' },
        { id: 'eye', name: 'Eye', core: 'Cognition / Synaptic', matrix: 'Cognition', trace: 'Support', stat: 'Neural Stability' },
        { id: 'ear', name: 'Ear', core: 'Support', matrix: 'Vitalis', trace: 'Cognition', stat: 'Neural Stability' },
        { id: 'chest', name: 'Chest', core: 'Vitalis', matrix: 'Support', trace: 'Vitalis', stat: 'Bio-Tolerance' },
        { id: 'waist', name: 'Waist', core: 'Vitalis / Synaptic', matrix: 'Vitalis', trace: 'Support', stat: 'Bio-Tolerance' },
        { id: 'legs', name: 'Leg', core: 'Synaptic', matrix: 'Vitalis', trace: 'Support', stat: 'Motor Integration' },
        { id: 'feet', name: 'Feet', core: 'Synaptic', matrix: 'Support', trace: 'Vitalis / Synaptic', stat: 'Motor Integration' },
        { id: 'rightArm', name: 'Right-Arm', core: 'Support', matrix: 'Synaptic', trace: 'Support / Synaptic', stat: 'Motor Integration' },
        { id: 'leftArm', name: 'Left-Arm', core: 'Synaptic / Vitalis', matrix: 'Support', trace: 'Support / Vitalis', stat: 'Motor Integration' },
        { id: 'rightHand', name: 'Right-Hand', core: 'Support / Synaptic', matrix: 'Cognition / Support', trace: 'Support', stat: 'Motor Integration' },
        { id: 'leftHand', name: 'Left-Hand', core: 'Support / Synaptic', matrix: 'Vitalis / Cognition', trace: 'Support', stat: 'Motor Integration' }
    ];

    const NANO_OPTIONS = {
        'Cognition': { id: 'cognition', name: 'Neural Stability', group: 'standard', family: 'Cognition' },
        'Vitalis': { id: 'vitalis', name: 'Bio-Tolerance', group: 'standard', family: 'Vitalis' },
        'Synaptic': { id: 'synaptic', name: 'Motor Integration', group: 'standard', family: 'Synaptic' },
        'Support_Stability': { id: 'support_stability', name: 'Minor Stability', group: 'support', family: 'Cognition' },
        'Support_Bio': { id: 'support_bio', name: 'Minor Bio-Tolerance', group: 'support', family: 'Vitalis' },
        'Support_Synaptic': { id: 'support_synaptic', name: 'Minor Synaptic', group: 'support', family: 'Synaptic' }
    };

    const SHIP_STAT_POOLS = {
        'Cognition': [
            { id: 'cpu_capacity', label: 'CPU Capacity' },
            { id: 'tracking', label: 'Tracking' },
            { id: 'sensor_resolution', label: 'Sensor Resolution' },
            { id: 'scan_time', label: 'Scan Time' },
            { id: 'mining_efficiency', label: 'Mining Efficiency' }
        ],
        'Vitalis': [
            { id: 'shield_capacity', label: 'Shield Capacity' },
            { id: 'shield_recharge', label: 'Shield Recharge' },
            { id: 'armor_plating', label: 'Armor Plating' },
            { id: 'res_thermal', label: 'Thermal Resistance' },
            { id: 'res_kinetic', label: 'Kinetic Resistance' },
            { id: 'res_blast', label: 'Blast Resistance' },
            { id: 'reactor_recovery', label: 'Reactor Recovery' },
            { id: 'heatsink_efficiency', label: 'Heat Sink Efficiency' },
            { id: 'powergrid_capacity', label: 'Power Grid Capacity' }
        ],
        'Synaptic': [
            { id: 'max_velocity', label: 'Max Forward Velocity' },
            { id: 'angular_turn_rate', label: 'Angular Turn Rate' },
            { id: 'fire_rate', label: 'Fire Rate' },
            { id: 'accuracy', label: 'Base Accuracy' }
        ]
    };

    const getAvailableNanos = (socketRequirement, slotFamilies) => {
        const types = socketRequirement.split(' / ');
        let available = [];
        if (types.includes('Cognition')) available.push(NANO_OPTIONS.Cognition);
        if (types.includes('Vitalis')) available.push(NANO_OPTIONS.Vitalis);
        if (types.includes('Synaptic')) available.push(NANO_OPTIONS.Synaptic);
        if (types.includes('Support')) {
            // Support gives minor versions of whatever the slot’s stat families allow
            if (slotFamilies.includes('Cognition')) available.push(NANO_OPTIONS.Support_Stability);
            if (slotFamilies.includes('Vitalis')) available.push(NANO_OPTIONS.Support_Bio);
            if (slotFamilies.includes('Synaptic')) available.push(NANO_OPTIONS.Support_Synaptic);
        }
        return available;
    };

    const getSubsystemPool = (socketKey, nano, slotFamilies) => {
        if (!nano) return [];
        
        // If the nano is NOT Support, it can only roll stats from its own family
        if (nano.group !== 'support') {
            return SHIP_STAT_POOLS[nano.family] || [];
        }

        // If the nano IS Support, it can roll minor versions of everything the slot allows
        let pool = [];
        slotFamilies.forEach(family => {
            if (SHIP_STAT_POOLS[family]) {
                pool = [...pool, ...SHIP_STAT_POOLS[family]];
            }
        });
        return pool;
    };

    // Helper to get all families allowed in a slot
    const getSlotFamilies = (type) => {
        const families = new Set();
        ['core', 'matrix', 'trace'].forEach(socket => {
            const req = type[socket];
            if (req.includes('Cognition')) families.add('Cognition');
            if (req.includes('Vitalis')) families.add('Vitalis');
            if (req.includes('Synaptic')) families.add('Synaptic');
        });
        return Array.from(families);
    };

    const calculateBonus = (ql, statId, socketKey = 'core') => {
        const socketMods = { core: 1.0, matrix: 0.75, trace: 0.5 };
        const socketMultiplier = socketMods[socketKey] || 1.0;
        
        let value = 0;
        // 1. Commander stats (Cognition, Vitalis, Synaptic, Support)
        if (statId === 'base') {
            value = ql * 0.25;
        }
        // 2. Fitting stats (Powergrid, CPU)
        else if (statId === 'cpu_capacity' || statId === 'powergrid_capacity') {
            value = ql * 0.20;
        }
        // 3. Weapon subsystems (Tracking)
        else if (statId === 'tracking') {
            value = ql * 0.15;
        }
        // 4. Defensive HP subsystems (Shield HP, Hull HP)
        else if (['shield_capacity', 'hull_integrity'].includes(statId)) {
            value = ql * 0.40;
        }
        // 5. Resist subsystems (Shield Resist, Armor Resist, Hull Resist, Specific Resists)
        else if (['resistances', 'res_thermal', 'res_kinetic', 'res_blast', 'armor_plating'].includes(statId)) {
            value = ql * 0.04;
        }
        // 6. Fire‑rate / cycle‑time / recharge subsystems
        else if (['fire_rate', 'reload_speed', 'cycle_time', 'charge_time', 'shield_recharge', 'reactor_recovery'].includes(statId)) {
            value = ql * 0.05;
        }
        // 7. Time‑reduction subsystems
        else if (['signature_radius', 'scan_time', 'lock_time', 'warp_time', 'cooldown_duration'].includes(statId)) {
            value = ql * 0.05;
        }
        // Fallback for general utilities (Mining Efficiency, Accuracy etc)
        else {
            value = ql * 0.10;
        }

        const result = value * socketMultiplier;
        const intStats = ['base', 'cpu_capacity', 'powergrid_capacity', 'tracking', 'shield_capacity', 'hull_integrity'];
        
        if (intStats.includes(statId)) {
            return Math.floor(result);
        }
        return Number(result.toFixed(2));
    };

    const requiredBio = 25 + Math.floor(ql / 10);
    const allNanosSelected = selectedImplantType && selectedNanos.core && selectedNanos.matrix && selectedNanos.trace;
    const allModifiersSelected = selectedModifiers.core && selectedModifiers.matrix && selectedModifiers.trace;
    const canCreate = selectedImplantType && totalBioCount >= requiredBio && allNanosSelected && allModifiersSelected;

    const handleCreateImplant = () => {
        if (canCreate) {
            const nanoData = {
                core: { 
                    ...selectedNanos.core, 
                    bonus: calculateBonus(ql, selectedModifiers.core.statId, 'core'),
                    modifier: selectedModifiers.core
                },
                matrix: { 
                    ...selectedNanos.matrix, 
                    bonus: calculateBonus(ql, selectedModifiers.matrix.statId, 'matrix'),
                    modifier: selectedModifiers.matrix
                },
                trace: { 
                    ...selectedNanos.trace, 
                    bonus: calculateBonus(ql, selectedModifiers.trace.statId, 'trace'),
                    modifier: selectedModifiers.trace
                }
            };
            onCreateImplant(selectedImplantType, ql, requiredBio, nanoData);
        }
    };

    const calculateImplantRequirement = (ql) => Math.floor((ql * 0.28) + 3);

    // Aggregate Bonuses for UI display
    const getAggregateBonuses = () => {
        const aggregates = {};
        ['core', 'matrix', 'trace'].forEach(socketKey => {
            const mod = selectedModifiers[socketKey];
            if (mod) {
                const bonus = calculateBonus(ql, mod.statId, socketKey);
                if (!aggregates[mod.statId]) {
                    aggregates[mod.statId] = { label: mod.label, value: 0 };
                }
                aggregates[mod.statId].value += bonus;
            }
        });
        return Object.values(aggregates);
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '160px',
            bottom: '140px',
            left: '300px',
            right: '40px',
            display: 'flex',
            gap: '24px',
            zIndex: 30,
            pointerEvents: 'auto',
            animation: 'fadeIn 0.4s ease-out'
        }
    },
        // Left: Neural Implant Facility
        React.createElement('div', {
            style: { flex: 1.5, background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }
        },
            React.createElement('div', { style: { color: '#ffcc00', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #333', paddingBottom: '15px', marginBottom: '15px' } }, 'NEURAL IMPLANT FACILITY'),
            
            React.createElement('div', { style: { display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' } },
                // Implant Selection List
                React.createElement('div', { 
                    onWheel: (e) => e.stopPropagation(),
                    style: { flex: 1, overflowY: 'auto', paddingRight: '10px', scrollbarWidth: 'thin', scrollbarColor: '#ffcc00 rgba(0,0,0,0.3)' } 
                },
                    BASIC_IMPLANT_TYPES.map(type => (
                        React.createElement('div', {
                            key: type.id,
                            onClick: () => setSelectedImplantType(type),
                            style: {
                                padding: '12px',
                                background: selectedImplantType?.id === type.id ? 'rgba(255, 204, 0, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                                border: `1px solid ${selectedImplantType?.id === type.id ? '#ffcc00' : '#333'}`,
                                borderRadius: '4px',
                                marginBottom: '8px',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            }
                        },
                            React.createElement('div', { style: { color: '#fff', fontWeight: 'bold', fontSize: '13px', marginBottom: '4px' } }, type.name.toUpperCase()),
                            React.createElement('div', { style: { fontSize: '11px', color: '#888' } }, `REQ: ${type.stat}`)
                        )
                    ))
                ),

                // Implant Configuration
                React.createElement('div', { style: { flex: 1.2, borderLeft: '1px solid #333', paddingLeft: '20px', display: 'flex', flexDirection: 'column' } },
                    selectedImplantType ? React.createElement(React.Fragment, null,
                        React.createElement('div', { style: { color: '#ffcc00', fontSize: '16px', fontWeight: 'bold', marginBottom: '15px' } }, selectedImplantType.name.toUpperCase()),
                        
                        // Total Bio-Material Display (Much smaller now)
                        React.createElement('div', {
                            style: {
                                padding: '6px 10px',
                                background: 'rgba(0, 204, 255, 0.03)',
                                border: '1px solid rgba(0, 204, 255, 0.1)',
                                borderRadius: '4px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                marginBottom: '10px'
                            }
                        },
                            React.createElement('div', { style: { textAlign: 'left' } },
                                React.createElement('div', { style: { color: '#888', fontSize: '11px', fontWeight: 'bold' } }, 'TOTAL BIO-MATERIAL'),
                                React.createElement('div', { style: { color: '#555', fontSize: '10px' } }, 'READY FOR FABRICATION')
                            ),
                            React.createElement('div', { style: { color: '#00ccff', fontSize: '20px', fontWeight: 'bold' } }, totalBioCount)
                        ),

                        // Synthesis Bonus Summary (Real-Time Bonus Tracking)
                        React.createElement('div', { style: { background: 'rgba(0,0,0,0.3)', padding: '10px 12px', borderRadius: '4px', marginBottom: '10px', border: '1px solid #444', overflow: 'hidden' } },
                            React.createElement('div', { style: { fontSize: '11px', color: '#aaa', marginBottom: '8px', fontWeight: 'bold', letterSpacing: '1px' } }, 'SYNTHESIS BONUS SUMMARY'),
                            ['core', 'matrix', 'trace'].map((socketKey, i) => {
                                const mod = selectedModifiers[socketKey];
                                const bonusValue = mod ? calculateBonus(ql, mod.statId, socketKey) : 0;
                                const reductionStats = ['signature_radius', 'scan_time', 'lock_time', 'warp_time', 'cooldown_duration'];
                                const percentStats = ['resistances', 'res_thermal', 'res_kinetic', 'res_blast', 'armor_plating', 'fire_rate', 'reload_speed', 'cycle_time', 'charge_time', 'shield_recharge', 'reactor_recovery', ...reductionStats];
                                
                                let bonusDisplay = '---';
                                if (mod) {
                                    const prefix = reductionStats.includes(mod.statId) ? '-' : '+';
                                    const suffix = percentStats.includes(mod.statId) ? '%' : '';
                                    bonusDisplay = `${prefix}${bonusValue}${suffix}`;
                                }

                                return React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '2px' } },
                                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
                                        React.createElement('span', { style: { color: '#888', fontSize: '10px', fontWeight: 'bold' } }, socketKey.toUpperCase()),
                                        React.createElement('span', { style: { color: mod ? '#fff' : '#444' } }, mod ? mod.label.toUpperCase() : 'EMPTY')
                                    ),
                                    React.createElement('span', { style: { color: mod ? '#00ff00' : '#444', fontWeight: 'bold', alignSelf: 'center' } }, bonusDisplay)
                                );
                            }),
                            
                            // Aggregate Impact Section
                            (allModifiersSelected || getAggregateBonuses().length > 0) && React.createElement('div', {
                                style: { marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed #444' }
                            },
                                React.createElement('div', { style: { fontSize: '11px', color: '#ffcc00', marginBottom: '6px', fontWeight: 'bold' } }, 'TOTAL AGGREGATE IMPACT'),
                                getAggregateBonuses().map((agg, i) => {
                                    const reductionStats = ['signature_radius', 'scan_time', 'lock_time', 'warp_time', 'cooldown_duration'];
                                    const percentStats = ['resistances', 'res_thermal', 'res_kinetic', 'res_blast', 'armor_plating', 'fire_rate', 'reload_speed', 'cycle_time', 'charge_time', 'shield_recharge', 'reactor_recovery', ...reductionStats];
                                    const prefix = reductionStats.includes(agg.statId) ? '-' : '+';
                                    const suffix = percentStats.includes(agg.statId) ? '%' : '';
                                    return React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' } },
                                        React.createElement('span', { style: { color: '#aaa' } }, agg.label.toUpperCase()),
                                        React.createElement('span', { style: { color: '#00ccff', fontWeight: 'bold' } }, `${prefix}${agg.value.toFixed(2)}${suffix}`)
                                    );
                                })
                            )
                        ),

                        React.createElement('div', { style: { marginBottom: '15px' } },
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } },
                                React.createElement('span', { style: { color: '#fff', opacity: 0.6, fontSize: '13px' } }, 'PROTOCOL SYNCHRONIZER'),
                                React.createElement('span', { style: { color: '#00ff00', fontSize: '16px', fontWeight: 'bold' } }, `QL ${ql}`)
                            ),
                            React.createElement('div', {
                                ref: sliderTrackRef,
                                onPointerDown: handleSliderPointerDown,
                                onPointerMove: handleSliderPointerMove,
                                onPointerUp: handleSliderPointerUp,
                                onPointerCancel: handleSliderPointerUp,
                                style: {
                                    position: 'relative',
                                    width: '100%',
                                    height: '24px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    marginBottom: '18px',
                                    touchAction: 'none'
                                }
                            },
                                // Track Background
                                React.createElement('div', {
                                    style: {
                                        width: '100%',
                                        height: '6px',
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid #333',
                                        borderRadius: '3px'
                                    }
                                }),
                                // Active Track Fill
                                React.createElement('div', {
                                    style: {
                                        position: 'absolute',
                                        left: 0,
                                        width: `${((ql - 1) / (maxPossibleQl - 1 || 1)) * 100}%`,
                                        height: '6px',
                                        background: '#00ff00',
                                        borderRadius: '3px',
                                        boxShadow: '0 0 10px rgba(0,255,0,0.4)',
                                        pointerEvents: 'none'
                                    }
                                }),
                                // Handle
                                React.createElement('div', {
                                    style: {
                                        position: 'absolute',
                                        left: `calc(${((ql - 1) / (maxPossibleQl - 1 || 1)) * 100}% - 9px)`,
                                        width: '18px',
                                        height: '18px',
                                        background: '#00ff00',
                                        border: '2px solid #fff',
                                        borderRadius: '50%',
                                        boxShadow: isSliderDragging ? '0 0 20px #00ff00' : '0 0 10px rgba(0,255,0,0.5)',
                                        transform: isSliderDragging ? 'scale(1.2)' : 'scale(1)',
                                        transition: 'transform 0.1s',
                                        zIndex: 2,
                                        pointerEvents: 'none'
                                    }
                                })
                            ),
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px', color: '#fff', opacity: 0.6 } },
                                React.createElement('span', null, `FITTING REQ: ${calculateImplantRequirement(ql)} ${selectedImplantType.stat}`),
                                React.createElement('span', null, `COST: ${requiredBio} BIO`)
                            )
                        ),

                        React.createElement('button', {
                            onClick: handleCreateImplant,
                            disabled: !canCreate,
                            style: {
                                padding: '15px',
                                background: canCreate ? 'rgba(255, 204, 0, 0.15)' : 'rgba(255,0,0,0.05)',
                                border: `2px solid ${canCreate ? '#ffcc00' : '#441111'}`,
                                color: canCreate ? '#ffcc00' : '#441111',
                                fontSize: '14px',
                                fontWeight: 'bold',
                                cursor: canCreate ? 'pointer' : 'default',
                                letterSpacing: '2px',
                                marginTop: 'auto',
                                transition: 'all 0.2s'
                            },
                            onMouseEnter: (e) => { if (canCreate) { e.target.style.background = '#ffcc00'; e.target.style.color = '#000'; } },
                            onMouseLeave: (e) => { if (canCreate) { e.target.style.background = 'rgba(255, 204, 0, 0.15)'; e.target.style.color = '#ffcc00'; } }
                        }, canCreate ? 'FABRICATE IMPLANT' : (selectedImplantType ? (allNanosSelected ? 'INSUFFICIENT MATERIALS' : 'SELECT ALL NANOS') : 'SELECT IMPLANT TYPE'))
                    ) : React.createElement('div', { 
                        style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0.3, textAlign: 'center' } 
                    },
                        React.createElement('div', { style: { fontSize: '40px', marginBottom: '20px' } }, '🧬'),
                        React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold' } }, 'SELECT IMPLANT TYPE')
                    )
                )
            ),

            React.createElement('div', { style: { borderTop: '1px solid #222', paddingTop: '15px', marginTop: '15px', fontSize: '9px', color: '#555', fontStyle: 'italic', textAlign: 'center' } },
                'BIO-MEDICAL // OMNI DIRECTORATE HEALTH BUREAU // V.4.0.0'
            )
        ),

        // Right: Biological Synthesis (Nano Selection)
        React.createElement('div', {
            style: { width: '400px', background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }
        },
            React.createElement('div', { style: { color: '#00ccff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #333', paddingBottom: '15px', marginBottom: '20px' } }, 'BIOLOGICAL SYNTHESIS'),
            
            React.createElement('div', { 
                onWheel: (e) => e.stopPropagation(),
                style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '15px', overflowY: 'auto', paddingRight: '5px', scrollbarWidth: 'thin', scrollbarColor: '#00ccff rgba(0,0,0,0.3)' } 
            },
                // Nano Synthesis Selection
                selectedImplantType ? (
                    ['core', 'matrix', 'trace'].map(socketKey => {
                        const requirement = selectedImplantType[socketKey];
                        const available = getAvailableNanos(requirement, getSlotFamilies(selectedImplantType));
                        
                        return React.createElement('div', { key: socketKey, style: { background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '4px', border: '1px solid #222' } },
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } },
                                React.createElement('span', { style: { color: '#aaa', fontSize: '10px', fontWeight: 'bold' } }, `${socketKey.toUpperCase()} NANO`),
                                React.createElement('span', { style: { color: '#555', fontSize: '9px' } }, requirement)
                            ),
                            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                                available.map(nano => {
                                    const pool = getSubsystemPool(socketKey, nano, getSlotFamilies(selectedImplantType));
                                    
                                    // Generate a flat list of all choices for this Nano
                                    const choices = [
                                        { statId: 'base', label: nano.name, isBase: true, color: '#ffcc00' },
                                        ...pool.map(stat => ({ 
                                            statId: stat.id, 
                                            label: nano.group === 'support' ? `Minor ${stat.label}` : stat.label, 
                                            isBase: false, 
                                            color: '#00ff00' 
                                        }))
                                    ];

                                    return React.createElement('div', { key: nano.id, style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' } },
                                        choices.map(choice => {
                                            const isSelected = selectedNanos[socketKey]?.id === nano.id && selectedModifiers[socketKey]?.statId === choice.statId;
                                            const bonusValue = calculateBonus(ql, choice.statId, socketKey);
                                            const reductionStats = ['signature_radius', 'scan_time', 'lock_time', 'warp_time', 'cooldown_duration'];
                                            const percentStats = ['resistances', 'res_thermal', 'res_kinetic', 'res_blast', 'armor_plating', 'fire_rate', 'reload_speed', 'cycle_time', 'charge_time', 'shield_recharge', 'reactor_recovery', ...reductionStats];
                                            
                                            const prefix = reductionStats.includes(choice.statId) ? '-' : '+';
                                            const suffix = percentStats.includes(choice.statId) ? '%' : '';
                                            const bonusDisplay = `${prefix}${bonusValue}${suffix}`;

                                            return React.createElement('div', {
                                                key: choice.statId,
                                                onClick: () => {
                                                    setSelectedNanos(prev => ({ ...prev, [socketKey]: nano }));
                                                    setSelectedModifiers(prev => ({ ...prev, [socketKey]: choice }));
                                                },
                                                style: {
                                                    padding: '12px',
                                                    background: isSelected ? `${choice.color}22` : 'rgba(255,255,255,0.03)',
                                                    border: `1px solid ${isSelected ? choice.color : '#333'}`,
                                                    borderRadius: '4px',
                                                    fontSize: '12px',
                                                    color: isSelected ? choice.color : '#ccc',
                                                    cursor: 'pointer',
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center',
                                                    transition: 'all 0.2s',
                                                }
                                            },
                                                React.createElement('span', { style: { fontWeight: isSelected ? 'bold' : 'normal' } }, choice.label.toUpperCase()),
                                                React.createElement('span', { style: { color: choice.color, fontWeight: 'bold', fontSize: '13px' } }, bonusDisplay)
                                            );
                                        })
                                    );
                                })
                            )
                        );
                    })
                ) : (
                    React.createElement('div', { 
                        style: { 
                            flex: 1, 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: 'center', 
                            justifyContent: 'center', 
                            opacity: 0.2, 
                            textAlign: 'center',
                            border: '1px dashed #333',
                            borderRadius: '4px',
                            padding: '20px'
                        } 
                    },
                        React.createElement('div', { style: { fontSize: '32px', marginBottom: '10px' } }, '💊'),
                        React.createElement('div', { style: { fontSize: '13px', fontWeight: 'bold', color: '#fff' } }, 'NANO SYNTHESIS HUB'),
                        React.createElement('div', { style: { fontSize: '11px', color: '#aaa', marginTop: '5px' } }, 'SELECT AN IMPLANT TO BEGIN NANO-SYNTHESIS')
                    )
                )
            ),

            React.createElement('div', { style: { marginTop: '15px', padding: '12px', background: 'rgba(0, 204, 255, 0.05)', borderRadius: '4px', fontSize: '12px', color: '#888', border: '1px solid rgba(0, 204, 255, 0.1)', lineHeight: '1.4' } },
                'Nano-fabrication protocols active. Select Nanos for all sockets to complete the synthesis sequence.'
            )
        )
    );
};

const MarketHistoryChart = ({ data, color = '#00ccff' }) => {
    if (!data || data.length === 0) return null;

    const width = 240;
    const height = 80;
    const padding = 10;
    
    const prices = data.map(d => d.price);
    const minPrice = Math.min(...prices) * 0.9;
    const maxPrice = Math.max(...prices) * 1.1;
    const priceRange = maxPrice - minPrice || 1;

    const points = data.map((d, i) => {
        const x = padding + (i * (width - 2 * padding) / (data.length - 1));
        const y = height - padding - ((d.price - minPrice) / priceRange * (height - 2 * padding));
        return `${x},${y}`;
    }).join(' ');

    return React.createElement('div', {
        style: {
            marginTop: '15px',
            padding: '10px',
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid #333',
            borderRadius: '4px'
        }
    },
        React.createElement('div', { style: { fontSize: '9px', color: '#555', marginBottom: '8px', letterSpacing: '1px', fontWeight: 'bold' } }, '7-DAY PRICE TREND:'),
        React.createElement('svg', {
            width: '100%',
            height: height,
            viewBox: `0 0 ${width} ${height}`,
            style: { overflow: 'visible' }
        },
            // Grid lines
            [0, 0.5, 1].map(v => {
                const y = padding + v * (height - 2 * padding);
                return React.createElement('line', {
                    key: v,
                    x1: padding,
                    y1: y,
                    x2: width - padding,
                    y2: y,
                    stroke: '#222',
                    strokeWidth: '1'
                });
            }),
            // Area
            React.createElement('polyline', {
                fill: `${color}11`,
                stroke: 'none',
                points: `${padding},${height - padding} ${points} ${width - padding},${height - padding}`
            }),
            // Line
            React.createElement('polyline', {
                fill: 'none',
                stroke: color,
                strokeWidth: '2',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                points: points
            }),
            // Data points
            data.map((d, i) => {
                const x = padding + (i * (width - 2 * padding) / (data.length - 1));
                const y = height - padding - ((d.price - minPrice) / priceRange * (height - 2 * padding));
                return React.createElement('circle', {
                    key: i,
                    cx: x,
                    cy: y,
                    r: 2,
                    fill: color
                });
            })
        ),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: '#444', marginTop: '5px' } },
            React.createElement('span', null, '7 DAYS AGO'),
            React.createElement('span', null, 'TODAY')
        )
    );
};

const RegionalDemandHeatmap = ({ itemId, gameManager }) => {
    const demandData = gameManager?.getRegionalDemandData(itemId) || {};
    const systems = Object.keys(SYSTEMS_REGISTRY);
    
    // Sort systems by demand volume
    const sortedSystems = systems
        .map(id => ({ id, name: SYSTEMS_REGISTRY[id].name, volume: demandData[id] || 0 }))
        .sort((a, b) => b.volume - a.volume)
        .filter(s => s.volume > 0);

    if (sortedSystems.length === 0) return null;

    const maxVolume = Math.max(...sortedSystems.map(s => s.volume));

    return React.createElement('div', { style: { marginTop: '20px' } },
        React.createElement('div', { style: { fontSize: '9px', color: '#555', marginBottom: '8px', letterSpacing: '1px', fontWeight: 'bold' } }, 'REGIONAL DEMAND HEATMAP (7D):'),
        sortedSystems.map((s, i) => {
            const intensity = s.volume / maxVolume;
            const barWidth = Math.max(5, intensity * 100);
            return React.createElement('div', { key: i, style: { marginBottom: '6px' } },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' } },
                    React.createElement('span', { style: { color: '#aaa' } }, s.name.toUpperCase()),
                    React.createElement('span', { style: { color: '#00ccff', fontWeight: 'bold' } }, `${s.volume} UNITS`)
                ),
                React.createElement('div', { style: { width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px' } },
                    React.createElement('div', { style: { width: `${barWidth}%`, height: '100%', background: `rgba(0, 204, 255, ${0.3 + intensity * 0.7})`, borderRadius: '2px', boxShadow: '0 0 10px rgba(0, 204, 255, 0.3)' } })
                )
            );
        })
    );
};

const TradeHub = ({ 
    gameState, onList, onBuy, onBuyOrder, onCollect, onStore, onBid, 
    onDeliverPackage, onPickupPackage, onCancelListing, onCancelContract 
}) => {
    const [activeTab, setActiveTab] = useState('browser'); // 'browser', 'storage'
    const [activeRightTab, setActiveRightTab] = useState('inventory'); // 'inventory', 'storage'
    const [marketFilter, setMarketFilter] = useState('commodities'); // 'commodities', 'buy_orders', 'auctions', 'contracts'
    const [selectedListing, setSelectedListing] = useState(null);
    const [isListingMode, setIsListingMode] = useState(false);
    const [isBuyOrderMode, setIsBuyOrderMode] = useState(false);
    const [isContractMode, setIsContractMode] = useState(false);
    const [selectedContract, setSelectedContract] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    
    // Contract Creation State
    const [contractReward, setContractReward] = useState('1000');
    const [contractCollateral, setContractCollateral] = useState('5000');
    const [contractDuration, setContractDuration] = useState(86400000); // 24h default
    
    const [listPrice, setListPrice] = useState('');
    const [listQuantity, setListQuantity] = useState(1);
    const [buyItemType, setBuyItemType] = useState('organic-material');
    const [selectedInventoryItem, setSelectedInventoryItem] = useState(null);

    const [newMarketListings, setNewMarketListings] = useState([]);
    const [newBuyOrders, setNewBuyOrders] = useState([]);
    const currentSystemId = gameState.currentSystem?.id;
    const currentStarportId = SYSTEM_TO_STARPORT[currentSystemId];

    const BUYABLE_COMMODITIES = [
        'iron-ore', 'silicon-crystal', 'hydrogen-fuel', 'organic-material', 
        'refined-metal', 'quantum-processor', 'fusion-core', 'shield-flux-catalyst'
    ];

    useEffect(() => {
        if (!currentStarportId) return;

        const fetchMarketData = async () => {
            if (marketFilter === 'commodities' || marketFilter === 'auctions') {
                // Trigger NPC Blueprint Seeding for this starport
                MarketSystem.seedNPCBlueprints(currentStarportId).catch(e => console.warn("[TradeHub] NPC Seeding error:", e));

                try {
                    const result = await MarketSystem.fetchMarketData(currentStarportId, marketFilter);
                    if (result.listings) setNewMarketListings(result.listings);
                } catch (e) {
                    console.warn("[TradeHub] Market fetch error:", e);
                }
            } else if (marketFilter === 'buy_orders') {
                try {
                    const result = await MarketSystem.fetchMarketData(currentStarportId, marketFilter);
                    if (result.buyOrders) setNewBuyOrders(result.buyOrders);
                } catch (e) {
                    console.warn("[TradeHub] Buy order fetch error:", e);
                }
            }
        };

        fetchMarketData();
        
        // Subscribe to changes for real-time updates
        const listingChannel = supabase.channel('market_listings_updates')
            .on('postgres_changes', { 
                event: '*', 
                schema: 'public', 
                table: 'market_listings',
                filter: `starport_id=eq.${currentStarportId}`
            }, () => fetchMarketData())
            .subscribe();

        const buyOrderChannel = supabase.channel('market_buy_orders_updates')
            .on('postgres_changes', { 
                event: '*', 
                schema: 'public', 
                table: 'market_buy_orders',
                filter: `starport_id=eq.${currentStarportId}`
            }, () => fetchMarketData())
            .subscribe();
            
        return () => { 
            supabase.removeChannel(listingChannel); 
            supabase.removeChannel(buyOrderChannel);
        };
    }, [marketFilter, currentStarportId]);

    let listings = [];
    if (marketFilter === 'contracts') {
        listings = gameState.courierContracts?.filter(c => c.status === 'available') || [];
    } else if (marketFilter === 'commodities') {
        listings = newMarketListings.map(l => {
            const itemType = String(l.item_type || 'unknown');
            const itemDisplayName = String(
                l.item_name || l.item_data?.displayName || l.item_data?.name || l.item_type || 'Unknown'
            ).replace(/-/g, ' ').toUpperCase();
            let rarity = String(l.item_data?.rarity || '').trim().toLowerCase() || 'common';
            if (!l.item_data?.rarity) {
                if (itemType.includes('-uncommon-')) rarity = 'uncommon';
                else if (itemType.includes('-rare-')) rarity = 'rare';
                else if (itemType.includes('-epic-')) rarity = 'epic';
                else if (itemType.includes('-legendary-')) rarity = 'legendary';
                else if (itemType.includes('-mythic-')) rarity = 'mythic';
            }

            return {
                id: l.listing_id,
                sellerId: l.seller_id,
                sellerName: l.seller_id === '00000000-0000-0000-0000-000000000001' ? 'OMNI DIRECTORATE' : `Seller ID: ${l.seller_id.substring(0, 5)}`,
                price: parseFloat(l.price_per_uni),
                quantity: l.quantity,
                item: { 
                    name: itemDisplayName,
                    rarity: rarity
                },
                originSystemId: currentSystemId,
                originSystemName: SYSTEMS_REGISTRY[currentSystemId]?.name || currentSystemId,
                originSector: SYSTEMS_REGISTRY[currentSystemId]?.sector || '??'
            };
        });
    } else if (marketFilter === 'buy_orders') {
        listings = newBuyOrders.map(o => {
            const itemType = String(o.item_type || 'unknown');
            const itemDisplayName = String(
                o.item_name || o.item_data?.displayName || o.item_data?.name || o.item_type || 'Unknown'
            ).replace(/-/g, ' ').toUpperCase();
            let rarity = String(o.item_data?.rarity || '').trim().toLowerCase() || 'common';
            if (!o.item_data?.rarity) {
                if (itemType.includes('-uncommon-')) rarity = 'uncommon';
                else if (itemType.includes('-rare-')) rarity = 'rare';
                else if (itemType.includes('-epic-')) rarity = 'epic';
                else if (itemType.includes('-legendary-')) rarity = 'legendary';
                else if (itemType.includes('-mythic-')) rarity = 'mythic';
            }

            return {
                id: o.order_id,
                buyerId: o.buyer_id,
                buyerName: `Buyer ID: ${o.buyer_id.substring(0, 5)}`,
                price: parseFloat(o.price_per_uni),
                quantity: o.quantity,
                item: {
                    name: itemDisplayName,
                    rarity: rarity
                },
                originSystemId: currentSystemId,
                originSystemName: SYSTEMS_REGISTRY[currentSystemId]?.name || currentSystemId,
                originSector: SYSTEMS_REGISTRY[currentSystemId]?.sector || '??'
            };
        });
    } else if (gameState.globalMarkets) {
        Object.entries(gameState.globalMarkets).forEach(([sysId, sysMarket]) => {
            const sysListings = (marketFilter === 'auctions' ? sysMarket.auctions : []) || [];
            sysListings.forEach(l => {
                listings.push({
                    ...l,
                    originSystemId: sysId,
                    originSystemName: SYSTEMS_REGISTRY[sysId]?.name || sysId,
                    originSector: SYSTEMS_REGISTRY[sysId]?.sector || '??'
                });
            });
        });
    }

    // Apply Search Filtering
    if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        listings = listings.filter(l => {
            const itemName = (l.item?.name || 'CONTRACT').toLowerCase();
            const price = (marketFilter === 'contracts' ? l.reward : l.price).toString();
            return itemName.includes(term) || price.includes(term);
        });
    }

    const myStorage = (gameState.regionalStorage && gameState.regionalStorage[currentSystemId] && gameState.regionalStorage[currentSystemId][cloudService.user?.id || 'local']) || [];
    // Ensure storage items carry their system identity for listing logic
    const identifiedMyStorage = myStorage.map(item => ({ ...item, systemId: currentSystemId }));
    
    let globalStorage = [];
    const userId = cloudService.user?.id || 'local';
    Object.entries(gameState.regionalStorage || {}).forEach(([sysId, users]) => {
        if (users[userId]) {
            users[userId].forEach(item => {
                globalStorage.push({
                    ...item,
                    systemId: sysId,
                    systemName: SYSTEMS_REGISTRY[sysId]?.name || sysId
                });
            });
        }
    });

    // Apply Search Filtering to Global Storage
    if (activeTab === 'storage' && searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        globalStorage = globalStorage.filter(item => {
            const itemName = item.name.toLowerCase();
            const systemName = item.systemName.toLowerCase();
            return itemName.includes(term) || systemName.includes(term);
        });
    }

    const [bidAmount, setBidAmount] = useState('');
    const [buyQuantity, setBuyQuantity] = useState(1);

    const handleSelectListing = (listing) => {
        if (marketFilter === 'contracts') {
            setSelectedContract(listing);
            setSelectedListing(null);
            setIsListingMode(false);
            setIsContractMode(false);
            return;
        }
        setSelectedListing(listing);
        setBuyQuantity(1);
        setSelectedContract(null);
        setIsListingMode(false);
        setIsContractMode(false);
        if (listing.type === 'auction') {
            setBidAmount((listing.price * 1.05).toFixed(2));
        }
    };

    const formatTimeRemaining = (ms) => {
        if (ms <= 0) return 'EXPIRED';
        const seconds = Math.floor((ms / 1000) % 60);
        const minutes = Math.floor((ms / (1000 * 60)) % 60);
        const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
        const days = Math.floor(ms / (1000 * 60 * 60 * 24));
        
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m ${seconds}s`;
    };

    const handleSelectListable = (item) => {
        setSelectedInventoryItem(item);
        setIsListingMode(true);
        setSelectedListing(null);
        setListQuantity(item.amount || 1);
        // Default to reference price
        if (gameState.globalMarkets && item) {
            // We can't call getReferencePrice directly from React if it's not exported, but we'll assume a sensible default or the engine handles it
            setListPrice('');
        }
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '160px',
            bottom: '140px',
            left: '300px',
            right: '40px',
            display: 'flex',
            gap: '24px',
            zIndex: 30,
            pointerEvents: 'auto',
            animation: 'fadeIn 0.4s ease-out',
            boxSizing: 'border-box'
        }
    },
        React.createElement('style', null, `
            .trade-hub-scrollable::-webkit-scrollbar {
                width: 6px;
            }
            .trade-hub-scrollable::-webkit-scrollbar-track {
                background: rgba(0, 0, 0, 0.2);
                border-radius: 3px;
            }
            .trade-hub-scrollable::-webkit-scrollbar-thumb {
                background: rgba(0, 204, 255, 0.3);
                border-radius: 3px;
                border: 1px solid rgba(0, 204, 255, 0.1);
            }
            .trade-hub-scrollable::-webkit-scrollbar-thumb:hover {
                background: rgba(0, 204, 255, 0.5);
            }
        `),
        // Left Column: Market Explorer
        React.createElement('div', {
            style: { flex: 1.5, background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box' }
        },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #333', paddingBottom: '15px', marginBottom: '15px' } },
                React.createElement('div', { style: { color: '#00ccff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px' } }, 'STARPORT TRADE TERMINAL'),
                React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                    ['browser', 'storage'].map(t => (
                        React.createElement('button', {
                            key: t,
                            onClick: () => { setActiveTab(t); setSelectedListing(null); setIsListingMode(false); },
                            style: {
                                background: activeTab === t ? '#00ccff' : 'transparent',
                                border: '1px solid #00ccff',
                                color: activeTab === t ? '#000' : '#00ccff',
                                fontSize: '10px', padding: '4px 12px', cursor: 'pointer', fontWeight: 'bold'
                            }
                        }, t.toUpperCase())
                    ))
                )
            ),

            activeTab === 'browser' ? React.createElement(React.Fragment, null,
                // Market Filters
                React.createElement('div', { style: { display: 'flex', gap: '10px', marginBottom: '15px' } },
                    ['commodities', 'buy_orders', 'auctions', 'contracts'].map(f => (
                        React.createElement('button', {
                            key: f,
                            onClick: () => { setMarketFilter(f); setSelectedListing(null); setSelectedContract(null); setIsListingMode(false); setIsContractMode(false); setIsBuyOrderMode(false); },
                            style: {
                                flex: 1,
                                background: marketFilter === f ? 'rgba(0, 204, 255, 0.1)' : 'transparent',
                                border: `1px solid ${marketFilter === f ? '#00ccff' : '#333'}`,
                                color: marketFilter === f ? '#fff' : '#666',
                                fontSize: '11px', padding: '8px', cursor: 'pointer', fontWeight: 'bold'
                            }
                        }, f.toUpperCase().replace('_', ' '))
                    ))
                ),

                // Post Buy Order Button
                marketFilter === 'buy_orders' && !isBuyOrderMode && React.createElement('button', {
                    onClick: () => { setIsBuyOrderMode(true); setListPrice(''); setListQuantity(1); },
                    style: {
                        width: '100%', padding: '10px', background: '#00ccff22', border: '1px solid #00ccff', color: '#00ccff',
                        fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '15px', borderRadius: '2px'
                    }
                }, '+ POST NEW BUY ORDER'),
                // Search Bar
                React.createElement('div', { style: { position: 'relative', marginBottom: '15px' } },
                    React.createElement('div', { style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 } },
                        React.createElement(IconSearch, { size: 14, color: '#00ccff' })
                    ),
                    React.createElement('input', {
                        type: 'text',
                        placeholder: 'FILTER BY RESOURCE OR PRICE...',
                        value: searchTerm,
                        onChange: (e) => setSearchTerm(e.target.value),
                        style: {
                            width: '100%',
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid #333',
                            borderRadius: '4px',
                            padding: '8px 12px 8px 35px',
                            color: '#00ccff',
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            outline: 'none',
                            boxSizing: 'border-box'
                        },
                        onFocus: (e) => e.target.style.borderColor = '#00ccff',
                        onBlur: (e) => e.target.style.borderColor = '#333'
                    }),
                    searchTerm && React.createElement('div', {
                        onClick: () => setSearchTerm(''),
                        style: { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: '#666', fontSize: '12px' }
                    }, '✕')
                ),
                // Listings List
                React.createElement('div', { 
                    onWheel: (e) => e.stopPropagation(),
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '5px', minHeight: 0 } 
                },
                    listings.length === 0 ? 
                    React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, `--- NO ACTIVE ${marketFilter.toUpperCase()} DETECTED ---`) :
                    listings.map((l, idx) => {
                        const isSelected = marketFilter === 'contracts' ? selectedContract?.id === l.id : selectedListing?.id === l.id;
                        const originName = l.originSystemName || SYSTEMS_REGISTRY[l.originSystemId]?.name || 'UNKNOWN';
                        const originSector = l.originSector || SYSTEMS_REGISTRY[l.originSystemId]?.sector || '??';
                        
                        return React.createElement('div', {
                            key: l.id,
                            onClick: () => handleSelectListing(l),
                            style: {
                                padding: '12px',
                                background: isSelected ? 'rgba(0, 204, 255, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                                border: `1px solid ${isSelected ? '#00ccff' : '#222'}`,
                                borderRadius: '4px',
                                marginBottom: '8px',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center'
                            }
                        },
                            React.createElement('div', { style: { flex: 1 } },
                                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                                    React.createElement('div', { style: { color: RARITY_COLORS[l.item?.rarity || 'common'] || '#fff', fontWeight: 'bold', fontSize: '13px' } }, (l.item?.name || 'CONTRACT').toUpperCase()),
                                    (marketFilter !== 'contracts' && l.originSystemId) && React.createElement('div', { 
                                        style: { fontSize: '9px', background: 'rgba(0, 204, 255, 0.15)', color: '#00ccff', padding: '1px 6px', borderRadius: '2px', border: '1px solid rgba(0, 204, 255, 0.3)', fontWeight: 'bold' } 
                                    }, `${originName.toUpperCase()} // SEC ${originSector}`)
                                ),
                                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginTop: '2px' } }, 
                                    l.type === 'auction' ? 
                                    `AUCTION // BIDS: ${l.bids.length} // SELLER: ${l.sellerName}` :
                                    (marketFilter === 'contracts' ? 
                                    `COURIER // FROM: ${SYSTEMS_REGISTRY[l.originSystemId]?.name} // TO: ${SYSTEMS_REGISTRY[l.destinationSystemId]?.name}` :
                                    `${l.quantity} UNITS // SELLER: ${l.sellerName}`)
                                )
                            ),
                            React.createElement('div', { style: { textAlign: 'right' } },
                                React.createElement('div', { style: { color: '#ffcc00', fontWeight: 'bold', fontSize: '14px' } }, marketFilter === 'contracts' ? `${l.reward.toFixed(0)} Cr` : `${l.price.toFixed(2)} Cr`),
                                React.createElement('div', { style: { fontSize: '9px', color: (l.type === 'auction' || marketFilter === 'contracts') ? '#00ccff' : '#555' } }, 
                                    (l.type === 'auction' || marketFilter === 'contracts') ? formatTimeRemaining(l.expiresAt - Date.now()) : 'LOCAL PICKUP ONLY'
                                )
                            )
                        );
                    })
                )
            ) : React.createElement(React.Fragment, null,
                // Regional Storage List (Updated to show Global Assets if applicable)
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' } },
                    React.createElement('div', { style: { fontSize: '11px', color: '#888' } }, 'INTERSTELLAR ASSET REGISTRY'),
                    React.createElement('div', { style: { fontSize: '9px', color: '#555' } }, 'SELECT ITEM TO WITHDRAW OR MOVE')
                ),
                // Search Bar for Storage
                React.createElement('div', { style: { position: 'relative', marginBottom: '15px' } },
                    React.createElement('div', { style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 } },
                        React.createElement(IconSearch, { size: 14, color: '#00ccff' })
                    ),
                    React.createElement('input', {
                        type: 'text',
                        placeholder: 'FILTER BY ASSET OR SYSTEM...',
                        value: searchTerm,
                        onChange: (e) => setSearchTerm(e.target.value),
                        style: {
                            width: '100%',
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid #333',
                            borderRadius: '4px',
                            padding: '8px 12px 8px 35px',
                            color: '#00ccff',
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            outline: 'none',
                            boxSizing: 'border-box'
                        }
                    }),
                    searchTerm && React.createElement('div', {
                        onClick: () => setSearchTerm(''),
                        style: { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: '#666', fontSize: '12px' }
                    }, '✕')
                ),
                React.createElement('div', { 
                    onWheel: (e) => e.stopPropagation(),
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '5px', minHeight: 0 } 
                },
                    globalStorage.length === 0 ? 
                    React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, '--- NO ASSETS DETECTED IN GALACTIC STORAGE ---') :
                    globalStorage.map((item, idx) => {
                        const isLocal = item.systemId === currentSystemId;
                        return React.createElement('div', {
                            key: idx,
                            onClick: () => {
                                if (!isLocal) {
                                    setSelectedInventoryItem(item);
                                    setIsContractMode(true);
                                    setIsListingMode(false);
                                    setSelectedListing(null);
                                    setSelectedContract(null);
                                }
                            },
                            style: {
                                padding: '12px',
                                background: 'rgba(255, 255, 255, 0.02)',
                                border: `1px solid ${!isLocal ? '#443311' : '#333'}`,
                                borderRadius: '4px',
                                marginBottom: '8px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                cursor: !isLocal ? 'pointer' : 'default'
                            }
                        },
                            React.createElement('div', null,
                                React.createElement('div', { style: { color: RARITY_COLORS[item.rarity] || '#fff', fontWeight: 'bold', fontSize: '13px' } }, item.name.toUpperCase()),
                                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginTop: '2px' } }, 
                                    `${item.amount} UNITS // @ ${item.systemName.toUpperCase()}`
                                )
                            ),
                            isLocal ? React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                                React.createElement('button', {
                                    onClick: (e) => { e.stopPropagation(); handleSelectListable(item); },
                                    style: {
                                        padding: '6px 12px',
                                        background: 'transparent',
                                        border: '1px solid #00ccff',
                                        color: '#00ccff',
                                        fontSize: '10px', fontWeight: 'bold', cursor: 'pointer'
                                    }
                                }, 'SELL')
                            ) : 
                            React.createElement('div', {
                                style: {
                                    padding: '6px 12px',
                                    color: '#ffcc00',
                                    fontSize: '9px', fontWeight: 'bold',
                                    border: '1px solid #ffcc00',
                                    borderRadius: '2px'
                                }
                            }, 'REQUEST TRANSPORT')
                        )
                    })
                )
            )
        ),

        // Right Column: Action Panel
        React.createElement('div', {
            style: { width: '350px', background: 'rgba(0, 5, 10, 0.9)', border: '1px solid #444', borderRadius: '4px', padding: '30px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.8)', minHeight: 0, overflow: 'hidden' }
        },
            !selectedListing && !isListingMode && !selectedContract && !isContractMode ? (
                React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } },
                    React.createElement('div', { style: { display: 'flex', gap: '5px', marginBottom: '15px', borderBottom: '1px solid #333', paddingBottom: '10px' } },
                        [
                            { id: 'inventory', label: 'SHIP CARGO' },
                            { id: 'storage', label: 'STARPORT BAY' }
                        ].map(t => (
                            React.createElement('button', {
                                key: t.id,
                                onClick: () => setActiveRightTab(t.id),
                                style: {
                                    flex: 1,
                                    background: activeRightTab === t.id ? '#fff' : 'transparent',
                                    border: '1px solid #555',
                                    color: activeRightTab === t.id ? '#000' : '#888',
                                    fontSize: '10px', padding: '6px', cursor: 'pointer', fontWeight: 'bold'
                                }
                            }, t.label)
                        ))
                    ),
                    
                    activeRightTab === 'inventory' ? (
                        React.createElement('div', { 
                            onWheel: (e) => e.stopPropagation(),
                            className: 'trade-hub-scrollable',
                            style: { flex: 1, overflowY: 'auto', paddingRight: '5px', minHeight: 0 } 
                        },
                            gameState.inventory.filter(i => i.type !== 'implant' && i.type !== 'courier-package').map((item, idx) => (
                                React.createElement('div', {
                                    key: item.id,
                                    style: {
                                        padding: '10px',
                                        background: 'rgba(255,255,255,0.03)',
                                        border: '1px solid #222',
                                        borderRadius: '4px',
                                        marginBottom: '6px',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }
                                },
                                        React.createElement('div', { 
                                            onClick: () => {
                                                setSelectedInventoryItem(item);
                                                setIsListingMode(true);
                                                setSelectedListing(null);
                                                setIsContractMode(false);
                                            },
                                            style: { flex: 1, cursor: 'pointer' }
                                        },
                                            React.createElement('div', { style: { color: RARITY_COLORS[item.rarity || 'common'] || '#fff', fontSize: '12px', fontWeight: 'bold' } }, item.name.toUpperCase()),
                                            React.createElement('div', { style: { fontSize: '9px', color: '#666' } }, `${item.amount || 1} UNITS`)
                                        ),
                                    React.createElement('div', { style: { display: 'flex', gap: '4px' } },
                                        React.createElement('button', {
                                            onClick: () => {
                                                setSelectedInventoryItem(item);
                                                setIsListingMode(true);
                                                setSelectedListing(null);
                                                setIsContractMode(false);
                                            },
                                            style: { background: '#00ccff', border: 'none', color: '#000', fontSize: '9px', fontWeight: 'bold', padding: '4px 8px', cursor: 'pointer', borderRadius: '2px' }
                                        }, 'SELL')
                                    )
                                )
                            )),
                            // Active Delivery section
                            gameState.inventory.some(i => i.type === 'courier-package') && React.createElement(React.Fragment, null,
                                React.createElement('div', { style: { fontSize: '10px', color: '#ffcc00', margin: '15px 0 10px', borderBottom: '1px solid #443311', paddingBottom: '5px' } }, 'ACTIVE DELIVERIES'),
                                gameState.inventory.filter(i => i.type === 'courier-package').map(pkg => {
                                    const contract = gameState.courierContracts?.find(c => c.id === pkg.contractId);
                                    const isAtDestination = contract?.destinationSystemId === currentSystemId;
                                    return React.createElement('div', {
                                        key: pkg.id,
                                        style: { padding: '10px', background: 'rgba(255,204,0,0.05)', border: '1px solid #ffcc0044', borderRadius: '4px', marginBottom: '6px' }
                                    },
                                        React.createElement('div', { style: { color: '#ffcc00', fontSize: '11px', fontWeight: 'bold' } }, pkg.name),
                                        React.createElement('div', { style: { fontSize: '9px', color: '#888', marginTop: '4px' } }, 
                                            isAtDestination ? 'DESTINATION REACHED' : `DESTINATION: ${SYSTEMS_REGISTRY[contract?.destinationSystemId]?.name || 'UNKNOWN'}`
                                        ),
                                        isAtDestination && React.createElement('button', {
                                            onClick: () => onDeliverPackage(pkg.contractId),
                                            style: { marginTop: '8px', width: '100%', padding: '6px', background: '#00ff00', border: 'none', color: '#000', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }
                                        }, 'COMPLETE DELIVERY')
                                    );
                                })
                            ),
                            // Accepted but not picked up section
                            gameState.courierContracts?.some(c => c.haulerId === userId && c.status === 'active') && React.createElement(React.Fragment, null,
                                React.createElement('div', { style: { fontSize: '10px', color: '#00ccff', margin: '15px 0 10px', borderBottom: '1px solid #113344', paddingBottom: '5px' } }, 'PENDING PICKUPS'),
                                gameState.courierContracts.filter(c => c.haulerId === userId && c.status === 'active').map(contract => {
                                    const isAtOrigin = contract.originSystemId === currentSystemId;
                                    return React.createElement('div', {
                                        key: contract.id,
                                        style: { padding: '10px', background: 'rgba(0,204,255,0.05)', border: '1px solid #00ccff44', borderRadius: '4px', marginBottom: '6px' }
                                    },
                                        React.createElement('div', { style: { color: '#00ccff', fontSize: '11px', fontWeight: 'bold' } }, `CARGO: ${contract.item.name}`),
                                        React.createElement('div', { style: { fontSize: '9px', color: '#888', marginTop: '4px' } }, 
                                            isAtOrigin ? 'LOCATED AT THIS STARPORT' : `ORIGIN: ${SYSTEMS_REGISTRY[contract.originSystemId]?.name}`
                                        ),
                                        isAtOrigin && React.createElement('button', {
                                            onClick: () => onPickupPackage(contract.id),
                                            style: { marginTop: '8px', width: '100%', padding: '6px', background: '#00ccff', border: 'none', color: '#000', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }
                                        }, 'PICKUP PACKAGE')
                                    );
                                })
                            )
                        )
                    ) : (
                        React.createElement('div', { 
                            onWheel: (e) => e.stopPropagation(),
                            className: 'trade-hub-scrollable',
                            style: { flex: 1, overflowY: 'auto', paddingRight: '5px', minHeight: 0 } 
                        },
                            identifiedMyStorage.length === 0 ? 
                            React.createElement('div', { style: { color: '#444', textAlign: 'center', marginTop: '40px', fontSize: '12px' } }, '--- NO ASSETS AT THIS STARPORT ---') :
                            identifiedMyStorage.map((item, idx) => (
                                React.createElement('div', {
                                    key: idx,
                                    style: {
                                        padding: '10px',
                                        background: 'rgba(255,255,255,0.03)',
                                        border: '1px solid #222',
                                        borderRadius: '4px',
                                        marginBottom: '6px',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }
                                },
                                    React.createElement('div', null,
                                        React.createElement('div', { style: { color: RARITY_COLORS[item.rarity] || '#fff', fontSize: '12px', fontWeight: 'bold' } }, item.name.toUpperCase()),
                                        React.createElement('div', { style: { fontSize: '9px', color: '#666' } }, `${item.amount || 1} UNITS`)
                                    ),
                                    React.createElement('div', { style: { display: 'flex', gap: '4px' } },
                                        React.createElement('button', {
                                            onClick: (e) => { e.stopPropagation(); handleSelectListable(item); },
                                            style: { background: '#00ccff', border: 'none', color: '#000', fontSize: '9px', fontWeight: 'bold', padding: '4px 8px', cursor: 'pointer', borderRadius: '2px' }
                                        }, 'SELL')
                                    )
                                )
                            ))
                        )
                    ),
                    activeRightTab === 'inventory' && React.createElement('div', { style: { marginTop: '24px', fontSize: '10px', color: '#444', textAlign: 'center', fontStyle: 'italic' } }, 'SELECT AN ITEM TO CREATE A MARKET LISTING')
                )
            ) : isListingMode ? (
                // Create Listing View
                React.createElement('div', { 
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '10px', minHeight: 0, display: 'flex', flexDirection: 'column' }
                },
                    React.createElement('div', { style: { color: '#fff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '10px', marginBottom: '20px' } }, 'CREATE MARKET LISTING'),
                    React.createElement('div', { style: { marginBottom: '20px', padding: '15px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #333' } },
                        React.createElement('div', { style: { color: RARITY_COLORS[selectedInventoryItem.rarity], fontWeight: 'bold', fontSize: '14px' } }, selectedInventoryItem.name.toUpperCase()),
                        React.createElement('div', { style: { color: '#888', fontSize: '11px', marginTop: '4px' } }, `OWNED: ${selectedInventoryItem.amount} UNITS`),
                        React.createElement(ItemSpecificationList, { item: selectedInventoryItem })
                    ),
                    
                    React.createElement('div', { style: { marginBottom: '20px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'UNIT PRICE (CREDITS):'),
                        React.createElement('input', {
                            type: 'number',
                            value: listPrice,
                            onChange: (e) => setListPrice(e.target.value),
                            placeholder: '0.00',
                            style: { width: '100%', background: '#000', border: '1px solid #444', color: '#ffcc00', padding: '10px', fontSize: '16px', fontFamily: 'monospace', borderRadius: '4px' }
                        })
                    ),

                    React.createElement('div', { style: { marginBottom: '30px' } },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
                            React.createElement('span', { style: { fontSize: '11px', color: '#888' } }, 'QUANTITY TO LIST:'),
                            React.createElement('input', {
                                type: 'number',
                                min: 1,
                                max: selectedInventoryItem.amount || 1,
                                value: listQuantity,
                                onChange: (e) => {
                                    const val = Math.max(1, Math.min(selectedInventoryItem.amount || 1, parseInt(e.target.value) || 1));
                                    setListQuantity(val);
                                },
                                style: { background: '#000', border: '1px solid #444', color: '#00ccff', padding: '4px 8px', fontSize: '12px', fontFamily: 'monospace', borderRadius: '4px', width: '80px', textAlign: 'right' }
                            })
                        ),
                        React.createElement('input', {
                            type: 'range',
                            min: 1,
                            max: selectedInventoryItem.amount || 1,
                            value: listQuantity,
                            onChange: (e) => setListQuantity(parseInt(e.target.value)),
                            style: { width: '100%', accentColor: '#00ccff' }
                        })
                    ),

                    React.createElement('div', { style: { flex: 1 } }),

                    React.createElement('div', { style: { padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', border: '1px solid #222', marginBottom: '20px' } },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '6px' } },
                            React.createElement('span', { style: { color: '#888' } }, 'LISTING FEE (0.5%)'),
                            React.createElement('span', { style: { color: '#fff' } }, `${(parseFloat(listPrice || 0) * listQuantity * 0.005).toFixed(2)} Cr`)
                        ),
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
                            React.createElement('span', { style: { color: '#888' } }, 'EXPECTED PROFIT'),
                            React.createElement('span', { style: { color: '#00ff00', fontWeight: 'bold' } }, `${(parseFloat(listPrice || 0) * listQuantity * 0.97).toFixed(2)} Cr`)
                        )
                    ),

                    React.createElement('button', {
                        onClick: () => {
                            const success = onList(selectedInventoryItem, parseFloat(listPrice), listQuantity, 'limit_order');
                            if (success) {
                                setIsListingMode(false);
                                setSelectedInventoryItem(null);
                            }
                        },
                        disabled: !listPrice || parseFloat(listPrice) <= 0,
                        style: {
                            width: '100%', padding: '15px', background: '#00ccff', border: 'none', color: '#000', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', marginBottom: '10px'
                        }
                    }, 'CONFIRM LISTING'),
                    React.createElement('button', {
                        onClick: () => setIsListingMode(false),
                        style: {
                            width: '100%', padding: '10px', background: 'transparent', border: '1px solid #444', color: '#888', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'
                        }
                    }, 'CANCEL')
                )
            ) : isBuyOrderMode ? (
                // Create Buy Order View
                React.createElement('div', { 
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '10px', minHeight: 0, display: 'flex', flexDirection: 'column' }
                },
                    React.createElement('div', { style: { color: '#fff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '10px', marginBottom: '20px' } }, 'POST BUY ORDER'),
                    
                    React.createElement('div', { style: { marginBottom: '20px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'SELECT COMMODITY:'),
                        React.createElement('select', {
                            value: buyItemType,
                            onChange: (e) => setBuyItemType(e.target.value),
                            style: { width: '100%', background: '#000', border: '1px solid #444', color: '#fff', padding: '10px', fontSize: '14px', fontFamily: 'monospace', borderRadius: '4px' }
                        }, BUYABLE_COMMODITIES.map(c => React.createElement('option', { key: c, value: c }, c.toUpperCase().replace(/-/g, ' '))))
                    ),

                    React.createElement('div', { style: { marginBottom: '20px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'BID PRICE PER UNIT (CREDITS):'),
                        React.createElement('input', {
                            type: 'number',
                            value: listPrice,
                            onChange: (e) => setListPrice(e.target.value),
                            placeholder: '0.00',
                            style: { width: '100%', background: '#000', border: '1px solid #444', color: '#ffcc00', padding: '10px', fontSize: '16px', fontFamily: 'monospace', borderRadius: '4px' }
                        })
                    ),

                    React.createElement('div', { style: { marginBottom: '30px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'QUANTITY REQUIRED:'),
                        React.createElement('input', {
                            type: 'number',
                            min: 1,
                            value: listQuantity,
                            onChange: (e) => setListQuantity(Math.max(1, parseInt(e.target.value) || 1)),
                            style: { width: '100%', background: '#000', border: '1px solid #444', color: '#00ccff', padding: '10px', fontSize: '16px', fontFamily: 'monospace', borderRadius: '4px' }
                        })
                    ),

                    React.createElement('div', { style: { flex: 1 } }),

                    React.createElement('div', { style: { padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', border: '1px solid #222', marginBottom: '20px' } },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
                            React.createElement('span', { style: { color: '#888' } }, 'TOTAL ESCROW'),
                            React.createElement('span', { style: { color: '#ffcc00', fontWeight: 'bold' } }, `${(parseFloat(listPrice || 0) * listQuantity).toFixed(2)} Cr`)
                        )
                    ),

                    React.createElement('button', {
                        onClick: async () => {
                            const success = await onBuyOrder(buyItemType, listQuantity, parseFloat(listPrice));
                            if (success) {
                                setIsBuyOrderMode(false);
                            }
                        },
                        disabled: !listPrice || parseFloat(listPrice) <= 0 || (parseFloat(listPrice) * listQuantity > gameState.credits),
                        style: {
                            width: '100%', padding: '15px', background: '#00ccff', border: 'none', color: '#000', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', marginBottom: '10px',
                            opacity: (!listPrice || parseFloat(listPrice) <= 0 || (parseFloat(listPrice) * listQuantity > gameState.credits)) ? 0.5 : 1
                        }
                    }, parseFloat(listPrice) * listQuantity > gameState.credits ? 'INSUFFICIENT CREDITS' : 'CONFIRM BUY ORDER'),
                    React.createElement('button', {
                        onClick: () => setIsBuyOrderMode(false),
                        style: {
                            width: '100%', padding: '10px', background: 'transparent', border: '1px solid #444', color: '#888', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'
                        }
                    }, 'CANCEL')
                )
            ) : isContractMode ? (
                // Create Courier Contract View
                React.createElement('div', { 
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '10px', minHeight: 0, display: 'flex', flexDirection: 'column' }
                },
                    React.createElement('div', { style: { color: '#fff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '10px', marginBottom: '20px' } }, 'CREATE COURIER CONTRACT'),
                    React.createElement('div', { style: { marginBottom: '20px', padding: '15px', background: 'rgba(255, 204, 0, 0.03)', borderRadius: '4px', border: '1px solid #443311' } },
                        React.createElement('div', { style: { color: '#ffcc00', fontWeight: 'bold', fontSize: '14px' } }, selectedInventoryItem.name.toUpperCase()),
                        React.createElement('div', { style: { color: '#888', fontSize: '11px', marginTop: '4px' } }, `LOCATION: ${selectedInventoryItem.systemName}`)
                    ),
                    
                    React.createElement('div', { style: { marginBottom: '15px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'REWARD (CREDITS):'),
                        React.createElement('input', {
                            type: 'number',
                            value: contractReward,
                            onChange: (e) => setContractReward(e.target.value),
                            style: { width: '100%', background: '#000', border: '1px solid #444', color: '#ffcc00', padding: '10px', fontSize: '16px', fontFamily: 'monospace', borderRadius: '4px' }
                        })
                    ),

                    React.createElement('div', { style: { marginBottom: '15px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'COLLATERAL (REPLACEMENT COST):'),
                        React.createElement('input', {
                            type: 'number',
                            value: contractCollateral,
                            onChange: (e) => setContractCollateral(e.target.value),
                            style: { width: '100%', background: '#000', border: '1px solid #444', color: '#ff4444', padding: '10px', fontSize: '16px', fontFamily: 'monospace', borderRadius: '4px' }
                        })
                    ),

                    React.createElement('div', { style: { marginBottom: '25px' } },
                        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, `DURATION: ${contractDuration / 3600000} HOURS`),
                        React.createElement('input', {
                            type: 'range',
                            min: 3600000,
                            max: 259200000,
                            step: 3600000,
                            value: contractDuration,
                            onChange: (e) => setContractDuration(parseInt(e.target.value)),
                            style: { width: '100%', accentColor: '#00ccff' }
                        })
                    ),

                    React.createElement('div', { style: { flex: 1 } }),

                    React.createElement('div', { style: { padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', border: '1px solid #222', fontSize: '10px', color: '#888', marginBottom: '20px', lineHeight: '1.4' } },
                        'NOTE: Reward credits will be deducted immediately and held in escrow. Item will be moved from its current storage to the hauler upon pickup.'
                    ),

                    React.createElement('button', {
                        onClick: () => {
                            const contractData = {
                                item: selectedInventoryItem,
                                reward: parseFloat(contractReward),
                                collateral: parseFloat(contractCollateral),
                                duration: contractDuration,
                                originSystemId: selectedInventoryItem.systemId,
                                destinationSystemId: currentSystemId
                            };
                            gameState.onCreateContract?.(contractData);
                            setIsContractMode(false);
                            setSelectedInventoryItem(null);
                        },
                        disabled: !contractReward || parseFloat(contractReward) <= 0,
                        style: {
                            width: '100%', padding: '15px', background: '#ffcc00', border: 'none', color: '#000', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', marginBottom: '10px'
                        }
                    }, 'ISSUE CONTRACT'),
                    React.createElement('button', {
                        onClick: () => setIsContractMode(false),
                        style: {
                            width: '100%', padding: '10px', background: 'transparent', border: '1px solid #444', color: '#888', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'
                        }
                    }, 'CANCEL')
                )
            ) : selectedContract ? (
                // Selected Contract View
                React.createElement('div', { 
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '10px', minHeight: 0, display: 'flex', flexDirection: 'column' }
                },
                    React.createElement('div', { style: { color: '#fff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '10px', marginBottom: '20px' } }, 'CONTRACT SPECIFICATIONS'),
                    React.createElement('div', { style: { marginBottom: '20px', padding: '15px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '4px', borderLeft: `4px solid #ffcc00` } },
                        React.createElement('div', { style: { color: '#fff', fontWeight: 'bold', fontSize: '16px' } }, `COURIER: ${selectedContract.item.name.toUpperCase()}`),
                        React.createElement('div', { style: { color: '#ffcc00', fontSize: '11px', marginTop: '2px' } }, 'FREIGHT SERVICE'),
                        React.createElement('div', { style: { color: '#888', fontSize: '12px', marginTop: '10px', lineHeight: '1.4' } }, `Transport of ${selectedContract.item.amount} unit(s) of ${selectedContract.item.name}.`),
                        React.createElement(ItemSpecificationList, { item: selectedContract.item })
                    ),

                    React.createElement('div', { style: { background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '4px', border: '1px solid #222', marginBottom: '20px' } },
                        [
                            { label: 'ISSUER', value: selectedContract.ownerName },
                            { label: 'FROM', value: SYSTEMS_REGISTRY[selectedContract.originSystemId]?.name, color: '#00ccff' },
                            { label: 'TO', value: SYSTEMS_REGISTRY[selectedContract.destinationSystemId]?.name, color: '#00ff00' },
                            { label: 'REWARD', value: `${selectedContract.reward.toFixed(0)} Cr`, color: '#ffcc00' },
                            { label: 'COLLATERAL', value: `${selectedContract.collateral.toFixed(0)} Cr`, color: '#ff4444' },
                            { label: 'EXPIRES IN', value: formatTimeRemaining(selectedContract.expiresAt - Date.now()), color: '#888' }
                        ].map((s, i) => (
                            React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '8px' } },
                                React.createElement('span', { style: { color: '#888' } }, s.label),
                                React.createElement('span', { style: { color: s.color || '#fff', fontWeight: 'bold' } }, s.value)
                            )
                        ))
                    ),

                    React.createElement('div', { style: { flex: 1 } }),

                    React.createElement('div', { style: { padding: '12px', background: 'rgba(255, 68, 68, 0.05)', border: '1px solid rgba(255, 68, 68, 0.2)', borderRadius: '4px', fontSize: '11px', color: '#ffaaaa', marginBottom: '20px', lineHeight: '1.4' } },
                        'WARNING: Accepting this contract will immediately deduct the collateral from your account. It will be returned upon successful delivery.'
                    ),

                    React.createElement('button', {
                        onClick: () => { gameState.onAcceptContract?.(selectedContract.id); setSelectedContract(null); },
                        disabled: gameState.credits < selectedContract.collateral || selectedContract.ownerId === userId,
                        style: {
                            width: '100%', padding: '15px', background: '#00ccff', border: 'none', color: '#000', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', marginBottom: '10px', opacity: (gameState.credits < selectedContract.collateral || selectedContract.ownerId === userId) ? 0.5 : 1
                        }
                    }, 'ACCEPT CONTRACT'),
                    selectedContract.ownerId === userId && React.createElement('button', {
                        onClick: () => { onCancelContract(selectedContract.id); setSelectedContract(null); },
                        style: {
                            width: '100%', padding: '12px', background: 'rgba(255, 0, 0, 0.2)', border: '1px solid #ff4444', color: '#ff4444', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', marginBottom: '10px'
                        }
                    }, 'CANCEL CONTRACT'),
                    React.createElement('button', {
                        onClick: () => setSelectedContract(null),
                        style: {
                            width: '100%', padding: '10px', background: 'transparent', border: '1px solid #444', color: '#888', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'
                        }
                    }, 'CLOSE')
                )
            ) : selectedListing ? (
                // Selected Listing View (Buy/Bid)
                React.createElement('div', { 
                    className: 'trade-hub-scrollable',
                    style: { flex: 1, overflowY: 'auto', paddingRight: '10px', minHeight: 0, display: 'flex', flexDirection: 'column' }
                },
                    React.createElement('div', { style: { color: '#fff', fontSize: '14px', fontWeight: 'bold', letterSpacing: '2px', borderBottom: '1px solid #222', paddingBottom: '10px', marginBottom: '20px' } }, 
                        marketFilter === 'auctions' ? 'AUCTION SPECIFICATIONS' : 'COMMODITY SPECIFICATIONS'
                    ),
                    React.createElement('div', { style: { marginBottom: '20px', padding: '15px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '4px', border: '1px solid #333' } },
                        React.createElement('div', { style: { color: RARITY_COLORS[selectedListing.item.rarity] || '#fff', fontWeight: 'bold', fontSize: '14px' } }, selectedListing.item.name.toUpperCase()),
                        React.createElement('div', { style: { color: '#888', fontSize: '11px', marginTop: '4px' } }, `SELLER: ${selectedListing.ownerName}`),
                        React.createElement(ItemSpecificationList, { item: selectedListing.item })
                    ),

                    marketFilter === 'auctions' ? React.createElement(React.Fragment, null,
                        React.createElement('div', { style: { background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '4px', border: '1px solid #222', marginBottom: '20px' } },
                            [
                                { label: 'CURRENT BID', value: `${selectedListing.price.toFixed(2)} Cr`, color: '#00ff00' },
                                { label: 'MIN NEXT BID', value: `${(selectedListing.price * 1.05).toFixed(2)} Cr`, color: '#ffcc00' },
                                { label: 'EXPIRES IN', value: formatTimeRemaining(selectedListing.expiresAt - Date.now()), color: '#888' }
                            ].map((s, i) => (
                                React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '8px' } },
                                    React.createElement('span', { style: { color: '#888' } }, s.label),
                                    React.createElement('span', { style: { color: s.color || '#fff', fontWeight: 'bold' } }, s.value)
                                )
                            ))
                        ),
                        React.createElement('div', { style: { marginBottom: '20px' } },
                            React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, 'YOUR BID:'),
                            React.createElement('input', {
                                type: 'number',
                                value: bidAmount,
                                onChange: (e) => setBidAmount(e.target.value),
                                style: { width: '100%', background: '#000', border: '1px solid #444', color: '#ffcc00', padding: '10px', fontSize: '16px', fontFamily: 'monospace', borderRadius: '4px' }
                            })
                        ),
                        React.createElement('button', {
                            onClick: () => { onBid(selectedListing.id, parseFloat(bidAmount)); setSelectedListing(null); },
                            disabled: !bidAmount || parseFloat(bidAmount) < selectedListing.price * 1.05 || gameState.credits < parseFloat(bidAmount),
                            style: { width: '100%', padding: '15px', background: '#ffcc00', border: 'none', color: '#000', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '10px', opacity: (!bidAmount || parseFloat(bidAmount) < selectedListing.price * 1.05 || gameState.credits < parseFloat(bidAmount)) ? 0.5 : 1 }
                        }, 'PLACE BID')
                    ) : React.createElement(React.Fragment, null,
                        React.createElement('div', { style: { background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '4px', border: '1px solid #222', marginBottom: '20px' } },
                            [
                                { label: 'UNIT PRICE', value: `${selectedListing.price.toFixed(2)} Cr`, color: '#ffcc00' },
                                { label: 'AVAILABLE', value: `${selectedListing.quantity} UNITS`, color: '#fff' },
                                { label: 'TOTAL COST', value: `${(selectedListing.price * buyQuantity).toFixed(2)} Cr`, color: '#00ff00' }
                            ].map((s, i) => (
                                React.createElement('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '8px' } },
                                    React.createElement('span', { style: { color: '#888' } }, s.label),
                                    React.createElement('span', { style: { color: s.color || '#fff', fontWeight: 'bold' } }, s.value)
                                )
                            ))
                        ),
                        React.createElement('div', { style: { marginBottom: '20px' } },
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888', marginBottom: '8px' } },
                                React.createElement('span', null, 'QUANTITY TO PURCHASE:'),
                                React.createElement('span', { style: { color: '#00ccff', fontWeight: 'bold' } }, `${buyQuantity} UNITS`)
                            ),
                            React.createElement('input', {
                                type: 'number',
                                min: 1,
                                max: selectedListing.quantity,
                                value: buyQuantity,
                                onChange: (e) => {
                                    const val = Math.max(1, Math.min(selectedListing.quantity, parseInt(e.target.value) || 1));
                                    setBuyQuantity(val);
                                },
                                style: { 
                                    width: '100%', 
                                    background: '#000', 
                                    border: '1px solid #444', 
                                    color: '#00ccff', 
                                    padding: '8px', 
                                    fontSize: '14px', 
                                    fontFamily: 'monospace', 
                                    borderRadius: '4px', 
                                    marginBottom: '10px',
                                    boxSizing: 'border-box'
                                }
                            }),
                            React.createElement('input', {
                                type: 'range',
                                min: 1,
                                max: selectedListing.quantity,
                                value: buyQuantity,
                                onChange: (e) => setBuyQuantity(parseInt(e.target.value)),
                                style: { width: '100%', accentColor: '#00ccff', cursor: 'pointer' }
                            })
                        ),
                        React.createElement('button', {
                            onClick: () => { onBuy(selectedListing, buyQuantity); setSelectedListing(null); },
                            disabled: gameState.credits < (selectedListing.price * buyQuantity) || selectedListing.sellerId === userId,
                            style: { width: '100%', padding: '15px', background: '#00ccff', border: 'none', color: '#000', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '10px', opacity: (gameState.credits < (selectedListing.price * buyQuantity) || selectedListing.sellerId === userId) ? 0.5 : 1 }
                        }, 'PURCHASE COMMODITY')
                    ),

                    selectedListing.sellerId === userId && React.createElement('button', {
                        onClick: () => { onCancelListing(selectedListing.id); setSelectedListing(null); },
                        style: { width: '100%', padding: '12px', background: 'rgba(255, 0, 0, 0.2)', border: '1px solid #ff4444', color: '#ff4444', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '10px' }
                    }, 'CANCEL LISTING'),

                    React.createElement('button', {
                        onClick: () => setSelectedListing(null),
                        style: { width: '100%', padding: '10px', background: 'transparent', border: '1px solid #444', color: '#888', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }
                    }, 'CLOSE')
                )
            ) : null
        )
    );
};

const RepairModal = ({ shipId, gameState, repairProgress, setRepairProgress, onRepairShip, onClose }) => {
    // Combine fleet + hangar, but never show duplicates if the same ship exists in both lists.
    const allShips = [...(gameState.ownedShips || []), ...(gameState.hangarShips || [])]
        .filter((s, idx, arr) => arr.findIndex(t => t && t.id === s.id) === idx);
    const ship = allShips.find(s => s.id === shipId);
    if (!ship) return null;
    const shipConfig = SHIP_REGISTRY[resolveShipRegistryKey(ship.type) || ship.type];
    const maxHp = shipConfig?.hp || 100;
    const currentHp = ship.hp || 0;
    const missingHp = Math.max(0, maxHp - currentHp);
    
    const trackRef = React.useRef(null);
    const [isDragging, setIsDragging] = React.useState(false);

    // 1 Credit = 5 HP
    const hpToRepair = missingHp * (repairProgress / 100);
    const repairCost = Math.ceil(hpToRepair / 5);

    const updateRepairProgress = (clientX) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        const percent = Math.round((x / rect.width) * 100);
        setRepairProgress(percent);
    };

    const handlePointerDown = (e) => {
        if (e.button !== 0) return; // Only left click
        setIsDragging(true);
        updateRepairProgress(e.clientX);
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e) => {
        if (isDragging) {
            updateRepairProgress(e.clientX);
        }
    };

    const handlePointerUp = (e) => {
        setIsDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    const handleRepair = () => {
        if (gameState.credits < repairCost) return;
        onRepairShip(shipId, repairProgress);
        onClose();
    };

    return React.createElement('div', {
        style: {
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: 'rgba(0,0,0,0.8)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto'
        },
        onClick: onClose
    },
        React.createElement('div', {
            onClick: (e) => e.stopPropagation(),
            style: {
                width: '400px',
                background: 'rgba(10, 20, 30, 0.95)',
                border: '2px solid #00ccff',
                borderRadius: '8px',
                padding: '30px',
                boxShadow: '0 0 40px rgba(0, 204, 255, 0.3)',
                fontFamily: 'monospace',
                color: '#fff',
                userSelect: 'none'
            }
        },
            React.createElement('div', { style: { fontSize: '20px', fontWeight: 'bold', color: '#00ccff', marginBottom: '20px', letterSpacing: '2px' } }, 'STRUCTURAL REPAIR FACILITY'),
            React.createElement('div', { style: { marginBottom: '20px' } },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } },
                    React.createElement('span', { style: { color: '#888' } }, 'VESSEL:'),
                    React.createElement('span', { style: { fontWeight: 'bold' } }, ship.name.toUpperCase())
                ),
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } },
                    React.createElement('span', { style: { color: '#888' } }, 'HULL STATUS:'),
                    React.createElement('span', { style: { color: currentHp < maxHp * 0.3 ? '#ff4444' : '#00ff00' } }, 
                        `${((currentHp / maxHp) * 100).toFixed(1)}% (${currentHp.toFixed(0)} / ${maxHp.toFixed(0)})`
                    )
                )
            ),

            React.createElement('div', { style: { marginBottom: '25px' } },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#00ccff', marginBottom: '15px' } },
                    React.createElement('span', null, 'REPAIR INTENSITY'),
                    React.createElement('span', null, `${repairProgress}%`)
                ),
                React.createElement('div', {
                    ref: trackRef,
                    onPointerDown: handlePointerDown,
                    onPointerMove: handlePointerMove,
                    onPointerUp: handlePointerUp,
                    onPointerCancel: handlePointerUp,
                    style: {
                        position: 'relative',
                        width: '100%',
                        height: '24px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center'
                    }
                },
                    React.createElement('div', {
                        style: {
                            width: '100%',
                            height: '4px',
                            background: '#111',
                            border: '1px solid #333',
                            borderRadius: '2px'
                        }
                    }),
                    React.createElement('div', {
                        style: {
                            position: 'absolute',
                            left: 0,
                            width: `${repairProgress}%`,
                            height: '4px',
                            background: '#00ccff',
                            borderRadius: '2px',
                            boxShadow: '0 0 10px #00ccff'
                        }
                    }),
                    React.createElement('div', {
                        style: {
                            position: 'absolute',
                            left: `calc(${repairProgress}% - 9px)`,
                            width: '18px',
                            height: '18px',
                            background: '#00ccff',
                            border: '2px solid #fff',
                            borderRadius: '50%',
                            boxShadow: isDragging ? '0 0 20px #00ccff' : '0 0 10px rgba(0,204,255,0.5)',
                            transform: isDragging ? 'scale(1.2)' : 'scale(1)',
                            transition: 'all 0.1s',
                            zIndex: 2
                        }
                    })
                )
            ),

            React.createElement('div', { style: { background: 'rgba(0,0,0,0.5)', padding: '15px', borderRadius: '4px', marginBottom: '25px', border: '1px solid #333' } },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '8px' } },
                    React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, 'HULL RESTORED:'),
                    React.createElement('span', { style: { fontSize: '14px', color: '#00ff00', fontWeight: 'bold' } }, `+ ${hpToRepair.toFixed(0)} HP`)
                ),
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                    React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, 'TOTAL COST:'),
                    React.createElement('span', { style: { fontSize: '14px', color: '#ffcc00', fontWeight: 'bold' } }, `${repairCost.toLocaleString()} Cr`)
                )
            ),

            React.createElement('div', { style: { display: 'flex', gap: '15px' } },
                React.createElement('button', {
                    onClick: handleRepair,
                    disabled: repairCost === 0 || gameState.credits < repairCost,
                    style: {
                        flex: 1,
                        background: repairCost === 0 || gameState.credits < repairCost ? '#222' : 'transparent',
                        border: `2px solid ${repairCost === 0 || gameState.credits < repairCost ? '#444' : '#00ccff'}`,
                        color: repairCost === 0 || gameState.credits < repairCost ? '#444' : '#00ccff',
                        padding: '12px',
                        cursor: repairCost === 0 || gameState.credits < repairCost ? 'not-allowed' : 'pointer',
                        fontWeight: 'bold',
                        letterSpacing: '2px',
                        transition: 'all 0.2s'
                    }
                }, gameState.credits < repairCost ? 'INSUFFICIENT CREDITS' : 'AUTHORIZE REPAIR'),
                React.createElement('button', {
                    onClick: onClose,
                    style: {
                        padding: '12px 20px',
                        background: 'transparent',
                        border: '1px solid #444',
                        color: '#888',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }
                }, 'CLOSE')
            )
        )
    );
};

const StationInterior = ({ 
    onUndock, gameState, onCommandShip, onRepairShip, onSetHome, onTransferToStation, onTransferToShip, 
    onOpenFitting, onRefine, onFabricate, onOptimize, onCreateImplant, onList, onBuy, onBuyOrder, onCollect, onBid,
    onCreateContract, onAcceptContract, onPickupPackage, onDeliverPackage, onCancelListing, onCancelContract,
    onActivateShip, onDepositShip
}) => {
    const [view, setView] = useState('hangar');
    const [repairMenuShipId, setRepairMenuShipId] = useState(null);
    const [repairProgress, setRepairProgress] = useState(0); // Percentage of missing HP to repair
    const [selectedShipId, setSelectedShipId] = useState(gameState.activeShipId);
    
    // Ensure selected ship is valid or fallback to active ship
    // Combine fleet + hangar, but never show duplicates if the same ship exists in both lists.
    const allShips = [...gameState.ownedShips, ...(gameState.hangarShips || [])]
        .filter((s, idx, arr) => arr.findIndex(t => t && t.id === s.id) === idx);
    const selectedShip = allShips.find(s => s.id === selectedShipId) || 
                       allShips.find(s => s.id === gameState.activeShipId) ||
                       allShips[0];
    
    useEffect(() => {
        if (!selectedShipId && gameState.activeShipId) {
            setSelectedShipId(gameState.activeShipId);
        }
    }, [gameState.activeShipId]);
    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: '#000',
            zIndex: 2000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            animation: 'fadeIn 0.8s ease-out',
            overflow: 'hidden'
        }
    },
        // Cinematic Background Layer
        React.createElement('div', {
            style: {
                position: 'absolute',
                width: '110%', // Larger for pan effect
                height: '110%',
                backgroundImage: `url(${view === 'hangar' ? '/assets/massive-starport-hangar.webp.webp' : '/assets/starport-interior-dollhouse.png.webp'})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                opacity: 0.95,
                transition: 'all 1s ease-in-out',
                animation: 'slowPan 30s infinite alternate ease-in-out, flicker 8s infinite step-end'
            }
        }),

        React.createElement('style', null, `
            @keyframes slowPan {
                from { transform: translate(-2%, -2%) scale(1); }
                to { transform: translate(2%, 2%) scale(1.05); }
            }
            @keyframes scanline {
                0% { transform: translateY(-100%); }
                100% { transform: translateY(100%); }
            }
            @keyframes flicker {
                0% { opacity: 0.95; }
                5% { opacity: 0.9; }
                10% { opacity: 0.95; }
                15% { opacity: 0.85; }
                20% { opacity: 0.95; }
            }
        `),
        
        // Scanlines/Hologram Overlay
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 2px)',
                pointerEvents: 'none',
                zIndex: 5
            }
        }),

        // High-speed scanline effect
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100px',
                background: 'linear-gradient(to bottom, transparent, rgba(0, 204, 255, 0.05), transparent)',
                animation: 'scanline 4s linear infinite',
                pointerEvents: 'none',
                zIndex: 6
            }
        }),

        // UI Header
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: '40px',
                left: '220px',
                right: '40px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                zIndex: 10,
                textShadow: '0 0 10px rgba(0,0,0,0.8)'
            }
        },
            React.createElement('div', null,
                React.createElement('div', { style: { color: '#fff', fontSize: '32px', fontWeight: 'bold', letterSpacing: '6px' } }, `${gameState.currentSystem?.name?.toUpperCase()} STARPORT`),
                React.createElement('div', { style: { color: '#00ccff', fontSize: '16px', marginTop: '6px', opacity: 0.8 } }, `SECTOR ${gameState.currentSystem?.sector} // OMNI DIRECTORATE INDUSTRIAL ANCHOR`)
            ),
            React.createElement('div', { style: { textAlign: 'right' } },
                React.createElement('div', { style: { color: '#00ff00', fontSize: '18px', fontWeight: 'bold', letterSpacing: '1px' } }, 'DOCKING STATUS: SECURED'),
                React.createElement('div', { style: { color: '#aaa', fontSize: '12px', marginTop: '4px' } }, 'INTERNAL ATMOSPHERE: NOMINAL (O2 21%)')
            )
        ),

        // Side Navigation for Station Sections
        React.createElement('div', {
            style: {
                position: 'absolute',
                left: '40px',
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'flex',
                flexDirection: 'column',
                gap: '15px',
                zIndex: 50 // Increased to stay above central panels
            }
        },
            [
                { id: 'hangar', label: 'MAIN HANGAR', icon: '🚀' },
                { id: 'storage', label: 'STORAGE BAY', icon: '📦' },
                { id: 'optimization', label: 'OPTIMIZATION HANGAR', icon: '⚡' },
                { id: 'biomedical', label: 'BIO-MEDICAL', icon: '🧬' },
                { id: 'fabrication', label: 'FABRICATION BAY', icon: '🛠️' },
                { id: 'refinery', label: 'REFINERY', icon: '🏭' },
                { id: 'trade', label: 'TRADE HUB', icon: '💎' }
            ].map(item => (
                React.createElement('div', {
                    key: item.id,
                    onClick: () => !item.disabled && setView(item.id),
                    style: {
                        padding: '12px 20px',
                        background: view === item.id ? 'rgba(0, 204, 255, 0.2)' : 'rgba(0,0,0,0.6)',
                        border: `1px solid ${view === item.id ? '#00ccff' : '#444'}`,
                        color: item.disabled ? '#555' : (view === item.id ? '#fff' : '#aaa'),
                        fontSize: '13px',
                        fontWeight: 'bold',
                        letterSpacing: '2px',
                        cursor: item.disabled ? 'default' : 'pointer',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        transition: 'all 0.2s',
                        pointerEvents: 'auto',
                        boxShadow: view === item.id ? '0 0 15px rgba(0, 204, 255, 0.2)' : 'none'
                    },
                    onMouseEnter: (e) => {
                        if (!item.disabled) {
                            e.currentTarget.style.background = 'rgba(0, 204, 255, 0.1)';
                            e.currentTarget.style.borderColor = '#00ccff';
                        }
                    },
                    onMouseLeave: (e) => {
                        if (view !== item.id && !item.disabled) {
                            e.currentTarget.style.background = 'rgba(0,0,0,0.6)';
                            e.currentTarget.style.borderColor = '#444';
                        }
                    }
                }, 
                    React.createElement('span', { style: { fontSize: '16px' } }, item.icon),
                    item.label
                )
            ))
        ),

        // Station Utility Actions (e.g., Set Home)
        React.createElement('div', {
            style: {
                position: 'absolute',
                left: '40px',
                bottom: '60px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                zIndex: 50 // Increased to stay above central panels
            }
        },
            React.createElement('div', {
                onClick: onSetHome,
                style: {
                    padding: '12px 20px',
                    background: gameState.homeSystemId === gameState.currentSystem?.id ? 'rgba(0, 255, 102, 0.15)' : 'rgba(0,0,0,0.6)',
                    border: `1px solid ${gameState.homeSystemId === gameState.currentSystem?.id ? '#00ff66' : '#444'}`,
                    color: gameState.homeSystemId === gameState.currentSystem?.id ? '#00ff66' : '#aaa',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    letterSpacing: '2px',
                    cursor: 'pointer',
                    borderRadius: '2px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    transition: 'all 0.2s',
                    pointerEvents: 'auto',
                    boxShadow: gameState.homeSystemId === gameState.currentSystem?.id ? '0 0 15px rgba(0, 255, 102, 0.2)' : 'none'
                },
                onMouseEnter: (e) => {
                    e.currentTarget.style.background = 'rgba(0, 255, 102, 0.1)';
                    e.currentTarget.style.borderColor = '#00ff66';
                },
                onMouseLeave: (e) => {
                    e.currentTarget.style.background = gameState.homeSystemId === gameState.currentSystem?.id ? 'rgba(0, 255, 102, 0.15)' : 'rgba(0,0,0,0.6)';
                    e.currentTarget.style.borderColor = gameState.homeSystemId === gameState.currentSystem?.id ? '#00ff66' : '#444';
                }
            },
                React.createElement('span', { style: { fontSize: '18px' } }, '🏠'),
                React.createElement('span', null, gameState.homeSystemId === gameState.currentSystem?.id ? 'HOME PORT REGISTERED' : 'SET AS HOME PORT')
            )
        ),

        // Central Content Area
        view === 'hangar' && React.createElement('div', {
            style: {
                position: 'absolute',
                top: '160px',
                bottom: '140px',
                left: '300px', 
                right: '40px',
                display: 'flex',
                gap: '24px',
                zIndex: 30,
                pointerEvents: 'none',
                animation: 'fadeIn 0.4s ease-out'
            }
        },
            // Left Pane: Fleet Manifest
            React.createElement('div', {
                style: {
                    flex: 1.2,
                    background: 'rgba(0, 5, 10, 0.9)',
                    border: '1px solid #444',
                    borderRadius: '4px',
                    padding: '30px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '20px',
                    boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
                    pointerEvents: 'auto'
                }
            },
                React.createElement('div', { style: { fontSize: '22px', color: '#00ccff', fontWeight: 'bold', letterSpacing: '4px', borderBottom: '1px solid #333', paddingBottom: '15px' } }, 'STARDOCK // FLEET MANIFEST'),
                
                React.createElement('div', {
                    onWheel: (e) => e.stopPropagation(),
                    style: {
                        flex: 1,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                        paddingRight: '10px',
                        scrollbarWidth: 'thin',
                        scrollbarColor: '#00ccff rgba(0,0,0,0.3)'
                    }
                },
                    allShips.map(ship => {
                        const isCommanded = gameState.activeShipId === ship.id;
                        const isSelected = selectedShipId === ship.id;
                        const isInHangar = (gameState.hangarShips || []).some(s => s.id === ship.id);
                        const shipConfig = SHIP_REGISTRY[resolveShipRegistryKey(ship.type) || ship.type];
                        const isDamaged = ship.hp !== undefined && ship.hp < (shipConfig?.hp || 0) - 0.5;
                        
                        return React.createElement('div', {
                            key: ship.id,
                            onClick: () => setSelectedShipId(ship.id),
                            style: {
                                padding: '20px',
                                background: isSelected ? 'rgba(0, 204, 255, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                                border: `1px solid ${isSelected ? '#00ccff' : (isCommanded ? '#444' : '#333')}`,
                                borderRadius: '4px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                transition: 'all 0.2s',
                                cursor: 'pointer'
                            }
                        },
                            // Ship Icon & Basic Info
                            React.createElement('div', { style: { display: 'flex', gap: '20px', alignItems: 'center' } },
                                React.createElement('div', {
                                    style: {
                                        width: '60px',
                                        height: '60px',
                                        background: '#111',
                                        border: `1px solid ${isSelected ? '#00ccff' : '#444'}`,
                                        borderRadius: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        position: 'relative'
                                    }
                                }, 
                                    React.createElement('img', {
                                        src: shipConfig?.spriteUrl || '/assets/spaceship.png.webp',
                                        style: { 
                                            width: `${40 * (shipConfig?.uiScale || 1.0)}px`, 
                                            transform: 'rotate(-45deg)', 
                                            opacity: isSelected || isCommanded ? 1 : 0.6 
                                        }
                                    }),
                                    isCommanded && React.createElement('div', {
                                        style: {
                                            position: 'absolute',
                                            top: '-5px',
                                            right: '-5px',
                                            background: '#00ff00',
                                            color: '#000',
                                            fontSize: '8px',
                                            fontWeight: 'bold',
                                            padding: '2px 4px',
                                            borderRadius: '2px',
                                            boxShadow: '0 0 10px rgba(0,255,0,0.5)'
                                        }
                                    }, 'ACTIVE'),
                                    isInHangar && !isCommanded && React.createElement('div', {
                                        style: {
                                            position: 'absolute',
                                            top: '-5px',
                                            right: '-5px',
                                            background: '#ffcc00',
                                            color: '#000',
                                            fontSize: '8px',
                                            fontWeight: 'bold',
                                            padding: '2px 4px',
                                            borderRadius: '2px',
                                            boxShadow: '0 0 10px rgba(255,204,0,0.5)'
                                        }
                                    }, 'STORED')
                                ),
                                React.createElement('div', null,
                                    React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', color: isSelected ? '#00ccff' : '#fff' } }, (ship.name || 'UNKNOWN').toUpperCase()),
                                    React.createElement('div', { style: { fontSize: '10px', color: '#888', marginTop: '4px' } }, `${String(getShipDisplayName(ship.type) || shipConfig?.name || ship.name || ship.type || 'UNKNOWN').toUpperCase()} CLASS // REGISTRY: ${ship.id}`)
                                )
                            ),
                            
                            // Stats Row (Condensed for Manifest)
                            React.createElement('div', { style: { display: 'flex', gap: '20px' } },
                                [
                                    { label: 'HULL', value: (ship.hp || shipConfig?.hp || 0).toFixed(0), color: '#ff4444' },
                                    { label: 'PG', value: (ship.basePG || shipConfig?.basePG || 0).toFixed(0), color: '#ffcc00' },
                                    { label: 'CPU', value: (ship.baseCPU || shipConfig?.baseCPU || 0).toFixed(0), color: '#00ccff' },
                                    { label: 'GRADE', value: ship.qualityTier?.toUpperCase() || 'STD', color: ship.avgQL > 120 ? '#00ff00' : '#888' }
                                ].map(stat => (
                                    React.createElement('div', { key: stat.label, style: { textAlign: 'center' } },
                                        React.createElement('div', { style: { fontSize: '8px', color: '#555', marginBottom: '4px' } }, stat.label),
                                        React.createElement('div', { style: { fontSize: '11px', fontWeight: 'bold', color: stat.color } }, stat.value)
                                    )
                                ))
                            ),
                            
                            // Action Column
                            React.createElement('div', { style: { display: 'flex', flexDirection: 'row', gap: '8px', alignItems: 'center' } },
                                isDamaged && React.createElement('button', {
                                    onClick: (e) => { e.stopPropagation(); setRepairMenuShipId(ship.id); setRepairProgress(100); },
                                    style: {
                                        width: '32px',
                                        height: '32px',
                                        background: 'rgba(255, 165, 0, 0.1)',
                                        border: '1px solid #ffa500',
                                        color: '#ffa500',
                                        cursor: 'pointer',
                                        borderRadius: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        transition: 'all 0.2s'
                                    },
                                    onMouseEnter: (e) => { e.currentTarget.style.background = '#ffa500'; e.currentTarget.style.color = '#000'; },
                                    onMouseLeave: (e) => { e.currentTarget.style.background = 'rgba(255, 165, 0, 0.1)'; e.currentTarget.style.color = '#ffa500'; }
                                }, 
                                    React.createElement('span', { style: { fontSize: '16px' } }, '🔧')
                                ),
                                isCommanded ? React.createElement('div', {
                                    style: {
                                        padding: '8px 16px',
                                        height: '32px',
                                        background: 'rgba(0, 255, 0, 0.1)',
                                        border: '1px solid #00ff00',
                                        color: '#00ff00',
                                        fontSize: '9px',
                                        fontWeight: 'bold',
                                        letterSpacing: '1px',
                                        textAlign: 'center',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        boxSizing: 'border-box'
                                    }
                                }, 'IN CONTROL') : (
                                    isInHangar ? React.createElement('button', {
                                        onClick: (e) => { e.stopPropagation(); onActivateShip(ship); },
                                        style: {
                                            padding: '8px 16px',
                                            height: '32px',
                                            background: 'transparent',
                                            border: '1px solid #ffcc00',
                                            color: '#ffcc00',
                                            fontSize: '9px',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            letterSpacing: '1px',
                                            transition: 'all 0.2s',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                        },
                                        onMouseEnter: (e) => { e.target.style.background = '#ffcc00'; e.target.style.color = '#000'; },
                                        onMouseLeave: (e) => { e.target.style.background = 'transparent'; e.target.style.color = '#ffcc00'; }
                                    }, 'ACTIVATE') : React.createElement(React.Fragment, null,
                                        React.createElement('button', {
                                            onClick: (e) => { e.stopPropagation(); onCommandShip(ship.id); },
                                            style: {
                                                padding: '8px 16px',
                                                height: '32px',
                                                background: 'transparent',
                                                border: '1px solid #00ccff',
                                                color: '#00ccff',
                                                fontSize: '9px',
                                                fontWeight: 'bold',
                                                cursor: 'pointer',
                                                letterSpacing: '1px',
                                                transition: 'all 0.2s',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center'
                                            },
                                            onMouseEnter: (e) => { e.target.style.background = '#00ccff'; e.target.style.color = '#000'; },
                                            onMouseLeave: (e) => { e.target.style.background = 'transparent'; e.target.style.color = '#00ccff'; }
                                        }, 'MAKE CURRENT'),
                                        React.createElement('button', {
                                            onClick: (e) => { e.stopPropagation(); onDepositShip(ship); },
                                            style: {
                                                padding: '8px 16px',
                                                height: '32px',
                                                background: 'transparent',
                                                border: '1px solid #ff4444',
                                                color: '#ff4444',
                                                fontSize: '9px',
                                                fontWeight: 'bold',
                                                cursor: 'pointer',
                                                letterSpacing: '1px',
                                                transition: 'all 0.2s',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center'
                                            },
                                            onMouseEnter: (e) => { e.target.style.background = '#ff4444'; e.target.style.color = '#000'; },
                                            onMouseLeave: (e) => { e.target.style.background = 'transparent'; e.target.style.color = '#ff4444'; }
                                        }, 'DEPOSIT')
                                    )
                                )
                            )
                        );
                    })
                )
            ),

            // Right Pane: Ship Statistics
            React.createElement('div', {
                style: {
                    flex: 0.8,
                    background: 'rgba(0, 5, 10, 0.9)',
                    border: '1px solid #444',
                    borderRadius: '4px',
                    padding: '30px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '20px',
                    boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
                    pointerEvents: 'auto',
                    animation: 'fadeIn 0.6s ease-out',
                    overflow: 'hidden',
                    minHeight: 0
                }
            },
                selectedShip ? (
                    React.createElement(ShipStatistics, { 
                        ship: selectedShip, 
                        fittings: selectedShip.id === gameState.activeShipId ? gameState.fittings : (selectedShip.fittings || {})
                    },
                        // Fitting Action
                        React.createElement('div', { style: { display: 'flex', gap: '10px', marginTop: '10px' } },
                            React.createElement('button', {
                                onClick: () => {
                                    if (selectedShip.id !== gameState.activeShipId) onCommandShip(selectedShip.id);
                                    onOpenFitting();
                                },
                                style: {
                                    flex: 1,
                                    padding: '12px',
                                    background: 'transparent',
                                    border: '1px solid #ffcc00',
                                    color: '#ffcc00',
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    cursor: 'pointer',
                                    letterSpacing: '2px',
                                    transition: 'all 0.2s',
                                    boxShadow: '0 0 15px rgba(255,204,0,0.1)',
                                    flexShrink: 0
                                },
                                onMouseEnter: (e) => { e.target.style.background = '#ffcc00'; e.target.style.color = '#000'; e.target.style.boxShadow = '0 0 25px rgba(255,204,0,0.3)'; },
                                onMouseLeave: (e) => { e.target.style.background = 'transparent'; e.target.style.color = '#ffcc00'; e.target.style.boxShadow = '0 0 15px rgba(255,204,0,0.1)'; }
                            }, 'ACCESS SHIP FITTING'),

                            // Repair Button inside stats pane
                            selectedShip.hp < (SHIP_REGISTRY[selectedShip.type]?.hp || 0) && React.createElement('button', {
                                onClick: (e) => { 
                                    e.stopPropagation(); 
                                    setRepairMenuShipId(selectedShip.id); 
                                    setRepairProgress(100); 
                                },
                                style: {
                                    width: '120px',
                                    padding: '12px',
                                    background: 'rgba(255, 165, 0, 0.1)',
                                    border: '1px solid #ffa500',
                                    color: '#ffa500',
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    cursor: 'pointer',
                                    letterSpacing: '2px',
                                    transition: 'all 0.2s',
                                    boxShadow: '0 0 15px rgba(255,165,0,0.1)',
                                    flexShrink: 0
                                },
                                onMouseEnter: (e) => { e.target.style.background = '#ffa500'; e.target.style.color = '#000'; },
                                onMouseLeave: (e) => { e.target.style.background = 'rgba(255, 165, 0, 0.1)'; e.target.style.color = '#ffa500'; }
                            }, 'REPAIR')
                        )
                    )
                ) : (
                    React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: '12px', letterSpacing: '2px', textAlign: 'center' } }, 
                        'SELECT A VESSEL FROM THE MANIFEST TO VIEW TECHNICAL TELEMETRY'
                    )
                )
            )
        ),

        view === 'storage' && React.createElement(StorageBay, { 
            gameState, 
            onTransferToStation, 
            onTransferToShip 
        }),

        view === 'refinery' && React.createElement(RefineryMenu, {
            gameState,
            onRefine
        }),

        view === 'fabrication' && React.createElement(FabricationBay, {
            gameState,
            onFabricate
        }),

        view === 'optimization' && React.createElement(OptimizationHangar, {
            gameState,
            onOptimize
        }),

        view === 'biomedical' && React.createElement(BioMedicalMenu, {
            gameState,
            onCreateImplant: onCreateImplant
        }),

        view === 'trade' && React.createElement(TradeHub, {
            gameState: {
                ...gameState,
                onCreateContract,
                onAcceptContract
            },
            onList: onList,
            onBuy: onBuy,
            onBuyOrder: onBuyOrder,
            onCollect: onCollect,
            onStore: onTransferToStation,
            onBid: onBid,
            onDeliverPackage: onDeliverPackage,
            onPickupPackage: onPickupPackage,
            onCancelListing: onCancelListing,
            onCancelContract: onCancelContract,
            gameManager: null // Pass if needed, or null if handled by props
        }),

        repairMenuShipId && React.createElement(RepairModal, {
            shipId: repairMenuShipId,
            gameState,
            repairProgress,
            setRepairProgress,
            onRepairShip: onRepairShip,
            onClose: () => setRepairMenuShipId(null)
        }),

        // Main Interaction Button (Undock)
        gameState.activeShipId && React.createElement('button', {
            onClick: onUndock,
            style: {
                position: 'absolute',
                bottom: '60px',
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '16px 60px',
                background: 'rgba(0,10,20,0.9)',
                border: '2px solid #00ccff',
                color: '#00ccff',
                fontFamily: 'monospace',
                fontSize: '18px',
                fontWeight: 'bold',
                letterSpacing: '4px',
                cursor: 'pointer',
                borderRadius: '4px',
                zIndex: 100, // Elevated to ensure click capture over other UI elements
                boxShadow: '0 0 30px rgba(0,204,255,0.4)',
                transition: 'all 0.3s cubic-bezier(0.19, 1, 0.22, 1)',
                pointerEvents: 'auto'
            },
            onMouseEnter: (e) => {
                e.target.style.background = '#00ccff';
                e.target.style.color = '#000';
                e.target.style.transform = 'translateX(-50%) scale(1.05)';
                e.target.style.boxShadow = '0 0 50px rgba(0,204,255,0.6)';
            },
            onMouseLeave: (e) => {
                e.target.style.background = 'rgba(0,10,20,0.9)';
                e.target.style.color = '#00ccff';
                e.target.style.transform = 'translateX(-50%) scale(1)';
                e.target.style.boxShadow = '0 0 30px rgba(0,204,255,0.4)';
            }
        }, `INITIATE LAUNCH SEQUENCE: ${gameState.shipName?.toUpperCase() || 'COMMANDED SHIP'}`)
    );
};

const ShipMenu = ({ gameState, onClose, onSelectSlot }) => {
    const { offset, isDragging, dragProps } = useDraggable();
    const [showFullStats, setShowFullStats] = useState(false);
    
    // Live recalculation of usage stats for display synchronization
    const { power: currentPower, cpu: currentCpu } = getLiveShipResources(gameState.fittings);
    const hasAnyModules = Object.values(gameState.fittings).some(f => f !== null);
    
    const activeShip = gameState.ownedShips.find(s => s.id === gameState.activeShipId);
    const shipConfig = SHIP_REGISTRY[activeShip?.type];
    const spriteUrl = shipConfig?.spriteUrl || '/assets/spaceship.png.webp';

    const slots = [
        { id: 'weapon1', type: 'weapon', label: 'W1', position: { x: '25%', y: '12%' } },
        { id: 'weapon2', type: 'weapon', label: 'W2', position: { x: '50%', y: '12%' } },
        { id: 'weapon3', type: 'weapon', label: 'W3', position: { x: '75%', y: '12%' } },
        { id: 'active1', type: 'active', label: 'C1', position: { x: '20%', y: '38%' } },
        { id: 'active2', type: 'active', label: 'C2', position: { x: '40%', y: '38%' } },
        { id: 'active3', type: 'active', label: 'C3', position: { x: '60%', y: '38%' } },
        { id: 'active4', type: 'active', label: 'C4', position: { x: '80%', y: '38%' } },
        { id: 'passive1', type: 'passive', label: 'U1', position: { x: '20%', y: '62%' } },
        { id: 'passive2', type: 'passive', label: 'U2', position: { x: '40%', y: '62%' } },
        { id: 'passive3', type: 'passive', label: 'U3', position: { x: '60%', y: '62%' } },
        { id: 'passive4', type: 'passive', label: 'U4', position: { x: '80%', y: '62%' } },
        { id: 'rig1', type: 'rig', label: 'R1', position: { x: '20%', y: '85%' } },
        { id: 'rig2', type: 'rig', label: 'R2', position: { x: '40%', y: '85%' } },
        { id: 'rig3', type: 'rig', label: 'R3', position: { x: '60%', y: '85%' } },
        { id: 'rig4', type: 'rig', label: 'R4', position: { x: '80%', y: '85%' } },
    ].filter(s => s.id in gameState.fittings);

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            display: 'flex',
            zIndex: 2500,
            pointerEvents: 'none',
            transition: isDragging ? 'none' : 'transform 0.6s cubic-bezier(0.19, 1, 0.22, 1)'
        }
    },
        // Main Diagnostic Window
        React.createElement('div', {
            style: {
                width: '500px',
                height: '650px',
                background: 'rgba(20, 20, 25, 0.98)',
                border: showFullStats ? '2px solid #00ccff' : '2px solid #555',
                borderRadius: '8px',
                boxShadow: showFullStats ? '0 0 40px rgba(0,204,255,0.2)' : '0 0 30px rgba(0,0,0,0.9), inset 0 0 20px rgba(0,255,255,0.05)',
                padding: '30px',
                color: '#fff',
                fontFamily: 'monospace',
                pointerEvents: 'auto',
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
                transition: 'all 0.3s ease',
            }
        },
            // Header / Draggable Handle
            React.createElement('div', {
                ...dragProps,
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '60px',
                    cursor: 'grab',
                    zIndex: 5
                }
            }),

            // Close Button
            React.createElement('button', {
                onClick: onClose,
                onPointerDown: (e) => e.stopPropagation(),
                style: {
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    cursor: 'pointer',
                    color: '#888',
                    fontSize: '18px',
                    zIndex: 10,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontFamily: 'inherit'
                }
            }, '✕'),

            // Title
            React.createElement('div', {
                style: {
                    fontSize: '22px',
                    fontWeight: 'bold',
                    color: '#00ccff',
                    marginBottom: '20px',
                    borderBottom: '1px solid #444',
                    paddingBottom: '10px',
                    letterSpacing: '2px',
                    pointerEvents: 'none'
                }
            }, showFullStats ? 'SHIP STATISTICS' : 'SHIP SYSTEMS'),

            // Main Content Area
            React.createElement('div', {
                onWheel: (e) => e.stopPropagation(),
                style: {
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    paddingRight: '5px'
                }
            },
                !showFullStats ? 
                // Diagnostic View
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '15px' } },
                    React.createElement('div', {
                        style: {
                            width: '100%',
                            background: 'radial-gradient(circle, #222 0%, #111 100%)',
                            borderRadius: '4px',
                            border: '1px solid #333',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            height: '260px', // Increased from 190px
                            overflow: 'hidden',
                            userSelect: 'none'
                        }
                    },
                        React.createElement('div', {
                            style: {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                background: 'repeating-linear-gradient(0deg, rgba(0,255,255,0.03) 0px, rgba(0,255,255,0.03) 1px, transparent 1px, transparent 2px)',
                                pointerEvents: 'none'
                            }
                        }),
                        React.createElement('img', {
                            src: spriteUrl,
                            draggable: false,
                            style: {
                                width: `${240 * (shipConfig?.uiScale || 1.0)}px`, 
                                height: 'auto',
                                filter: 'drop-shadow(0 0 10px rgba(0,204,255,0.4)) brightness(0.7)',
                                imageRendering: 'pixelated',
                                transform: 'rotate(-45deg)',
                                pointerEvents: 'none',
                                transition: 'filter 0.3s ease'
                            }
                        }),
                        // Background overlay for slots area
                        React.createElement('div', {
                            style: {
                                position: 'absolute',
                                width: '100%',
                                height: '100%',
                                background: 'radial-gradient(circle, transparent 30%, rgba(0,0,0,0.4) 100%)',
                                pointerEvents: 'none'
                            }
                        }),
                        slots.map(slot => React.createElement(FittingSlot, {
                            key: slot.id,
                            ...slot,
                            equipped: gameState.fittings[slot.id],
                            onClick: () => onSelectSlot(slot)
                        }))
                    ),

                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
                        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '15px' } },
                            React.createElement('div', { style: { fontSize: '24px', fontWeight: 'bold', color: '#fff' } }, gameState.shipName.toUpperCase()),
                            React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                                ['synapse1', 'synapse2', 'synapse3'].map(id => React.createElement(SynapseSlot, {
                                    key: id,
                                    id: id,
                                    equipped: gameState.fittings[id],
                                    onClick: () => onSelectSlot({ id, type: 'synapse', label: 'SYN' })
                                }))
                            )
                        ),
                        React.createElement('div', { style: { fontSize: '12px', color: '#00ccff', fontWeight: 'bold', marginBottom: '5px', opacity: 0.8 } }, `${String(gameState.shipClass || 'VESSEL').toUpperCase()} CLASS`),
                        React.createElement('div', { style: { display: 'flex', gap: '15px' } },
                            // Left Column: Vitals
                            React.createElement('div', { style: { flex: 1 } },
                                [
                                    { label: 'HULL', value: `${(gameState.hp || 0).toFixed(1)}/${gameState.maxHp.toFixed(1)}`, color: '#ff4444' },
                                    { label: 'SHIELDS', value: gameState.maxShields > 0 ? `${(gameState.shields || 0).toFixed(1)}/${gameState.maxShields.toFixed(1)}` : 'OFFLINE', color: '#00ccff' },
                                    { label: 'ENERGY', value: `${(gameState.energy || 0).toFixed(1)}/${gameState.maxEnergy}`, color: '#00ff00' },
                                    { label: 'PWR GRID', value: `${(hasAnyModules ? currentPower : 0).toFixed(1)} / ${gameState.maxPowerGrid}`, color: '#ffcc00' },
                                    { label: 'CPU', value: `${(hasAnyModules ? currentCpu : 0).toFixed(1)} / ${gameState.maxCpu}`, color: '#00ccff' }
                                ].map((stat, i) => 
                                    React.createElement('div', { key: i, style: { marginBottom: '5px', fontSize: '13px' } },
                                        React.createElement('span', { style: { color: '#888' } }, `${stat.label}: `),
                                        React.createElement('span', { style: { color: stat.color, fontWeight: 'bold' } }, stat.value)
                                    )
                                )
                            ),
                            // Right Column: Tactical Data
                            React.createElement('div', { style: { flex: 1, borderLeft: '1px solid #333', paddingLeft: '15px' } },
                                (() => {
                                    // Use simple aggregation for the summary view
                                    const dps = Object.values(gameState.fittings)
                                        .filter(f => f && f.type === 'weapon')
                                        .reduce((sum, w) => {
                                            const effective = w.final_stats ? w : hydrateItem(w);
                                            const fs = effective.final_stats;
                                            const nameLower = (w.name || '').toLowerCase();
                                            
                                            if (nameLower.includes('flux')) {
                                                return sum + (fs.damagePerTick * fs.fireRate);
                                            } else if (nameLower.includes('pulse')) {
                                                const cycleTime = (fs.magazine / fs.fireRate) + fs.reload;
                                                return sum + ((fs.magazine * fs.damage) / cycleTime);
                                            } else if (nameLower.includes('seeker') || nameLower.includes('missile')) {
                                                return sum + (fs.damage / fs.reload);
                                            }
                                            return sum + ((fs.damage || 0) / (fs.fireRate || 1));
                                        }, 0);
                                    
                                    const miningRate = Object.values(gameState.fittings)
                                        .filter(f => f && f.type === 'mining')
                                        .reduce((sum, m) => {
                                            const effective = m.final_stats ? m : hydrateItem(m);
                                            const fs = effective.final_stats;
                                            return sum + (fs.baseExtraction * (60 / fs.fireRate));
                                        }, 0);

                                    const avgRes = (gameState.kineticRes + gameState.thermalRes + gameState.blastRes) / 3;
                                    const ehp = (gameState.hp + gameState.shields) / Math.max(0.01, 1 - avgRes);
                                    
                                    const thrusterBoost = Object.values(gameState.fittings)
                                        .filter(f => f && f.type === 'thruster')
                                        .reduce((sum, t) => {
                                            const effective = t.final_stats ? t : hydrateItem(t);
                                            return sum + effective.final_stats.speedBoost;
                                        }, 0);

                                    const stats = [
                                        { label: 'DPS', value: `${dps.toFixed(1)} u/s`, color: '#ffcc00' },
                                        { label: 'EHP', value: `${ehp.toFixed(1)} u`, color: '#ffffff' },
                                        { label: 'SIGNATURE', value: `${(gameState.sigRadius || 30).toFixed(1)}m`, color: '#ff4444' }
                                    ];

                                    if (miningRate > 0) {
                                        stats.push({ label: 'MINING', value: `${miningRate.toFixed(1)} ore/min`, color: '#00ccff' });
                                    }

                                    if (thrusterBoost > 0) {
                                        stats.push({ label: 'BOOST', value: `+${thrusterBoost}% Vel`, color: '#00ff00' });
                                    }
                                    
                                    return stats.map((stat, i) => 
                                        React.createElement('div', { key: i, style: { marginBottom: '5px', fontSize: '13px' } },
                                            React.createElement('span', { style: { color: '#888' } }, `${stat.label}: `),
                                            React.createElement('span', { style: { color: stat.color, fontWeight: 'bold' } }, stat.value)
                                        )
                                    );
                                })()
                            )
                        )
                    )
                ) : 
                // Full Stats View
                React.createElement(ShipStatistics, { ship: activeShip, fittings: gameState.fittings })
            ),

            // Toggle Button
            React.createElement('button', {
                onClick: () => setShowFullStats(!showFullStats),
                onPointerDown: (e) => e.stopPropagation(),
                style: {
                    marginTop: '24px',
                    background: showFullStats ? '#00ccff' : 'transparent',
                    border: '1px solid #00ccff',
                    color: showFullStats ? '#000' : '#00ccff',
                    fontSize: '14px', // Increased from 10px
                    padding: '12px 12px', // Increased padding
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                    fontWeight: 'bold',
                    width: '100%',
                    transition: 'all 0.2s',
                    letterSpacing: '1px'
                }
            }, showFullStats ? 'RETURN TO SHIP FITTING' : 'SHIP STATISTICS'),

            // Bottom Decorative Text
            React.createElement('div', {
                style: {
                    marginTop: '15px',
                    fontSize: '9px',
                    color: '#555',
                    textAlign: 'center',
                    fontStyle: 'italic'
                }
            }, 'S-CORE CLASS RECONNAISSANCE VESSEL // AUTHENTICATED ACCESS')
        )
    );
};

const FittingSelectMenu = ({ slot, equipped, inventory, onSelect, onUnfit, onToggleGroup, onClose, gameState, isDocked }) => {
    const getFormattedTitle = () => {
        if (slot.type === 'outfit') return `BODY SLOT: ${slot.fullName}`;
        if (slot.type === 'implant') return `IMPLANT LOCATION: ${slot.fullName}`;
        if (slot.type === 'weapon') return `HARDPOINT: WEAPON ${slot.id.replace('weapon', '')}`;
        if (slot.type === 'mining') return `HARDPOINT: MINING LASER`;
        if (slot.type === 'active') return `SYSTEM: CORE FITTING`;
        if (slot.type === 'passive') return `SYSTEM: UTILITY FITTING`;
        if (slot.type === 'rig') return `HULL: RIG FITTING`;
        return `HARDPOINT: ${slot.type.toUpperCase()}`;
    };

    const formattedTitle = getFormattedTitle();
    const isShipFitting = slot.type !== 'outfit' && slot.type !== 'implant';
    const isWeaponSlot = slot.type === 'weapon' || slot.type === 'mining';

    const renderHardwareSelection = () => {
        const getHardwareTitle = () => {
            if (slot.type === 'active') return `CORE HARDWARE`;
            if (slot.type === 'passive') return `UTILITY HARDWARE`;
            return `${slot.type.toUpperCase()} HARDWARE`;
        };

        const hardwareTitle = getHardwareTitle();

        return React.createElement(React.Fragment, null,
            React.createElement('div', {
                style: { fontSize: '11px', color: '#888', marginBottom: '10px', display: 'flex', justifyContent: 'space-between' }
            }, 
                React.createElement('span', null, hardwareTitle),
                !isDocked && React.createElement('span', { style: { color: '#ffcc00', fontSize: '9px' } }, 'VIEW-ONLY MODE')
            ),
            
            React.createElement('div', {
                onWheel: (e) => e.stopPropagation(),
                style: { maxHeight: '160px', overflowY: 'auto', marginBottom: '15px', border: '1px solid #333', background: 'rgba(0,0,0,0.2)', paddingRight: '8px' }
            },
                inventory.length === 0 ? 
                React.createElement('div', { style: { color: '#444', fontSize: '11px', textAlign: 'center', padding: '20px' } }, '--- NO COMPATIBLE COMPONENT DETECTED ---') :
                inventory.map((item, i) => {
                    let pwrError = false;
                    let cpuError = false;

                    if (isShipFitting) {
                        const nextFittings = { ...gameState.fittings, [slot.id]: item };
                        const { power, cpu } = getLiveShipResources(nextFittings);
                        pwrError = power > gameState.maxPowerGrid;
                        cpuError = cpu > gameState.maxCpu;
                    }

                    const stats = getCommanderStats(gameState);
                    let statError = false;
                    if (item.requiredStatType && item.requiredStatValue) {
                        const currentStatValue = item.requiredStatType === 'Neural Stability' ? stats.neuralStability :
                                               item.requiredStatType === 'Bio-Tolerance' ? stats.bioTolerance :
                                               item.requiredStatType === 'Motor Integration' ? stats.motorIntegration : 0;
                        if (currentStatValue < item.requiredStatValue) {
                            statError = true;
                        }
                    }

                    return React.createElement('button', {
                        key: i,
                        onClick: () => isDocked && !statError && onSelect(item),
                        onPointerDown: (e) => e.stopPropagation(),
                        title: !isDocked ? "Module fitting is only available while docked at a Starport." : (statError ? `Insufficient ${item.requiredStatType}` : ""),
                        style: {
                            padding: '10px',
                            borderBottom: '1px solid #222',
                            cursor: (isDocked && !statError) ? 'pointer' : 'default',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            fontSize: '12px',
                            background: 'rgba(255,255,255,0.02)',
                            opacity: (isDocked && !statError) ? 1 : 0.7,
                            width: '100%',
                            textAlign: 'left',
                            color: 'inherit',
                            fontFamily: 'inherit',
                            border: 'none',
                            outline: 'none'
                        },
                        onMouseEnter: (e) => { if (isDocked && !statError) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; },
                        onMouseLeave: (e) => { if (isDocked && !statError) e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }
                    },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                                React.createElement('span', { style: { fontWeight: 'bold', color: RARITY_COLORS[item.rarity] || '#fff' } }, item.name.toUpperCase()),
                                item.location === 'storage' && React.createElement('span', { 
                                    style: { fontSize: '8px', padding: '1px 4px', background: 'rgba(0, 204, 255, 0.2)', color: '#00ccff', borderRadius: '2px', border: '1px solid #00ccff44' } 
                                }, 'STORAGE')
                            ),
                            React.createElement('span', { style: { color: !isDocked ? '#555' : ((pwrError || cpuError || statError) ? '#ff4444' : '#00ff00'), fontWeight: 'bold', fontSize: '10px' } }, 
                                !isDocked ? 'LOCKED' : (statError ? 'STAT REQ' : ((pwrError || cpuError) ? 'LIMIT EXCEEDED' : (equipped ? 'SWAP' : 'INSTALL')))
                            )
                        ),
                        React.createElement('div', { style: { display: 'flex', gap: '10px', fontSize: '9px', color: '#888', flexWrap: 'wrap' } },
                            React.createElement(ItemSpecificationList, { item: item })
                        )
                    );
                })
            )
        );
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '320px',
            background: 'rgba(20, 20, 25, 0.98)',
            border: '2px solid #555',
            borderRadius: '8px',
            padding: '20px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 2600,
            pointerEvents: 'auto',
            boxShadow: '0 0 50px rgba(0,0,0,0.9)'
        }
    },
        React.createElement('div', {
            style: { fontSize: '14px', fontWeight: 'bold', color: '#00ccff', marginBottom: '15px', borderBottom: '1px solid #444', paddingBottom: '8px' }
        }, formattedTitle),
        
        // Currently Equipped Section
        equipped && React.createElement('div', {
            style: {
                background: isDocked ? 'rgba(0, 204, 255, 0.1)' : 'rgba(100, 100, 100, 0.1)',
                border: `1px solid ${isDocked ? '#00ccff' : '#555'}`,
                borderRadius: '4px',
                padding: '12px',
                marginBottom: '20px',
                opacity: isDocked ? 1 : 0.7
            }
        },
            React.createElement('div', { style: { fontSize: '10px', color: isDocked ? '#00ccff' : '#888', marginBottom: '4px' } }, 'EQUIPPED MODULE'),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold' } }, equipped.name.toUpperCase()),
                React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                    isWeaponSlot && React.createElement('div', { style: { display: 'flex', gap: '4px' } },
                        React.createElement('button', {
                            onClick: () => onToggleGroup(slot.id, 1),
                            style: {
                                background: equipped.weaponGroup1 ? 'rgba(0, 204, 255, 0.4)' : '#222',
                                border: `1px solid ${equipped.weaponGroup1 ? '#00ccff' : '#444'}`,
                                color: equipped.weaponGroup1 ? '#fff' : '#888',
                                fontSize: '9px', padding: '2px 6px', borderRadius: '2px', cursor: 'pointer'
                            }
                        }, 'G1'),
                        React.createElement('button', {
                            onClick: () => onToggleGroup(slot.id, 2),
                            style: {
                                background: equipped.weaponGroup2 ? 'rgba(0, 204, 255, 0.4)' : '#222',
                                border: `1px solid ${equipped.weaponGroup2 ? '#00ccff' : '#444'}`,
                                color: equipped.weaponGroup2 ? '#fff' : '#888',
                                fontSize: '9px', padding: '2px 6px', borderRadius: '2px', cursor: 'pointer'
                            }
                        }, 'G2')
                    ),
                    React.createElement('button', {
                        onClick: () => isDocked && onUnfit(slot.id),
                        title: !isDocked ? "Module fitting is only available while docked at a Starport." : "",
                        style: {
                            background: isDocked ? '#441111' : '#222',
                            border: `1px solid ${isDocked ? '#ff4444' : '#444'}`,
                            color: isDocked ? '#ff4444' : '#555',
                            fontSize: '10px',
                            padding: '4px 8px',
                            cursor: isDocked ? 'pointer' : 'default',
                            fontWeight: 'bold'
                        }
                    }, 'UNFIT')
                )
            ),
            
            equipped && React.createElement('div', { style: { marginTop: '-10px', marginBottom: '20px', fontSize: '10px', color: '#888', background: 'rgba(0,0,0,0.2)', padding: '10px', border: '1px solid #333' } },
                equipped.type === 'implant' ? (
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                            React.createElement('span', null, 'QL RATING:'),
                            React.createElement('span', { style: { color: '#fff' } }, equipped.ql)
                        ),
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                            React.createElement('span', null, 'NEURAL REQ:'),
                            React.createElement('span', { style: { color: '#00ccff' } }, `${equipped.requiredStatValue} ${equipped.requiredStatType}`)
                        ),
                        equipped.sockets && ['core', 'matrix', 'trace'].map(s => (
                            equipped.sockets[s]?.installed && React.createElement('div', { key: s, style: { display: 'flex', justifyContent: 'space-between', color: '#00ff00' } },
                                React.createElement('span', null, `${equipped.sockets[s].installed.modifier?.label || s.toUpperCase()}:`),
                                React.createElement('span', null, `+${equipped.sockets[s].installed.bonus}`)
                            )
                        ))
                    )
                ) : (
                    React.createElement('div', null, equipped.description || 'Standard federation hardware.')
                )
            )
        ),

        renderHardwareSelection(),
        
        React.createElement('button', {
            onClick: onClose,
            style: { marginTop: '24px', width: '100%', background: 'transparent', border: '1px solid #555', color: '#888', padding: '8px', cursor: 'pointer', fontSize: '11px' }
        }, 'CLOSE')
    );
};

const ActionHotkeysHUD = ({ hoveredEntity, target, gameManager }) => {
    const actions = [];
    if (hoveredEntity) {
        if (hoveredEntity.type === 'Starport') {
            actions.push({ key: 'E', label: 'DOCK', code: 'KeyE' });
        } else if (hoveredEntity.type === 'WarpGate') {
            actions.push({ key: 'E', label: 'LEAP', code: 'KeyE' });
        } else if (hoveredEntity.type === 'ArenaBeacon' || hoveredEntity.type === 'BattlegroundBeacon') {
            actions.push({ key: 'E', label: 'VIEW', code: 'KeyE' });
        }
    }
    if (target) {
        const isScanned = gameManager?.scannedEntities instanceof Set ? gameManager.scannedEntities.has(target.id) : gameManager?.scannedEntities?.includes(target.id);
        const isAnomaly = target.type === 'anomaly';
        const label = (isAnomaly && isScanned) ? 'SURVEY' : 'SCAN';
        actions.push({ key: 'Q', label: label, code: 'KeyQ' });
    }

    if (actions.length === 0) return null;

    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    return React.createElement('div', {
        style: {
            marginTop: '10px',
            background: 'rgba(0,0,0,0.7)',
            border: '1px solid #444',
            padding: '10px',
            borderRadius: '4px',
            fontFamily: 'monospace',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            minWidth: '160px',
            boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
            pointerEvents: isTouch ? 'auto' : 'none'
        }
    },
        React.createElement('div', { style: { fontSize: '10px', color: '#fff', marginBottom: '2px', letterSpacing: '1px' } }, 'AVAILABLE ACTIONS'),
        actions.map(action => (
            React.createElement('div', { 
                key: action.key, 
                onClick: () => {
                    if (isTouch && gameManager) {
                        // Dispatch a fake keydown event to trigger the action
                        const event = new KeyboardEvent('keydown', { code: action.code });
                        window.dispatchEvent(event);
                    }
                },
                style: { 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '10px',
                    cursor: isTouch ? 'pointer' : 'default',
                    opacity: 1,
                    transition: 'opacity 0.1s'
                } 
            },
                React.createElement('div', {
                    style: {
                        width: '24px',
                        height: '24px',
                        border: '1px solid #00ccff',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 'bold',
                        color: '#00ccff',
                        background: 'rgba(0, 204, 255, 0.1)'
                    }
                }, action.key),
                React.createElement('div', { style: { fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px' } }, action.label)
            )
        ))
    );
};

const LoadingScreen = ({ fadeOut, steps = [], title = 'SECTORFALL', actionLabel = null, onAction = null, footerLabel = 'INITIALIZING PERSISTENCE LAYER', staticTitle = false }) => {
    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: '#000',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            color: '#fff',
            opacity: fadeOut ? 0 : 1,
            transition: 'opacity 1s ease-out',
            pointerEvents: fadeOut ? 'none' : 'auto'
        }
    },
        React.createElement('div', {
            style: {
                fontSize: '48px',
                fontWeight: 'bold',
                letterSpacing: '16px',
                color: '#fff',
                marginBottom: actionLabel ? '26px' : '40px',
                textShadow: '0 0 30px rgba(255, 255, 255, 0.3)',
                animation: staticTitle ? 'none' : 'loadingTextPulse 3s infinite ease-in-out'
            }
        }, title),

        actionLabel && React.createElement('button', {
            onClick: onAction,
            style: {
                marginBottom: '28px',
                minWidth: '220px',
                padding: '12px 22px',
                background: 'rgba(0, 204, 255, 0.12)',
                border: '1px solid rgba(0, 204, 255, 0.75)',
                color: '#00ccff',
                fontSize: '12px',
                fontWeight: 'bold',
                letterSpacing: '3px',
                fontFamily: 'monospace',
                cursor: 'pointer',
                borderRadius: '2px',
                boxShadow: '0 0 18px rgba(0, 204, 255, 0.14)',
                transition: 'all 0.2s ease'
            },
            onMouseEnter: (e) => {
                e.currentTarget.style.background = 'rgba(0, 204, 255, 0.22)';
                e.currentTarget.style.boxShadow = '0 0 24px rgba(0, 204, 255, 0.24)';
            },
            onMouseLeave: (e) => {
                e.currentTarget.style.background = 'rgba(0, 204, 255, 0.12)';
                e.currentTarget.style.boxShadow = '0 0 18px rgba(0, 204, 255, 0.14)';
            }
        }, actionLabel),

        React.createElement('div', {
            style: {
                width: '400px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                marginBottom: '32px',
                minHeight: '182px'
            }
        },
            steps.map((step, i) => (
                React.createElement('div', {
                    key: i,
                    style: {
                        fontSize: '11px',
                        color: i === steps.length - 1 ? '#00ccff' : '#444',
                        letterSpacing: '2px',
                        fontWeight: 'bold',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        minHeight: '18px',
                        animation: i === steps.length - 1 ? 'flicker 0.45s infinite' : 'none'
                    }
                }, 
                    React.createElement('span', { style: { color: i === steps.length - 1 ? '#00ccff' : '#00ff66' } }, i === steps.length - 1 ? '>>' : 'OK'),
                    step.toUpperCase()
                )
            ))
        ),

        !actionLabel && React.createElement('div', {
            style: {
                width: '300px',
                height: '1px',
                background: 'rgba(255, 255, 255, 0.1)',
                position: 'relative',
                overflow: 'hidden',
                marginTop: '8px'
            }
        },
            React.createElement('div', {
                style: {
                    position: 'absolute',
                    width: '60px',
                    height: '100%',
                    background: 'linear-gradient(90deg, transparent, #fff, transparent)',
                    animation: 'loadingBarSlide 3.6s infinite ease-in-out'
                }
            })
        ),
        React.createElement('div', {
            style: {
                marginTop: '24px',
                fontSize: '9px',
                color: '#444',
                letterSpacing: '4px',
                fontWeight: 'bold'
            }
        }, footerLabel),
        React.createElement('style', null, `
            @keyframes loadingTextPulse {
                0%, 100% { opacity: 0.4; letter-spacing: 16px; transform: scale(0.98); }
                50% { opacity: 1; letter-spacing: 20px; transform: scale(1); }
            }
            @keyframes loadingBarSlide {
                0% { left: -100px; }
                100% { left: 300px; }
            }
        `)
    );
};

const ChatWindow = ({ messages, onSendMessage, currentChannel, onSetChannel, systemName, messageDraft, onClearDraft }) => {
    const [input, setInput] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const scrollRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
        if (messageDraft) {
            setInput(messageDraft);
            setIsMinimized(false);
            if (inputRef.current) {
                inputRef.current.focus();
            }
            onClearDraft();
        }
    }, [messageDraft, onClearDraft]);

    useEffect(() => {
        if (scrollRef.current && !isMinimized) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isMinimized]);

    const handleSend = (e) => {
        e.preventDefault();
        if (input.trim()) {
            onSendMessage(input.trim());
            setInput('');
            if (inputRef.current) {
                inputRef.current.focus();
            }
        }
    };

    const IconChat = () => (
        React.createElement('svg', { 
            width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', 
            stroke: '#00ccff', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' 
        },
            React.createElement('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' })
        )
    );

    return React.createElement(React.Fragment, null,
        // Minimized Icon Button
        React.createElement('div', {
            onClick: () => setIsMinimized(false),
            style: {
                position: 'absolute',
                bottom: '20px',
                left: '20px',
                width: '50px',
                height: '50px',
                background: '#000',
                border: '1.5px solid #888',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1001,
                cursor: 'pointer',
                pointerEvents: isMinimized ? 'auto' : 'none',
                boxShadow: '0 4px 10px rgba(0,0,0,0.8)',
                opacity: isMinimized ? 1 : 0,
                transform: isMinimized ? 'scale(1)' : 'scale(0.5)',
                transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
            },
            onMouseEnter: (e) => {
                e.currentTarget.style.borderColor = '#00ccff';
                e.currentTarget.style.boxShadow = '0 0 25px rgba(0,204,255,0.4)';
            },
            onMouseLeave: (e) => {
                e.currentTarget.style.borderColor = '#888';
                e.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,0.8)';
            }
        }, React.createElement(IconChat)),

        // Main Chat Window
        React.createElement('div', {
            style: {
                position: 'absolute',
                bottom: '20px',
                left: '20px',
                width: '420px',
                height: '240px',
                background: 'rgba(0, 10, 20, 0.85)',
                border: '1px solid #444',
                borderRadius: '4px',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 1000,
                fontFamily: 'monospace',
                pointerEvents: isMinimized ? 'none' : 'auto',
                boxShadow: '0 0 20px rgba(0,0,0,0.5)',
                overflow: 'hidden',
                opacity: isMinimized ? 0 : 1,
                transform: isMinimized ? 'scale(0.8) translate(-40px, 40px)' : 'scale(1) translate(0, 0)',
                transformOrigin: 'bottom left',
                transition: 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)'
            }
        },
            React.createElement('style', null, `
                .chat-placeholder::placeholder {
                    color: #fff !important;
                    opacity: 0.7;
                }
            `),
            // Tabs & Controls
            React.createElement('div', {
                style: {
                    display: 'flex',
                    background: 'rgba(0,0,0,0.5)',
                    borderBottom: '1px solid #333'
                }
            },
                ['SYSTEM', 'SYNDICATE', 'FLEET', 'DIRECT'].map(channel => (
                    React.createElement('div', {
                        key: channel,
                        onClick: () => onSetChannel(channel),
                        style: {
                            padding: '8px 12px',
                            fontSize: '9px',
                            fontWeight: 'bold',
                            color: currentChannel === channel ? '#00ccff' : '#fff',
                            borderBottom: currentChannel === channel ? '2px solid #00ccff' : 'none',
                            cursor: 'pointer',
                            letterSpacing: '1px',
                            transition: 'all 0.2s'
                        }
                    }, channel)
                )),
                React.createElement('div', {
                    style: {
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        paddingRight: '5px',
                        fontSize: '9px',
                        color: '#fff',
                        fontStyle: 'italic',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, (() => {
                    if (currentChannel === 'SYSTEM') return systemName;
                    if (currentChannel === 'SYNDICATE') return 'SYNDICATE CHANNEL';
                    if (currentChannel === 'FLEET') return 'FLEET COMS';
                    if (currentChannel === 'DIRECT') return 'ENCRYPTED SIGNAL';
                    return '';
                })()),
                
                // Minimize Button
                React.createElement('div', {
                    onClick: (e) => {
                        e.stopPropagation();
                        setIsMinimized(true);
                    },
                    style: {
                        padding: '8px 12px',
                        fontSize: '14px',
                        color: '#fff',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'color 0.2s'
                    },
                    onMouseEnter: (e) => e.currentTarget.style.color = '#00ccff',
                    onMouseLeave: (e) => e.currentTarget.style.color = '#fff'
                }, '−')
            ),

            // Message Area
            React.createElement('div', {
                ref: scrollRef,
                onWheel: (e) => e.stopPropagation(),
                style: {
                    flex: 1,
                    padding: '10px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#333 transparent'
                }
            },
                messages.length === 0 ? 
                React.createElement('div', { style: { color: '#888', fontSize: '10px', textAlign: 'center', marginTop: '20px' } }, '--- NO MESSAGES ---') :
                messages.map((msg, i) => (
                    React.createElement('div', { key: i, style: { fontSize: '11px', lineHeight: '1.4' } },
                        React.createElement('span', { style: { color: '#888', marginRight: '6px' } }, `[${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}]`),
                        React.createElement('span', { style: { color: msg.userId === 'local' ? '#00ff00' : '#00ccff', fontWeight: 'bold' } }, `${msg.userName}: `),
                        React.createElement('span', { style: { color: '#eee' } }, msg.content)
                    )
                ))
            ),

            // Input Area
            React.createElement('form', {
                onSubmit: handleSend,
                style: {
                    padding: '10px',
                    borderTop: '1px solid #333',
                    background: 'rgba(0,0,0,0.3)',
                    display: 'flex',
                    gap: '8px'
                }
            },
                React.createElement('input', {
                    ref: inputRef,
                    className: 'chat-placeholder',
                    value: input,
                    onChange: (e) => setInput(e.target.value),
                    onFocus: () => setIsFocused(true),
                    onBlur: () => setIsFocused(false),
                    placeholder: `Broadcast to ${currentChannel.toLowerCase()}...`,
                    style: {
                        flex: 1,
                        background: '#000',
                        border: '1px solid #444',
                        color: '#fff',
                        padding: '6px 10px',
                        fontSize: '11px',
                        outline: 'none',
                        borderRadius: '2px',
                        fontFamily: 'monospace'
                    }
                }),
                React.createElement('button', {
                    type: 'submit',
                    style: {
                        background: 'transparent',
                        border: '1px solid #00ccff',
                        color: '#00ccff',
                        fontSize: '9px',
                        fontWeight: 'bold',
                        padding: '0 10px',
                        cursor: 'pointer',
                        borderRadius: '2px'
                    }
                }, 'SEND')
            )
        )
    );
};

const SAFE_DEFAULT_FITTINGS = {
    weapon1: null, weapon2: null, weapon3: null,
    active1: null, active2: null, active3: null, active4: null,
    passive1: null, passive2: null, passive3: null, passive4: null,
    rig1: null, rig2: null, rig3: null, rig4: null,
    synapse1: null, synapse2: null, synapse3: null
};

/**
 * Hydrates a vessel manifestation with authoritative hardware stats and slot maps.
 * Ensures slot definitions always come from SHIP_REGISTRY.
 * 
 * Merge Order:
 * 1. SHIP_REGISTRY (Authoritative slots and base stats)
 * 2. Persistent Fleet Entry (Saved fittings and status)
 * 3. Real-time Telemetry (Latest HP/Energy/Fittings)
 */
const hydrateVessel = (registryShip, fleetEntry = null, telemetry = null) => {
    const config = SHIP_REGISTRY[registryShip.type] || SHIP_REGISTRY['OMNI SCOUT'];
    
    // 1. Start with registry defaults
    const base = {
        ...config,
        id: registryShip.id,
        type: registryShip.type,
        name: registryShip.name || config.name || getShipDisplayName(registryShip.type),
        isShip: true,
        classId: config.classId || config.name || registryShip.type,
        hp: config.hp,
        maxHp: config.hp,
        energy: config.baseEnergy,
        maxEnergy: config.baseEnergy,
        shields: 0,
        maxShields: 0,
        fittings: { ...(config.fittings || {}) }
    };

    // 2. Overlay Fleet Entry (Persistence)
    if (fleetEntry) {
        base.hp = fleetEntry.hp ?? base.hp;
        base.energy = fleetEntry.energy ?? base.energy;
        base.shields = fleetEntry.shields ?? base.shields;
        base.name = fleetEntry.name || base.name;
        
        // Merge fittings only for keys that exist in registry
        if (fleetEntry.fittings) {
            Object.keys(base.fittings).forEach(slotId => {
                if (fleetEntry.fittings[slotId] !== undefined) {
                    base.fittings[slotId] = hydrateFittedModule(fleetEntry.fittings[slotId]);
                }
            });
        }
    }

    // 3. Overlay Telemetry (Real-time physical state)
    // Real-time telemetry is the FINAL authority.
    if (telemetry) {
        const stats = telemetry.stats || {};
        base.hp = telemetry.hp ?? stats.hp ?? base.hp;
        base.energy = telemetry.energy ?? stats.energy ?? base.energy;
        base.shields = telemetry.shields ?? stats.shields ?? base.shields;
        
        // Max stats can also be authoritative if they include bonuses from previous sessions
        base.maxHp = telemetry.maxHp ?? stats.maxHp ?? base.maxHp;
        base.maxEnergy = telemetry.maxEnergy ?? stats.maxEnergy ?? base.maxEnergy;
        base.maxShields = telemetry.maxShields ?? stats.maxShields ?? base.maxShields;
        
        // Merge fittings only for keys that exist in registry
        if (telemetry.fittings) {
            Object.keys(base.fittings).forEach(slotId => {
                if (telemetry.fittings[slotId] !== undefined) {
                    base.fittings[slotId] = hydrateFittedModule(telemetry.fittings[slotId]);
                }
            });
        }
    }

    return base;
};

export default function App() {
    const { commanderData } = useGameState();
    const containerRef = useRef(null);
    const gameManagerRef = useRef(null);
    const [activeMenu, setActiveMenu] = useState(null);
    const [arenaState, setArenaState] = useState({ open: false, status: 'idle', currentInstanceId: null, beaconId: null, beaconName: 'ARENA BEACON' });
    const [battlegroundState, setBattlegroundState] = useState({ open: false, status: 'idle', currentInstanceId: null, beaconId: null, beaconName: 'OMNI DIRECTORATE COMBAT RELAY', definition: null, bankedCredits: 0, choice: null, hud: { currentWave: 0, enemiesRemaining: 0, statusLabel: 'STANDBY' } });

const handleOpenArenaMenu = (entity = null) => {
    setArenaState(prev => ({
        ...prev,
        open: true,
        status: prev.status === 'joining' ? prev.status : 'idle',
        beaconId: entity?.id || prev.beaconId || null,
        beaconName: entity?.name || prev.beaconName || 'ARENA BEACON'
    }));
};

const handleCloseArenaMenu = () => {
    setArenaState(prev => ({ ...prev, open: false, status: 'idle' }));
};


const BattlegroundCompleteOverlay = ({ state }) => (
    React.createElement('div', {
        style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: state?.phase === 'blackout' ? 'rgba(0, 0, 0, 1)' : 'rgba(0, 0, 0, 0.9)',
            zIndex: 10003,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            color: '#fff',
            pointerEvents: 'auto',
            transition: 'background 0.45s ease, opacity 0.45s ease'
        }
    },
        state?.phase !== 'blackout' && React.createElement(React.Fragment, null,
            React.createElement('div', { style: { color: '#73d5ff', fontSize: '18px', letterSpacing: '4px', marginBottom: '14px' } }, 'BATTLEGROUND COMPLETED'),
            React.createElement('div', { style: { color: '#ffffff', fontSize: '34px', fontWeight: 'bold', letterSpacing: '2px', marginBottom: '16px', textShadow: '0 0 18px rgba(80, 180, 255, 0.35)' } }, 'REWARD BANK SECURED'),
            React.createElement('div', { style: { color: '#9cc7d9', fontSize: '14px', marginBottom: '8px' } }, `WAVE REACHED: ${Number(state?.waveNumber || 0) || '?'}`),
            React.createElement('div', { style: { color: '#ffffff', fontSize: '18px', marginBottom: '10px' } }, `${Number(state?.securedCredits || 0).toLocaleString()} CREDITS`),
            React.createElement('div', { style: { color: '#cfd9df', fontSize: '13px', letterSpacing: '2px' } }, `RETURNING TO ${(state?.returnSystemName || 'ENTRY POINT').toUpperCase()}`)
        )
    )
);

const showArenaLoadingScreen = () => {
    if (arenaLoadingHideTimerRef.current) {
        clearTimeout(arenaLoadingHideTimerRef.current);
        arenaLoadingHideTimerRef.current = null;
    }
    if (arenaIntroReadyTimerRef.current) {
        clearTimeout(arenaIntroReadyTimerRef.current);
        arenaIntroReadyTimerRef.current = null;
    }
    setLoadingScreenTitle('ARENA');
    setLoadingSteps([]);
    setLoadingFadeOut(false);
    setArenaIntroPending(true);
    setArenaIntroCanContinue(false);
    setShowLoading(true);
    arenaIntroReadyTimerRef.current = setTimeout(() => {
        setArenaIntroCanContinue(true);
        arenaIntroReadyTimerRef.current = null;
    }, 800);
};

const hideArenaLoadingScreen = (delayMs = 700) => {
    if (arenaLoadingHideTimerRef.current) {
        clearTimeout(arenaLoadingHideTimerRef.current);
    }
    arenaLoadingHideTimerRef.current = setTimeout(() => {
        setLoadingFadeOut(true);
        setTimeout(() => {
            setShowLoading(false);
            setLoadingScreenTitle('SECTORFALL');
            setLoadingFadeOut(false);
        }, 1000);
        arenaLoadingHideTimerRef.current = null;
    }, delayMs);
};

const cancelArenaLoadingScreen = () => {
    if (arenaLoadingHideTimerRef.current) {
        clearTimeout(arenaLoadingHideTimerRef.current);
        arenaLoadingHideTimerRef.current = null;
    }
    if (arenaIntroReadyTimerRef.current) {
        clearTimeout(arenaIntroReadyTimerRef.current);
        arenaIntroReadyTimerRef.current = null;
    }
    setArenaIntroPending(false);
    setArenaIntroCanContinue(false);
    setShowLoading(false);
    setLoadingScreenTitle('SECTORFALL');
    setLoadingFadeOut(false);
};

const handleContinueArenaIntro = () => {
    if (!arenaIntroPending || !arenaIntroCanContinue) return;
    setArenaIntroPending(false);
    setArenaIntroCanContinue(false);
    try {
        if (backendSocket?.sendArenaReady) {
            backendSocket.sendArenaReady({});
        }
    } catch (e) {
        console.warn('[Arena] sendArenaReady failed', e);
    }
    hideArenaLoadingScreen(0);
};

const handleLeaveArena = () => {
    setArenaState(prev => ({ ...prev, status: 'leaving' }));
    try {
        if (!backendSocket?.sendArenaLeave) {
            throw new Error('sendArenaLeave unavailable');
        }
        backendSocket.sendArenaLeave({});
    } catch (e) {
        console.warn('[Arena] sendArenaLeave failed', e);
        setArenaState(prev => ({ ...prev, status: 'idle' }));
    }
};

const handleOpenBattlegroundMenu = (entity = null) => {
    setBattlegroundState(prev => ({
        ...prev,
        open: true,
        status: prev.status === 'joining' ? prev.status : 'idle',
        beaconId: entity?.id || prev.beaconId || null,
        beaconName: entity?.name || prev.beaconName || 'OMNI DIRECTORATE COMBAT RELAY'
    }));
    try { backendSocket?.sendBattlegroundInspect?.({ structureId: entity?.id || null }); } catch (e) {}
};

const handleCloseBattlegroundMenu = () => {
    setBattlegroundState(prev => ({ ...prev, open: false, status: 'idle' }));
};

const startBattlegroundWaveCountdown = (waveNumber = 0, seconds = 5) => {
    if (battlegroundWaveCountdownTimerRef.current) {
        clearInterval(battlegroundWaveCountdownTimerRef.current);
        battlegroundWaveCountdownTimerRef.current = null;
    }
    let remaining = Math.max(1, Number(seconds) || 5);
    setBattlegroundWaveCountdown({ waveNumber: Number(waveNumber) || 0, remaining });
    battlegroundWaveCountdownTimerRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            if (battlegroundWaveCountdownTimerRef.current) {
                clearInterval(battlegroundWaveCountdownTimerRef.current);
                battlegroundWaveCountdownTimerRef.current = null;
            }
            setBattlegroundWaveCountdown(null);
            return;
        }
        setBattlegroundWaveCountdown({ waveNumber: Number(waveNumber) || 0, remaining });
    }, 1000);
};


const handleEnterBattleground = () => {
    setBattlegroundState(prev => ({ ...prev, status: 'joining' }));
    setLoadingScreenTitle('BATTLEGROUND');
    setLoadingSteps([]);
    setLoadingFadeOut(false);
    setArenaIntroPending(false);
    setArenaIntroCanContinue(false);
    setBattlegroundIntroPending(true);
    setBattlegroundIntroCanContinue(false);
    setShowLoading(true);
    try {
        gameManagerRef.current?.setInstanceMusicMode?.('battleground');
    } catch (e) {
        console.warn('[Battleground] pre-entry music start failed', e);
    }
    setTimeout(() => setBattlegroundIntroCanContinue(true), 800);
    try {
        if (!backendSocket?.sendBattlegroundEnter) throw new Error('sendBattlegroundEnter unavailable');
        backendSocket.sendBattlegroundEnter({ structureId: battlegroundState.beaconId || null });
    } catch (e) {
        console.warn('[Battleground] sendBattlegroundEnter failed', e);
        setBattlegroundState(prev => ({ ...prev, status: 'idle' }));
    }
};

const handleLeaveBattleground = () => {
    setBattlegroundState(prev => ({ ...prev, status: 'leaving' }));
    try {
        if (!backendSocket?.sendBattlegroundLeave) throw new Error('sendBattlegroundLeave unavailable');
        backendSocket.sendBattlegroundLeave({});
    } catch (e) {
        console.warn('[Battleground] sendBattlegroundLeave failed', e);
        setBattlegroundState(prev => ({ ...prev, status: 'idle' }));
    }
};

const handleBattlegroundExtract = () => {
    setBattlegroundState(prev => ({ ...prev, choice: null, hud: { ...prev.hud, statusLabel: 'EXTRACTION IN PROGRESS' } }));
    try {
        backendSocket?.sendBattlegroundExtract?.({});
    } catch (e) {
        console.warn('[Battleground] sendBattlegroundExtract failed', e);
        setBattlegroundState(prev => ({ ...prev, hud: { ...prev.hud, statusLabel: 'EXTRACTION READY' } }));
    }
};

const handleBattlegroundContinue = () => {
    try {
        backendSocket?.sendBattlegroundContinue?.({});
    } catch (e) {
        console.warn('[Battleground] sendBattlegroundContinue failed', e);
    }
};

const handleEnterArena = () => {
    setArenaState(prev => ({ ...prev, status: 'joining' }));
    showArenaLoadingScreen();
    try {
        if (!backendSocket?.sendArenaEnter) {
            throw new Error('sendArenaEnter unavailable');
        }
        backendSocket.sendArenaEnter({ beaconId: arenaState.beaconId || null });
    } catch (e) {
        console.warn('[Arena] sendArenaEnter failed', e);
        setArenaState(prev => ({ ...prev, status: 'idle' }));
    }
};

    const [activePanel, setActivePanel] = useState(null);
    const [isEditingName, setIsEditingName] = useState(false);
    const [securityError, setSecurityError] = useState(null);
    const [fittingWarning, setFittingWarning] = useState(null);
    const [activeFittingSlot, setActiveFittingSlot] = useState(null);
    const [notifications, setNotifications] = useState([]);
    const lastNotificationTimeRef = useRef(0);
    const [isDocked, setIsDocked] = useState(true);
    const [showStarMap, setShowStarMap] = useState(false);
    const [initialStarMapView, setInitialStarMapView] = useState('sector');
    const [isLeapMode, setIsLeapMode] = useState(false);
    
    // Chat State
    const [chatMessages, setChatMessages] = useState([]);
    const [chatChannel, setChatChannel] = useState('SYSTEM');
    const [messageDraft, setMessageDraft] = useState('');
    
    // Resolution Scaling State
    const [viewportScale, setViewportScale] = useState(1);

    useEffect(() => {
        // Maintenance: One-time purge of stale market cache to resolve FALCON CHASSIS ghost listings
        const MARKET_PURGE_VERSION = 'v1.0.2'; // Increment this if future purges are needed
        if (localStorage.getItem('arc_market_purged') !== MARKET_PURGE_VERSION) {
            localStorage.removeItem('arc_space_market_data');
            
            // Purge all vendor refresh timestamps to trigger immediate reseeding
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('arc_market_vendor_refresh_')) {
                    localStorage.removeItem(key);
                }
            });

            localStorage.setItem('arc_market_purged', MARKET_PURGE_VERSION);
            console.log("[Maintenance] Stale market cache and refresh timestamps purged.");
        }

        const updateScale = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            const targetAspect = 1920 / 1080;
            const currentAspect = width / height;
            
            let scale;
            if (currentAspect > targetAspect) {
                scale = height / 1080;
            } else {
                scale = width / 1920;
            }
            setViewportScale(scale);
        };

        window.addEventListener('resize', updateScale);
        updateScale();
        return () => window.removeEventListener('resize', updateScale);
    }, []);

    // Cloud and Persistence State
    const [cloudUser, setCloudUser] = useState(null);
    const [isCloudSyncing, setIsCloudSyncing] = useState(false);
    const [isGameLoaded, setIsGameLoaded] = useState(false);
    const [showLoading, setShowLoading] = useState(true);
    const [loadingSteps, setLoadingSteps] = useState([]);
    const [loadingScreenTitle, setLoadingScreenTitle] = useState('SECTORFALL');
    const [loadingFadeOut, setLoadingFadeOut] = useState(false);
    const [arenaIntroPending, setArenaIntroPending] = useState(false);
    const [arenaIntroCanContinue, setArenaIntroCanContinue] = useState(false);
    const [battlegroundIntroPending, setBattlegroundIntroPending] = useState(false);
    const [battlegroundIntroCanContinue, setBattlegroundIntroCanContinue] = useState(false);
    const [battlegroundWaveCountdown, setBattlegroundWaveCountdown] = useState(null);
    const [battlegroundFailState, setBattlegroundFailState] = useState(null);
    const arenaLoadingHideTimerRef = useRef(null);
    const battlegroundWaveCountdownTimerRef = useRef(null);
    const arenaIntroReadyTimerRef = useRef(null);
    const battlegroundFailTimerRef = useRef(null);
    const battlegroundExtractPhaseTimerRef = useRef(null);
    const [battlegroundExtractState, setBattlegroundExtractState] = useState(null);
    const loadingStepQueueRef = useRef(Promise.resolve());
    const loadingStepTimerRefs = useRef([]);
    const loadingSequenceStartedAtRef = useRef(0);

    useEffect(() => {
        if (isGameLoaded) {
            // Keep loading screen for a short delay after systems are ready for a smooth transition
            setLoadingFadeOut(true);
            const timer = setTimeout(() => {
                setShowLoading(false);
                setLoadingScreenTitle('SECTORFALL');
            }, 1000);
            return () => clearTimeout(timer);
        }
    }, [isGameLoaded]);

    const queueLoadingStep = useCallback((label, minDelayMs = 420) => {
        const text = String(label || '').trim();
        if (!text) return loadingStepQueueRef.current;

        loadingStepQueueRef.current = loadingStepQueueRef.current.then(() => new Promise(resolve => {
            setLoadingSteps(prev => {
                if (prev.includes(text)) return prev;
                return [...prev, text];
            });
            const timer = setTimeout(() => {
                loadingStepTimerRefs.current = loadingStepTimerRefs.current.filter(id => id !== timer);
                resolve();
            }, minDelayMs);
            loadingStepTimerRefs.current.push(timer);
        }));

        return loadingStepQueueRef.current;
    }, []);

    const beginInitialLoadingSequence = useCallback(() => {
        loadingSequenceStartedAtRef.current = Date.now();
        loadingStepQueueRef.current = Promise.resolve();
        loadingStepTimerRefs.current.forEach(clearTimeout);
        loadingStepTimerRefs.current = [];
        setLoadingScreenTitle('SECTORFALL');
        setLoadingSteps([]);
        setLoadingFadeOut(false);
        setShowLoading(true);
    }, []);

    const flushInitialLoadingSequence = useCallback(async (minVisibleMs = 4200) => {
        const elapsed = Date.now() - (loadingSequenceStartedAtRef.current || Date.now());
        const remaining = Math.max(0, minVisibleMs - elapsed);
        await Promise.all([
            loadingStepQueueRef.current,
            new Promise(resolve => setTimeout(resolve, remaining))
        ]);
    }, []);

    useEffect(() => {
        return () => {
            if (arenaLoadingHideTimerRef.current) {
                clearTimeout(arenaLoadingHideTimerRef.current);
            }
            if (arenaIntroReadyTimerRef.current) {
                clearTimeout(arenaIntroReadyTimerRef.current);
            }
            if (battlegroundFailTimerRef.current) {
                clearTimeout(battlegroundFailTimerRef.current);
                battlegroundFailTimerRef.current = null;
            }
            if (battlegroundExtractPhaseTimerRef.current) {
                clearTimeout(battlegroundExtractPhaseTimerRef.current);
                battlegroundExtractPhaseTimerRef.current = null;
            }
            loadingStepTimerRefs.current.forEach(clearTimeout);
            loadingStepTimerRefs.current = [];
        };
    }, []);

    const [gameState, setGameState] = useState({
        activeShipId: 'PENDING',
        shipName: 'Detecting...',
        shipClass: 'SCANNING...',
        ownedShips: [],
        commanderName: `RECRUIT-${Math.floor(Math.random() * 9000 + 1000)}`,
        homeStarport: 'CYGNUS_PRIME_STARPORT',
        homeSystemId: 'cygnus-prime',
        level: 1,
        experience: 0,
        credits: 1000,
        factionStandings: {
            'OMNI DIRECTORATE': 100,
            'CRIMSON RIFT CARTEL': 0,
            'VOIDBORNE COVENANT': 0,
            'FERRON INDUSTRIAL GUILD': 0
        },
        inventory: [],
        storage: {}, // Authoritative storage keyed by starport_id
        hangarShips: [],
        regionalStorage: {}, // Read-only overview across starports
        currentSystem: { 
            id: 'cygnus-prime', 
            name: 'CYGNUS PRIME', 
            sector: 'SECURE', 
            security: 'high', 
            securityValue: 1.0 
        },
        asteroidBelts: [],
        jumpDrive: { active: false, remaining: 0, progress: 0 },
        commanderStats: {
            neuralStability: 1, bioTolerance: 1, motorIntegration: 1,
            nanoProgramming: 0, mining: 0, refining: 0, terraformingScience: 0,
            energyTurretMastery: 0, kineticCannonProficiency: 0, missileSystemsOperation: 0,
            heavyOrdnanceHandling: 0, structuralIntegrity: 0, shieldEfficiency: 0,
            reactorRegulation: 0, droneControlSystems: 0, quantumHacking: 0,
            xenobiology: 0, astroNavigation: 0, interstellarEconomics: 0
        },
        hp: 100,
        maxHp: 100,
        shields: 0,
        maxShields: 0,
        shieldRegen: 0,
        energy: 100,
        maxEnergy: 100,
        reactorRecovery: 1.0,
        jumpPower: 1,
        currentPowerGrid: 0,
        maxPowerGrid: 0,
        currentCpu: 0,
        maxCpu: 0,
        currentCargoWeight: 0,
        currentCargoVolume: 0,
        cargoHold: 0,
        cargoMaxVolume: 0,
        scanRange: 1000,
        scanTime: 3.5,
        lockOnRange: 1800,
        lockOnTime: 4.0,
        lockMultiplier: 1.0,
        sigRadius: 20,
        target: null,
        friendlyTarget: null,
        fleet: [],
        contextMenu: null,
        inspectingRemotePlayer: null,
        hoveredEntity: null,
        scanning: { active: false, progress: 0 },
        locking: { state: 'Idle', progress: 0, entity: null },
        scannedEntities: [],
        cooldowns: { weapon1: 0, weapon2: 0 },
        weaponStates: {
            weapon1: { heat: 0, overheated: false },
            weapon2: { heat: 0, overheated: false }
        },
        activeWeapons: {
            weapon1: false, weapon2: false, active1: false,
            passive1: false, passive2: false, engine: false
        },
        fittings: {
            weapon1: null, weapon2: null, active1: null,
            passive1: null, passive2: null, rig1: null,
            synapse1: null, synapse2: null, synapse3: null
        },
        commanderOutfit: { head: null, shoulders: null, chest: null, legs: null, feet: null, hands: null },
        commanderImplants: { brain: null, eye: null, ear: null, rightArm: null, chest: null, leftArm: null, waist: null, rightHand: null, legs: null, leftHand: null, feet: null },
        shipLayout: { weaponSlots: ['weapon1', 'weapon2'], auxiliarySlots: ['active1', 'passive1', 'passive2'] },
        globalMarkets: {},
        marketHistory: {},
        broodmotherSystemIds: [],
        radarEntities: [],
        hasRenamed: false
    })
    const isArenaCurrent = typeof gameState?.currentSystem?.id === 'string' && gameState.currentSystem.id.startsWith('arena:');
    const isBattlegroundCurrent = typeof gameState?.currentSystem?.id === 'string' && gameState.currentSystem.id.startsWith('bg:pve:');

    useEffect(() => {
        if (!arenaIntroPending || !showLoading || loadingScreenTitle !== 'ARENA' || !isArenaCurrent) return;

        const handleArenaIntroContinue = () => {
            if (!arenaIntroCanContinue) return;
            handleContinueArenaIntro();
        };

        const handleArenaIntroKey = () => handleArenaIntroContinue();
        const handleArenaIntroClick = () => handleArenaIntroContinue();

        window.addEventListener('keydown', handleArenaIntroKey);
        window.addEventListener('pointerdown', handleArenaIntroClick);

        return () => {
            window.removeEventListener('keydown', handleArenaIntroKey);
            window.removeEventListener('pointerdown', handleArenaIntroClick);
        };
    }, [arenaIntroPending, arenaIntroCanContinue, isArenaCurrent, showLoading, loadingScreenTitle]);

    const handleContinueBattlegroundIntro = useCallback(() => {
        if (!battlegroundIntroPending || !battlegroundIntroCanContinue) return;
        setBattlegroundIntroPending(false);
        setBattlegroundIntroCanContinue(false);
        try {
            gameManagerRef.current?.setInstanceMusicMode?.('battleground');
        } catch (e) {
            console.warn('[Battleground] setInstanceMusicMode failed', e);
        }
        try {
            backendSocket?.sendBattlegroundReady?.({});
        } catch (e) {
            console.warn('[Battleground] sendBattlegroundReady failed', e);
        }
        setLoadingFadeOut(true);
        setTimeout(() => {
            setShowLoading(false);
            setLoadingScreenTitle('SECTORFALL');
            setLoadingFadeOut(false);
        }, 1000);
    }, [backendSocket, battlegroundIntroPending, battlegroundIntroCanContinue]);

    useEffect(() => {
        if (!battlegroundIntroPending || !showLoading || loadingScreenTitle !== 'BATTLEGROUND' || !isBattlegroundCurrent) return;

        const handleBattlegroundIntroContinue = () => {
            if (!battlegroundIntroCanContinue) return;
            handleContinueBattlegroundIntro();
        };

        const handleBattlegroundIntroKey = () => handleBattlegroundIntroContinue();
        const handleBattlegroundIntroClick = () => handleBattlegroundIntroContinue();

        window.addEventListener('keydown', handleBattlegroundIntroKey);
        window.addEventListener('pointerdown', handleBattlegroundIntroClick);

        return () => {
            window.removeEventListener('keydown', handleBattlegroundIntroKey);
            window.removeEventListener('pointerdown', handleBattlegroundIntroClick);
        };
    }, [battlegroundIntroPending, battlegroundIntroCanContinue, handleContinueBattlegroundIntro, isBattlegroundCurrent, showLoading, loadingScreenTitle]);

    const pickBroodmotherSystems = (count = 3) => {
        const eligibleSystems = Object.keys(SYSTEMS_REGISTRY).filter(id => {
            const sys = SYSTEMS_REGISTRY[id];
            // Only spawn in low sec or null sec (security < 0.5)
            // AND exclude Cygnus Prime
            return sys.securityValue < 0.5 && id !== 'cygnus-prime';
        });
        if (eligibleSystems.length === 0) return [];
        
        // Shuffle and pick N
        const shuffled = [...eligibleSystems].sort(() => 0.5 - Math.random());
        const actualCount = Math.min(count, shuffled.length);
        return shuffled.slice(0, actualCount);
    };

    // --- Persistence Engine ---

    const seedNPCMarketListings = (currentMarkets) => {
        const nextMarkets = { ...currentMarkets };
        const systemId = 'cygnus-prime';
        if (!nextMarkets[systemId]) nextMarkets[systemId] = { commodities: [], auctions: [] };
        else nextMarkets[systemId] = { ...nextMarkets[systemId], commodities: [...(nextMarkets[systemId].commodities || [])] };

        const commonBlueprints = Object.keys(BLUEPRINT_REGISTRY).filter(id => BLUEPRINT_REGISTRY[id].rarity === 'common');
        
        commonBlueprints.forEach(bpId => {
            const bp = BLUEPRINT_REGISTRY[bpId];
            const listingId = `npc-listing-${systemId}-${bpId}`;
            
            const existingIdx = nextMarkets[systemId].commodities.findIndex(l => l.id === listingId);
            const listing = {
                id: listingId,
                sellerId: 'NPC_OMNI_DIRECTORATE',
                sellerName: 'OMNI DIRECTORATE',
                item: {
                    blueprintId: bpId,
                    name: bp.name,
                    type: 'blueprint',
                    rarity: 'common',
                    weight: 0.5,
                    description: `Official manufacturing data for ${bp.outputId}. Authorized Directorate distribution.`
                },
                price: 585.00, // Near max price (Reference 150 * 4.0 = 600)
                quantity: 500,
                type: 'commodity',
                expiresAt: Infinity
            };

            if (existingIdx !== -1) {
                nextMarkets[systemId].commodities[existingIdx] = listing;
            } else {
                nextMarkets[systemId].commodities.push(listing);
            }
        });

        return nextMarkets;
    };

    const lastSavedStateRef = useRef({
        x: 0,
        y: 0,
        rot: 0,
        cargoCount: 0,
        hp: 0,
        shields: 0,
        energy: 0,
        isDocked: false,
        timestamp: 0
    });

    const isPersistableShipId = (value) => {
        const shipId = String(value || '').trim();
        return !!shipId && shipId.toUpperCase() !== 'PENDING' && shipId.toLowerCase() !== 'null';
    };

    const saveGame = async (force = false) => {
        if (!isGameLoaded) return;

        const rawTelemetry = gameManagerRef.current?.getTelemetry() || {};
        const gmStats = gameManagerRef.current?.stats || {};
        const gmShip = gameManagerRef.current?.ship || null;
        const shipStats = gmShip?.stats || {};
        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId] || gameState.homeStarport;
const now = Date.now();

// Normalize telemetry shapes (supports legacy flat + new nested shapes)
const tX = numOr(rawTelemetry.x, numOr(rawTelemetry.position?.x, numOr(gmStats.x, lastSavedStateRef.current.x)));
const tY = numOr(rawTelemetry.y, numOr(rawTelemetry.position?.y, numOr(gmStats.y, lastSavedStateRef.current.y)));
const tRot = numOr(rawTelemetry.rot, numOr(rawTelemetry.rotation, numOr(gmStats.rot, lastSavedStateRef.current.rot)));
const tVX = numOr(rawTelemetry.vx, numOr(rawTelemetry.velocity?.x, 0));
const tVY = numOr(rawTelemetry.vy, numOr(rawTelemetry.velocity?.y, 0));

// Meaningful change detection
const deltaX = Math.abs(tX - lastSavedStateRef.current.x);
const deltaY = Math.abs(tY - lastSavedStateRef.current.y);
const deltaRot = Math.abs(tRot - lastSavedStateRef.current.rot);
const cargoChanged = (gameState.inventory?.length || 0) !== lastSavedStateRef.current.cargoCount;

// Authoritative vitals: prefer engine ship stats first (actual damage), then telemetry, then GameManager.stats, then UI state
const hpNow = numOr(shipStats.hp, numOr(gmShip?.hp,
  numOr(rawTelemetry.hp, numOr(rawTelemetry.stats?.hp, numOr(gmStats.hp, numOr(gameState.hp, 0))))
));
const shieldsNow = numOr(shipStats.shields, numOr(gmShip?.shields,
  numOr(rawTelemetry.shields, numOr(rawTelemetry.stats?.shields, numOr(gmStats.shields, numOr(gameState.shields, 0))))
));
const energyNow = numOr(shipStats.energy, numOr(gmShip?.energy,
  numOr(rawTelemetry.energy, numOr(rawTelemetry.stats?.energy, numOr(gmStats.energy, numOr(gameState.energy, 0))))
));
const hpChanged = Math.abs(hpNow - lastSavedStateRef.current.hp) > 1;
const shieldsChanged = Math.abs(shieldsNow - lastSavedStateRef.current.shields) > 1;
const energyChanged = Math.abs(energyNow - lastSavedStateRef.current.energy) > 1;

const dockingChanged = isDocked !== lastSavedStateRef.current.isDocked;
const timeSinceLastSave = now - lastSavedStateRef.current.timestamp;
        // Thresholds for "meaningful" movement
        const MOVE_THRESHOLD = 50; 
        const ROT_THRESHOLD = 0.5;
        const MAX_SAVE_INTERVAL = 30000; // 30 seconds max interval if no movement
        const MIN_SAVE_INTERVAL = 5000;  // 5 seconds min interval between saves

        const shouldSave = force || 
            cargoChanged || 
            hpChanged || 
            shieldsChanged || 
            energyChanged || 
            dockingChanged || 
            (timeSinceLastSave > MIN_SAVE_INTERVAL && (deltaX > MOVE_THRESHOLD || deltaY > MOVE_THRESHOLD || deltaRot > ROT_THRESHOLD)) ||
            (timeSinceLastSave > MAX_SAVE_INTERVAL);

        if (!shouldSave) return;

        // Update tracking ref
        lastSavedStateRef.current = {
            x: tX,
            y: tY,
            rot: tRot,
            cargoCount: gameState.inventory?.length || 0,
            hp: hpNow,
            shields: shieldsNow,
            energy: energyNow,
            isDocked,
            timestamp: now
        };

        // Filter telemetry to only allowed fields
const numOr = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

const telemetry = {
  x: tX,
  y: tY,
  rot: tRot,
  vx: tVX,
  vy: tVY,

  // ✅ vitals: prefer telemetry/stats, but fall back to UI-authoritative gameState
  hp: hpNow,
  maxHp: numOr(shipStats.maxHp, numOr(gmShip?.maxHp, numOr(rawTelemetry.maxHp, numOr(rawTelemetry.stats?.maxHp, numOr(gmStats.maxHp, numOr(gameState.maxHp, 0)))))),
  shields: shieldsNow,
  maxShields: numOr(shipStats.maxShields, numOr(gmShip?.maxShields, numOr(rawTelemetry.maxShields, numOr(rawTelemetry.stats?.maxShields, numOr(gmStats.maxShields, numOr(gameState.maxShields, 0)))))),
  energy: energyNow,
  maxEnergy: numOr(shipStats.maxEnergy, numOr(gmShip?.maxEnergy, numOr(rawTelemetry.maxEnergy, numOr(rawTelemetry.stats?.maxEnergy, numOr(gmStats.maxEnergy, numOr(gameState.maxEnergy, 0))))) )
};
        const saveData = {
            gameState: {
                ...gameState,
                isDocked // Include docking state in save
            },
            telemetry,
            timestamp: now
        };

        // Local Persistence (Full state)
        localStorage.setItem('arc_space_flight_save', JSON.stringify(saveData));

        // Cloud Persistence
const physicalSave = cloudService.saveToCloud(cloudUser.id, starportId, {
    // ship_type must be the canonical ship_id (eg ship_omni_scout), NOT the class label
    ship_type: (gameState.ownedShips || []).find(s => s.id === gameState.activeShipId)?.type || rawTelemetry.shipType || gameState.shipClass,
    cargo: gameState.inventory || [],
    fittings: gameState.fittings || {},
    // ✅ current vitals (these map to ship_states_v2 columns)
    hull: hpNow,
    shields: shieldsNow,
    energy: energyNow,
    // ✅ max vitals
    maxHp: numOr(gameState.maxHp, telemetry.maxHp),
    maxEnergy: numOr(gameState.maxEnergy, telemetry.maxEnergy),
    maxShields: numOr(gameState.maxShields, telemetry.maxShields),
    // ✅ always include telemetry snapshot for spawn/persistence
    telemetry: { ...telemetry }
});

            // 2. Commander Data (Progression/Identity/Fleet)
            const commanderPayload = {
                commander_name: gameState.commanderName,
                credits: gameState.credits,
                experience: gameState.experience,
                level: gameState.level,
                owned_ships: gameState.ownedShips,
                fleet: gameState.fleet || [],
                last_station_id: starportId
            };
            if (isPersistableShipId(gameState.activeShipId)) {
                commanderPayload.active_ship_id = gameState.activeShipId;
            }
            const commanderSave = cloudService.updateCommanderData(cloudUser.id, commanderPayload);

            // 3. Regional Storage (if docked at a starport)
            let inventorySave = Promise.resolve();
            if (isDocked) {
                const currentStorage = starportId ? (gameState.storage[starportId] || []) : [];
                if (starportId) {
                    inventorySave = cloudService.saveInventoryState(cloudUser.id, starportId, currentStorage, "saveGame");
                }
            }

            await Promise.all([physicalSave, commanderSave, inventorySave]);
            setIsCloudSyncing(false);
        
    };

    // Auto-save interval instead of debounced effect on every state change
useEffect(() => {
    const interval = setInterval(() => {
        saveGame();
    }, 5000);

    return () => clearInterval(interval);
}, []); // ← FIXED

useEffect(() => {
    const onCommanderState = (event) => {
        const detail = event?.detail || {};
        const nextCommanderName = String(detail.commander_name || '').trim();

        const activeShipStats = (detail.active_ship_stats && typeof detail.active_ship_stats === 'object') ? detail.active_ship_stats : null;
        const activeShipCombatStats = (activeShipStats?.combatStats && typeof activeShipStats.combatStats === 'object') ? activeShipStats.combatStats : null;
        const activeShipFittings = (activeShipStats?.fittings && typeof activeShipStats.fittings === 'object') ? activeShipStats.fittings : null;
        setGameState(prev => ({
            ...prev,
            credits: typeof detail.credits === 'number' ? detail.credits : prev.credits,
            experience: typeof detail.experience === 'number' ? detail.experience : prev.experience,
            level: typeof detail.level === 'number' ? detail.level : prev.level,
            commanderName: nextCommanderName || prev.commanderName,
            activeShipId: isPersistableShipId(detail.active_ship_id) ? detail.active_ship_id : prev.activeShipId,
            hp: typeof activeShipStats?.hp === 'number' ? activeShipStats.hp : prev.hp,
            maxHp: typeof activeShipStats?.maxHp === 'number' ? activeShipStats.maxHp : (typeof activeShipCombatStats?.maxHp === 'number' ? activeShipCombatStats.maxHp : prev.maxHp),
            shields: typeof activeShipStats?.shields === 'number' ? activeShipStats.shields : prev.shields,
            maxShields: typeof activeShipStats?.maxShields === 'number' ? activeShipStats.maxShields : (typeof activeShipCombatStats?.maxShields === 'number' ? activeShipCombatStats.maxShields : prev.maxShields),
            energy: typeof activeShipStats?.energy === 'number' ? activeShipStats.energy : prev.energy,
            maxEnergy: typeof activeShipStats?.maxEnergy === 'number' ? activeShipStats.maxEnergy : (typeof activeShipCombatStats?.maxEnergy === 'number' ? activeShipCombatStats.maxEnergy : prev.maxEnergy),
            armor: typeof activeShipStats?.armor === 'number' ? activeShipStats.armor : (typeof activeShipCombatStats?.armor === 'number' ? activeShipCombatStats.armor : prev.armor),
            resistances: activeShipStats?.resistances && typeof activeShipStats.resistances === 'object' ? activeShipStats.resistances : prev.resistances,
            combatStats: activeShipCombatStats || prev.combatStats,
            fittings: activeShipFittings || prev.fittings
        }));

        if (gameManagerRef.current?.stats && activeShipStats) {
            if (typeof activeShipStats.hp === 'number') gameManagerRef.current.stats.hp = activeShipStats.hp;
            if (typeof activeShipStats.maxHp === 'number') gameManagerRef.current.stats.maxHp = activeShipStats.maxHp;
            else if (typeof activeShipCombatStats?.maxHp === 'number') gameManagerRef.current.stats.maxHp = activeShipCombatStats.maxHp;
            if (typeof activeShipStats.shields === 'number') gameManagerRef.current.stats.shields = activeShipStats.shields;
            if (typeof activeShipStats.maxShields === 'number') gameManagerRef.current.stats.maxShields = activeShipStats.maxShields;
            else if (typeof activeShipCombatStats?.maxShields === 'number') gameManagerRef.current.stats.maxShields = activeShipCombatStats.maxShields;
            if (typeof activeShipStats.energy === 'number') gameManagerRef.current.stats.energy = activeShipStats.energy;
            if (typeof activeShipStats.maxEnergy === 'number') gameManagerRef.current.stats.maxEnergy = activeShipStats.maxEnergy;
            else if (typeof activeShipCombatStats?.maxEnergy === 'number') gameManagerRef.current.stats.maxEnergy = activeShipCombatStats.maxEnergy;
            if (typeof activeShipStats.armor === 'number') gameManagerRef.current.stats.armor = activeShipStats.armor;
            else if (typeof activeShipCombatStats?.armor === 'number') gameManagerRef.current.stats.armor = activeShipCombatStats.armor;
            if (activeShipStats?.resistances && typeof activeShipStats.resistances === 'object') gameManagerRef.current.stats.resistances = { ...activeShipStats.resistances };
            if (activeShipCombatStats) gameManagerRef.current.stats.combatStats = activeShipCombatStats;
            if (activeShipFittings) {
                gameManagerRef.current.fittings = activeShipFittings;
                gameManagerRef.current.gameState = { ...(gameManagerRef.current.gameState || {}), fittings: activeShipFittings };
            }
        }
        if (gameManagerRef.current?.ship && activeShipStats) {
            if (typeof activeShipStats.hp === 'number') gameManagerRef.current.ship.hp = activeShipStats.hp;
            if (typeof activeShipStats.maxHp === 'number') gameManagerRef.current.ship.maxHp = activeShipStats.maxHp;
            else if (typeof activeShipCombatStats?.maxHp === 'number') gameManagerRef.current.ship.maxHp = activeShipCombatStats.maxHp;
            if (typeof activeShipStats.shields === 'number') gameManagerRef.current.ship.shields = activeShipStats.shields;
            if (typeof activeShipStats.maxShields === 'number') gameManagerRef.current.ship.maxShields = activeShipStats.maxShields;
            else if (typeof activeShipCombatStats?.maxShields === 'number') gameManagerRef.current.ship.maxShields = activeShipCombatStats.maxShields;
            if (typeof activeShipStats.energy === 'number') gameManagerRef.current.ship.energy = activeShipStats.energy;
            if (typeof activeShipStats.maxEnergy === 'number') gameManagerRef.current.ship.maxEnergy = activeShipStats.maxEnergy;
            else if (typeof activeShipCombatStats?.maxEnergy === 'number') gameManagerRef.current.ship.maxEnergy = activeShipCombatStats.maxEnergy;
            if (typeof activeShipStats.armor === 'number') gameManagerRef.current.ship.armor = activeShipStats.armor;
            else if (typeof activeShipCombatStats?.armor === 'number') gameManagerRef.current.ship.armor = activeShipCombatStats.armor;
            if (activeShipStats?.resistances && typeof activeShipStats.resistances === 'object') gameManagerRef.current.ship.resistances = { ...activeShipStats.resistances };
            if (activeShipCombatStats) gameManagerRef.current.ship.combatStats = activeShipCombatStats;
            if (activeShipFittings) gameManagerRef.current.ship.fittings = activeShipFittings;
        }

        if (nextCommanderName && gameManagerRef.current?.updateCommanderName) {
            gameManagerRef.current.updateCommanderName(nextCommanderName);
        }
    };

    window.addEventListener('sectorfall:commander_state', onCommanderState);
    return () => window.removeEventListener('sectorfall:commander_state', onCommanderState);
}, []);

useEffect(() => {
    const sanitizeAuthoritativeFittings = (...candidates) => {
        for (const candidate of candidates) {
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                return candidate;
            }
        }
        return {};
    };

    const onAuthoritativeShipState = (event) => {
        const detail = event?.detail || {};
        const nextCombatStats = detail.combat_stats && typeof detail.combat_stats === 'object'
            ? detail.combat_stats
            : ((detail.combatStats && typeof detail.combatStats === 'object') ? detail.combatStats : null);
        const nextResistances = detail.resistances && typeof detail.resistances === 'object' ? detail.resistances : null;
        const nextFittings = sanitizeAuthoritativeFittings(
            detail.fittings,
            detail.active_ship_stats?.fittings,
            gameManagerRef.current?.fittings,
            gameManagerRef.current?.ship?.fittings,
            gameManagerRef.current?.gameState?.fittings
        );
        const resolvedMaxHp = typeof detail.maxHp === 'number' ? detail.maxHp : (typeof nextCombatStats?.maxHp === 'number' ? nextCombatStats.maxHp : null);
        const resolvedMaxShields = typeof detail.maxShields === 'number' ? detail.maxShields : (typeof nextCombatStats?.maxShields === 'number' ? nextCombatStats.maxShields : null);
        const resolvedMaxEnergy = typeof detail.maxEnergy === 'number' ? detail.maxEnergy : (typeof nextCombatStats?.maxEnergy === 'number' ? nextCombatStats.maxEnergy : null);
        const resolvedArmor = typeof detail.armor === 'number' ? detail.armor : (typeof nextCombatStats?.armor === 'number' ? nextCombatStats.armor : null);

        console.log('[Authoritative Ship State]', {
            hp: detail.hp,
            maxHp: resolvedMaxHp,
            shields: detail.shields,
            maxShields: resolvedMaxShields,
            energy: detail.energy,
            maxEnergy: resolvedMaxEnergy,
            armor: resolvedArmor,
            resistances: nextResistances,
            combat_stats: nextCombatStats,
            fittings: nextFittings
        });

        setGameState(prev => ({
            ...prev,
            hp: typeof detail.hp === 'number' ? detail.hp : prev.hp,
            maxHp: typeof resolvedMaxHp === 'number' ? resolvedMaxHp : prev.maxHp,
            shields: typeof detail.shields === 'number' ? detail.shields : prev.shields,
            maxShields: typeof resolvedMaxShields === 'number' ? resolvedMaxShields : prev.maxShields,
            energy: typeof detail.energy === 'number' ? detail.energy : prev.energy,
            maxEnergy: typeof resolvedMaxEnergy === 'number' ? resolvedMaxEnergy : prev.maxEnergy,
            armor: typeof resolvedArmor === 'number' ? resolvedArmor : prev.armor,
            resistances: nextResistances || prev.resistances,
            combatStats: nextCombatStats || prev.combatStats,
            fittings: sanitizeAuthoritativeFittings(nextFittings, prev.fittings),
            ownedShips: Array.isArray(prev.ownedShips)
                ? prev.ownedShips.map((ship) => {
                    if (!ship || ship.id !== prev.activeShipId) return ship;
                    return {
                        ...ship,
                        hp: typeof detail.hp === 'number' ? detail.hp : ship.hp,
                        maxHp: typeof resolvedMaxHp === 'number' ? resolvedMaxHp : ship.maxHp,
                        shields: typeof detail.shields === 'number' ? detail.shields : ship.shields,
                        maxShields: typeof resolvedMaxShields === 'number' ? resolvedMaxShields : ship.maxShields,
                        energy: typeof detail.energy === 'number' ? detail.energy : ship.energy,
                        maxEnergy: typeof resolvedMaxEnergy === 'number' ? resolvedMaxEnergy : ship.maxEnergy,
                        armor: typeof resolvedArmor === 'number' ? resolvedArmor : ship.armor,
                        resistances: nextResistances || ship.resistances,
                        combatStats: nextCombatStats || ship.combatStats,
                        fittings: sanitizeAuthoritativeFittings(nextFittings, ship.fittings),
                        kineticRes: nextResistances ? Number(nextResistances.kinetic || 0) : ship.kineticRes,
                        thermalRes: nextResistances ? Number(nextResistances.thermal || 0) : ship.thermalRes,
                        blastRes: nextResistances ? Number(nextResistances.blast || 0) : ship.blastRes
                    };
                })
                : prev.ownedShips
        }));

        if (gameManagerRef.current?.stats) {
            if (typeof detail.hp === 'number') gameManagerRef.current.stats.hp = detail.hp;
            if (typeof resolvedMaxHp === 'number') gameManagerRef.current.stats.maxHp = resolvedMaxHp;
            if (typeof detail.shields === 'number') gameManagerRef.current.stats.shields = detail.shields;
            if (typeof resolvedMaxShields === 'number') gameManagerRef.current.stats.maxShields = resolvedMaxShields;
            if (typeof detail.energy === 'number') gameManagerRef.current.stats.energy = detail.energy;
            if (typeof resolvedMaxEnergy === 'number') gameManagerRef.current.stats.maxEnergy = resolvedMaxEnergy;
            if (typeof resolvedArmor === 'number') gameManagerRef.current.stats.armor = resolvedArmor;
            if (detail.resistances && typeof detail.resistances === 'object') {
                gameManagerRef.current.stats.kineticRes = Number(detail.resistances.kinetic || 0);
                gameManagerRef.current.stats.thermalRes = Number(detail.resistances.thermal || 0);
                gameManagerRef.current.stats.blastRes = Number(detail.resistances.blast || 0);
                gameManagerRef.current.stats.resistances = { ...detail.resistances };
            }
            if (detail.combat_stats && typeof detail.combat_stats === 'object') {
                gameManagerRef.current.stats.combatStats = detail.combat_stats;
            } else if (detail.combatStats && typeof detail.combatStats === 'object') {
                gameManagerRef.current.stats.combatStats = detail.combatStats;
            }
            gameManagerRef.current.fittings = sanitizeAuthoritativeFittings(nextFittings, gameManagerRef.current.fittings);
            gameManagerRef.current.gameState = {
                ...(gameManagerRef.current.gameState || {}),
                fittings: sanitizeAuthoritativeFittings(nextFittings, gameManagerRef.current.gameState?.fittings)
            };
        }
        if (gameManagerRef.current?.ship) {
            if (typeof detail.hp === 'number') gameManagerRef.current.ship.hp = detail.hp;
            if (typeof resolvedMaxHp === 'number') gameManagerRef.current.ship.maxHp = resolvedMaxHp;
            if (typeof detail.shields === 'number') gameManagerRef.current.ship.shields = detail.shields;
            if (typeof resolvedMaxShields === 'number') gameManagerRef.current.ship.maxShields = resolvedMaxShields;
            if (typeof detail.energy === 'number') gameManagerRef.current.ship.energy = detail.energy;
            if (typeof resolvedMaxEnergy === 'number') gameManagerRef.current.ship.maxEnergy = resolvedMaxEnergy;
            if (typeof resolvedArmor === 'number') gameManagerRef.current.ship.armor = resolvedArmor;
            if (detail.resistances && typeof detail.resistances === 'object') {
                gameManagerRef.current.ship.resistances = { ...detail.resistances };
                gameManagerRef.current.ship.kineticRes = Number(detail.resistances.kinetic || 0);
                gameManagerRef.current.ship.thermalRes = Number(detail.resistances.thermal || 0);
                gameManagerRef.current.ship.blastRes = Number(detail.resistances.blast || 0);
            }
            if (detail.combat_stats && typeof detail.combat_stats === 'object') {
                gameManagerRef.current.ship.combatStats = detail.combat_stats;
            } else if (detail.combatStats && typeof detail.combatStats === 'object') {
                gameManagerRef.current.ship.combatStats = detail.combatStats;
            }
            gameManagerRef.current.ship.fittings = sanitizeAuthoritativeFittings(nextFittings, gameManagerRef.current.ship.fittings);
        }
    };

    window.addEventListener('sectorfall:authoritative_ship_state', onAuthoritativeShipState);
    return () => window.removeEventListener('sectorfall:authoritative_ship_state', onAuthoritativeShipState);
}, []);

    const loadGame = async () => {
        beginInitialLoadingSequence();
        queueLoadingStep("ESTABLISHING AUTHENTICATION HANDSHAKE...", 650);
        console.log("%c[Persistence] [DIAGNOSTIC] Step 1: Initiating Auth Handshake...", 'background: #222; color: #ffcc00; padding: 2px 5px;');
        
        // 1. Authenticate with Supabase
        let user = null;
        try {
            user = await cloudService.login('ARC_CLOUD');
            setCloudUser(user);
        } catch (err) {
            console.error("%c[Persistence] [CRITICAL] Step 1 Failed: Authentication failure.", 'background: #440000; color: #fff;', err);
            queueLoadingStep("AUTH HANDSHAKE FAILED. REATTEMPTING...", 900);
            return;
        }

        if (!user || !user.id) {
            console.error("%c[Persistence] [CRITICAL] Step 1 Failed: No verified UID authority. Manifest aborted.", 'background: #440000; color: #fff;');
            return;
        }

        const playerId = user.id;
        console.log(`%c[Persistence] [DIAGNOSTIC] Step 1 Complete: UID verified: ${playerId}`, 'color: #00ff66;');
        queueLoadingStep("MANIFESTING PHYSICAL ENTITY IDENTITY...", 520);

        // 1.5. Load Commander Data + Profile
        let commanderData = await cloudService.getCommanderData(playerId);
        let profile = await cloudService.getCommanderProfile(playerId);
        const defaultStarport = 'CYGNUS_PRIME_STARPORT';
        const defaultCommanderStats = { kills: 0, deaths: 0, flights: 0, asteroids_mined: 0 };
        const hadCommanderData = !!commanderData;
        const hadProfile = !!profile;

        if (!commanderData) {
            console.log("%c[Persistence] [NEW PLAYER] [INIT] No commander_data row found. Initializing starter manifest...", 'background: #222; color: #00ccff; padding: 2px 5px;');
            const commanderResult = await cloudService.updateCommanderData(playerId, {
                commander_name: user.name,
                active_ship_id: null,
                owned_ships: [],
                fleet: [],
                last_station_id: defaultStarport,
                credits: 1000,
                level: 1,
                experience: 0
            });
            commanderData = commanderResult?.data || commanderResult || null;
        }

        if (!profile) {
            const profileResult = await cloudService.updateCommanderProfile(playerId, {
                commander_name: commanderData?.commander_name || user.name,
                home_starport: defaultStarport,
                commander_stats: defaultCommanderStats
            });
            profile = profileResult?.data || null;
        }

        if (!hadCommanderData && !hadProfile) {
            console.log("%c[Persistence] [NEW PLAYER] Issuing Starter Kit to: " + defaultStarport, 'color: #ffcc00;');
            await cloudService.issueStarterKit(playerId, defaultStarport);
        }

        profile = profile || {};
        const homeStarport = profile.home_starport || 'CYGNUS_PRIME_STARPORT';
        const lastStationId = commanderData?.last_station_id || homeStarport;

        // 2. Authoritative Discovery attempt
        console.log("%c[Persistence] [DIAGNOSTIC] Step 2: Querying manifest for UID: " + playerId + " at " + lastStationId, 'background: #222; color: #ffcc00; padding: 2px 5px;');
        let cloudRecord = await cloudService.loadFromCloud(playerId, lastStationId);

// --- Regional Storage Overview (read-only, no remote transfer) ---
try {
    const allInvStates = await cloudService.getAllInventoryStates(playerId);
    const regionalStorage = {};
    (allInvStates || []).forEach(row => {
        const portKey = String(row.starport_id || '').toUpperCase();
        const systemId = STARPORT_TO_SYSTEM[portKey] || 'unknown';
        if (!regionalStorage[systemId]) regionalStorage[systemId] = {};
        if (!regionalStorage[systemId][playerId]) regionalStorage[systemId][playerId] = [];
        (row.items || []).forEach(it => {
            regionalStorage[systemId][playerId].push({ ...it, starportId: portKey });
        });
    });
    // keep in local state immediately so Commander -> Assets is populated
    setGameState(prev => ({ ...prev, regionalStorage }));
    // keep in engine mirror if present
    if (gameManagerRef.current) gameManagerRef.current.regionalStorage = regionalStorage;
} catch (e) {
    console.warn("[Persistence] Regional storage overview unavailable:", e?.message || e);
}

        
        // 3. Forced Manifestation if null or invalid
        if (!cloudRecord || cloudRecord.ship_type === 'Unknown' || !cloudRecord.ship_type) {
            console.log("%c[Persistence] [DIAGNOSTIC] Step 2: No valid manifest found at " + lastStationId + ". Creating default ship...", 'background: #222; color: #ff8000; padding: 2px 5px;');
            
            const systemId = STARPORT_TO_SYSTEM[lastStationId] || 'cygnus-prime';
            const defaultShipType = 'OMNI SCOUT';
            
            // Safe spawn calculations
            const nearbyShips = await cloudService.getNearbyShips(systemId);
            let spawnPos = { x: 500, y: 0 }; 
            const minSafeDist = 200;
            let attempts = 0;
            let safe = false;
            
            while (!safe && attempts < 20) {
                safe = true;
                for (const ship of nearbyShips) {
                    const tel = ship.telemetry || {};
                    const dx = spawnPos.x - (tel.x || 0);
                    const dy = spawnPos.y - (tel.y || 0);
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist < minSafeDist) {
                        safe = false;
                        const angle = (attempts / 8) * Math.PI * 2;
                        const radius = 500 + (attempts * 100);
                        spawnPos.x = Math.cos(angle) * radius;
                        spawnPos.y = Math.sin(angle) * radius;
                        break;
                    }
                }
                attempts++;
            }

const defaultTelemetry = {
    x: spawnPos.x,
    y: spawnPos.y,
    rot: 0,
    vx: 0,
    vy: 0,
    hp: SHIP_REGISTRY[defaultShipType].hp,
    maxHp: SHIP_REGISTRY[defaultShipType].hp,
    shields: 0,
    maxShields: 0,
    energy: SHIP_REGISTRY[defaultShipType].baseEnergy,
    maxEnergy: SHIP_REGISTRY[defaultShipType].baseEnergy
    // system_id removed — EC2 is authoritative
};

            // Force the write to Postgres
            console.log("%c[Persistence] [DIAGNOSTIC] Step 2: [POST] Triggering createDefaultShip for " + lastStationId + "...", 'color: #00ccff; font-weight: bold;');
            const creationResult = await cloudService.createDefaultShip(playerId, lastStationId, defaultShipType, defaultTelemetry);
            
            if (!creationResult) {
                console.error("%c[Persistence] [CRITICAL] Step 2 Failed: Manifest creation failed. Aborting manifestation pipeline.", 'background: #440000; color: #fff;');
                return;
            }

            // RE-VERIFICATION: Explicit secondary query to confirm Postgres write persistence
            console.log("%c[Persistence] [DIAGNOSTIC] Step 2: [VERIFICATION] Re-querying Postgres to confirm row presence for " + lastStationId + "...", 'color: #ffcc00; font-weight: bold;');
            cloudRecord = await cloudService.loadFromCloud(playerId, lastStationId);
            
            if (!cloudRecord || !cloudRecord.ship_type || cloudRecord.ship_type === 'Unknown') {
                console.error("%c[Persistence] [CRITICAL] Step 2 Failed: Manifest verification failed after creation. Aborting.", 'background: #440000; color: #fff;');
                return;
            }
            const t = cloudRecord.telemetry || {};
            const tx = typeof t.x === 'number' ? t.x.toFixed(1) : '0.0';
            const ty = typeof t.y === 'number' ? t.y.toFixed(1) : '0.0';
            const trot = typeof t.rot === 'number' ? t.rot.toFixed(2) : '0.00';
            console.log(`%c[Persistence] [DIAGNOSTIC] Step 2 Complete: Vessel manifest confirmed. Telemetry: x=${tx}, y=${ty}, rot=${trot}`, 'color: #00ff66;');
        } else {
            const t = cloudRecord.telemetry || {};
            const tx = typeof t.x === 'number' ? t.x.toFixed(1) : '0.0';
            const ty = typeof t.y === 'number' ? t.y.toFixed(1) : '0.0';
            const trot = typeof t.rot === 'number' ? t.rot.toFixed(2) : '0.00';
            console.log(`%c[Persistence] [DIAGNOSTIC] Step 2 Complete: Recovered manifest for: ${cloudRecord.ship_type}. Telemetry: x=${tx}, y=${ty}, rot=${trot}`, 'color: #00ff66;');
        }

        // ABSOLUTE GATE: Abort if cloudRecord is not authoritatively confirmed
        if (!cloudRecord || !cloudRecord.ship_type || cloudRecord.ship_type === 'Unknown') {
            console.error("%c[Persistence] [CRITICAL] Manifestation Corrupted: Physical data is invalid. Engine initialization aborted.", 'background: #440000; color: #fff;');
            return;
        }

        queueLoadingStep("QUERYING GALAXY REGISTRY FOR REGIONAL SECTOR...", 520);

        // 4. Engine Manifestation handshake
        console.log("%c[Persistence] [DIAGNOSTIC] Step 3: Gating Engine Initialization...", 'background: #222; color: #ffcc00; padding: 2px 5px;');
        const checkReady = () => {
            return new Promise(resolve => {
                const interval = setInterval(() => {
                    if (gameManagerRef.current && gameManagerRef.current.ready) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 50);
            });
        };
        await checkReady();
        console.log("%c[Persistence] [DIAGNOSTIC] Step 3 Complete: Engine Handshake verified.", 'color: #00ff66;');
        
        queueLoadingStep("SYNCHRONIZING ENGINE TO CLOUD MANIFEST...", 520);

        // 5. Final Synchronization
        console.log("%c[Persistence] [DIAGNOSTIC] Step 4: Synchronizing Engine to Cloud Manifest...", 'background: #222; color: #ffcc00; padding: 2px 5px;');
        const localCacheRaw = localStorage.getItem('arc_space_flight_save');
        let localCache = localCacheRaw ? JSON.parse(localCacheRaw) : null;
        
        const savedState = localCache?.gameState || {};
        const telemetryBase = (cloudRecord && typeof cloudRecord.telemetry === 'object' && cloudRecord.telemetry)
  ? { ...cloudRecord.telemetry }
  : {};

// ✅ merge ship_states_v2 columns into telemetry so vitals persist across refresh
telemetryBase.hp = numOr(telemetryBase.hp, numOr(cloudRecord.hull, numOr(cloudRecord.hp, 0)));
telemetryBase.maxHp = numOr(telemetryBase.maxHp, numOr(cloudRecord.maxHp, 0));
telemetryBase.shields = numOr(telemetryBase.shields, numOr(cloudRecord.shields, 0));
telemetryBase.maxShields = numOr(telemetryBase.maxShields, numOr(cloudRecord.maxShields, 0));
telemetryBase.energy = numOr(telemetryBase.energy, numOr(cloudRecord.energy, 0));
telemetryBase.maxEnergy = numOr(telemetryBase.maxEnergy, numOr(cloudRecord.maxEnergy, 0));

const telemetry = telemetryBase;
const shipType = cloudRecord.ship_type;

if (gameManagerRef.current) {
  if (!gameManagerRef.current.stats) gameManagerRef.current.stats = {};
  gameManagerRef.current.stats.name = shipType;

  if (gameManagerRef.current.ship) {
    gameManagerRef.current.ship.name = shipType;
  }

  if (typeof gameManagerRef.current.refreshShipConfig === "function") {
    gameManagerRef.current.refreshShipConfig();
  }

  // ✅ ADD THIS (rebuildShip)
  if (typeof gameManagerRef.current.rebuildShip === "function") {
    const _shipKey = resolveShipRegistryKey(shipType) || shipType;
    const base = SHIP_REGISTRY[_shipKey] || SHIP_REGISTRY['OMNI SCOUT'];
    const hydratedShip = hydrateVessel({
      ...base,
      id: commanderData.active_ship_id || "default",
      type: shipType,
      name: getShipDisplayName(shipType),
      hp: telemetry && typeof telemetry.hp === "number" ? telemetry.hp : base.hp,
      energy: telemetry && typeof telemetry.energy === "number" ? telemetry.energy : base.baseEnergy,
      fittings: (savedState && savedState.fittings) ? savedState.fittings : {}
    });
    gameManagerRef.current.rebuildShip(hydratedShip);
    console.log("[Init] rebuildShip called for:", shipType);
  }
}
        // system_id now comes ONLY from EC2 spawn packet
let targetSystemId = STARPORT_TO_SYSTEM[lastStationId] || 'cygnus-prime';
        const currentStarportId = SYSTEM_TO_STARPORT[targetSystemId];
        await gameManagerRef.current.loadSystem(targetSystemId, currentStarportId);

        setIsDocked(localCache ? localCache.isDocked : true);
        const dockedAtStarport = localCache ? localCache.isDocked : true;

        // 6. Load Regional Storage and Hangar if docked
        let stationStorage = [];
        let hangarShips = [];
        if (dockedAtStarport) {
            if (currentStarportId) {
                const [inventoryState, hangarData] = await Promise.all([
                    cloudService.getInventoryState(playerId, currentStarportId),
                    cloudService.getHangarShips(playerId, currentStarportId)
                ]);
                
                if (inventoryState) {
                    stationStorage = (Array.isArray(inventoryState.items) ? inventoryState.items : [])
                        .filter(i => i.type !== 'ship' && !i.isShip)
                        .map(hydrateItem);
                }
                if (hangarData) {
                    hangarShips = (hangarData || []).map(h => {
                        const config = h.ship_config || {};
                        const type = config.type || config.item_id || 'OMNI SCOUT';
                        const registry = SHIP_REGISTRY[type] || SHIP_REGISTRY['OMNI SCOUT'];
                        
                        return hydrateVessel({
                            ...registry, // Use registry as base for safety
                            ...config, // Overlay stored instance data
                            id: h.ship_id,
                            type: type, // Ensure type matches registry key
                            dbId: h.id // internal row id
                        });
                    });
                }
            }
        }

        const actualSystemData = SYSTEMS_REGISTRY[targetSystemId];
        const systemInfo = {
            id: targetSystemId,
            name: actualSystemData.name.toUpperCase(),
            sector: actualSystemData.sector,
            security: actualSystemData.security,
            securityValue: actualSystemData.securityValue
        };

        setGameState(prev => {
            // Reconstruct ship cargo from authoritative ship_states_v2.cargo.
            // telemetry.cargo is not guaranteed to be populated on load, so prefer cloudRecord.cargo.
            const cargoRaw = Array.isArray(cloudRecord?.cargo)
                ? cloudRecord.cargo
                : (Array.isArray(telemetry?.cargo) ? telemetry.cargo : []);

            // Mirror into telemetry for any code that still reads telemetry.cargo.
            if (telemetry && typeof telemetry === 'object') telemetry.cargo = cargoRaw;

            const loadedInventory = cargoRaw.map(hydrateItem);
            const totalWeight = loadedInventory.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
            const totalVolume = loadedInventory.reduce((sum, item) => sum + (Number(item.volume || (item.weight * 2)) || 0), 0);

            const newState = {
                ...prev,
                // Authority Gating: Local cache is ignored for progress and assets
                credits: commanderData?.credits ?? prev.credits ?? 1000,
                experience: commanderData?.experience ?? prev.experience ?? 0,
                level: commanderData?.level ?? prev.level ?? 1,
                commanderStats: profile.commander_stats ?? prev.commanderStats,
                homeStarport: profile.home_starport ?? 'CYGNUS_PRIME_STARPORT',
                
                // Inventory from manifest/storage (Absolute Authority)
                inventory: loadedInventory,
                currentCargoWeight: totalWeight,
                currentCargoVolume: totalVolume,
                storage: currentStarportId ? { ...prev.storage, [currentStarportId]: stationStorage } : prev.storage,
                hangarShips: hangarShips,
                
                activeMenu: null,
                target: null,
                currentSystem: systemInfo,
                commanderName: commanderData?.commander_name || profile.commander_name || user.name,
                globalMarkets: seedNPCMarketListings(savedState.globalMarkets || {}),
                ownedShips: commanderData.owned_ships || [] // PERSISTENCE FIX: Load full fleet manifest
            };

            // Link the manifested ship to the active game state
            let activeShip;
            if (!newState.ownedShips || newState.ownedShips.length === 0) {
                // ✅ If the player already has ships stored in hangar (common for brand-new profiles after starter kit),
                // use the first stored ship as the active fleet entry to avoid "double ship" manifests.
                if (Array.isArray(newState.hangarShips) && newState.hangarShips.length > 0) {
                    const primary = newState.hangarShips[0];
                    // Hydrate the primary hangar ship with telemetry so the active craft reflects ship_states_v2.
                    activeShip = hydrateVessel(primary, primary, telemetry);
                    // Mirror hangar ships into ownedShips for the fleet manifest.
                    newState.ownedShips = newState.hangarShips.map(s => (s.id === primary.id ? activeShip : hydrateVessel(s, s)));
                    newState.activeShipId = primary.id;
                } else {
                    const newShipId = uuid();
                    const displayName = getShipDisplayName(shipType || 'OMNI SCOUT');
                    const registryEntry = { id: newShipId, type: shipType || 'OMNI SCOUT', name: String(displayName || (shipType || 'OMNI SCOUT')).toUpperCase() };
                    // Hydrate using telemetry as the final state
                    activeShip = hydrateVessel(registryEntry, null, telemetry);
                    newState.ownedShips = [activeShip];
                    newState.activeShipId = newShipId;
                }
            } else {
                // Fleet exists in cloud. Resolve the active ship from commander_data and sync with ship_states telemetry.
                const cloudActiveShipId = commanderData.active_ship_id || newState.ownedShips[0].id;
                let foundShip = newState.ownedShips.find(s => s.id === cloudActiveShipId);
                
                // Fallback: if ship ID from commander_data not found in owned_ships, fallback to type match
                if (!foundShip) {
                    const cloudShipType = shipType || (telemetry?.shipType);
                    foundShip = newState.ownedShips.find(s => s.type === cloudShipType);
                }
                
                // Final fallback: first ship in fleet
                if (!foundShip) foundShip = newState.ownedShips[0];

                newState.activeShipId = foundShip.id;
                
                // Hydrate the fleet manifest with authoritative stats and slot map integrity
                newState.ownedShips = newState.ownedShips.map(s => {
                    // For the active ship, we merge telemetry. For others, we just hydrate from registry + fleet entry.
                    if (s.id === foundShip.id) {
                        return hydrateVessel(s, s, telemetry);
                    }
                    return hydrateVessel(s, s);
                });
                
                activeShip = newState.ownedShips.find(s => s.id === foundShip.id);
            }

            // --- AUTHORITATIVE STAT SYNC ---
            // Ensure top-level gameState vitals match the hydrated authoritative active ship.
            // This prevents default templates or blueprints from leaking into the active UI state.
            newState.fittings = activeShip.fittings;
            newState.hp = activeShip.hp;
            newState.maxHp = activeShip.maxHp;
            newState.energy = activeShip.energy;
            newState.maxEnergy = activeShip.maxEnergy;
            newState.shields = activeShip.shields;
            newState.maxShields = activeShip.maxShields;
            newState.shipName = activeShip.name;
            newState.shipClass = activeShip.classId || activeShip.type;

            return newState;
        });

        if (telemetry) {
            gameManagerRef.current.setTelemetry({
                ...telemetry,
                shipType: shipType
            });
        }
        gameManagerRef.current.updateCommanderName(savedState.commanderName || user.name);
        gameManagerRef.current.refreshShipConfig();
        
        await queueLoadingStep("LINK ESTABLISHED. PILOT IN COMMAND.", 850);
        await flushInitialLoadingSequence(4200);
        gameManagerRef.current.isLoaded = true; // Enable persistence loop after full initialization
        setIsGameLoaded(true);
        console.log("%c[Persistence] [DIAGNOSTIC] COMPLETE: Absolute manifest confirmed. Pilot in command.", 'background: #004400; color: #fff; font-weight: bold; padding: 5px;');
    };

    useEffect(() => {
        if (gameManagerRef.current) {
            gameManagerRef.current.isMenuOpen = !!activeMenu || showStarMap || !!securityError || !!fittingWarning || arenaState.open || battlegroundState.open;
        }
    }, [activeMenu, showStarMap, securityError, fittingWarning, arenaState.open, battlegroundState.open]);

    useEffect(() => {
        if ((isArenaCurrent || isBattlegroundCurrent) && showStarMap) {
            setShowStarMap(false);
            setIsLeapMode(false);
        }
    }, [isArenaCurrent, isBattlegroundCurrent, showStarMap]);

    useEffect(() => {
        if (gameManagerRef.current) {
            gameManagerRef.current.setDocked(isDocked);
        }
        
        // Refresh Starport Data when docking
        if (isDocked && cloudService.user) {
            const currentSystemId = gameState.currentSystem?.id;
            const starportId = SYSTEM_TO_STARPORT[currentSystemId];
            if (starportId) {
                (async () => {
                    const [inventoryState, hangarData] = await Promise.all([
                        cloudService.getInventoryState(cloudService.user.id, starportId),
                        cloudService.getHangarShips(cloudService.user.id, starportId)
                    ]);
                    
                    setGameState(prev => ({ ...prev,
                        storage: { ...prev.storage, [starportId]: (Array.isArray(inventoryState?.items) ? inventoryState.items : []).filter(i => i.type !== 'ship' && !i.isShip) },
                        hangarShips: (hangarData || []).map(h => {
                            const config = h.ship_config || {};
                            const type = config.type || config.item_id || 'OMNI SCOUT';
                            const registry = SHIP_REGISTRY[type] || SHIP_REGISTRY['OMNI SCOUT'];
                            return {
                                ...registry,
                                ...config,
                                id: h.ship_id,
                                type: type,
                                classId: registry.classId || type,
                                isShip: true,
                                hp: config.hp ?? registry.hp,
                                energy: config.energy ?? registry.baseEnergy,
                                fittings: config.fittings || {
                                    weapon1: null, weapon2: null, active1: null,
                                    passive1: null, passive2: null, rig1: null,
                                    synapse1: null, synapse2: null, synapse3: null
                                },
                                dbId: h.id
                            };
                        })
                    }));
                })();
            }
        }
    }, [isDocked]);

    useEffect(() => {
        if (gameManagerRef.current) {
            gameManagerRef.current.inventory = gameState.inventory;
            gameManagerRef.current.fittings = gameState.fittings;
            gameManagerRef.current.activeWeapons = gameState.activeWeapons;
            gameManagerRef.current.commanderImplants = gameState.commanderImplants;
            gameManagerRef.current.regionalStorage = gameState.regionalStorage;
            gameManagerRef.current.globalMarkets = gameState.globalMarkets;
            gameManagerRef.current.courierContracts = gameState.courierContracts;
            gameManagerRef.current.factionStandings = gameState.factionStandings;
        }
    }, [gameState.inventory, gameState.fittings, gameState.activeWeapons, gameState.commanderImplants, gameState.regionalStorage, gameState.globalMarkets, gameState.courierContracts, gameState.factionStandings]);

    useEffect(() => {
        if (gameManagerRef.current) {
            gameManagerRef.current.stats.currentCargoWeight = gameState.currentCargoWeight || 0;
            gameManagerRef.current.stats.cargoHold = gameState.cargoHold || 60;
            gameManagerRef.current.broodmotherSystemIds = gameState.broodmotherSystemIds || [];
        }
    }, [gameState.currentCargoWeight, gameState.cargoHold, gameState.broodmotherSystemIds]);

    useEffect(() => {
        if (!containerRef.current) return;
        
        // Authority-First Spawning: Don't spawn a placeholder ship if identity is still PENDING
        const activeShip = gameState.ownedShips.find(s => s.id === gameState.activeShipId);
        const initialShipType = activeShip ? activeShip.type : (gameState.activeShipId === 'PENDING' ? 'PENDING' : gameState.ownedShips[0].type);


        const gameManager = new GameManager(
            containerRef.current, 
            setGameState, 
            showNotification, 
            initialShipType,
            handleShipDestruction, 
            gameState.currentCargoWeight || 0,
            gameState.currentCargoVolume || 0,
            (docked, starportId = null) => {
                console.log("[Dock][Client] GameManager dock callback", { docked, starportId });

                if (docked) {
                    try {
                        const liveTelemetry = gameManagerRef.current?.getTelemetry?.() || null;
                        const snapshotTelemetry = gameManagerRef.current?.lastSpaceTelemetry || null;
                        const telemetry = (liveTelemetry && Number.isFinite(liveTelemetry.x) && Number.isFinite(liveTelemetry.y))
                            ? {
                                x: liveTelemetry.x,
                                y: liveTelemetry.y,
                                rot: liveTelemetry.rot ?? liveTelemetry.rotation ?? 0,
                                vx: liveTelemetry.vx ?? liveTelemetry.velocity?.x ?? 0,
                                vy: liveTelemetry.vy ?? liveTelemetry.velocity?.y ?? 0
                            }
                            : snapshotTelemetry;
                        if (window.backendSocket?.sendDock && starportId) {
                            console.log('[Dock][Client] resolved dock telemetry', telemetry);
                            window.backendSocket.sendDock(starportId, telemetry);
                        } else {
                            console.warn("[Dock][Client] dock callback missing backendSocket.sendDock or starportId", {
                                hasSendDock: !!window.backendSocket?.sendDock,
                                starportId
                            });
                        }
                    } catch (e) {
                        console.warn("[Dock][Client] dock callback sendDock failed:", e);
                    }
                }

                setIsDocked(docked);
            },
            {
                setActiveMenu,
                setShowStarMap,
                setIsLeapMode,
                setInitialStarMapView,
                onSaveRequested: () => {
                    saveGame();
                },
                onArenaBeaconInteract: handleOpenArenaMenu,
                onBattlegroundBeaconInteract: handleOpenBattlegroundMenu,
                onBroodmotherDestroyed: (systemId) => {
                    setGameState(prev => {
                        const nextIds = (prev.broodmotherSystemIds || []).filter(id => id !== systemId);
                        // Repopulate if we're below 3
                        if (nextIds.length < 3) {
                            const newSystem = pickBroodmotherSystems(1).find(id => !nextIds.includes(id));
                            if (newSystem) nextIds.push(newSystem);
                        }
                        return {
                            ...prev,
                            broodmotherSystemIds: nextIds
                        };
                    });
                }
            },
            activeShip?.hp ?? (initialShipType === 'PENDING' ? null : SHIP_REGISTRY[initialShipType]?.hp)
        );
        gameManager.backendSocket = backendSocket;
gameManagerRef.current = gameManager;

// Expose backendSocket for websocket.js + spawn gating
window.backendSocket = backendSocket;

// While we are (re)loading a system / awaiting WELCOME, hide the local ship to avoid 0,0 / 150,150 "jump" frames.
backendSocket.awaitingSpawn = true;
gameManager._hideShipUntilSpawn = true;
try { if (gameManager.ship?.sprite) gameManager.ship.sprite.visible = false; } catch (e) {}

// Wrap loadSystem so every system load re-enters "awaiting spawn" mode before the backend handshake completes.
if (!gameManager._loadSystemWrapped && typeof gameManager.loadSystem === "function") {
  gameManager._loadSystemWrapped = true;
  const __origLoadSystem = gameManager.loadSystem.bind(gameManager);
  gameManager.loadSystem = async (...args) => {
    try {
      backendSocket.awaitingSpawn = true;
      gameManager._hideShipUntilSpawn = true;
      if (gameManager.ship?.sprite) gameManager.ship.sprite.visible = false;
    } catch (e) {}
    return __origLoadSystem(...args);
  };
}


// --- expose a tiny bridge for websocket.js dock UI calls ---
window.game = {
  manager: gameManager,

setLocalPlayerSpawn: function (x, y, rot) {
    if (window.backendSocket?.awaitingSpawn) {
  console.log("[Spawn] Ignored local spawn while awaiting WELCOME:", x, y);
  return;
}
  var gm = gameManager;
  if (!gm) return;

  var s = gm.ship || gm.activeShip || null;

  if (!s) {
    console.warn("[Spawn] No gm.ship found. Deferring spawn.");
    gm._pendingSpawn = { x: x, y: y, rot: rot };
    return;
  }

  // If we were hiding the ship until authoritative spawn, unhide now.
  try { if (s.sprite) s.sprite.visible = true; } catch (e) {}
  gm._hideShipUntilSpawn = false;

  // Normalize rotation
  rot = (typeof rot === "number") ? rot : 0;

  // ✅ FIX 3: prevent “one frame docked position” + any lerp from old state
  // Clear anything that might interpolate from previous (docked) snapshots
  if (Array.isArray(gm.snapshots)) gm.snapshots.length = 0;
  if (Array.isArray(gm.stateBuffer)) gm.stateBuffer.length = 0;
  if (Array.isArray(gm.netBuffer)) gm.netBuffer.length = 0;
  if (Array.isArray(gm.telemetryBuffer)) gm.telemetryBuffer.length = 0;

  if (gm.interpolator && typeof gm.interpolator.reset === "function") {
    gm.interpolator.reset();
  } else if (gm.interpolator && gm.interpolator.prev && gm.interpolator.target) {
    gm.interpolator.prev.x = x; gm.interpolator.prev.y = y; gm.interpolator.prev.rot = rot;
    gm.interpolator.target.x = x; gm.interpolator.target.y = y; gm.interpolator.target.rot = rot;
  }

  // Optional: if your update loop supports it, suppress smoothing for a couple frames
  gm._suppressSmoothingFrames = 2;

  // Stop any “snap back” due to velocity / motion continuing from dock state
  if ("vx" in s) s.vx = 0;
  if ("vy" in s) s.vy = 0;
  if ("rotVel" in s) s.rotVel = 0;
  if (s.velocity && typeof s.velocity.set === "function") s.velocity.set(0, 0);

  // ✅ Apply spawn to engine coords
  s.x = x;
  s.y = y;
  s.rot = rot;

  // ✅ Apply spawn to render coords (sprite)
  if (s.sprite && s.sprite.position && typeof s.sprite.position.set === "function") {
    s.sprite.position.set(x, y, 0);
  } else if (s.sprite && s.sprite.position) {
    s.sprite.position.x = x;
    s.sprite.position.y = y;
  }

  // ✅ Apply rotation in both places (whatever your engine expects)
  if (typeof s.rotation === "number") s.rotation = rot;
  if (s.sprite && typeof s.sprite.rotation === "number") s.sprite.rotation = rot;

  console.log("[Spawn] Applied to gm.ship:", x, y, rot, "ship.x/y=", s.x, s.y);
},
hideSpaceScene: function () {
  gameManager.setDocked(true);
},

showStarportUI: function (starportId) {
  // keep this early so hideSpaceScene can fall back to it
  window.game.lastStarportId = starportId;
  console.log("[Dock][Client] showStarportUI", { starportId });

  // UI only here. DOCK is sent from the actual docking interaction path.
  setIsDocked(true);
  gameManager.setDocked(true);
},

  spawnRemoteShip: function (userId, x, y, rot) {
    return gameManager.spawnRemoteShip(userId, x, y, rot);
  },

  // Modern EC2 remote-player API (preferred)
  upsertRemotePlayer: function (state) {
    try {
      return gameManager.spawnOrUpdateRemotePlayer(state);
    } catch (e) {
      console.warn('[Remote] upsertRemotePlayer failed:', e);
      return null;
    }
  },

  despawnRemotePlayer: function (userId) {
    try {
      if (typeof gameManager.despawnRemotePlayer === 'function') {
        return gameManager.despawnRemotePlayer(userId);
      }
      return null;
    } catch (e) {
      console.warn('[Remote] despawnRemotePlayer failed:', e);
      return null;
    }
  }
};

        // Auction Resolution Callback
        gameManager.onAuctionResolved = (auction, failed = false) => {
            const userId = cloudService.user?.id || 'local';
            if (auction.sellerId === userId) {
                if (failed) {
                    showNotification(`Auction for ${auction.item.name} failed (no bids). Item returned to regional storage.`, "info");
                } else {
                    showNotification(`Auction successful! ${auction.price.toFixed(0)} Cr credited for ${auction.item.name}.`, "success");
                    setGameState(prev => ({ ...prev,
                        credits: prev.credits + auction.price
                    }));
                }
            }
        };

        // Chat is now handled via ChatService (Supabase table + realtime).
        // We initialize it after the auth handshake completes inside initialize().
        let chatRt = null;

        // Load game data after manager is initialized
        const initialize = async () => {
            // STEP 1: Authority Handshake & Data Loading
            // We wait for the cloud manifest to be fully resolved before 
            // the engine acts on any local state.
            await loadGame();

            // Phase 3: Validate catalog/starters/blueprints linkage once per boot
            try {
                validateItemBlueprintIntegrity({ verbose: true });
            } catch (e) {
                console.warn('[Integrity] validateItemBlueprintIntegrity failed:', e?.message || e);
            }

            // STEP 1.25: Chat bootstrap (requires Supabase auth/session)
            try {
                const userId = cloudService.user?.id;
                const commanderName = cloudService.user?.name || localStorage.getItem('arc_commander_name') || '';
                if (userId) {
                    chatService.setIdentity({ userId, commanderName });

                    // Load a small history first (RLS protects DIRECT messages).
                    const history = await chatService.fetchRecent(50);
                    setChatMessages(history);

                    // Subscribe to new inserts.
                    chatRt = chatService.subscribe((chatMsg) => {
                        setChatMessages(prev => {
                            const next = [...prev, chatMsg];
                            if (next.length > 50) next.shift();
                            return next;
                        });
                    });
                }
            } catch (e) {
                console.warn('[Chat] bootstrap failed:', e?.message);
            }

            // STEP 2: Engine Vitals Synchronization
            // Now that gameState has correct ownedShips and activeShipId,
            // ensure the engine matches the UI authority.
            if (gameManagerRef.current) {
                gameManagerRef.current.refreshShipConfig();
            }

            // STEP 3: Multiplayer & Backend Initialization
            if (multiplayerEnabled) {
                const userId = cloudService.user?.id;
                initMultiplayer(gameManager, supabase, userId);
            }

        
        };

        initialize();

        return () => {
            try { chatService.unsubscribe(); } catch (e) {}
            disconnectMultiplayer();
            backendSocket.disconnect();
            gameManager.dispose();
        };
    }, []);

    useEffect(() => {
        if (!isGameLoaded) return;
        
        const legacyNames = ['Small Pulse Laser', 'Medium Pulse Laser', 'Ion Thruster'];
        const hasLegacyInventory = gameState.inventory.some(item => legacyNames.includes(item.name));
        const hasLegacyFittings = Object.values(gameState.fittings).some(f => f && legacyNames.includes(f.name));

        if (hasLegacyInventory || hasLegacyFittings) {
            setGameState(prev => {
                const nextInventory = prev.inventory.filter(item => !legacyNames.includes(item.name));
                const nextFittings = { ...prev.fittings };
                Object.keys(nextFittings).forEach(slot => {
                    if (nextFittings[slot] && legacyNames.includes(nextFittings[slot].name)) {
                        nextFittings[slot] = null;
                    }
                });
                return { ...prev, inventory: nextInventory, fittings: nextFittings };
            });
            console.log("[Maintenance] Legacy hardware purged from active session.");
        }
    }, [isGameLoaded, gameState.inventory, gameState.fittings]);

    // --- Cloud Handlers ---

    // Expose HUD bridge for engine-to-UI communication
    useEffect(() => {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes hud-toast-in {
                0% { opacity: 0; transform: translate(-50%, 20px); }
                100% { opacity: 1; transform: translate(-50%, 0); }
            }
            .hud-toast-container {
                position: fixed;
                bottom: 120px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 9999;
                pointer-events: none;
                font-family: 'JetBrains Mono', monospace;
            }
            .hud-toast-content {
                background: rgba(0, 20, 10, 0.9);
                border: 1px solid #00ff66;
                box-shadow: 0 0 15px rgba(0, 255, 102, 0.3);
                color: #00ff66;
                padding: 10px 24px;
                border-radius: 4px;
                font-size: 14px;
                font-weight: bold;
                text-transform: uppercase;
                letter-spacing: 1px;
                animation: hud-toast-in 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);

        window.HUD = {
            updateCargo: (updatedCargo) => {
                console.log("[HUD] Cargo Manifest Synchronized:", updatedCargo.length, "items.");
            },
            showToast: (message) => {
                setLootToast(null); // Clear existing to prevent stacking
                const id = Date.now();
                setLootToast({ id, message });
                
                // Auto-clear after 4 seconds
                setTimeout(() => {
                    setLootToast(current => current?.id === id ? null : current);
                }, 4000);
            }
        };
        return () => {
            document.head.removeChild(style);
            delete window.HUD;
        };
    }, []);

    const [lootToast, setLootToast] = useState(null);

    const handleCloudLogin = async (provider) => {
        try {
            const user = await cloudService.login(provider);
            setCloudUser(user);
            showNotification(`Connected to ${provider} Cloud Storage.`, "info");
            
            // Sync current state to cloud immediately upon login
            setIsCloudSyncing(true);
            const telemetry = gameManagerRef.current?.getTelemetry();
            const currentSystemId = gameState.currentSystem?.id;
            const starportId = SYSTEM_TO_STARPORT[currentSystemId] || gameState.homeStarport;
            await cloudService.saveToCloud(user.id, starportId, { gameState, telemetry, timestamp: Date.now() });
            setIsCloudSyncing(false);
        } catch (err) {
            showNotification("Cloud synchronization failed.", "error");
        }
    };

    const handleCloudLogout = () => {
        cloudService.logout();
        setCloudUser(null);
        showNotification("Cloud storage disconnected.", "info");
    };

    function showNotification(messageOrData, type = 'info') {
        const now = Date.now();
        const notification = typeof messageOrData === 'object' 
            ? { id: now, ...messageOrData }
            : { id: now, message: messageOrData, type };

        // Loot notifications bypass the 1.5s spam cooldown to ensure you see everything picked up
        if (notification.type !== 'loot') {
            if (now - lastNotificationTimeRef.current < 1500 && !notification.actions) return;
            if (notifications.some(n => n.message === notification.message)) return;
            if (!notification.actions) lastNotificationTimeRef.current = now;
        }
        
        setNotifications(prev => [...prev, notification]);
        
        // Only set timeout if not persistent
        if (!notification.persistent) {
            const duration = notification.type === 'loot' ? 4000 : 3000;
            setTimeout(() => {
                setNotifications(prev => prev.filter(n => n.id !== notification.id));
            }, duration);
        }
    }

    const removeNotification = (id) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    };

    useEffect(() => {
        if (!backendSocket?.setArenaHooks) return;
        backendSocket.setArenaHooks({
            onJoined: (data = {}) => {
                setArenaState(prev => ({
                    ...prev,
                    open: false,
                    status: 'idle',
                    currentInstanceId: data?.instanceId || null
                }));
                showArenaLoadingScreen();
                showNotification('Arena link established.', 'info');
            },
            onJoinFailed: (data = {}) => {
                setArenaState(prev => ({ ...prev, status: 'idle' }));
                cancelArenaLoadingScreen();
                showNotification(data?.reason || 'Arena link failed.', 'error');
            },
            onRespawn: () => {
                showArenaLoadingScreen();
                showNotification('Arena respawn engaged.', 'info');
            },
            onLeft: () => {
                setArenaState(prev => ({ ...prev, open: false, status: 'idle', currentInstanceId: null }));
                setShowStarMap(false);
                cancelArenaLoadingScreen();
                showNotification('Returned from arena.', 'info');
            }
        });
        return () => {
            try { backendSocket.setArenaHooks(null); } catch (e) {}
        };
    }, [showNotification]);

    useEffect(() => {
        if (!backendSocket?.setBattlegroundHooks) return;
        backendSocket.setBattlegroundHooks({
            onBattlegroundDefinition: (data = {}) => {
                setBattlegroundState(prev => ({ ...prev, definition: data?.definition || null, beaconName: data?.structure?.structure_name || prev.beaconName }));
            },
            onBattlegroundEntered: (data = {}) => {
                setBattlegroundFailState(null);
                setBattlegroundExtractState(null);
                setBattlegroundState(prev => ({ ...prev, open: false, status: 'active', currentInstanceId: data?.instanceId || null, bankedCredits: 0, choice: null, hud: { ...prev.hud, statusLabel: 'PREPARING WAVE' } }));
                try {
                    gameManagerRef.current?.setInstanceMusicMode?.('battleground');
                } catch (e) {
                    console.warn('[Battleground] entry music start failed', e);
                }
                showNotification('Battleground link established.', 'info');
            },
            onBattlegroundEnterFailed: (data = {}) => {
                setBattlegroundState(prev => ({ ...prev, status: 'idle', choice: null, bankedCredits: 0 }));
                if (battlegroundWaveCountdownTimerRef.current) {
                    clearInterval(battlegroundWaveCountdownTimerRef.current);
                    battlegroundWaveCountdownTimerRef.current = null;
                }
                setBattlegroundWaveCountdown(null);
                setBattlegroundIntroPending(false);
                setBattlegroundIntroCanContinue(false);
                setBattlegroundExtractState(null);
                setShowLoading(false);
                setLoadingScreenTitle('SECTORFALL');
                try {
                    gameManagerRef.current?.setInstanceMusicMode?.('normal');
                } catch (e) {
                    console.warn('[Battleground] restore normal music failed', e);
                }
                showNotification(data?.reason || 'Battleground link failed.', 'error');
            },
            onBattlegroundLeft: () => {
                const extractSnapshot = battlegroundExtractState;
                setBattlegroundState(prev => ({ ...prev, open: false, status: 'idle', currentInstanceId: null, bankedCredits: 0, choice: null, hud: { currentWave: 0, enemiesRemaining: 0, statusLabel: 'STANDBY' } }));
                if (battlegroundFailTimerRef.current) {
                    clearTimeout(battlegroundFailTimerRef.current);
                    battlegroundFailTimerRef.current = null;
                }
                setBattlegroundFailState(null);
                if (battlegroundWaveCountdownTimerRef.current) {
                    clearInterval(battlegroundWaveCountdownTimerRef.current);
                    battlegroundWaveCountdownTimerRef.current = null;
                }
                if (battlegroundExtractPhaseTimerRef.current) {
                    clearTimeout(battlegroundExtractPhaseTimerRef.current);
                    battlegroundExtractPhaseTimerRef.current = null;
                }
                setBattlegroundWaveCountdown(null);
                setShowStarMap(false);
                setBattlegroundIntroPending(false);
                setBattlegroundIntroCanContinue(false);
                setShowLoading(false);
                setLoadingScreenTitle('SECTORFALL');
                if (extractSnapshot) {
                    setBattlegroundExtractState(prev => prev ? { ...prev, phase: 'blackout' } : null);
                    battlegroundExtractPhaseTimerRef.current = setTimeout(() => {
                        setBattlegroundExtractState(null);
                        battlegroundExtractPhaseTimerRef.current = null;
                    }, 950);
                    showNotification(`Extraction complete. +${Number(extractSnapshot.securedCredits || 0).toLocaleString()} credits secured.`, 'success');
                } else {
                    showNotification('Returned from battleground.', 'info');
                }
            },
            onBattlegroundState: (data = {}) => {
                setBattlegroundState(prev => ({
                    ...prev,
                    bankedCredits: Number(data?.bankedCredits ?? prev.bankedCredits ?? 0),
                    choice: (data?.canExtract || data?.canContinue) ? {
                        canExtract: !!data?.canExtract,
                        canContinue: !!data?.canContinue,
                        waveReward: Number(data?.waveReward || 0),
                        bankedCredits: Number(data?.bankedCredits ?? prev.bankedCredits ?? 0),
                        completed: data?.phase === 'completed',
                        failed: data?.phase === 'failed',
                        reason: data?.reason || null
                    } : (data?.phase === 'active' || data?.phase === 'countdown' ? null : prev.choice),
                    hud: { currentWave: data?.currentWave || 0, enemiesRemaining: data?.enemiesRemaining ?? 0, statusLabel: data?.statusLabel || prev.hud.statusLabel }
                }));
                if (data?.phase === 'countdown') {
                    startBattlegroundWaveCountdown(data?.currentWave || data?.waveNumber || 0, data?.countdownRemaining || 5);
                }
            },
            onBattlegroundWaveStarted: (data = {}) => {
                const waveNumber = data?.waveNumber || 0;
                if (battlegroundWaveCountdownTimerRef.current) {
                    clearInterval(battlegroundWaveCountdownTimerRef.current);
                    battlegroundWaveCountdownTimerRef.current = null;
                }
                setBattlegroundWaveCountdown(null);
                setBattlegroundState(prev => ({ ...prev, choice: null, hud: { currentWave: waveNumber || prev.hud.currentWave || 0, enemiesRemaining: data?.enemiesRemaining ?? 0, statusLabel: 'WAVE ACTIVE' } }));
                showNotification(`Wave ${waveNumber || '?'} engaged.`, 'info');
            },
            onBattlegroundEnterReady: () => {
                setBattlegroundState(prev => ({ ...prev, hud: { ...prev.hud, statusLabel: 'AWAITING DEPLOYMENT' } }));
            },
            onBattlegroundWaveCleared: (data = {}) => {
                setBattlegroundState(prev => ({
                    ...prev,
                    bankedCredits: Number(data?.bankedCredits ?? prev.bankedCredits ?? 0),
                    choice: {
                        canExtract: !!data?.canExtract,
                        canContinue: !!data?.canContinue,
                        waveReward: Number(data?.waveReward || 0),
                        bankedCredits: Number(data?.bankedCredits ?? prev.bankedCredits ?? 0),
                        completed: false,
                        failed: false,
                        reason: null
                    },
                    hud: { currentWave: data?.waveNumber || prev.hud.currentWave || 0, enemiesRemaining: 0, statusLabel: 'WAVE CLEARED' }
                }));
                showNotification(`Wave ${data?.waveNumber || '?'} cleared.`, 'success');
            },
            onBattlegroundExtractStarted: (data = {}) => {
                const returnSystemId = String(data?.returnSystemId || gameState?.homeSystemId || 'cygnus-prime');
                const returnSystemName = SYSTEMS_REGISTRY[returnSystemId]?.name || returnSystemId || 'Entry Point';
                if (battlegroundExtractPhaseTimerRef.current) {
                    clearTimeout(battlegroundExtractPhaseTimerRef.current);
                    battlegroundExtractPhaseTimerRef.current = null;
                }
                setBattlegroundFailState(null);
                setBattlegroundExtractState({
                    securedCredits: Number(data?.securedCredits || 0),
                    waveNumber: Number(data?.currentWave || 0),
                    returnSystemId,
                    returnSystemName,
                    phase: 'card'
                });
                battlegroundExtractPhaseTimerRef.current = setTimeout(() => {
                    setBattlegroundExtractState(prev => prev ? { ...prev, phase: 'blackout' } : null);
                    battlegroundExtractPhaseTimerRef.current = null;
                }, 1600);
                setBattlegroundState(prev => ({
                    ...prev,
                    choice: null,
                    bankedCredits: 0,
                    hud: { ...prev.hud, enemiesRemaining: 0, statusLabel: 'EXTRACTION COMPLETE' }
                }));
            },
            onBattlegroundCompleted: (data = {}) => {
                setBattlegroundState(prev => ({
                    ...prev,
                    bankedCredits: Number(data?.bankedCredits ?? prev.bankedCredits ?? 0),
                    choice: data?.failed ? null : {
                        canExtract: !!(data?.canExtract ?? true),
                        canContinue: !!data?.canContinue,
                        waveReward: 0,
                        bankedCredits: Number(data?.bankedCredits ?? prev.bankedCredits ?? 0),
                        completed: true,
                        failed: false,
                        reason: null
                    },
                    hud: { ...prev.hud, enemiesRemaining: 0, statusLabel: data?.failed ? 'RUN FAILED' : 'ALL WAVES CLEARED' }
                }));
                showNotification(data?.failed ? 'Battleground failed. Bank lost.' : 'Battleground complete. Extract when ready.', data?.failed ? 'error' : 'success');
            },
            onBattlegroundFailed: (data = {}) => {
                setBattlegroundExtractState(null);
                const homeStarportId = String(gameState?.homeStarport || 'CYGNUS_PRIME_STARPORT');
                const respawnSystemId = STARPORT_TO_SYSTEM[homeStarportId] || 'cygnus-prime';
                const respawnSystemName = SYSTEMS_REGISTRY[respawnSystemId]?.name || respawnSystemId || 'Cygnus Prime';
                const respawnLocationName = homeStarportId.replace(/_/g, ' ');
                setShowDestroyedButton(false);
                setIsShipDestroyed(false);
                setDestructionSummary(null);
                if (battlegroundWaveCountdownTimerRef.current) {
                    clearInterval(battlegroundWaveCountdownTimerRef.current);
                    battlegroundWaveCountdownTimerRef.current = null;
                }
                if (battlegroundFailTimerRef.current) {
                    clearTimeout(battlegroundFailTimerRef.current);
                    battlegroundFailTimerRef.current = null;
                }
                setBattlegroundWaveCountdown(null);
                setBattlegroundFailState({
                    lostBank: !!data?.lostBank,
                    waveNumber: Number(data?.currentWave || 0),
                    respawnSystemId,
                    respawnSystemName,
                    respawnLocationName
                });
                setBattlegroundState(prev => ({
                    ...prev,
                    choice: null,
                    bankedCredits: Number(data?.bankedCredits ?? 0),
                    hud: { ...prev.hud, enemiesRemaining: 0, statusLabel: 'RUN FAILED' }
                }));
                showNotification(data?.lostBank ? 'Battleground failed. Reward bank lost.' : 'Battleground failed.', 'error');
            }
        });
        return () => {
            try { backendSocket.setBattlegroundHooks(null); } catch (e) {}
        };
    }, [showNotification, gameState.homeStarport, gameState.homeSystemId, battlegroundExtractState]);

    useEffect(() => () => {
        if (battlegroundWaveCountdownTimerRef.current) {
            clearInterval(battlegroundWaveCountdownTimerRef.current);
            battlegroundWaveCountdownTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        const arenaUiOpen = !!arenaState.open || !!battlegroundState.open;
        try { if (arenaUiOpen) document.exitPointerLock?.(); } catch {}

        const STYLE_ID = 'sf-force-cursor-arena-style';
        const ensureStyle = () => {
            let style = document.getElementById(STYLE_ID);
            if (!style) {
                style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = `
                    html.sf-arena-ui, body.sf-arena-ui { cursor: default !important; }
                    html.sf-arena-ui * { cursor: default !important; }
                    html.sf-arena-ui button, html.sf-arena-ui [role="button"], html.sf-arena-ui input, html.sf-arena-ui textarea, html.sf-arena-ui select { cursor: pointer !important; }
                `;
                document.head.appendChild(style);
            }
        };

        if (arenaUiOpen) {
            ensureStyle();
            try { document.documentElement.classList.add('sf-arena-ui'); } catch {}
            try { document.body.classList.add('sf-arena-ui'); } catch {}
            try { document.documentElement.style.cursor = 'default'; } catch {}
            try { document.body.style.cursor = 'default'; } catch {}
            try { if (gameManagerRef.current?.container) gameManagerRef.current.container.style.cursor = 'auto'; } catch {}
        } else {
            try { document.documentElement.classList.remove('sf-arena-ui'); } catch {}
            try { document.body.classList.remove('sf-arena-ui'); } catch {}
            const style = document.getElementById(STYLE_ID);
            if (style) style.remove();
            try { document.documentElement.style.cursor = ''; } catch {}
            try { document.body.style.cursor = ''; } catch {}
        }

        return () => {
            try { document.documentElement.classList.remove('sf-arena-ui'); } catch {}
            try { document.body.classList.remove('sf-arena-ui'); } catch {}
            const style = document.getElementById(STYLE_ID);
            if (style) style.remove();
            try { document.documentElement.style.cursor = ''; } catch {}
            try { document.body.style.cursor = ''; } catch {}
        };
    }, [arenaState.open, battlegroundState.open]);


    const handleSaveName = async (newName) => {
        const formattedName = newName.trim().toUpperCase().substring(0, 15) || gameState.commanderName;
        const hasItem = gameState.inventory.some(item => item.name === 'Commander Rename');
        
        if (gameState.hasRenamed && !hasItem) {
            setSecurityError("Unauthorized re-authorization attempt detected. You are missing a 'Commander Rename' security data chip. Access restricted.");
            setIsEditingName(false);
            return;
        }

        // Check uniqueness and save to commander_data
        const userId = cloudService.user?.id;
        if (userId) {
            const result = await cloudService.updateCommanderData(userId, {
                commander_name: formattedName
            });

            if (!result.success) {
                if (result.error === "NAME_TAKEN") {
                    setSecurityError(`The name "${formattedName}" is already claimed by another commander. Please choose a unique callsign.`);
                } else {
                    setSecurityError(`Rename failed: ${result.error}`);
                }
                return;
            }
        }

        setGameState(prev => {
            const nextInventory = [...prev.inventory];
            if (prev.hasRenamed) {
                const itemIndex = nextInventory.findIndex(item => item.name === 'Commander Rename');
                if (itemIndex > -1) nextInventory.splice(itemIndex, 1);
            }
            
            return { 
                ...prev, 
                commanderName: formattedName,
                hasRenamed: true,
                inventory: nextInventory
            };
        });

        if (gameManagerRef.current) {
            gameManagerRef.current.updateCommanderName(formattedName);
        }
        setIsEditingName(false);
    };

    const handleSendChatMessage = (content) => {
        if (!content.trim()) return;

        // DIRECT messages must use @NAME syntax.
        if (chatChannel === 'DIRECT' && !content.trim().startsWith('@')) {
            showNotification('To send a direct message, start with @COMMANDERNAME (example: @CMDR_FOXX hello).', 'info');
            return;
        }

        // Best-route chat: persist everything into chat_messages.
        const leaderId = (gameState.fleet || []).find(m => m.isLeader)?.id || null;
        const context = {
            scope: chatChannel,
            systemId: gameState.currentSystem?.id || null,
            fleetId: leaderId,
            syndicateId: gameState.commanderStats?.syndicate_id || gameState.commanderStats?.syndicateId || null
        };

        chatService.send(content, context).catch((e) => {
            const code = e?.message || 'CHAT_SEND_FAILED';
            if (code === 'CHAT_DM_USER_NOT_FOUND') {
                showNotification('Direct message failed: commander name not found.', 'error');
            } else if (code === 'CHAT_DM_SELF') {
                showNotification("You can't DM yourself.", 'info');
            } else if (code === 'CHAT_DM_EMPTY') {
                showNotification('Direct message failed: message text is empty.', 'info');
            } else {
                showNotification('Chat send failed.', 'error');
                console.warn('[Chat] send failed:', code);
            }
        });
    };

    const handleInstallFitting = (item) => {
        if (!activeFittingSlot) return;
        
        const isCommanderFitting = activeFittingSlot.type === 'outfit' || activeFittingSlot.type === 'implant';
        const fittingCategory = activeFittingSlot.type === 'outfit' ? 'commanderOutfit' : 'commanderImplants';

        // Calculate fresh resources for validation
        let nextPowerGrid = gameState.currentPowerGrid;
        let nextCpu = gameState.currentCpu;
        
        if (!isCommanderFitting) {
            const shipConfig = SHIP_REGISTRY[gameState.shipClass];
            const slotCheck = canFit({
                item,
                slotId: activeFittingSlot.id,
                shipConfig,
                currentFittings: gameState.fittings,
                // PG/CPU warning UI is handled below; here we only enforce slot typing.
                maxPG: Number.POSITIVE_INFINITY,
                maxCPU: Number.POSITIVE_INFINITY
            });
            if (!slotCheck.ok) {
                showNotification(slotCheck.reason || 'Fitting rejected.', 'error');
                return;
            }

            const nextFittings = { ...gameState.fittings, [activeFittingSlot.id]: hydrateFittedModule(item) };
            const resources = getLiveShipResources(nextFittings);
            nextPowerGrid = resources.power;
            nextCpu = resources.cpu;

            if (nextPowerGrid > gameState.maxPowerGrid || nextCpu > gameState.maxCpu) {
                setFittingWarning({
                    moduleName: item.name,
                    powerDeficit: Math.max(0, nextPowerGrid - gameState.maxPowerGrid),
                    cpuDeficit: Math.max(0, nextCpu - gameState.maxCpu)
                });
                return;
            }
        }

        setGameState(prev => {
            const currentSystemId = prev.currentSystem?.id;
            const starportId = SYSTEM_TO_STARPORT[currentSystemId];
            const userId = cloudUser?.id;

            let nextInventory = [...prev.inventory];
            let nextStorage = starportId ? [...(prev.storage[starportId] || [])] : [];
            let updateObj = { 
                inventory: nextInventory, 
                storage: starportId ? { ...prev.storage, [starportId]: nextStorage } : prev.storage 
            };

            if (isCommanderFitting) {
                const nextCommanderFittings = { ...prev[fittingCategory] };
                const oldItem = nextCommanderFittings[activeFittingSlot.id];
                if (oldItem) nextInventory.push(oldItem);
                
                // Remove from either inventory or storage based on location marker
                if (item.location === 'storage') {
                    const itemIndex = nextStorage.findIndex(i => i.id === item.id);
                    if (itemIndex > -1) nextStorage.splice(itemIndex, 1);
                } else {
                    const itemIndex = nextInventory.findIndex(i => i.id === item.id);
                    if (itemIndex > -1) nextInventory.splice(itemIndex, 1);
                }
                
                nextCommanderFittings[activeFittingSlot.id] = item;
                updateObj[fittingCategory] = nextCommanderFittings;
            } else {
                const nextFittings = { ...prev.fittings };
                const oldItem = nextFittings[activeFittingSlot.id];
                // Uninstalled items always go back to ship cargo (inventory)
                if (oldItem) nextInventory.push(oldItem);
                
                // Remove from either inventory or storage based on location marker
                if (item.location === 'storage') {
                    const itemIndex = nextStorage.findIndex(i => i.id === item.id);
                    if (itemIndex > -1) nextStorage.splice(itemIndex, 1);
                } else {
                    const itemIndex = nextInventory.findIndex(i => i.id === item.id);
                    if (itemIndex > -1) nextInventory.splice(itemIndex, 1);
                }
                
                const hydratedItem = hydrateFittedModule(item);
                nextFittings[activeFittingSlot.id] = hydratedItem;
                updateObj.fittings = nextFittings;

                // PERSISTENCE FIX: Update the fittings in ownedShips as well
                updateObj.ownedShips = prev.ownedShips.map(ship => 
                    ship.id === prev.activeShipId ? { ...ship, fittings: nextFittings } : ship
                );
                
                // Final re-sync of usage stats
                const finalResources = getLiveShipResources(nextFittings);
                updateObj.currentPowerGrid = finalResources.power;
                updateObj.currentCpu = finalResources.cpu;

                // Sync engine immediately
                if (gameManagerRef.current) {
                    gameManagerRef.current.syncFittings(nextFittings);
                }
            }
            
            // AUTHORITATIVE PERSISTENCE HANDSHAKE
            // Immediately sync critical configuration changes to the cloud
            if (userId) {
                // 1. Update Inventory / Storage
                if (starportId) {
                    cloudService.saveInventoryState(userId, starportId, nextStorage, "handleInstallFitting_storage");
                }
                
                // 2. Update Fleet Configuration (Commander Data)
                const nextOwnedShips = updateObj.ownedShips || prev.ownedShips;
                cloudService.updateCommanderData(userId, {
                    owned_ships: nextOwnedShips,
                    active_ship_id: prev.activeShipId
                });

                // 3. Update active ship cargo
                cloudService.saveToCloud(userId, starportId, {
                    ship_type: (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass,
                    telemetry: {
                        ...(gameManagerRef.current?.getTelemetry() || {}),
                        cargo: nextInventory,
                        fittings: updateObj.fittings || prev.fittings
                    }
                });
            }

            return { ...prev, ...updateObj };
        });
        
        setActiveFittingSlot(null);
        showNotification(`${item.name} installed successfully.`, "info");
    };

    const handleUnfitFitting = (slotId) => {
        if (!activeFittingSlot) return;
        const isCommanderFitting = activeFittingSlot.type === 'outfit' || activeFittingSlot.type === 'implant';
        const fittingCategory = activeFittingSlot.type === 'outfit' ? 'commanderOutfit' : 'commanderImplants';

        setGameState(prev => {
            const currentSystemId = prev.currentSystem?.id;
            const starportId = SYSTEM_TO_STARPORT[currentSystemId] || prev.homeStarport;
            const userId = cloudUser?.id;

            let nextInventory = [...prev.inventory];
            let updateObj = { inventory: nextInventory };

            if (isCommanderFitting) {
                const nextCommanderFittings = { ...prev[fittingCategory] };
                const oldItem = nextCommanderFittings[slotId];
                if (!oldItem) return prev;
                // Uninstalled items always go back to ship cargo (inventory)
                nextInventory.push(oldItem);
                nextCommanderFittings[slotId] = null;
                updateObj[fittingCategory] = nextCommanderFittings;
            } else {
                const nextFittings = { ...prev.fittings };
                const oldItem = nextFittings[slotId];
                if (!oldItem) return prev;
                
                // Uninstalled items always go back to ship cargo (inventory)
                nextInventory.push(oldItem);
                nextFittings[slotId] = null;
                updateObj.fittings = nextFittings;

                // PERSISTENCE FIX: Update the fittings in ownedShips as well
                updateObj.ownedShips = prev.ownedShips.map(ship => 
                    ship.id === prev.activeShipId ? { ...ship, fittings: nextFittings } : ship
                );
                
                // Recalculate fresh usage stats
                const finalResources = getLiveShipResources(nextFittings);
                updateObj.currentPowerGrid = finalResources.power;
                updateObj.currentCpu = finalResources.cpu;

                // Sync engine immediately
                if (gameManagerRef.current) {
                    gameManagerRef.current.syncFittings(nextFittings);
                }
            }

            // AUTHORITATIVE PERSISTENCE HANDSHAKE
            // Immediately sync critical configuration changes to the cloud
            if (userId) {
                // 1. Update Fleet Configuration (Commander Data)
                const nextOwnedShips = updateObj.ownedShips || prev.ownedShips;
                cloudService.updateCommanderData(userId, {
                    owned_ships: nextOwnedShips,
                    active_ship_id: prev.activeShipId
                });

                // 2. Update active ship cargo and fittings in ship_states
                cloudService.saveToCloud(userId, starportId, {
                    ship_type: (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass,
                    telemetry: {
                        ...(gameManagerRef.current?.getTelemetry() || {}),
                        cargo: nextInventory,
                        fittings: updateObj.fittings || prev.fittings
                    }
                });
            }

            return { ...prev, ...updateObj };
        });
        
        setActiveFittingSlot(null);
        showNotification("Module uninstalled to ship cargo.", "info");
    };

    const handleToggleWeaponGroup = (slotId, group) => {
        setGameState(prev => {
            const module = prev.fittings[slotId];
            if (!module) return prev;

            const isG1 = group === 1;
            const key = isG1 ? 'weaponGroup1' : 'weaponGroup2';
            
            const nextFittings = { ...prev.fittings };
            nextFittings[slotId] = { ...module, [key]: !module[key] };
            
            const nextInventory = prev.inventory.map(item => 
                item.id === module.id ? { ...item, [key]: !module[key] } : item
            );
            
            // Sync engine immediately
            if (gameManagerRef.current) {
                gameManagerRef.current.syncFittings(nextFittings);
            }

            // PERSISTENCE FIX: Update the fittings in ownedShips as well
            const nextOwnedShips = prev.ownedShips.map(ship => 
                ship.id === prev.activeShipId ? { ...ship, fittings: nextFittings } : ship
            );

            return { ...prev, fittings: nextFittings, inventory: nextInventory, ownedShips: nextOwnedShips };
        });
    };

    const handleActivateShip = async (ship) => {
        if (!isDocked || !cloudUser) {
            showNotification("ACTIVATE FAILED: VESSEL MUST BE DOCKED AT STARPORT", "error");
            return;
        }

        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId];

        if (!starportId) {
            showNotification("ACTIVATE FAILED: NO AUTHORITATIVE STARPORT ID", "error");
            return;
        }

        try {
            // 1. Remove from cloud hangar
            await cloudService.removeFromHangar(cloudUser.id, ship.id);
            
            // 2. Prepare the ship data (hydration)
            const hydratedShip = hydrateVessel(ship, ship);
            const shipConfig = SHIP_REGISTRY[hydratedShip.type];

            const resources = getLiveShipResources(hydratedShip.fittings);

            // 3. Update state: move to ownedShips AND set as active
            setGameState(prev => {
                const newState = {
                    ...prev,
                    hangarShips: (prev.hangarShips || []).filter(s => s.id !== ship.id),
                    ownedShips: [...prev.ownedShips, hydratedShip],
                    activeShipId: ship.id,
                    shipName: getShipDisplayName(hydratedShip.type),
                    shipClass: getShipClassLabel(hydratedShip.type),
                    fittings: hydratedShip.fittings,
                    currentPowerGrid: resources.power,
                    currentCpu: resources.cpu,
                    maxHp: shipConfig.hp,
                    hp: hydratedShip.hp,
                    armor: shipConfig.armor,
                    kineticRes: shipConfig.kineticRes,
                    thermalRes: shipConfig.thermalRes,
                    blastRes: shipConfig.blastRes,
                    maxEnergy: shipConfig.baseEnergy,
                    energy: hydratedShip.energy,
                    reactorRecovery: shipConfig.baseEnergyRecharge || 1.0,
                    maxPowerGrid: shipConfig.basePG,
                    maxCpu: shipConfig.baseCPU,
                    cargoHold: shipConfig.cargoHold,
                    cargoMaxVolume: shipConfig.cargoMaxVolume,
                    sigRadius: shipConfig.baseSigRadius,
                    scanRange: shipConfig.scanRange,
                    lockOnRange: shipConfig.lockOnRange,
                    lockMultiplier: shipConfig.lockMultiplier,
                    maxSpeed: hydratedShip.maxSpeed || shipConfig.maxSpeed || 3.5,
                    turnSpeed: hydratedShip.turnSpeed || shipConfig.turnSpeed || 0.045,
                    modifiedStats: hydratedShip.modifiedStats || null
                };
                
                // CRITICAL: Immediate Cloud Manifest Sync to prevent race conditions on refresh
                cloudService.updateCommanderData(cloudUser.id, {
                    owned_ships: newState.ownedShips,
                    active_ship_id: newState.activeShipId
                });
                
                return newState;
            });

            // 4. Notify Engine
            gameManagerRef.current?.rebuildShip(hydratedShip);
            
            showNotification(`${hydratedShip.name} activated and ready for command.`, "success");
        } catch (err) {
            console.error("Activate failed:", err);
            showNotification("ACTIVATE FAILED: Could not process vessel manifestation.", "error");
        }
    };

    const handleDepositShip = async (ship) => {
        if (!isDocked || !cloudUser) {
            showNotification("DEPOSIT FAILED: VESSEL MUST BE DOCKED AT STARPORT", "error");
            return;
        }

        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId];
        
        if (!starportId) {
            showNotification("DEPOSIT FAILED: NO AUTHORITATIVE STARPORT ID", "error");
            return;
        }

        // Cannot deposit the currently active ship
        if (ship.id === gameState.activeShipId) {
            showNotification("DEPOSIT FAILED: CANNOT STORE CURRENTLY COMMANDED VESSEL", "error");
            return;
        }

        try {
            const registry = SHIP_REGISTRY[resolveShipRegistryKey(ship.type) || ship.type];
            const shipToSave = {
                ...ship,
                type: ship.type,
                classId: registry?.classId || ship.type,
                isShip: true
            };
            
            await cloudService.saveToHangar(cloudUser.id, starportId, ship.id, shipToSave);
            
            setGameState(prev => {
                const newState = {
                    ...prev,
                    ownedShips: prev.ownedShips.filter(s => s.id !== ship.id),
                    hangarShips: [...(prev.hangarShips || []), shipToSave]
                };
                
                // CRITICAL: Immediate Cloud Manifest Sync to prevent race conditions on refresh
                cloudService.updateCommanderData(cloudUser.id, {
                    owned_ships: newState.ownedShips
                });
                
                return newState;
            });
            
            const prettyPort = String(starportId).replace(/_/g,' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            showNotification(`${ship.name} secured in hangar at ${prettyPort}.`, "success");
        } catch (err) {
            console.error("Deposit failed:", err);
            showNotification("DEPOSIT FAILED: Could not secure vessel in hangar.", "error");
        }
    };

    const handleCommandShip = (shipId) => {
        const targetShip = gameState.ownedShips.find(s => s.id === shipId);
        if (!targetShip) return;

        const shipConfig = SHIP_REGISTRY[targetShip.type];
        const resources = getLiveShipResources(targetShip.fittings);
        
        setGameState(prev => {
            const newState = {
                ...prev,
                activeShipId: shipId,
                shipName: getShipDisplayName(targetShip.type),
                shipClass: getShipClassLabel(targetShip.type),
                fittings: targetShip.fittings,
                currentPowerGrid: resources.power,
                currentCpu: resources.cpu,
                // Re-initialize ship base stats
                maxHp: shipConfig.hp,
                hp: targetShip.hp ?? shipConfig.hp, 
                armor: shipConfig.armor,
                kineticRes: shipConfig.kineticRes,
                thermalRes: shipConfig.thermalRes,
                blastRes: shipConfig.blastRes,
                maxEnergy: shipConfig.baseEnergy,
                energy: targetShip.energy ?? shipConfig.baseEnergy,
                reactorRecovery: shipConfig.baseEnergyRecharge || 1.0,
                maxPowerGrid: shipConfig.basePG,
                maxCpu: shipConfig.baseCPU,
                cargoHold: shipConfig.cargoHold,
                cargoMaxVolume: shipConfig.cargoMaxVolume,
                sigRadius: shipConfig.baseSigRadius,
                scanRange: shipConfig.scanRange,
                lockOnRange: shipConfig.lockOnRange,
                lockMultiplier: shipConfig.lockMultiplier,
                maxSpeed: targetShip.maxSpeed || shipConfig.maxSpeed || 3.5,
                turnSpeed: targetShip.turnSpeed || shipConfig.turnSpeed || 0.045,
                modifiedStats: targetShip.modifiedStats || null
            };

            // CRITICAL: Immediate Cloud Manifest Sync to prevent race conditions on refresh
            if (cloudUser) {
                cloudService.updateCommanderData(cloudUser.id, {
                    active_ship_id: shipId
                });
            }

            return newState;
        });

        // Notify GameManager to rebuild the ship
        gameManagerRef.current?.rebuildShip(targetShip);
        
        showNotification(`Commanding ${targetShip.name} (${targetShip.type})`, "info");
    };

    const [isShipDestroyed, setIsShipDestroyed] = useState(false);
    const [showDestroyedButton, setShowDestroyedButton] = useState(false);
    const [destructionSummary, setDestructionSummary] = useState(null);
    const [battlegroundRespawnFade, setBattlegroundRespawnFade] = useState({ active: false, opaque: false });
    const destroyedButtonTimeoutRef = useRef(null);

    // -----------------------------------------------------
    // DEATH UI INPUT FIX (cursor + clicks)
    // -----------------------------------------------------
    // When the DESTROYED / respawn overlays appear, we must ensure:
    // 1) Pointer lock is released (otherwise cursor vanishes)
    // 2) Cursor is visible (some loops set cursor:none every frame)
    // 3) Canvas doesn't steal mouse clicks from the overlay
    useEffect(() => {
        const deathUiOpen = !!(isShipDestroyed || showDestroyedButton || battlegroundFailState);

        // --- 1) Release pointer lock (if any) ---
        try { if (deathUiOpen) document.exitPointerLock?.(); } catch {}

        // --- 2) Force cursor visible with an !important stylesheet ---
        const STYLE_ID = 'sf-force-cursor-style';
        const ensureStyle = () => {
            let style = document.getElementById(STYLE_ID);
            if (!style) {
                style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = `
                    html.sf-death-ui, body.sf-death-ui { cursor: default !important; }
                    html.sf-death-ui * { cursor: default !important; }
                    html.sf-death-ui button, html.sf-death-ui [role="button"] { cursor: pointer !important; }
                `;
                document.head.appendChild(style);
            }
        };

        if (deathUiOpen) {
            ensureStyle();
            try { document.documentElement.classList.add('sf-death-ui'); } catch {}
            try { document.body.classList.add('sf-death-ui'); } catch {}
            try { document.documentElement.style.cursor = 'default'; } catch {}
            try { document.body.style.cursor = 'default'; } catch {}
        } else {
            try { document.documentElement.classList.remove('sf-death-ui'); } catch {}
            try { document.body.classList.remove('sf-death-ui'); } catch {}
            const style = document.getElementById(STYLE_ID);
            if (style) style.remove();
            try { document.documentElement.style.cursor = ''; } catch {}
            try { document.body.style.cursor = ''; } catch {}
        }

        // --- 3) IMPORTANT: Do NOT disable canvas pointer events here. ---
        // In Sectorfall, parts of the scene can be driven by pointer activity.
        // Disabling pointer events makes it look like the game has paused even if the
        // render loop is still running. The overlay already captures clicks via z-index.

        return () => {
            // On unmount, remove forced cursor style
            try { document.documentElement.classList.remove('sf-death-ui'); } catch {}
            try { document.body.classList.remove('sf-death-ui'); } catch {}
            const style = document.getElementById(STYLE_ID);
            if (style) style.remove();
        };
    }, [isShipDestroyed, showDestroyedButton, battlegroundFailState]);

    const beginDestroyedUiFlow = useCallback(() => {
        if (destroyedButtonTimeoutRef.current) {
            clearTimeout(destroyedButtonTimeoutRef.current);
            destroyedButtonTimeoutRef.current = null;
        }

        setGameState(prev => {
            const destroyedShipId = prev.activeShipId;
            if (!destroyedShipId) return prev;

            const ship = prev.ownedShips.find(s => s.id === destroyedShipId);
            const summary = {
                shipName: ship ? ship.name : 'Unknown Ship',
                modules: Object.values(prev.fittings).filter(m => m !== null).map(m => m.name),
                cargoCount: prev.inventory.length
            };
            setDestructionSummary(summary);

            destroyedButtonTimeoutRef.current = setTimeout(() => {
                setShowDestroyedButton(true);
                destroyedButtonTimeoutRef.current = null;
            }, 2500);

            return prev;
        });

        showNotification("CRITICAL FAILURE: SHIP DESTROYED.", "error");
    }, [showNotification]);

    const handleShipDestruction = (payload = {}) => {
        if (payload?.battlegroundFailure || isBattlegroundCurrent || battlegroundFailState) {
            if (destroyedButtonTimeoutRef.current) {
                clearTimeout(destroyedButtonTimeoutRef.current);
                destroyedButtonTimeoutRef.current = null;
            }
            setShowDestroyedButton(false);
            setIsShipDestroyed(false);
            setDestructionSummary(null);
            return;
        }
        beginDestroyedUiFlow();
    };

    const performRespawn = async () => {
        const playerId = cloudService.user?.id;
        if (!playerId) {
            console.error("[handleRespawn] No authenticated player ID found.");
            return;
        }

        const homeStarport = gameState.homeStarport || 'CYGNUS_PRIME_STARPORT';
        const respawnSystemId = STARPORT_TO_SYSTEM[homeStarport] || 'cygnus-prime';
        const respawnSystem = SYSTEMS_REGISTRY[respawnSystemId] || SYSTEMS_REGISTRY['cygnus-prime'];
        
        // 1. Process local state reset for vessel loss
        setGameState(prev => {
            const destroyedShipId = prev.activeShipId;
            const nextOwnedShips = prev.ownedShips.filter(s => s.id !== destroyedShipId);

            const newState = {
                ...prev,
                ownedShips: nextOwnedShips,
                activeShipId: null,
                shipName: 'NO ACTIVE SHIP',
                shipClass: 'NONE',
                fittings: SAFE_DEFAULT_FITTINGS,
                hp: 0, maxHp: 0, shields: 0, maxShields: 0,
                energy: 0, maxEnergy: 0, currentPowerGrid: 0, currentCpu: 0,
                inventory: [], currentCargoWeight: 0,
                currentSystem: {
                    id: respawnSystemId,
                    name: respawnSystem.name.toUpperCase(),
                    sector: respawnSystem.sector,
                    security: respawnSystem.security,
                    securityValue: respawnSystem.securityValue
                }
            };

            // PERSISTENCE FIX: Sync manifest loss to cloud immediately
            if (cloudUser) {
                cloudService.updateCommanderData(cloudUser.id, {
                    owned_ships: nextOwnedShips,
                    active_ship_id: null,
                    explicit_clear_active_ship_id: true
                });
            }

            return newState;
        });

        // 2. Authoritative Storage Check: Issue starter kit if no ships are owned in storage or hangar
        try {
            const starportId = homeStarport;
            const [inventoryState, hangarData] = await Promise.all([
                cloudService.getInventoryState(playerId, starportId),
                cloudService.getHangarShips(playerId, starportId)
            ]);
            
            const storedShipsInHangar = hangarData || [];
            
            if (storedShipsInHangar.length === 0) {
                const kitResult = await cloudService.issueStarterKit(playerId, starportId);
                if (kitResult.success) {
                    showNotification("You have been issued an Omni Scout and starting equipment.", "success");
                    
                    // Re-sync storage and hangar to reflect the new kit
                    const [updatedInventory, updatedHangar] = await Promise.all([
                        cloudService.getInventoryState(playerId, starportId),
                        cloudService.getHangarShips(playerId, starportId)
                    ]);
                    
                    if (updatedInventory || updatedHangar) {
                        setGameState(prev => ({ ...prev,
                            storage: { ...prev.storage, [starportId]: (Array.isArray(updatedInventory?.items) ? updatedInventory.items : []).filter(i => i.type !== 'ship') },
                            hangarShips: (updatedHangar || []).map(h => ({
                                ...h.ship_config,
                                id: h.ship_id,
                                dbId: h.id
                            }))
                        }));
                    }
                }
            }
        } catch (err) {
            console.error("[handleRespawn] Storage check/kit issuance failed:", err);
        }

        if (destroyedButtonTimeoutRef.current) {
            clearTimeout(destroyedButtonTimeoutRef.current);
            destroyedButtonTimeoutRef.current = null;
        }
        setIsShipDestroyed(false);
        setShowDestroyedButton(false);
        setDestructionSummary(null);
        setBattlegroundFailState(null);
        setBattlegroundExtractState(null);
        setBattlegroundState(prev => ({ ...prev, open: false, status: 'idle', currentInstanceId: null, bankedCredits: 0, choice: null, hud: { currentWave: 0, enemiesRemaining: 0, statusLabel: 'STANDBY' } }));

        // 3. Teleport and Dock at Home Starport
        if (gameManagerRef.current) {
            await gameManagerRef.current.loadSystem(respawnSystemId, homeStarport);
            gameManagerRef.current.setDocked(true);
            
            // Absolute Visibility Suppression: No ship should be rendered in space during docking
            if (gameManagerRef.current.ship?.sprite) {
                gameManagerRef.current.ship.sprite.visible = false;
                gameManagerRef.current.ship.sprite.position.set(0, 0, 0);
                gameManagerRef.current.ship.velocity.set(0, 0);
            }
        }
        
        setIsDocked(true);
        showNotification(`Vessel lost. Respawning at Port ${homeStarport.replace(/_/g, ' ')}.`, "info");
    };

    const handleRespawn = async () => {
        await performRespawn();
    };

    const handleBattlegroundFailRespawn = async () => {
        setBattlegroundRespawnFade({ active: true, opaque: false });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setBattlegroundRespawnFade({ active: true, opaque: true });
            });
        });

        setTimeout(async () => {
            try {
                await performRespawn();
            } finally {
                // Keep the blackout fully opaque long enough for the home-starport
                // respawn/docking transition to complete before revealing the scene.
                setTimeout(() => {
                    setBattlegroundRespawnFade({ active: true, opaque: false });
                }, 950);
                setTimeout(() => {
                    setBattlegroundRespawnFade({ active: false, opaque: false });
                }, 1500);
            }
        }, 420);
    };

    useEffect(() => {
        if (isDocked && !isBattlegroundCurrent) {
            if (destroyedButtonTimeoutRef.current) {
                clearTimeout(destroyedButtonTimeoutRef.current);
                destroyedButtonTimeoutRef.current = null;
            }
            if (showDestroyedButton) setShowDestroyedButton(false);
            if (isShipDestroyed) setIsShipDestroyed(false);
        }
    }, [isDocked, isBattlegroundCurrent, showDestroyedButton, isShipDestroyed]);

    useEffect(() => () => {
        if (destroyedButtonTimeoutRef.current) {
            clearTimeout(destroyedButtonTimeoutRef.current);
            destroyedButtonTimeoutRef.current = null;
        }
    }, []);

    // --- Trade System Handlers ---

    const handleListTradeItem = async (item, price, quantity, type) => {
        if (!gameManagerRef.current) return false;
        const currentSystemId = gameState.currentSystem?.id;
        const currentStarportId = SYSTEM_TO_STARPORT[currentSystemId];
        if (!currentStarportId) {
            showNotification("Listing error: Starport terminal not found.", "error");
            return false;
        }

        try {
            await MarketSystem.createSellOrder(
                item.item_id || item.type || item.id,
                quantity,
                parseFloat(price),
                currentStarportId,
                item
            );

            showNotification(`Listed ${quantity}x ${item.name || item.item_type || item.type || 'item'} for ${price} Cr/unit.`, "success");

            const updatedStorage = await cloudService.getInventoryState(cloudService.user.id, currentStarportId);
            setGameState(prev => ({
                ...prev,
                storage: { ...prev.storage, [currentStarportId]: (updatedStorage?.items || []).map(hydrateItem) }
            }));
            return true;
        } catch (error) {
            console.error("[TradeHub] Listing failed:", error);
            showNotification(error.message || "Failed to create market listing.", "error");
            return false;
        }
    };

    const handleBuyTradeItem = async (listing, quantity = 1) => {
        if (!gameManagerRef.current) return;
        const buyerId = cloudService.user?.id;
        if (!buyerId) {
            showNotification("You must be logged in to trade.", "error");
            return;
        }

        const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];

        try {
            const result = await MarketSystem.buyListing(listing.id, buyerId, currentStarportId, quantity);

            if (result.success) {
                showNotification(`Purchased ${listing.item?.name || listing.item_type || 'item'} for ${listing.price} Cr.`, "success");

                const updatedStorage = await cloudService.getInventoryState(buyerId, currentStarportId);

                setGameState(prev => ({
                    ...prev,
                    credits: typeof result?.commanderState?.credits === 'number'
                        ? result.commanderState.credits
                        : prev.credits,
                    storage: {
                        ...prev.storage,
                        [currentStarportId]: (updatedStorage?.items || (prev.storage[currentStarportId] || [])).map(hydrateItem)
                    }
                }));
            }
        } catch (error) {
            console.error("[TradeHub] Direct purchase failed:", error);
            showNotification(error.message || "Failed to process transaction.", "error");
        }
    };

    const handleBidAuctionItem = (listing, bidAmount) => {
        // Auction bid implementation
    };

    const handleCreateBuyOrder = async (itemType, quantity, pricePerUni) => {
        const userId = cloudService.user?.id;
        const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
        if (!userId || !currentStarportId) return;

        try {
            const result = await MarketSystem.createBuyOrder(itemType, quantity, pricePerUni, currentStarportId);
            showNotification(`Posted Buy Order for ${quantity}x ${itemType.toUpperCase()}.`, "success");
            
            const refreshedMarket = await MarketSystem.fetchMarketData(currentStarportId, 'buy_orders');
            setNewBuyOrders(refreshedMarket?.buyOrders || []);
            if (typeof result?.commanderState?.credits === 'number') {
                setGameState(prev => ({ ...prev, credits: result.commanderState.credits }));
            }
            return true;
        } catch (error) {
            console.error("[TradeHub] Buy Order failed:", error);
            showNotification(error.message || "Failed to post buy order.", "error");
            return false;
        }
    };
    const handleCreateContract = (contractData) => {
        if (!gameManagerRef.current) return;
        if (gameState.credits < contractData.reward) {
            showNotification("Insufficient credits for reward escrow.", "error");
            return;
        }

        const result = gameManagerRef.current.createCourierContract(
            cloudService.user?.id || 'local',
            gameState.commanderName,
            contractData.item.id || contractData.item.blueprintId || contractData.item.materialKey,
            contractData.originSystemId,
            contractData.destinationSystemId,
            contractData.reward,
            contractData.collateral,
            contractData.duration
        );

        if (!result.success) {
            showNotification(result.error, "error");
            return;
        }

        setGameState(prev => ({ ...prev,
            credits: prev.credits - contractData.reward,
            courierContracts: [...gameManagerRef.current.courierContracts],
            regionalStorage: { ...gameManagerRef.current.regionalStorage }
        }));

        showNotification(`Courier contract issued for ${contractData.item.name}.`, "success");
    };

    const handleAcceptContract = (contractId) => {
        if (!gameManagerRef.current) return;
        
        const contract = gameState.courierContracts.find(c => c.id === contractId);
        if (!contract) return;

        if (gameState.credits < contract.collateral) {
            showNotification("Insufficient credits for contract collateral.", "error");
            return;
        }

        const result = gameManagerRef.current.acceptCourierContract(
            contractId,
            cloudService.user?.id || 'local',
            gameState.commanderName
        );

        if (!result.success) {
            showNotification(result.error, "error");
            return;
        }

        setGameState(prev => ({ ...prev,
            credits: prev.credits - contract.collateral,
            courierContracts: [...gameManagerRef.current.courierContracts]
        }));

        showNotification(`Contract accepted. Travel to ${SYSTEMS_REGISTRY[contract.originSystemId]?.name} to pickup package.`, "info");
    };

    const handlePickupPackage = (contractId) => {
        if (!gameManagerRef.current) return;
        
        const result = gameManagerRef.current.pickupCourierPackage(
            contractId,
            cloudService.user?.id || 'local'
        );

        if (!result.success) {
            showNotification(result.error, "error");
            return;
        }

        setGameState(prev => {
            const nextInventory = [...prev.inventory, result.packageItem];
            const nextWeight = nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0);
            return {
                ...prev,
                inventory: nextInventory,
                currentCargoWeight: nextWeight,
                courierContracts: [...gameManagerRef.current.courierContracts]
            };
        });

        showNotification(`Package acquired. Deliver to ${SYSTEMS_REGISTRY[result.packageItem.destinationSystemId]?.name || 'destination'}.`, "success");
    };

    const handleDeliverPackage = (contractId) => {
        if (!gameManagerRef.current) return;
        
        const result = gameManagerRef.current.deliverCourierPackage(
            contractId,
            cloudService.user?.id || 'local'
        );

        if (!result.success) {
            showNotification(result.error, "error");
            return;
        }

        setGameState(prev => {
            const nextInventory = prev.inventory.filter(i => i.contractId !== contractId);
            const nextWeight = nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0);
            return {
                ...prev,
                credits: prev.credits + result.reward + result.collateral,
                inventory: nextInventory,
                currentCargoWeight: nextWeight,
                courierContracts: [...gameManagerRef.current.courierContracts],
                regionalStorage: { ...gameManagerRef.current.regionalStorage }
            };
        });

        showNotification(`Contract complete. Received ${result.reward} Cr reward and collateral return.`, "success");
    };

    const handleCancelTradeItem = async (listingId) => {
        if (!gameManagerRef.current) return;
        try {
            await MarketSystem.cancelSellOrder(listingId);
            showNotification("Market listing cancelled. Item returned to regional storage.", "info");
            
            const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
            const updatedStorage = await cloudService.getInventoryState(cloudService.user.id, currentStarportId);
            setGameState(prev => ({ ...prev,
                storage: { ...prev.storage, [currentStarportId]: (updatedStorage?.items || []).map(hydrateItem) }
            }));
        } catch (error) {
            console.error("[TradeHub] Cancellation failed:", error);
            showNotification(error.message || "Failed to cancel listing.", "error");
        }
    };

    const handleCancelCourierContract = (contractId) => {
        if (!gameManagerRef.current) return;
        const userId = cloudService.user?.id || 'local';
        const result = gameManagerRef.current.cancelCourierContract(contractId, userId);

        if (!result.success) {
            showNotification(result.error, "error");
            return;
        }

        setGameState(prev => {
            const starportId = SYSTEM_TO_STARPORT[prev.currentSystem?.id];
            return {
                ...prev,
                credits: prev.credits + result.rewardRefund,
                courierContracts: [...gameManagerRef.current.courierContracts],
                regionalStorage: { ...gameManagerRef.current.regionalStorage },
                storage: starportId ? { ...prev.storage, [starportId]: (gameManagerRef.current.regionalStorage[prev.currentSystem?.id]?.[userId] || []) } : prev.storage
            };
        });

        showNotification("Courier contract cancelled. Escrow reward and item returned.", "info");
    };

    const handleCollectTradeItem = (storageItem) => {
        if (!gameManagerRef.current) return;
        const currentSystemId = gameState.currentSystem?.id;
        const result = gameManagerRef.current.collectTradeItem(storageItem.id || storageItem.blueprintId || storageItem.materialKey, cloudService.user?.id || 'local', currentSystemId);

        if (!result.success) {
            showNotification(result.error, "error");
            return;
        }

        setGameState(prev => {
            let nextInventory = [...prev.inventory];
            const item = result.item;
            
            // Check for stack merging
            const existingIdx = nextInventory.findIndex(i => 
                i.type === item.type && 
                (i.id === item.id || i.blueprintId === item.blueprintId || i.materialKey === item.materialKey) &&
                i.rarity === item.rarity &&
                i.qlBand === item.qlBand
            );

            if (existingIdx > -1) {
                const existing = { ...nextInventory[existingIdx] };
                existing.amount = (existing.amount || 1) + (item.amount || 1);
                existing.weight = (parseFloat(existing.weight) + (parseFloat(item.weight) || 0.1)).toFixed(1);
                nextInventory[existingIdx] = existing;
            } else {
                // Strip systemId when moving to ship cargo to prevent inventory logic confusion
                const { systemId, ...rest } = item;
                nextInventory.push({ ...rest, amount: item.amount || 1 });
            }

            const nextShipWeight = nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0);
            const nextRegionalStorage = { ...gameManagerRef.current.regionalStorage };
            const starportId = SYSTEM_TO_STARPORT[prev.currentSystem?.id];

            return {
                ...prev,
                inventory: nextInventory,
                currentCargoWeight: nextShipWeight,
                regionalStorage: nextRegionalStorage,
                storage: starportId ? { ...prev.storage, [starportId]: (nextRegionalStorage[prev.currentSystem?.id]?.[cloudService.user?.id || 'local'] || []).map(hydrateItem) } : prev.storage
            };
        });

        showNotification(`Item withdrawn from regional storage: ${storageItem.name}`, "success");
    };

    const handleStoreTradeItem = (item) => {
        if (!gameManagerRef.current) return;
        const currentSystemId = gameState.currentSystem?.id;
        if (!currentSystemId) return;

        const result = gameManagerRef.current.depositTradeItem(item, cloudService.user?.id || 'local', currentSystemId);

        if (result.success) {
            setGameState(prev => {
                const nextInventory = prev.inventory.filter(i => i.id !== item.id);
                const nextShipWeight = nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0);
                const nextRegionalStorage = { ...gameManagerRef.current.regionalStorage };
                const starportId = SYSTEM_TO_STARPORT[prev.currentSystem?.id];

                return {
                    ...prev,
                    inventory: nextInventory,
                    currentCargoWeight: nextShipWeight,
                    regionalStorage: nextRegionalStorage,
                    storage: starportId ? { ...prev.storage, [starportId]: (nextRegionalStorage[prev.currentSystem?.id]?.[cloudService.user?.id || 'local'] || []) } : prev.storage
                };
            });
            showNotification(`${item.name} moved to starport storage bay.`, "success");
        }
    };

    const handleJump = (beltId) => {
        if (gameManagerRef.current) {
            const result = gameManagerRef.current.initiateJump(beltId);
            if (result === "SUCCESS") {
                setActiveMenu(null);
            }
        }
    };

    const handleInterstellarJump = (systemId) => {
        if (gameManagerRef.current) {
            const result = gameManagerRef.current.initiateSystemJump(systemId);
            if (result === "SUCCESS") {
                setShowStarMap(false);
                setIsLeapMode(false);
                setInitialStarMapView('sector');
                setActiveMenu(null);
            }
        }
    };

    const handleLeap = () => {
        setInitialStarMapView('galaxy');
        setIsLeapMode(true);
        setShowStarMap(true);
        setGameState(prev => ({ ...prev, radialMenu: null }));
    };

    const handleOptimize = (module, catalyst) => {
        let updatedModule = applyCatalystToItem(module, catalyst.catalystId || catalyst.id);
        
        if (!updatedModule) {
            showNotification({
                type: "error",
                message: `CALIBRATION FAILED: Modifier slots are full.`
            });
            return;
        }

        // Hydrate the upgraded module so it has proper base_stats and final_stats
        updatedModule = hydrateItem(updatedModule);

        showNotification({
            type: "info",
            message: `SYSTEM: Optimization of ${module.name} using ${catalyst.name} initiated.`
        });
        
        setGameState(prev => {
            const currentSystemId = prev.currentSystem?.id;
            const starportId = SYSTEM_TO_STARPORT[currentSystemId];
            const inventory = [...prev.inventory];
            const storage = starportId ? [...(prev.storage[starportId] || [])] : [];
            
            // 1. Consume the catalyst
            const consumeItem = (list) => {
                const idx = list.findIndex(i => i.id === catalyst.id);
                if (idx > -1) {
                    const item = { ...list[idx] };
                    if (item.amount > 1) {
                        const originalWeight = parseFloat(item.weight) || 0;
                        const originalAmount = item.amount;
                        item.amount--;
                        item.weight = ((originalWeight / originalAmount) * item.amount).toFixed(1);
                        list[idx] = item;
                    } else {
                        list.splice(idx, 1);
                    }
                    return true;
                }
                return false;
            };

            const consumed = consumeItem(inventory) || consumeItem(storage);
            if (!consumed) return prev;

            // 2. Update the module in the correct list
            const updateModuleInList = (list) => {
                const idx = list.findIndex(i => i.id === module.id);
                if (idx > -1) {
                    list[idx] = updatedModule;
                    return true;
                }
                return false;
            };

            updateModuleInList(inventory) || updateModuleInList(storage);

            // 3. PERSISTENCE FIX: Update module if it's currently equipped on the active ship
            let nextFittings = { ...prev.fittings };
            let fittingsUpdated = false;
            Object.keys(nextFittings).forEach(slotId => {
                if (nextFittings[slotId]?.id === module.id) {
                    nextFittings[slotId] = updatedModule;
                    fittingsUpdated = true;
                }
            });

            // 4. Update the module if it's equipped on ANY owned ship
            const nextOwnedShips = prev.ownedShips.map(ship => {
                let shipFittings = { ...ship.fittings };
                let shipFittingsUpdated = false;
                Object.keys(shipFittings).forEach(slotId => {
                    if (shipFittings[slotId]?.id === module.id) {
                        shipFittings[slotId] = updatedModule;
                        shipFittingsUpdated = true;
                    }
                });
                return shipFittingsUpdated ? { ...ship, fittings: shipFittings } : ship;
            });

            // Sync engine immediately if active ship fittings were updated
            if (fittingsUpdated && gameManagerRef.current) {
                gameManagerRef.current.syncFittings(nextFittings);
            }
            
            return { 
                ...prev, 
                inventory, 
                storage: starportId ? { ...prev.storage, [starportId]: storage } : prev.storage,
                fittings: nextFittings,
                ownedShips: nextOwnedShips
            };
        });

        setTimeout(() => {
            const modNames = updatedModule.modifiers?.length > 0 
                ? updatedModule.modifiers.map(m => m.name).join(', ') 
                : 'NONE';
            
            showNotification({
                type: "success",
                message: `CALIBRATION COMPLETE: ${updatedModule.name} [${updatedModule.rarity.toUpperCase()}] optimized. Active Mods: ${modNames}`
            });
        }, 1500);
    };

    const handleFabricate = async (blueprintData, ingredients, avgQL, blueprintItem) => {
        const userId = cloudService.user?.id;
        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId];

        if (!userId) {
            showNotification("FABRICATION FAILED: Commander authentication missing.", "error");
            return { ok: false, error: 'missing_user' };
        }
        if (!starportId) {
            showNotification("FABRICATION FAILED: You must be docked at a fabrication bay.", "error");
            return { ok: false, error: 'not_docked' };
        }
        if (!blueprintItem?.id) {
            showNotification("FABRICATION FAILED: Blueprint instance missing.", "error");
            return { ok: false, error: 'missing_blueprint_instance' };
        }

        const ingredientPayload = (Array.isArray(ingredients) ? ingredients : []).map(({ item, amount, source }) => ({
            itemId: item?.id,
            amount,
            source
        })).filter(entry => entry.itemId && Number(entry.amount) > 0);

        try {
            const result = await backendSocket.requestFabricateBlueprint({
                starportId,
                blueprintInstanceId: blueprintItem.id,
                blueprintId:
                    blueprintData?.canonical_blueprint_id ||
                    blueprintData?.canonicalBlueprintId ||
                    blueprintData?.item_type ||
                    blueprintData?.item_id ||
                    blueprintData?.blueprintId ||
                    blueprintData?.id ||
                    null,
                ingredients: ingredientPayload
            });

            if (!result) {
                showNotification("FABRICATION FAILED: Backend timeout.", "error");
                return { ok: false, error: 'timeout' };
            }

            if (!result.ok) {
                const reasonMap = {
                    not_docked: "FABRICATION FAILED: You must be docked.",
                    wrong_starport: "FABRICATION FAILED: Wrong starport context.",
                    missing_blueprint_instance: "FABRICATION FAILED: Missing blueprint instance.",
                    blueprint_not_found: "FABRICATION FAILED: Blueprint item not found.",
                    blueprint_definition_missing: "FABRICATION FAILED: Blueprint definition missing.",
                    blueprint_recipe_missing: "FABRICATION FAILED: Blueprint recipe missing.",
                    ingredients_missing: "FABRICATION FAILED: No ingredients selected.",
                    ingredient_not_found: "FABRICATION FAILED: Selected ingredient not found.",
                    insufficient_ingredient_amount: "FABRICATION FAILED: Insufficient ingredient amount.",
                    invalid_ingredient_type: "FABRICATION FAILED: Invalid ingredient type.",
                    recipe_not_satisfied: "FABRICATION FAILED: Recipe requirements not met.",
                    blueprint_consume_failed: "FABRICATION FAILED: Blueprint consume failed.",
                    ingredient_consume_failed: "FABRICATION FAILED: Ingredient consume failed.",
                    ship_definition_missing: "FABRICATION FAILED: Ship definition missing.",
                    module_definition_missing: "FABRICATION FAILED: Module definition missing.",
                    fabrication_failed: "FABRICATION FAILED: Internal fabrication error."
                };
                showNotification(reasonMap[result.error] || "FABRICATION FAILED: Internal fabrication error.", "error");
                return result;
            }

            const nextInventory = (Array.isArray(result.cargo) ? result.cargo : gameState.inventory).map(item => hydrateItem(item));
            const nextStorage = (Array.isArray(result.storage) ? result.storage : (gameState.storage?.[starportId] || [])).map(item => hydrateItem(item));
            const nextOwnedShips = Array.isArray(result.ownedShips)
                ? result.ownedShips.map(ship => hydrateVessel(ship, ship))
                : gameState.ownedShips;
            const nextCargoWeight = nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0);

            setGameState(prev => ({
                ...prev,
                inventory: nextInventory,
                storage: starportId ? { ...prev.storage, [starportId]: nextStorage } : prev.storage,
                ownedShips: nextOwnedShips,
                currentCargoWeight: nextCargoWeight,
                credits: typeof result?.commanderState?.credits === 'number' ? result.commanderState.credits : prev.credits
            }));

            if (result?.commanderState && typeof result.commanderState.credits === 'number') {
                window.dispatchEvent(new CustomEvent('sectorfall:commander_state', { detail: result.commanderState }));
            }

            const craftedName = result?.output?.name || blueprintData?.outputId || 'Fabricated Item';
            const craftedQl = Number(result?.avgQL || avgQL || 0).toFixed(1);
            if (result?.output && result.output.isShip) {
                showNotification(`Vessel Fabrication Complete: ${craftedName} [QL ${craftedQl}]`, 'success');
            } else {
                showNotification(`Hardware Fabrication Complete: ${craftedName} [QL ${craftedQl}]`, 'success');
            }

            return result;
        } catch (err) {
            console.warn('[Fabricate][Client] backend fabricate failed', err);
            showNotification('FABRICATION FAILED: Backend rejected the request.', 'error');
            return { ok: false, error: err?.message || 'backend_failure' };
        }
    };

    const handleRepairShip = async (shipId, repairPercent) => {
        const userId = cloudService.user?.id;
        if (!userId) {
            console.warn("[App] handleRepairShip: No user ID");
            return;
        }

        console.log(`[App] Initiating backend-authoritative repair for ship ${shipId} at ${repairPercent}%`);

        try {
            const result = await backendSocket.requestRepairShip({ shipId, repairPercent });

            if (!result) {
                showNotification("REPAIR FAILED: Backend timeout.", "error");
                return;
            }

            if (!result.ok) {
                if (typeof result.credits === 'number') {
                    setGameState(prev => ({ ...prev, credits: result.credits }));
                }
                const reasonMap = {
                    not_docked: "REPAIR FAILED: You must be docked.",
                    invalid_request: "REPAIR FAILED: Invalid repair request.",
                    insufficient_credits: "REPAIR FAILED: Insufficient credits.",
                    nothing_to_repair: "REPAIR FAILED: Hull is already at full integrity.",
                    persist_failed: "REPAIR FAILED: Persistence layer rejected the repair."
                };
                showNotification(reasonMap[result.error] || "REPAIR FAILED: Internal facility error.", "error");
                return;
            }

            const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];

            let updatedHangar = [];
            if (currentStarportId) {
                updatedHangar = await cloudService.getHangarShips(userId, currentStarportId);
            }

            if (result.isActiveShip && gameManagerRef.current) {
                // GameManager HUD / telemetry authority uses gm.stats, not just gm.ship.
                if (gameManagerRef.current.stats && typeof gameManagerRef.current.stats === 'object') {
                    gameManagerRef.current.stats.hp = result.nextHp;
                    if (typeof result.maxHp === 'number') {
                        gameManagerRef.current.stats.maxHp = result.maxHp;
                    }
                }

                // Keep ship object in sync too for any code paths that still read from it.
                if (gameManagerRef.current.ship) {
                    gameManagerRef.current.ship.hp = result.nextHp;
                    if (typeof result.maxHp === 'number') {
                        gameManagerRef.current.ship.maxHp = result.maxHp;
                    }
                }

                console.log('[Repair][Client] Applied repaired hull to active ship', {
                    shipId,
                    nextHp: result.nextHp,
                    maxHp: result.maxHp,
                    gmStatsHp: gameManagerRef.current.stats?.hp,
                    gmStatsMaxHp: gameManagerRef.current.stats?.maxHp,
                    gmShipHp: gameManagerRef.current.ship?.hp,
                    gmShipMaxHp: gameManagerRef.current.ship?.maxHp
                });
            }

            setGameState(prev => {
                const nextOwnedShips = prev.ownedShips.map(s => {
                    if (s.id === shipId) {
                        return { ...s, hp: result.nextHp, maxHp: result.maxHp ?? s.maxHp };
                    }
                    return s;
                });

                const isNowActive = shipId === prev.activeShipId;
                const nextHp = isNowActive ? result.nextHp : prev.hp;

                return {
                    ...prev,
                    credits: typeof result.credits === 'number' ? result.credits : prev.credits,
                    hp: nextHp,
                    ownedShips: nextOwnedShips,
                    hangarShips: updatedHangar.length > 0 ? updatedHangar.map(s => s.ship_config) : prev.hangarShips
                };
            });

            showNotification(`REPAIR COMPLETE: Hull integrity restored. Deducted ${Number(result.repairCost || 0).toLocaleString()} Cr.`, "success");
        } catch (error) {
            console.error("[App] Repair operation failed:", error);
            showNotification("REPAIR FAILED: Internal facility error. Credits not deducted.", "error");
        }
    };

const handleUndock = () => {
    if (!gameState.activeShipId || !gameState.fittings) {
        // Prevent undocking while ship is still a placeholder
if (gameState.shipName === "PENDING" || gameState.activeShipId === "PENDING") {
  showNotification("Ship systems still initializing. Please wait 1–2 seconds and try again.", "error");
  return;
}
        showNotification("LAUNCH ABORTED: No active starship command registered.", "error");
        return;
    }

    const { power, cpu } = getLiveShipResources(gameState.fittings);

    if (power > gameState.maxPowerGrid || cpu > gameState.maxCpu) {
        showNotification(
            `LAUNCH ABORTED: ${gameState.shipName} Overload. (PG: ${power.toFixed(1)}/${gameState.maxPowerGrid}, CPU: ${cpu.toFixed(1)}/${gameState.maxCpu})`,
            "error"
        );
        return;
    }

    // 🚀 SEND UNDOCK TO SERVER
// Prevent a 0,0 / starport-exit frame before the server's WELCOME arrives
backendSocket.awaitingSpawn = true;
try { if (gameManagerRef.current?.ship?.sprite) gameManagerRef.current.ship.sprite.visible = false; } catch (e) {}
backendSocket.sendUndock(
  (gameState.currentSystem && gameState.currentSystem.id)
    ? gameState.currentSystem.id
    : "cygnus-prime"
);

    //if (gameManagerRef.current) {
    //    gameManagerRef.current.performUndock();
   // }

    setIsDocked(false);
    showNotification(
        `Launch sequence complete. ${gameState.shipName} is clear of the station.`,
        "info"
    );
};
    const handleSetHome = () => {
        const systemId = gameState.currentSystem?.id;
        if (!systemId) return;
        
        setGameState(prev => ({ ...prev,
            homeSystemId: systemId
        }));
        
        showNotification(`Home location synchronized: ${gameState.currentSystem.name}`, "info");
    };

    // --- Backend Transfer Logic: Ship <-> Starport ---
    const handleTransferToStation = async (item) => {
        if (!isDocked || !cloudUser) {
            showNotification("TRANSFER FAILED: VESSEL MUST BE DOCKED AT STARPORT", "error");
            return;
        }

        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId];
        
        if (!starportId) {
            showNotification("TRANSFER FAILED: NO AUTHORITATIVE STARPORT ID", "error");
            return;
        }

        if (item.type === 'ship') {
            try {
                const registry = SHIP_REGISTRY[item.type || item.item_id];
                const shipToSave = {
                    ...item,
                    type: item.type || item.item_id,
                    classId: registry?.classId || (item.type || item.item_id),
                    isShip: true
                };
                await cloudService.saveToHangar(cloudUser.id, starportId, item.id, shipToSave);
                setGameState(prev => ({ ...prev,
                    ownedShips: prev.ownedShips.filter(s => s.id !== item.id),
                    hangarShips: [...(prev.hangarShips || []), shipToSave]
                }));
                showNotification(`${item.name} transferred to hangar.`, "success");
            } catch (err) {
                showNotification("TRANSFER FAILED: Could not save to hangar.", "error");
            }
            return;
        }

        setGameState(prev => {
            const nextInventory = removeSingleTransferredItemFromList(prev.inventory, item);
            const nextStationStorage = mergeTransferredItemIntoList(prev.storage[starportId] || [], item);
            const { weight: nextShipWeight, volume: nextShipVolume } = calculateCargoTotals(nextInventory);

            // Notify Engine
            if (gameManagerRef.current) {
                gameManagerRef.current.stats.currentCargoWeight = nextShipWeight;
                gameManagerRef.current.stats.currentCargoVolume = nextShipVolume;
                gameManagerRef.current.inventory = nextInventory;
            }

            // Push to Cloud
            cloudService.saveInventoryState(cloudUser.id, starportId, nextStationStorage, "transferToStation");
            cloudService.saveToCloud(cloudUser.id, starportId, {
                ship_type: (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass,
                cargo: nextInventory,
                fittings: prev.fittings,
                system_id: currentSystemId,
                isDocked: true,
                telemetry: {
                    ...(gameManagerRef.current?.getTelemetry() || {}),
                    cargo: nextInventory,
                    fittings: prev.fittings,
                    system_id: currentSystemId,
                    isDocked: true,
                    docked: true
                }
            });

            return {
                ...prev,
                inventory: nextInventory,
                storage: { ...prev.storage, [starportId]: nextStationStorage },
                currentCargoWeight: nextShipWeight,
                currentCargoVolume: nextShipVolume
            };
        });

        showNotification(`${item.name} transferred to storage bay.`, "success");
    };

    const handleTransferToShip = async (item) => {
        if (!isDocked || !cloudUser) {
            showNotification("TRANSFER FAILED: VESSEL MUST BE DOCKED AT STARPORT", "error");
            return;
        }

        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId];

        if (!starportId) {
            showNotification("TRANSFER FAILED: NO AUTHORITATIVE STARPORT ID", "error");
            return;
        }

        if (item.type === 'ship') {
            try {
                await cloudService.removeFromHangar(cloudUser.id, item.id);
                setGameState(prev => {
                    const hydratedShip = hydrateVessel(item, item);
                    const newState = {
                        ...prev,
                        hangarShips: prev.hangarShips.filter(s => s.id !== item.id),
                        ownedShips: [...prev.ownedShips, hydratedShip]
                    };
                    
                    // PERSISTENCE FIX: Sync manifest change to cloud immediately
                    cloudService.updateCommanderData(cloudUser.id, {
                        owned_ships: newState.ownedShips
                    });
                    
                    return newState;
                });
                showNotification(`${item.name} activated from hangar.`, "success");
            } catch (err) {
                showNotification("TRANSFER FAILED: Could not remove from hangar.", "error");
            }
            return;
        }

        setGameState(prev => {
            const nextStationStorage = removeSingleTransferredItemFromList(prev.storage[starportId] || [], item);
            const nextInventory = mergeTransferredItemIntoList(prev.inventory, item);
            const { weight: nextShipWeight, volume: nextShipVolume } = calculateCargoTotals(nextInventory);

            // Notify Engine
            if (gameManagerRef.current) {
                gameManagerRef.current.stats.currentCargoWeight = nextShipWeight;
                gameManagerRef.current.stats.currentCargoVolume = nextShipVolume;
                gameManagerRef.current.inventory = nextInventory;
            }

            // Push to Cloud
            cloudService.saveInventoryState(cloudUser.id, starportId, nextStationStorage, "transferToShip");
            cloudService.saveToCloud(cloudUser.id, starportId, {
                ship_type: (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass,
                cargo: nextInventory,
                fittings: prev.fittings,
                system_id: currentSystemId,
                isDocked: true,
                telemetry: {
                    ...(gameManagerRef.current?.getTelemetry() || {}),
                    cargo: nextInventory,
                    fittings: prev.fittings,
                    system_id: currentSystemId,
                    isDocked: true,
                    docked: true
                }
            });

            return {
                ...prev,
                inventory: nextInventory,
                storage: { ...prev.storage, [starportId]: nextStationStorage },
                currentCargoWeight: nextShipWeight,
                currentCargoVolume: nextShipVolume
            };
        });

        showNotification(`${item.name} transferred to ship cargo.`, "success");
    };

    const handleCreateImplant = (type, ql, bioCost, nanoData) => {
        setGameState(prev => {
            let countToPull = bioCost;
            let nextInventory = [...prev.inventory];
            const starportId = SYSTEM_TO_STARPORT[prev.currentSystem?.id];
            let nextStorage = starportId ? [...(prev.storage[starportId] || [])] : [];

            const pullFromList = (list) => {
                for (let i = list.length - 1; i >= 0 && countToPull > 0; i--) {
                    const item = list[i];
                    if (item.type === 'bio-material') {
                        const pull = Math.min(item.amount || 1, countToPull);
                        item.amount = (item.amount || 1) - pull;
                        countToPull -= pull;
                        if (item.amount <= 0) list.splice(i, 1);
                    }
                }
            };

            pullFromList(nextInventory);
            if (countToPull > 0) pullFromList(nextStorage);

            if (countToPull > 0) {
                showNotification("Error: Insufficient bio-materials for implant fabrication.", "error");
                return prev;
            }

            const newImplant = {
                id: `implant-basic-${type.id}-${ql}-${Date.now()}`,
                name: `${type.name} Basic Implant`,
                type: 'implant',
                implantType: 'basic',
                slot: type.id,
                ql: ql,
                rarity: 'common',
                weight: 0.5,
                requiredStatType: type.stat,
                requiredStatValue: Math.floor((ql * 0.28) + 3),
                sockets: {
                    core: { type: type.core, installed: nanoData.core },
                    matrix: { type: type.matrix, installed: nanoData.matrix },
                    trace: { type: type.trace, installed: nanoData.trace }
                },
                description: `A precision-tuned ${type.name} implant with integrated Nanos.`
            };

            nextStorage.push(newImplant);
            showNotification(`Fabrication Success: QL ${ql} ${type.name} Implant transferred to storage.`, "success");

            return {
                ...prev,
                inventory: nextInventory,
                storage: starportId ? { ...prev.storage, [starportId]: nextStorage } : prev.storage,
                currentCargoWeight: nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0)
            };
        });
    };

    const handleRefine = (item, source, filteredIndex = -1) => {
        const stationCapacity = 1000;
        const starportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
        if (!starportId) return;
        
        setGameState(prev => {
            const currentStationCargo = prev.storage[starportId] || [];
            let nextInventory = [...prev.inventory];
            let nextStationStorage = [...currentStationCargo];

            const sourceItems = source === 'ship'
                ? nextInventory.filter(i => i.type === 'resource' && !i.isRefined)
                : nextStationStorage.filter(i => i.type === 'resource' && !i.isRefined);

            const selectedItem = sourceItems[filteredIndex] || item;
            if (!selectedItem) {
                showNotification("SELECTED ORE STACK NOT FOUND", "error");
                return prev;
            }

            const itemWeight = parseFloat(selectedItem.weight) || (Number(selectedItem.amount || 0) * 0.1);
            const currentStationWeight = currentStationCargo.reduce((sum, i) => sum + (parseFloat(i.weight) || 5), 0);
            
            // Check station capacity
            if (currentStationWeight + itemWeight > stationCapacity) {
                showNotification("STARPORT STORAGE BAY AT CAPACITY", "error");
                return prev;
            }

            // A. Rename the Resource (e.g., "Refined Silicite")
            const oreType = selectedItem.oreType || selectedItem.name.split(' [')[0].replace(/ Ore/i, '');
            const refinedName = `Refined ${oreType}`;
            
            // B. QL-Based Refining Output: Average calculation from the Unit List
            let refinedQL = 1;
            if (selectedItem.qlList && selectedItem.qlList.length > 0) {
                const sum = selectedItem.qlList.reduce((a, b) => a + b, 0);
                // Calculate precise average
                refinedQL = Number((sum / selectedItem.qlList.length).toFixed(1));
                console.log(`[Refinery] Averaging ${selectedItem.qlList.length} units. Sum: ${sum}, Resulting QL: ${refinedQL}`);
            } else {
                // Fallback to band-average if list missing
                if (typeof selectedItem.qlBand === 'string' && selectedItem.qlBand.includes('-')) {
                    const parts = selectedItem.qlBand.split('-').map(p => parseInt(p.trim()));
                    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                        refinedQL = Math.floor((parts[0] + parts[1]) / 2);
                    }
                } else if (!isNaN(parseInt(selectedItem.qlBand))) {
                    refinedQL = parseInt(selectedItem.qlBand);
                }
            }
            
            const refinedAmount = Math.floor(Number(selectedItem.amount || 0) * 0.75);
            
            // D. Remove only the exact selected raw ore stack & add refined resource
            if (source === 'ship') {
                const selectedIndex = nextInventory.indexOf(selectedItem);
                if (selectedIndex === -1) {
                    showNotification("SELECTED SHIP ORE STACK NOT FOUND", "error");
                    return prev;
                }
                nextInventory.splice(selectedIndex, 1);
            } else {
                const selectedIndex = nextStationStorage.indexOf(selectedItem);
                if (selectedIndex === -1) {
                    showNotification("SELECTED STORAGE ORE STACK NOT FOUND", "error");
                    return prev;
                }
                nextStationStorage.splice(selectedIndex, 1);
            }

            const existingInStorage = nextStationStorage.find(i => 
                i.isRefined && 
                i.oreType === oreType &&
                i.qlBand === refinedQL
            );

            if (existingInStorage) {
                existingInStorage.amount += refinedAmount;
                existingInStorage.weight = (parseFloat(existingInStorage.weight) + itemWeight).toFixed(1);
            } else {
                const refinedItem = {
                    id: `${refinedName}-Refined-QL-${refinedQL}-${Date.now()}`,
                    name: `${refinedName} [QL ${refinedQL}]`,
                    oreType: oreType,
                    type: 'resource',
                    isRefined: true,
                    amount: refinedAmount,
                    weight: itemWeight.toFixed(1), 
                    qlBand: refinedQL, 
                    rarity: selectedItem.rarity || 'common',
                    description: `High-purity ${oreType}. Refined to an exact average quality of ${refinedQL} from ${selectedItem.qlList?.length || 'legacy'} raw units.`
                };
                nextStationStorage.push(refinedItem);
            }

            // Recalculate ship weight if source was ship
            const nextShipWeight = nextInventory.reduce((sum, i) => sum + (parseFloat(i.weight) || 0), 0);

            // AUTHORITATIVE PUSH
            cloudService.saveInventoryState(cloudUser.id, starportId, nextStationStorage, "refineOre");

            showNotification(`Refining Complete: ${refinedAmount} units of ${refinedName} produced at QL ${refinedQL}.`, "success");

            return {
                ...prev,
                inventory: nextInventory,
                storage: { ...prev.storage, [starportId]: nextStationStorage },
                currentCargoWeight: nextShipWeight
            };
        });
        };   // ← ADD THIS LINE


    const subButtons = [
        { label: 'FIND', angle: -175, id: 'find', icon: (color) => React.createElement(IconSearch, { color }) },
        { label: 'CARGO', angle: -135, id: 'cargo', icon: (color) => React.createElement(IconCargo, { color }) },
        { label: 'SHIP', angle: -95, id: 'ship', icon: (color) => React.createElement(IconShipSub, { color }) },
        { label: 'SOCIAL', angle: -55, id: 'social', icon: (color) => React.createElement(IconSyndicate, { color }) },
    ];

    return React.createElement('div', {
        id: 'game-root',
        style: {
            width: '100vw',
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#000',
            overflow: 'hidden'
        }
    },
        React.createElement('div', { 
            ref: containerRef, 
            onContextMenu: (e) => {
                e.preventDefault();
                gameManagerRef.current?.handleContextMenu(e.clientX, e.clientY);
            },
            style: { 
                width: '1920px', 
                height: '1080px', 
                position: 'relative', 
                background: '#000',
                transform: `scale(${viewportScale})`,
                transformOrigin: 'center center',
                flexShrink: 0
            } 
        }, 
            React.createElement('style', null, `
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes fadeOut {
                    from { opacity: 1; }
                    to { opacity: 0; }
                }
                @keyframes flicker {
                    0% { opacity: 1; }
                    50% { opacity: 0.5; }
                    100% { opacity: 1; }
                }
                @keyframes destructionPulse {
                    0% { transform: translate(-50%, -50%) scale(1); opacity: 0.8; box-shadow: 0 0 20px rgba(255,0,0,0.5); }
                    100% { transform: translate(-50%, -50%) scale(1.1); opacity: 1; box-shadow: 0 0 50px rgba(255,0,0,0.8); }
                }
                @keyframes ping {
                    0% { transform: scale(0.5); opacity: 1; }
                    100% { transform: scale(1.5); opacity: 0; }
                }
                @keyframes warningFlash {
                    0% { opacity: 1; }
                    50% { opacity: 0.3; filter: brightness(2.0); }
                    100% { opacity: 1; }
                }
                /* Industrial Standard Scrollbars */
                ::-webkit-scrollbar {
                    width: 4px;
                    height: 4px;
                }
                ::-webkit-scrollbar-track {
                    background: rgba(0, 0, 0, 0.2);
                }
                ::-webkit-scrollbar-thumb {
                    background: #00ccff;
                    border-radius: 2px;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: #fff;
                }
                /* Optimization Hangar overrides are handled via inline scrollbarColor where possible */
            `),
        // Left Side HUD (Captain Portrait)
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: '30px',
                left: '30px',
                width: '160px',
                display: 'flex',
                flexDirection: 'column',
                pointerEvents: 'none',
                zIndex: 2100 // High enough to show over Starport Interior (2000)
            }
        },
            // Captain Portrait Hologram
            React.createElement('div', {
                onClick: () => setActiveMenu('commander'),
                style: {
                    width: '160px',
                    height: '160px',
                    position: 'relative',
                    background: 'rgba(20, 20, 25, 0.8)',
                    border: '1.5px solid #444',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    boxShadow: '0 0 15px rgba(0,0,0,0.5)',
                    cursor: 'pointer',
                    pointerEvents: 'auto',
                    transition: 'all 0.2s ease-out'
                },
                onMouseEnter: (e) => {
                    e.currentTarget.style.borderColor = '#00ccff';
                    e.currentTarget.style.boxShadow = '0 0 20px rgba(0,204,255,0.4), inset 0 0 10px rgba(0,204,255,0.1)';
                },
                onMouseLeave: (e) => {
                    e.currentTarget.style.borderColor = '#444';
                    e.currentTarget.style.boxShadow = '0 0 15px rgba(0,0,0,0.5)';
                }
            },
                React.createElement('img', {
                    src: commanderData?.portrait_url || '/assets/captain-portrait.png.webp',
                    style: {
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        imageRendering: 'pixelated'
                    }
                }),
                // Label
                React.createElement('div', {
                    style: {
                        position: 'absolute',
                        bottom: '0',
                        left: '0',
                        width: '100%',
                        background: 'rgba(0,0,0,0.6)',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'monospace',
                        fontWeight: 'bold',
                        letterSpacing: '1px',
                        zIndex: 3,
                        textAlign: 'center',
                        padding: '6px 0',
                        borderTop: '1px solid #444',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textTransform: 'uppercase'
                    }
                }, gameState.commanderName),
                
                // Cloud Sync Status Indicator
                isCloudSyncing && React.createElement('div', {
                    style: {
                        position: 'absolute',
                        top: '-20px',
                        left: '0',
                        fontSize: '11px',
                        color: '#00ff00',
                        fontWeight: 'bold',
                        letterSpacing: '1px',
                        animation: 'flicker 1s infinite'
                    }
                }, '☁️ SYNCING...')
            )
        ),

        // Command Hub (Vertical List - Aligned with Chat Icon, Under Portrait)
        !isDocked && React.createElement('div', {
            style: {
                position: 'absolute',
                top: '220px', // Positioned under the Portrait (which ends at ~190px)
                left: '20px',
                width: '50px', // Match chat icon width for perfect alignment
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                alignItems: 'center',
                pointerEvents: 'none',
                zIndex: 2100
            }
        },
            // Sector Map Slot
            React.createElement('div', {
                style: {
                    position: 'relative',
                    width: '58px',
                    height: '58px',
                    marginBottom: '4px',
                    pointerEvents: 'none'
                }
            },
                // Sector Map Button (Larger)
                React.createElement('div', {
                    onClick: () => {
                        if (isArenaCurrent || isBattlegroundCurrent) return;
                        setIsLeapMode(false);
                        setInitialStarMapView('sector');
                        setShowStarMap(true);
                    },
                    style: {
                        width: '58px',
                        height: '58px',
                        background: '#000',
                        border: `1.5px solid ${(isArenaCurrent || isBattlegroundCurrent) ? '#444' : '#888'}`,
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: (isArenaCurrent || isBattlegroundCurrent) ? 'not-allowed' : 'pointer',
                        opacity: (isArenaCurrent || isBattlegroundCurrent) ? 0.45 : 1,
                        boxShadow: '0 4px 10px rgba(0,0,0,0.8)',
                        pointerEvents: 'auto',
                        transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
                    },
                    onMouseEnter: (e) => {
                        if (isArenaCurrent || isBattlegroundCurrent) return;
                        e.currentTarget.style.transform = 'scale(1.15)';
                        e.currentTarget.style.borderColor = '#00ccff';
                        e.currentTarget.style.boxShadow = '0 0 20px rgba(0,204,255,0.4)';
                    },
                    onMouseLeave: (e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.borderColor = (isArenaCurrent || isBattlegroundCurrent) ? '#444' : '#888';
                        e.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,0.8)';
                    }
                }, 
                    React.createElement(IconGalaxy)
                ),

                // Shop Button (Satellite to the right - Sibling to avoid highlight bleed)
                React.createElement(NavButton, {
                    label: 'SHOP',
                    icon: React.createElement(IconShop),
                    size: 34,
                    onClick: () => setActiveMenu('shop'),
                    style: {
                        position: 'absolute',
                        left: '65px',
                        top: '12px',
                        pointerEvents: 'auto'
                    }
                })
            ),
            
            // Navigation Satellite Buttons (Vertical)
            subButtons.map((btn, i) => {
                const progress = btn.id === 'cargo' ? (gameState.currentCargoWeight / gameState.cargoHold) * 100 : 0;
                const isCargoFull = btn.id === 'cargo' && progress >= 99;
                
                return React.createElement(NavButton, {
                    key: i,
                    label: btn.label,
                    icon: btn.icon,
                    progress: progress,
                    size: 42,
                    onClick: () => setActiveMenu(btn.id),
                    style: {
                        position: 'relative',
                        animation: isCargoFull ? 'warningFlash 0.5s infinite ease-in-out' : 'none',
                        borderColor: isCargoFull ? '#ff0000' : '#666',
                        boxShadow: isCargoFull ? '0 0 20px rgba(255,0,0,0.5)' : '0 4px 10px rgba(0,0,0,0.8)'
                    }
                });
            })
        ),

        // System Name (Restored Top Center)
        (() => {
            const secValue = gameState.currentSystem?.securityValue ?? 0;
            const secInfo = getSecurityInfo(secValue);
            return React.createElement('div', {
                onClick: () => setActiveMenu('system'),
                style: {
                    position: 'absolute',
                    top: '20px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    padding: '8px 20px',
                    background: 'rgba(0,0,0,0.7)',
                    border: `1px solid ${secInfo.color}66`,
                    borderRadius: '4px',
                    color: secInfo.color,
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    letterSpacing: '2px',
                    fontWeight: 'bold',
                    textShadow: `0 0 12px ${secInfo.color}88`,
                    zIndex: 10,
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                    userSelect: 'none',
                    textAlign: 'center',
                    transition: 'all 0.2s'
                },
                onMouseEnter: (e) => {
                    e.currentTarget.style.background = 'rgba(0,40,0,0.8)';
                    e.currentTarget.style.borderColor = secInfo.color;
                },
                onMouseLeave: (e) => {
                    e.currentTarget.style.background = 'rgba(0,0,0,0.7)';
                    e.currentTarget.style.borderColor = `${secInfo.color}66`;
                }
            }, `${gameState.currentSystem?.name?.toUpperCase()} // SEC: ${secValue.toFixed(1)}`);
        })(),


        // Tactical Notifications Area (Lowered to avoid overlapping System Name)
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: '100px',
                left: '50%',
                transform: 'translateX(-50%)',
                width: '450px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                zIndex: 3000,
                pointerEvents: 'none'
            }
        },
            notifications.map(n => {
                if (n.type === 'loot') {
                    const rarityColor = RARITY_COLORS[n.rarity] || '#ffffff';
                    return React.createElement('div', {
                        key: n.id,
                        style: {
                            background: 'rgba(0, 5, 10, 0.9)',
                            padding: '10px 15px',
                            border: `1px solid ${rarityColor}55`,
                            borderRadius: '4px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            boxShadow: `0 4px 15px rgba(0,0,0,0.8), 0 0 10px ${rarityColor}22`,
                            animation: 'fadeIn 0.3s ease-out, fadeOut 0.3s ease-in 3.7s forwards',
                            minWidth: '240px',
                            pointerEvents: 'none'
                        }
                    },
                        React.createElement('div', { 
                            style: { 
                                fontSize: '9px', 
                                color: '#888', 
                                letterSpacing: '2px', 
                                fontWeight: 'bold' 
                            } 
                        }, `${n.itemType} ACQUIRED`),
                        React.createElement('div', { 
                            style: { 
                                color: '#fff', 
                                fontSize: '13px', 
                                fontWeight: 'bold' 
                            } 
                        }, n.name),
                        React.createElement('div', { 
                            style: { 
                                display: 'flex', 
                                justifyContent: 'space-between', 
                                alignItems: 'center',
                                marginTop: '2px'
                            } 
                        },
                            React.createElement('span', { 
                                style: { 
                                    color: rarityColor, 
                                    fontSize: '10px', 
                                    fontWeight: 'bold',
                                    textTransform: 'uppercase'
                                } 
                            }, n.rarity),
                            n.size && React.createElement('span', { 
                                style: { 
                                    color: '#aaa', 
                                    fontSize: '10px', 
                                    fontWeight: 'bold',
                                    border: '1px solid #444',
                                    padding: '0 4px',
                                    borderRadius: '2px'
                                } 
                            }, n.size)
                        )
                    );
                }

                const color = n.type === 'error' ? '#ff4444' : (n.type === 'success' ? '#00ff00' : '#00ccff');

                return React.createElement('div', {
                    key: n.id,
                    style: {
                        background: 'rgba(0,0,0,0.85)',
                        padding: '12px 20px',
                        color: color,
                        fontFamily: 'monospace',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        letterSpacing: '1.5px',
                        boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
                        animation: n.persistent ? 'fadeIn 0.3s ease-out' : 'fadeIn 0.3s ease-out, fadeOut 0.3s ease-in 2.7s forwards',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        textTransform: 'uppercase',
                        borderRadius: '2px',
                        border: `1px solid ${color}44`,
                        pointerEvents: 'auto' // Enable clicks for actions
                    }
                }, 
                React.createElement('div', { style: { marginBottom: n.actions ? '12px' : '0' }}, n.message),
                n.actions && React.createElement('div', {
                    style: {
                        display: 'flex',
                        gap: '10px',
                        pointerEvents: 'auto'
                    }
                }, n.actions.map((action, idx) => 
                    React.createElement('button', {
                        key: idx,
                        onClick: (e) => {
                            e.stopPropagation();
                            action.onClick();
                            removeNotification(n.id);
                        },
                        style: {
                            background: action.type === 'success' ? 'rgba(0, 255, 0, 0.2)' : 'rgba(255, 0, 0, 0.2)',
                            color: action.type === 'success' ? '#00ff00' : '#ff4444',
                            border: `1px solid ${action.type === 'success' ? '#00ff00' : '#ff4444'}88`,
                            padding: '5px 15px',
                            cursor: 'pointer',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            fontFamily: 'monospace',
                            borderRadius: '2px',
                            transition: 'all 0.2s ease'
                        },
                        onMouseOver: (e) => {
                            e.target.style.background = action.type === 'success' ? 'rgba(0, 255, 0, 0.4)' : 'rgba(255, 0, 0, 0.4)';
                        },
                        onMouseOut: (e) => {
                            e.target.style.background = action.type === 'success' ? 'rgba(0, 255, 0, 0.2)' : 'rgba(255, 0, 0, 0.2)';
                        }
                    }, action.label)
                )));
            })
        ),

        // Target Info Box (Lowered to avoid overlap with Right HUD)
        (gameState.target || gameState.hoveredEntity) && (() => {
            const activeEntity = gameState.target || gameState.hoveredEntity;
            const isScanned = (gameState.scannedEntities || []).includes(activeEntity.id);
            const isBio = activeEntity.isBio;
            const targetName = isBio ? (isScanned ? activeEntity.creatureType : activeEntity.classId) : (isScanned ? (activeEntity.name || activeEntity.type) : activeEntity.type);
            const isHoverOnly = !gameState.target && gameState.hoveredEntity;
            
            // Scanning/Surveying Progress from GameManager state
            const scanning = gameManagerRef.current?.scanning;
            const isTargetScanning = scanning?.active && scanning?.entity?.id === activeEntity.id;
            const isSurvey = scanning?.isSurvey;
            
            return React.createElement(React.Fragment, null,
                React.createElement('div', {
                    style: {
                        position: 'absolute',
                        top: '320px',
                        right: '20px',
                        width: '180px',
                        background: 'rgba(0,0,0,0.85)',
                        border: `1px solid ${isScanned ? (isBio ? '#00ff88' : '#ffcc00') : (isHoverOnly ? '#00ccff88' : '#444')}`,
                        borderRadius: '4px',
                        padding: '12px',
                        fontFamily: 'monospace',
                        color: '#fff',
                        zIndex: 10,
                        pointerEvents: 'none',
                        boxShadow: isScanned ? `0 0 15px ${isBio ? 'rgba(0,255,136,0.2)' : 'rgba(255,204,0,0.2)'}` : (isHoverOnly ? '0 0 10px rgba(0,204,255,0.1)' : 'none')
                    }
                },
                    React.createElement('div', { 
                        style: { 
                            fontSize: '9px', 
                            color: isHoverOnly ? '#00ccff' : (isScanned ? (isBio ? '#00ff88' : '#ffcc00') : '#888'), 
                            marginBottom: '4px', 
                            fontWeight: 'bold',
                            letterSpacing: '1px'
                        } 
                    }, isHoverOnly ? 'HOVERED ENTITY' : 'LOCKED TARGET'),
                    React.createElement('div', { 
                        style: { 
                            fontSize: '14px', 
                            fontWeight: 'bold', 
                            marginBottom: '6px',
                            color: isBio ? '#00ff88' : '#fff'
                        } 
                    }, targetName?.toUpperCase() || 'UNKNOWN ENTITY'),
                    
                    isTargetScanning ? [
                        React.createElement('div', { key: 'scan-label', style: { fontSize: '11px', color: isSurvey ? '#cc00ff' : '#00ccff', fontWeight: 'bold', marginBottom: '4px' } }, isSurvey ? 'DEEP SURVEY...' : 'SCANNING...'),
                        React.createElement('div', { key: 'scan-bar', style: { width: '100%', height: '6px', background: 'rgba(0,0,0,0.5)', borderRadius: '3px', overflow: 'hidden', border: `1px solid ${isSurvey ? '#cc00ff44' : '#00ccff44'}` } }, 
                        React.createElement('div', { 
                                style: { 
                                    width: `${Math.floor(scanning.progress)}%`, 
                                    height: '100%', 
                                    background: isSurvey ? '#cc00ff' : '#00ccff',
                                    boxShadow: `0 0 10px ${isSurvey ? '#cc00ff88' : '#00ccff88'}`
                                } 
                            })
                        )
                    ] : (isScanned || activeEntity.type === 'Starport' || activeEntity.type === 'WarpGate' ? [
                        isBio ? [
                            React.createElement('div', { key: 'status', style: { fontSize: '11px', color: '#00ff88', fontWeight: 'bold', marginBottom: '8px' } }, 'STATUS: ORGANIC'),
                            React.createElement('div', { key: 'vitality-bar', style: { width: '100%', height: '6px', background: 'rgba(0,0,0,0.5)', borderRadius: '3px', overflow: 'hidden', border: '1px solid #00ff8844' } }, 
                                React.createElement('div', { 
                                    style: { 
                                        width: `${Math.floor((activeEntity.stats?.hp / activeEntity.stats?.maxHp) * 100)}%`, 
                                        height: '100%', 
                                        background: '#00ff88',
                                        boxShadow: '0 0 10px #00ff8888'
                                    } 
                                })
                            ),
                            React.createElement('div', { key: 'vitality-text', style: { fontSize: '10px', color: '#00ff88', marginTop: '4px', textAlign: 'right', fontWeight: 'bold' } }, 
                                `${Math.floor(activeEntity.stats?.hp || 0)} / ${Math.floor(activeEntity.stats?.maxHp || 0)}`
                            )
                        ] : [
                            activeEntity.type === 'anomaly' && React.createElement('div', { key: 'anomaly-status', style: { fontSize: '11px', color: '#cc00ff', fontWeight: 'bold', marginBottom: '5px' } }, 'SURVEY RECOMMENDED'),
                            activeEntity.type === 'Starport' && React.createElement('div', { key: 'starport-status', style: { fontSize: '11px', color: '#00ccff', fontWeight: 'bold', marginBottom: '5px' } }, 'STATION SERVICES ACTIVE'),
                            activeEntity.type === 'WarpGate' && React.createElement('div', { key: 'warpgate-status', style: { fontSize: '11px', color: '#00ccff', fontWeight: 'bold', marginBottom: '5px' } }, 'QUANTUM LINK STABLE'),
                            activeEntity.ql && React.createElement('div', { key: 'ql', style: { fontSize: '11px', color: '#ffcc00', fontWeight: 'bold' } }, `QUALITY: ${activeEntity.ql}`),
                            activeEntity.oreAmount !== undefined && React.createElement('div', { key: 'ore', style: { fontSize: '11px', color: '#aaa' } }, `ORE: ${Math.floor(activeEntity.oreAmount)}u`),
                            activeEntity.stats && React.createElement('div', { key: 'hp', style: { fontSize: '11px', color: '#aaa' } }, `HULL: ${Math.floor((activeEntity.stats.hp / activeEntity.stats.maxHp) * 100)}%`)
                        ]
                    ] : React.createElement('div', { style: { fontSize: '10px', color: '#ff4444', fontStyle: 'italic', marginTop: '5px' } }, 'SENSORS: SCAN REQUIRED'))
                ),
                React.createElement('div', {
                    style: {
                        position: 'absolute',
                        top: '420px',
                        right: '20px',
                        zIndex: 10,
                        pointerEvents: 'none'
                    }
                },
                    React.createElement(ActionHotkeysHUD, { 
                        hoveredEntity: gameState.hoveredEntity, 
                        target: gameState.target,
                        gameManager: gameManagerRef.current
                    })
                )
            );
        })(),

        // --- DOCKING OVERLAY ---
        isDocked && React.createElement(StationInterior, { 
            onUndock: handleUndock, 
            gameState: gameState,
            onCommandShip: handleCommandShip,
            onActivateShip: handleActivateShip,
            onDepositShip: handleDepositShip,
            onRepairShip: handleRepairShip,
            onSetHome: handleSetHome,
            onTransferToStation: handleTransferToStation,
            onTransferToShip: handleTransferToShip,
            onOpenFitting: () => setActiveMenu('ship'),
            onRefine: handleRefine,
            onFabricate: handleFabricate,
            onOptimize: handleOptimize,
            onCreateImplant: handleCreateImplant,
            onList: handleListTradeItem,
            onBuy: handleBuyTradeItem,
            onBuyOrder: handleCreateBuyOrder,
            onCollect: handleCollectTradeItem,
            onBid: handleBidAuctionItem,
            onCreateContract: handleCreateContract,
            onAcceptContract: handleAcceptContract,
            onPickupPackage: handlePickupPackage,
            onDeliverPackage: handleDeliverPackage,
            onCancelListing: handleCancelTradeItem,
            onCancelContract: handleCancelCourierContract
        }),

        // Right Side HUD Structure
        React.createElement('div', {
            style: {
                position: 'absolute',
                top: '20px',
                right: '20px',
                width: '230px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                pointerEvents: 'none',
                zIndex: 10
            }
        },
            // Radar (No grey border)
            React.createElement('div', {
                style: { 
                    width: '150px', 
                    height: '150px',
                    position: 'relative',
                    marginBottom: '15px'
                }
            }, 
                React.createElement('div', {
                    style: {
                        width: '100%',
                        height: '100%',
                        background: 'rgba(0,0,0,0.8)',
                        borderRadius: '4px',
                        position: 'relative',
                        overflow: 'hidden',
                        border: '1px solid #444',
                        boxShadow: 'inset 0 0 10px rgba(0,255,0,0.1)'
                    }
                },
                    // Grid lines
                    React.createElement('div', { style: { position: 'absolute', width: '100%', height: '1px', background: 'rgba(0, 255, 0, 0.1)', top: '50%' } }),
                    React.createElement('div', { style: { position: 'absolute', height: '100%', width: '1px', background: 'rgba(0, 255, 0, 0.1)', left: '50%' } }),
                    
                    // Entities
                    gameState.radarEntities.map((ent, i) => (
                        React.createElement('div', {
                            key: i,
                            style: {
                                position: 'absolute',
                                width: '4px',
                                height: '4px',
                                backgroundColor: ent.color || '#ff0000',
                                left: `${50 + ent.x * 50}%`,
                                top: `${50 + ent.y * 50}%`,
                                transform: 'translate(-50%, -50%)'
                            }
                        })
                    )),
                    // Player
                    React.createElement('div', {
                        style: {
                            position: 'absolute',
                            left: '50%',
                            top: '50%',
                            width: '6px',
                            height: '6px',
                            backgroundColor: '#fff',
                            borderRadius: '50%',
                            transform: 'translate(-50%, -50%)'
                        }
                    })
                )
            ),

            // Ship Info and Status Bars
            React.createElement('div', {
                style: {
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column'
                }
            },
                // Ship Name Label
                React.createElement('div', {
                    style: {
                        color: '#aaa',
                        fontSize: '14px',
                        fontFamily: 'monospace',
                        textAlign: 'right',
                        marginBottom: '10px',
                        letterSpacing: '2px',
                        fontWeight: 'bold',
                        userSelect: 'none',
                        cursor: 'default'
                    }
                }, gameState.shipName.toUpperCase()),

                gameState.maxShields > 0 ? React.createElement(BarRow, { color: '#00ccff', percent: (gameState.shields / gameState.maxShields) * 100, value: gameState.shields, icon: React.createElement(IconShield) }) : null,
                React.createElement(BarRow, { 
                    color: '#ff0000', 
                    percent: (gameState.hp / gameState.maxHp) * 100, 
                    value: gameState.hp, 
                    icon: React.createElement(IconHP),
                    isFlashing: (gameState.hp / gameState.maxHp) < 0.2
                }),
                React.createElement(BarRow, { 
                    color: (gameState.energy / gameState.maxEnergy) < 0.15 ? '#ffcc00' : '#00ff00', 
                    percent: (gameState.energy / gameState.maxEnergy) * 100, 
                    value: gameState.energy, 
                    icon: React.createElement(IconEnergy),
                    isFlashing: (gameState.energy / gameState.maxEnergy) < 0.15
                })
            )
        ),

        // Overlays
        activeMenu === 'cargo' && React.createElement(CargoMenu, { 
            gameState: gameState, 
            onClose: () => setActiveMenu(null) 
        }),
        activeMenu === 'ship' && React.createElement(ShipMenu, { 
            gameState: gameState, 
            onClose: () => setActiveMenu(null),
            onSelectSlot: (slot) => setActiveFittingSlot(slot)
        }),
        activeMenu === 'system' && React.createElement(SystemMenu, { 
            gameState: gameState,
            onClose: () => setActiveMenu(null),
            inArena: isArenaCurrent,
            onLeaveArena: handleLeaveArena,
            inBattleground: isBattlegroundCurrent,
            onLeaveBattleground: handleLeaveBattleground,
            battlegroundHud: battlegroundState.hud
        }),
        arenaState.open && React.createElement(ArenaMenu, {
            state: arenaState,
            onClose: handleCloseArenaMenu,
            onEnter: handleEnterArena,
            onLeave: handleLeaveArena,
            inArena: isArenaCurrent
        }),
        battlegroundState.open && React.createElement(PveBattlegroundMenu, {
            state: battlegroundState,
            onClose: handleCloseBattlegroundMenu,
            onEnter: handleEnterBattleground,
            onLeave: handleLeaveBattleground,
            inBattleground: isBattlegroundCurrent
        }),
        battlegroundWaveCountdown && isBattlegroundCurrent && React.createElement('div', {
            style: {
                position: 'absolute',
                top: '14%',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2600,
                pointerEvents: 'none',
                textAlign: 'center',
                fontFamily: 'monospace',
                letterSpacing: '2px'
            }
        },
            React.createElement('div', { style: { color: '#73d5ff', fontSize: '18px', marginBottom: '8px', textShadow: '0 0 12px rgba(0,204,255,0.45)' } }, `WAVE ${battlegroundWaveCountdown.waveNumber || battlegroundState.hud.currentWave || '?'} INBOUND`),
            React.createElement('div', { style: { color: '#ffffff', fontSize: '64px', fontWeight: 'bold', textShadow: '0 0 24px rgba(0,204,255,0.5)' } }, String(battlegroundWaveCountdown.remaining)),
            React.createElement('div', { style: { color: '#9cc7d9', fontSize: '12px', marginTop: '6px' } }, 'PREPARE FOR WARP-IN')
        ),
        battlegroundState.choice && isBattlegroundCurrent && React.createElement('div', {
            style: {
                position: 'absolute',
                bottom: '11%',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2600,
                minWidth: '360px',
                padding: '16px 18px',
                borderRadius: '8px',
                border: '1px solid rgba(0,204,255,0.26)',
                background: 'rgba(6,16,24,0.92)',
                boxShadow: '0 0 30px rgba(0,0,0,0.45)',
                textAlign: 'center',
                fontFamily: 'monospace'
            }
        },
            React.createElement('div', { style: { color: '#73d5ff', fontSize: '16px', letterSpacing: '2px', marginBottom: '6px' } }, battlegroundState.choice.completed ? 'BATTLEGROUND COMPLETE' : 'WAVE CLEARED'),
            React.createElement('div', { style: { color: '#ffffff', fontSize: '13px', marginBottom: '6px' } }, `BANKED CREDITS: ${Number(battlegroundState.choice.bankedCredits || battlegroundState.bankedCredits || 0).toLocaleString()}`),
            (!!battlegroundState.choice.waveReward) && React.createElement('div', { style: { color: '#9cc7d9', fontSize: '11px', marginBottom: '12px' } }, `WAVE REWARD +${Number(battlegroundState.choice.waveReward || 0).toLocaleString()}`),
            React.createElement('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } },
                battlegroundState.choice.canExtract && React.createElement('button', {
                    onClick: handleBattlegroundExtract,
                    style: { padding: '10px 18px', borderRadius: '6px', border: '1px solid rgba(0,204,255,0.45)', background: 'linear-gradient(180deg, rgba(0,204,255,0.22), rgba(0,110,170,0.22))', color: '#fff', fontFamily: 'monospace', fontWeight: 'bold', cursor: 'pointer' }
                }, 'EXTRACT'),
                battlegroundState.choice.canContinue && React.createElement('button', {
                    onClick: handleBattlegroundContinue,
                    style: { padding: '10px 18px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)', color: '#d7efff', fontFamily: 'monospace', fontWeight: 'bold', cursor: 'pointer' }
                }, 'CONTINUE')
            )
        ),
        activeMenu === 'commander' && React.createElement(CommanderMenu, { 
            gameState: gameState,
            onClose: () => {
                setActiveMenu(null);
                setIsEditingName(false);
            },
            isEditing: isEditingName,
            onToggleEdit: () => setIsEditingName(!isEditingName),
            onSaveName: handleSaveName,
            cloudUser: cloudUser,
            onCloudLogin: handleCloudLogin,
            onCloudLogout: handleCloudLogout,
            isSyncing: isCloudSyncing,
            onSelectSlot: (slot) => setActiveFittingSlot(slot),
            setActivePanel: setActivePanel
        }),
        gameState.inspectingRemotePlayer && React.createElement(CommanderMenu, {
            gameState: gameState,
            remotePlayer: gameState.inspectingRemotePlayer,
            onClose: () => gameManagerRef.current.inspectingRemotePlayer = null
        }),
        gameState.contextMenu && React.createElement(ContextMenu, {
            x: gameState.contextMenu.x,
            y: gameState.contextMenu.y,
            entity: gameState.contextMenu.entity,
            onInspect: (e) => gameManagerRef.current.inspectPlayer(e),
            onInvite: (e) => gameManagerRef.current.inviteToFleet(e),
            onMessage: (e) => {
                setChatChannel('DIRECT');
                setMessageDraft(`@${e.name} `);
            },
            onClose: () => gameManagerRef.current.contextMenu = null
        }),
        React.createElement(FleetHUD, {
            fleet: gameState.fleet,
            remotePlayers: gameManagerRef.current?.remotePlayers || new Map(),
            userId: cloudService.user?.id,
            onTargetMember: (id) => {
                const player = gameManagerRef.current?.remotePlayers.get(id);
                if (player) gameManagerRef.current.setTarget(player);
            },
            onLeaveFleet: () => gameManagerRef.current?.leaveFleet(),
            onKickMember: (id) => gameManagerRef.current?.kickMember(id)
        }),
        activeMenu === 'social' && React.createElement(SocialMenu, { 
            onClose: () => setActiveMenu(null),
            fleet: gameState.fleet,
            userId: cloudService.user?.id,
            onLeaveFleet: () => gameManagerRef.current?.leaveFleet(),
            onKickMember: (id) => gameManagerRef.current?.kickMember(id),
            onPromoteMember: (id) => gameManagerRef.current?.promoteMember(id),
            onOpenSyndicateMenu: () => {
                console.log('Opening Syndicate Menu...');
                // Callback for future integration
            }
        }),
        activeMenu === 'find' && React.createElement(FindMenu, { 
            gameState: gameState, 
            onClose: () => setActiveMenu(null),
            onJump: handleJump
        }),
        activePanel === 'portraitPicker' && React.createElement(PortraitPicker, { 
            onClose: () => setActivePanel(null) 
        }),

        activeFittingSlot && React.createElement(FittingSelectMenu, {
            slot: activeFittingSlot,
            equipped: (activeFittingSlot.type === 'outfit' ? gameState.commanderOutfit[activeFittingSlot.id] : 
                       (activeFittingSlot.type === 'implant' ? gameState.commanderImplants[activeFittingSlot.id] : 
                        gameState.fittings[activeFittingSlot.id])),
            inventory: [
                ...gameState.inventory.map(i => ({ ...i, location: 'cargo' })),
                ...(isDocked && SYSTEM_TO_STARPORT[gameState.currentSystem?.id] ? (gameState.storage[SYSTEM_TO_STARPORT[gameState.currentSystem?.id]] || []).map(i => ({ ...i, location: 'storage' })) : [])
            ].filter(item => {
                if (activeFittingSlot.type === 'weapon') {
                    return item.type === 'weapon' || item.type === 'mining';
                }
                if (activeFittingSlot.type === 'active') {
                    // Core slots allow Shields and other Active components (Drones moved to Utility)
                    return item.type === 'active' || item.type === 'shield';
                }
                if (activeFittingSlot.type === 'passive') {
                    // Utility slots allow Thrusters, Passive components, and all Drone modules
                    return item.type === 'passive' || item.type === 'thruster' || item.type === 'drone-module';
                }
                return item.type === activeFittingSlot.type;
            }),
            onSelect: handleInstallFitting,
            onUnfit: handleUnfitFitting,
            onToggleGroup: handleToggleWeaponGroup,
            onClose: () => setActiveFittingSlot(null),
            gameState: gameState,
            isDocked: isDocked
        }),

        gameState.jumpDrive.active && React.createElement(JumpOverlay, {
            remaining: gameState.jumpDrive.remaining,
            progress: gameState.jumpDrive.progress
        }),

        securityError && React.createElement(SecurityAlert, {
            message: securityError,
            onClose: () => setSecurityError(null)
        }),

        fittingWarning && React.createElement(FittingWarning, {
            warning: fittingWarning,
            onClose: () => setFittingWarning(null)
        }),

        // Action Buttons Area (Bottom Right)
        React.createElement('div', {
            style: {
                position: 'absolute',
                bottom: '40px',
                right: '40px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: '12px',
                pointerEvents: 'none',
                zIndex: 10
            }
        },
            // Auxiliary Layer (Engines, Shields, and Fittings)
            React.createElement('div', {
                style: {
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'flex-end',
                    gap: '10px',
                    maxWidth: '220px', // Allow wrapping if many slots
                    marginRight: '15px' 
                }
            },
                Object.keys(gameState.fittings)
                    .filter(slotId => {
                        const module = gameState.fittings[slotId];
                        // Only show active and passive utility slots that have a module fitted
                        return module && (slotId.startsWith('active') || slotId.startsWith('passive'));
                    })
                    .map(slotId => {
                        const module = gameState.fittings[slotId];
                        
                        return React.createElement(ActionButton, {
                            key: slotId,
                            slotId: slotId,
                            size: 42,
                            iconSize: 20,
                            module: module,
                            cooldown: 0,
                            weaponState: gameState.weaponStates ? gameState.weaponStates[slotId] : null,
                            active: gameState.activeWeapons[slotId],
                            onTrigger: (mod) => {
                                setGameState(prev => ({ ...prev,
                                    activeWeapons: { 
                                        ...prev.activeWeapons, 
                                        [slotId]: !prev.activeWeapons[slotId] 
                                    }
                                }));
                            },
                            onToggleGroup: handleToggleWeaponGroup,
                            onRelease: null
                        });
                    })
            ),

            // Primary Layer (Weapons)
            React.createElement('div', {
                style: {
                    display: 'flex',
                    gap: '20px'
                }
            },
                Object.keys(gameState.fittings)
                    .filter(slotId => {
                        const module = gameState.fittings[slotId];
                        return (slotId.startsWith('weapon') || slotId.startsWith('mining')) && module;
                    })
                    .map(slotId => (
                        React.createElement(ActionButton, {
                            key: slotId,
                            slotId: slotId,
                            size: 72,
                            module: gameState.fittings[slotId],
                            cooldown: gameState.cooldowns[slotId] || 0,
                            weaponState: gameState.weaponStates ? gameState.weaponStates[slotId] : null,
                            active: gameState.activeWeapons[slotId],
                            onTrigger: (mod) => {
                                setGameState(prev => ({ ...prev,
                                    activeWeapons: { 
                                        ...prev.activeWeapons, 
                                        [slotId]: !prev.activeWeapons[slotId] 
                                    }
                                }));
                            },
                            onToggleGroup: handleToggleWeaponGroup,
                            onRelease: null
                        })
                    ))
            )
        ),

        // Global Overlays
        showDestroyedButton && React.createElement('button', {
            onClick: () => {
                setShowDestroyedButton(false);
                setIsShipDestroyed(true);
            },
            style: {
                position: 'absolute',
                top: '220px',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                padding: '6px 24px',
                background: 'rgba(150, 0, 0, 0.9)',
                border: '2px solid #ff4444',
                color: '#fff',
                fontSize: '16px',
                fontWeight: 'bold',
                letterSpacing: '4px',
                cursor: 'default',
                zIndex: 10001,
                boxShadow: '0 0 25px rgba(255, 0, 0, 0.5)',
                fontFamily: 'monospace',
                pointerEvents: 'auto',
                animation: 'destructionPulse 1s infinite alternate'
            }
        }, 'DESTROYED'),

        // --- CHAT WINDOW ---
        React.createElement(ChatWindow, {
            messages: chatMessages.filter(m => {
                if (chatChannel === 'SYSTEM') {
                    return m.channel === 'SYSTEM' && m.systemId === gameState.currentSystem?.id;
                }
                if (chatChannel === 'FLEET') {
                    // Only show messages from players in our current fleet roster
                    const fleetMemberIds = gameState.fleet.map(member => member.id);
                    return m.channel === 'FLEET' && (fleetMemberIds.includes(m.userId) || m.userId === 'local');
                }
                return m.channel === chatChannel;
            }),
            onSendMessage: handleSendChatMessage,
            currentChannel: chatChannel,
            onSetChannel: setChatChannel,
            systemName: gameState.currentSystem?.name?.toUpperCase() || 'UNKNOWN',
            messageDraft: messageDraft,
            onClearDraft: () => setMessageDraft('')
        }),

        battlegroundExtractState && React.createElement(BattlegroundCompleteOverlay, { state: battlegroundExtractState }),
        battlegroundFailState && React.createElement(BattlegroundFailOverlay, { state: battlegroundFailState, onRespawn: handleBattlegroundFailRespawn }),
        React.createElement(BattlegroundBlackoutOverlay, battlegroundRespawnFade),
        isShipDestroyed && React.createElement(ShipDestroyedOverlay, { 
            summary: destructionSummary, 
            onRespawn: handleRespawn 
        }),
        showStarMap && !isArenaCurrent && !isBattlegroundCurrent && React.createElement(StarMap, {
            currentSystemId: gameState.currentSystem?.id,
            isLeapMode: isLeapMode,
            initialView: initialStarMapView,
            onJump: handleInterstellarJump,
            onClose: () => {
                setShowStarMap(false);
                setIsLeapMode(false);
            }
        }),
        showLoading && React.createElement(LoadingScreen, {
            fadeOut: loadingFadeOut,
            steps: loadingSteps,
            title: loadingScreenTitle,
            actionLabel: null,
            onAction: null,
            footerLabel: (arenaIntroPending && loadingScreenTitle === 'ARENA')
                ? (arenaIntroCanContinue
                    ? React.createElement('span', { style: { color: '#00ccff' } }, 'CLICK TO CONTINUE')
                    : 'PREPARING ARENA')
                : ((battlegroundIntroPending && loadingScreenTitle === 'BATTLEGROUND')
                    ? (battlegroundIntroCanContinue
                        ? React.createElement('span', { style: { color: '#00ccff' } }, 'CLICK TO CONTINUE')
                        : 'PREPARING BATTLEGROUND')
                    : 'INITIALIZING PERSISTENCE LAYER'),
            staticTitle: ((arenaIntroPending && loadingScreenTitle === 'ARENA') || (battlegroundIntroPending && loadingScreenTitle === 'BATTLEGROUND'))
        })
        )
    );
}