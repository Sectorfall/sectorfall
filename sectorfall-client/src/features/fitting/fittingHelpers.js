import { hydrateItem } from '../../GameManager.js';

export const getModuleResourceUsage = (module) => {
    if (!module) return { power: 0, cpu: 0 };
    const finalStats = (module.final_stats && typeof module.final_stats === 'object') ? module.final_stats : null;
    if (!finalStats) return { power: 0, cpu: 0 };
    return {
        power: Number(finalStats.power || 0),
        cpu: Number(finalStats.cpu || 0)
    };
};

export const getLiveShipResources = (fittings) => {
    let power = 0;
    let cpu = 0;
    Object.values(fittings || {}).forEach(mod => {
        if (!mod) return;
        const usage = getModuleResourceUsage(mod);
        power += usage.power;
        cpu += usage.cpu;
    });
    return { power, cpu };
};

export const getSlotClass = (slotId) => {
    const id = String(slotId || '').toLowerCase();
    if (id.startsWith('weapon')) return 'weapon';
    if (id.startsWith('rig')) return 'rig';
    if (id.startsWith('synapse')) return 'synapse';
    if (id.startsWith('active')) return 'core';
    if (id.startsWith('passive')) return 'utility';
    return 'utility';
};

export const getItemSlotClass = (item) => {
    if (!item) return null;
    const t = String(item.type || '').toLowerCase();
    const st = String(item.subtype || '').toLowerCase();
    const n = String(item.name || '').toLowerCase();

    if (t === 'blueprint' || t === 'resource' || t === 'bio-material' || t === 'catalyst') return null;

    if (t === 'drone-module' || n.includes('drone')) return 'utility';

    if (t === 'weapon' || t === 'mining' || st.includes('laser') || st.includes('cannon') || st.includes('missile') || n.includes('flux') || n.includes('pulse') || n.includes('seeker') || n.includes('mining')) {
        return 'weapon';
    }

    if (t === 'shield' || n.includes('shield')) return 'core';

    if (t === 'thruster' || n.includes('thruster')) return 'utility';

    if (t === 'rig' || n.includes('rig')) return 'rig';

    if (t === 'synapse' || st.includes('synapse') || n.includes('synapse')) return 'synapse';

    return 'utility';
};

export const normalizeModuleFamilyKey = (value = '') => {
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

export const normalizeModuleSizeKey = (value = '') => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 's' || raw === 'small') return 's';
    if (raw === 'm' || raw === 'medium') return 'm';
    if (raw === 'l' || raw === 'large') return 'l';
    return raw ? raw.slice(0, 1) : '';
};

export const normalizeModuleRarityKey = (value = '') => {
    const raw = String(value || '').trim().toLowerCase();
    for (const rarity of ['legendary', 'epic', 'rare', 'uncommon', 'common']) {
        if (raw === rarity || raw.includes(rarity)) return rarity;
    }
    return raw;
};

export const deriveCanonicalModuleId = (item = null) => {
    if (!item || typeof item !== 'object') return '';
    if (item.module_id) return item.module_id;
    const family = normalizeModuleFamilyKey(item.subtype || item.type || item.itemKey || item.item_id || item.name || '');
    const size = normalizeModuleSizeKey(item.size || item.weaponsize || '');
    const rarity = normalizeModuleRarityKey(item.rarity || '');
    if (!family || !size || !rarity) return '';
    return `module_${family}_${size}_${rarity}`;
};

export const normalizeFittedModuleIdentity = (item = null) => {
    if (!item || typeof item !== 'object') return item;
    const canonicalModuleId = deriveCanonicalModuleId(item);
    if (!canonicalModuleId) return item;
    return {
        ...item,
        module_id: canonicalModuleId,
        canonical_output_id: item.canonical_output_id || canonicalModuleId
    };
};

export const hydrateFittedModule = (item = null) => {
    if (!item || typeof item !== 'object') return item;
    return normalizeFittedModuleIdentity(hydrateItem({ ...item }));
};

export const canFit = ({ item, slotId, shipConfig, currentFittings, maxPG = 0, maxCPU = 0 }) => {
    if (!item || !slotId) return { ok: false, reason: 'No module/slot selected.' };

    const slotClass = getSlotClass(slotId);
    const itemClass = getItemSlotClass(item);

    if (!itemClass) {
        return { ok: false, reason: 'That item cannot be fitted to a ship.' };
    }

    if (slotClass !== itemClass) {
        return { ok: false, reason: `Slot mismatch: ${slotClass.toUpperCase()} slot cannot accept ${itemClass.toUpperCase()} modules.` };
    }

    const size = item.size || item.weaponsize;
    if (slotClass === 'weapon' && shipConfig?.recommendedWeaponSizes && size) {
        const rec = shipConfig.recommendedWeaponSizes;
        if (Array.isArray(rec) && rec.length && !rec.includes(size)) {
            // Oversize/undersize remains warning-only elsewhere.
        }
    }

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
