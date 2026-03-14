export function applyCommanderInstallFittingState(prev, context) {
    const {
        item,
        activeFittingSlot,
        systemToStarport,
        getLiveShipResources,
        gameManager
    } = context;

    const fittingCategory = activeFittingSlot.type === 'outfit' ? 'commanderOutfit' : 'commanderImplants';
    const currentSystemId = prev.currentSystem?.id;
    const starportId = currentSystemId ? systemToStarport?.[currentSystemId] : null;

    const nextInventory = [...(prev.inventory || [])];
    const nextStorage = starportId ? [...(prev.storage?.[starportId] || [])] : [];
    const updateObj = {
        inventory: nextInventory,
        storage: starportId ? { ...(prev.storage || {}), [starportId]: nextStorage } : (prev.storage || {})
    };

    const nextCommanderFittings = { ...(prev[fittingCategory] || {}) };
    const oldItem = nextCommanderFittings[activeFittingSlot.id];
    if (oldItem) nextInventory.push(oldItem);

    if (item?.location === 'storage') {
        const storageIndex = nextStorage.findIndex(entry => entry?.id === item?.id);
        if (storageIndex > -1) nextStorage.splice(storageIndex, 1);
    } else {
        const itemIndex = nextInventory.findIndex(entry => entry?.id === item?.id);
        if (itemIndex > -1) nextInventory.splice(itemIndex, 1);
    }

    nextCommanderFittings[activeFittingSlot.id] = item;
    updateObj[fittingCategory] = nextCommanderFittings;

    const finalResources = getLiveShipResources(prev.fittings || {});
    updateObj.currentPowerGrid = finalResources.power;
    updateObj.currentCpu = finalResources.cpu;

    if (gameManager) {
        gameManager.syncFittings(prev.fittings || {});
    }

    return { ...prev, ...updateObj };
}

export function applyCommanderUnfitFittingState(prev, context) {
    const {
        slotId,
        activeFittingSlot,
        getLiveShipResources,
        gameManager
    } = context;

    const fittingCategory = activeFittingSlot.type === 'outfit' ? 'commanderOutfit' : 'commanderImplants';
    const nextInventory = [...(prev.inventory || [])];
    const updateObj = { inventory: nextInventory };

    const nextCommanderFittings = { ...(prev[fittingCategory] || {}) };
    const oldItem = nextCommanderFittings[slotId];
    if (!oldItem) return prev;

    nextInventory.push(oldItem);
    nextCommanderFittings[slotId] = null;
    updateObj[fittingCategory] = nextCommanderFittings;

    const finalResources = getLiveShipResources(prev.fittings || {});
    updateObj.currentPowerGrid = finalResources.power;
    updateObj.currentCpu = finalResources.cpu;

    if (gameManager) {
        gameManager.syncFittings(prev.fittings || {});
    }

    return { ...prev, ...updateObj };
}

export function applyAuthoritativeFittingResult(prev, context) {
    const {
        result,
        starportId,
        hydrateItem,
        hydrateVessel
    } = context;

    const nextInventory = Array.isArray(result?.cargo) ? result.cargo.map(entry => hydrateItem(entry)) : prev.inventory;
    const nextStorageItems = Array.isArray(result?.storage) ? result.storage.map(entry => hydrateItem(entry)) : (prev.storage?.[starportId] || []);
    const nextCargoWeight = nextInventory.reduce((sum, cargoItem) => sum + (parseFloat(cargoItem.weight) || 0), 0);
    const nextActiveShipStats = (result?.active_ship_stats && typeof result.active_ship_stats === 'object') ? result.active_ship_stats : null;
    const nextCombatStats = (nextActiveShipStats?.combat_stats && typeof nextActiveShipStats.combat_stats === 'object')
        ? nextActiveShipStats.combat_stats
        : ((nextActiveShipStats?.combatStats && typeof nextActiveShipStats.combatStats === 'object')
            ? nextActiveShipStats.combatStats
            : ((prev.combatStats && typeof prev.combatStats === 'object') ? prev.combatStats : prev.combat_stats));
    const nextFittings = (nextActiveShipStats?.fittings && typeof nextActiveShipStats.fittings === 'object')
        ? nextActiveShipStats.fittings
        : prev.fittings;
    const nextActiveShipId = result?.commanderState?.active_ship_id || prev.activeShipId;

    const nextOwnedShips = Array.isArray(result?.commanderState?.owned_ships)
        ? result.commanderState.owned_ships.map(ship => hydrateVessel(ship, ship)).map((ship) => {
            if (!ship || ship.id !== nextActiveShipId || !nextActiveShipStats) return ship;
            return {
                ...ship,
                hp: Number.isFinite(nextActiveShipStats?.hp) ? nextActiveShipStats.hp : ship.hp,
                maxHp: Number.isFinite(nextActiveShipStats?.maxHp) ? nextActiveShipStats.maxHp : (Number.isFinite(nextCombatStats?.maxHp) ? nextCombatStats.maxHp : ship.maxHp),
                shields: Number.isFinite(nextActiveShipStats?.shields) ? nextActiveShipStats.shields : ship.shields,
                maxShields: Number.isFinite(nextActiveShipStats?.maxShields) ? nextActiveShipStats.maxShields : (Number.isFinite(nextCombatStats?.maxShields) ? nextCombatStats.maxShields : ship.maxShields),
                energy: Number.isFinite(nextActiveShipStats?.energy) ? nextActiveShipStats.energy : ship.energy,
                maxEnergy: Number.isFinite(nextActiveShipStats?.maxEnergy) ? nextActiveShipStats.maxEnergy : (Number.isFinite(nextCombatStats?.maxEnergy) ? nextCombatStats.maxEnergy : ship.maxEnergy),
                armor: Number.isFinite(nextActiveShipStats?.armor) ? nextActiveShipStats.armor : (Number.isFinite(nextCombatStats?.armor) ? nextCombatStats.armor : ship.armor),
                resistances: nextCombatStats?.resistances || ship.resistances,
                combat_stats: nextCombatStats || ship.combat_stats,
                combatStats: nextCombatStats || ship.combatStats,
                fittings: nextFittings || ship.fittings,
                kineticRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.kinetic || 0) : ship.kineticRes,
                thermalRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.thermal || 0) : ship.thermalRes,
                blastRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.blast || 0) : ship.blastRes
            };
        })
        : prev.ownedShips;

    return {
        ...prev,
        inventory: nextInventory,
        storage: { ...(prev.storage || {}), [starportId]: nextStorageItems },
        ownedShips: nextOwnedShips,
        currentCargoWeight: nextCargoWeight,
        activeShipId: nextActiveShipId,
        fittings: nextFittings,
        hp: Number.isFinite(nextActiveShipStats?.hp) ? nextActiveShipStats.hp : prev.hp,
        maxHp: Number.isFinite(nextActiveShipStats?.maxHp) ? nextActiveShipStats.maxHp : (Number.isFinite(nextCombatStats?.maxHp) ? nextCombatStats.maxHp : prev.maxHp),
        shields: Number.isFinite(nextActiveShipStats?.shields) ? nextActiveShipStats.shields : prev.shields,
        maxShields: Number.isFinite(nextActiveShipStats?.maxShields) ? nextActiveShipStats.maxShields : (Number.isFinite(nextCombatStats?.maxShields) ? nextCombatStats.maxShields : prev.maxShields),
        energy: Number.isFinite(nextActiveShipStats?.energy) ? nextActiveShipStats.energy : prev.energy,
        maxEnergy: Number.isFinite(nextActiveShipStats?.maxEnergy) ? nextActiveShipStats.maxEnergy : (Number.isFinite(nextCombatStats?.maxEnergy) ? nextCombatStats.maxEnergy : prev.maxEnergy),
        combat_stats: nextCombatStats,
        combatStats: nextCombatStats,
        armor: Number.isFinite(nextActiveShipStats?.armor) ? nextActiveShipStats.armor : (Number.isFinite(nextCombatStats?.armor) ? nextCombatStats.armor : prev.armor),
        resistances: nextCombatStats?.resistances || prev.resistances,
        maxPowerGrid: Number.isFinite(nextCombatStats?.powergrid) ? nextCombatStats.powergrid : prev.maxPowerGrid,
        maxCpu: Number.isFinite(nextCombatStats?.cpu) ? nextCombatStats.cpu : prev.maxCpu,
        currentLiveShipId: nextActiveShipId || prev.currentLiveShipId,
        shipId: nextActiveShipId || prev.shipId,
        kineticRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.kinetic || 0) : prev.kineticRes,
        thermalRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.thermal || 0) : prev.thermalRes,
        blastRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.blast || 0) : prev.blastRes
    };
}
