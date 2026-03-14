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
    const nextOwnedShipsBase = Array.isArray(result?.commanderState?.owned_ships)
        ? result.commanderState.owned_ships.map(ship => hydrateVessel(ship, ship))
        : prev.ownedShips;
    const nextActiveShipStats = result?.active_ship_stats || null;
    const nextCombatStats = nextActiveShipStats?.combat_stats || nextActiveShipStats?.combatStats || prev.combat_stats || prev.combatStats;

    const resolvedMaxHp = Number.isFinite(nextActiveShipStats?.maxHp)
        ? nextActiveShipStats.maxHp
        : (Number.isFinite(nextCombatStats?.maxHp) ? nextCombatStats.maxHp : prev.maxHp);
    const resolvedMaxShields = Number.isFinite(nextActiveShipStats?.maxShields)
        ? nextActiveShipStats.maxShields
        : (Number.isFinite(nextCombatStats?.maxShields) ? nextCombatStats.maxShields : prev.maxShields);
    const resolvedMaxEnergy = Number.isFinite(nextActiveShipStats?.maxEnergy)
        ? nextActiveShipStats.maxEnergy
        : (Number.isFinite(nextCombatStats?.maxEnergy) ? nextCombatStats.maxEnergy : prev.maxEnergy);

    let resolvedShields = Number.isFinite(nextActiveShipStats?.shields) ? nextActiveShipStats.shields : prev.shields;
    if (resolvedMaxShields > 0 && !(prev.maxShields > 0) && !(resolvedShields > 0)) {
        resolvedShields = resolvedMaxShields;
    }

    const activeShipKey = prev.activeShipId;
    const nextOwnedShips = Array.isArray(nextOwnedShipsBase)
        ? nextOwnedShipsBase.map((ship) => {
            if (!ship || ship.id !== activeShipKey) return ship;
            return {
                ...ship,
                hp: Number.isFinite(nextActiveShipStats?.hp) ? nextActiveShipStats.hp : ship.hp,
                maxHp: resolvedMaxHp,
                shields: resolvedShields,
                maxShields: resolvedMaxShields,
                energy: Number.isFinite(nextActiveShipStats?.energy) ? nextActiveShipStats.energy : ship.energy,
                maxEnergy: resolvedMaxEnergy,
                armor: Number.isFinite(nextCombatStats?.armor) ? nextCombatStats.armor : ship.armor,
                resistances: nextCombatStats?.resistances || ship.resistances,
                combat_stats: nextCombatStats || ship.combat_stats,
                combatStats: nextCombatStats || ship.combatStats,
                fittings: nextActiveShipStats?.fittings || ship.fittings,
                kineticRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.kinetic || 0) : ship.kineticRes,
                thermalRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.thermal || 0) : ship.thermalRes,
                blastRes: nextCombatStats?.resistances ? Number(nextCombatStats.resistances.blast || 0) : ship.blastRes
            };
        })
        : nextOwnedShipsBase;

    return {
        ...prev,
        inventory: nextInventory,
        storage: { ...(prev.storage || {}), [starportId]: nextStorageItems },
        ownedShips: nextOwnedShips,
        currentCargoWeight: nextCargoWeight,
        fittings: nextActiveShipStats?.fittings || prev.fittings,
        hp: Number.isFinite(nextActiveShipStats?.hp) ? nextActiveShipStats.hp : prev.hp,
        maxHp: resolvedMaxHp,
        shields: resolvedShields,
        maxShields: resolvedMaxShields,
        energy: Number.isFinite(nextActiveShipStats?.energy) ? nextActiveShipStats.energy : prev.energy,
        maxEnergy: resolvedMaxEnergy,
        combat_stats: nextCombatStats,
        combatStats: nextCombatStats,
        armor: Number.isFinite(nextCombatStats?.armor) ? nextCombatStats.armor : prev.armor,
        resistances: nextCombatStats?.resistances || prev.resistances,
        maxPowerGrid: Number.isFinite(nextCombatStats?.powergrid) ? nextCombatStats.powergrid : prev.maxPowerGrid,
        maxCpu: Number.isFinite(nextCombatStats?.cpu) ? nextCombatStats.cpu : prev.maxCpu,
        currentLiveShipId: nextCombatStats?.shipId || prev.currentLiveShipId,
        shipId: nextCombatStats?.shipId || prev.shipId
    };
}
