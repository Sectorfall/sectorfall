export function applyInstallFittingState(prev, context) {
    const {
        item,
        activeFittingSlot,
        cloudUserId,
        systemToStarport,
        hydrateFittedModule,
        getLiveShipResources,
        cloudService,
        gameManager
    } = context;

    const isCommanderFitting = activeFittingSlot.type === 'outfit' || activeFittingSlot.type === 'implant';
    const fittingCategory = activeFittingSlot.type === 'outfit' ? 'commanderOutfit' : 'commanderImplants';
    const currentSystemId = prev.currentSystem?.id;
    const starportId = systemToStarport[currentSystemId];

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
        if (oldItem) nextInventory.push(oldItem);

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
        updateObj.ownedShips = prev.ownedShips.map(ship =>
            ship.id === prev.activeShipId ? { ...ship, fittings: nextFittings } : ship
        );

        const finalResources = getLiveShipResources(nextFittings);
        updateObj.currentPowerGrid = finalResources.power;
        updateObj.currentCpu = finalResources.cpu;

        if (gameManager) {
            gameManager.syncFittings(nextFittings);
        }
    }

    if (cloudUserId) {
        if (starportId) {
            cloudService.saveInventoryState(cloudUserId, starportId, nextStorage, 'handleInstallFitting_storage');
        }

        const nextOwnedShips = updateObj.ownedShips || prev.ownedShips;
        cloudService.updateCommanderData(cloudUserId, {
            owned_ships: nextOwnedShips,
            active_ship_id: prev.activeShipId
        });

        cloudService.saveToCloud(cloudUserId, starportId, {
            ship_type: (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass,
            telemetry: {
                ...(gameManager?.getTelemetry() || {}),
                cargo: nextInventory,
                fittings: updateObj.fittings || prev.fittings
            }
        });
    }

    return { ...prev, ...updateObj };
}

export function applyUnfitFittingState(prev, context) {
    const {
        slotId,
        activeFittingSlot,
        cloudUserId,
        systemToStarport,
        getLiveShipResources,
        cloudService,
        gameManager
    } = context;

    const isCommanderFitting = activeFittingSlot.type === 'outfit' || activeFittingSlot.type === 'implant';
    const fittingCategory = activeFittingSlot.type === 'outfit' ? 'commanderOutfit' : 'commanderImplants';
    const currentSystemId = prev.currentSystem?.id;
    const starportId = systemToStarport[currentSystemId] || prev.homeStarport;

    let nextInventory = [...prev.inventory];
    let updateObj = { inventory: nextInventory };

    if (isCommanderFitting) {
        const nextCommanderFittings = { ...prev[fittingCategory] };
        const oldItem = nextCommanderFittings[slotId];
        if (!oldItem) return prev;
        nextInventory.push(oldItem);
        nextCommanderFittings[slotId] = null;
        updateObj[fittingCategory] = nextCommanderFittings;
    } else {
        const nextFittings = { ...prev.fittings };
        const oldItem = nextFittings[slotId];
        if (!oldItem) return prev;

        nextInventory.push(oldItem);
        nextFittings[slotId] = null;
        updateObj.fittings = nextFittings;
        updateObj.ownedShips = prev.ownedShips.map(ship =>
            ship.id === prev.activeShipId ? { ...ship, fittings: nextFittings } : ship
        );

        const finalResources = getLiveShipResources(nextFittings);
        updateObj.currentPowerGrid = finalResources.power;
        updateObj.currentCpu = finalResources.cpu;

        if (gameManager) {
            gameManager.syncFittings(nextFittings);
        }
    }

    if (cloudUserId) {
        const nextOwnedShips = updateObj.ownedShips || prev.ownedShips;
        cloudService.updateCommanderData(cloudUserId, {
            owned_ships: nextOwnedShips,
            active_ship_id: prev.activeShipId
        });

        cloudService.saveToCloud(cloudUserId, starportId, {
            ship_type: (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass,
            telemetry: {
                ...(gameManager?.getTelemetry() || {}),
                cargo: nextInventory,
                fittings: updateObj.fittings || prev.fittings
            }
        });
    }

    return { ...prev, ...updateObj };
}
