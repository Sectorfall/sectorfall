import { buildFabricationIngredientPayload, resolveFabricationBlueprintId, getFabricationErrorMessage, getFabricationSuccessMessage } from './fabricationHelpers.js';

export function buildFabricationRequestPayload({ starportId, blueprintData, blueprintItem, ingredients }) {
    return {
        starportId,
        blueprintInstanceId: blueprintItem.id,
        blueprintId: resolveFabricationBlueprintId(blueprintData),
        ingredients: buildFabricationIngredientPayload(ingredients)
    };
}

export function buildFabricationStateUpdate({ prev, result, starportId, hydrateItem, hydrateVessel }) {
    const nextInventory = (Array.isArray(result.cargoItems) ? result.cargoItems : (Array.isArray(result.cargo) ? result.cargo : prev.inventory)).map(item => hydrateItem(item));
    const nextStorage = (Array.isArray(result.storageItems) ? result.storageItems : (Array.isArray(result.storage) ? result.storage : (prev.storage?.[starportId] || []))).map(item => hydrateItem(item));
    const nextOwnedShips = Array.isArray(result.ownedShips)
        ? result.ownedShips.map(ship => hydrateVessel(ship, ship))
        : prev.ownedShips;
    const nextCargoWeight = nextInventory.reduce((sum, item) => sum + (parseFloat(item.weight) || 0), 0);

    return {
        nextInventory,
        nextStorage,
        nextOwnedShips,
        nextCargoWeight,
        nextState: {
            ...prev,
            inventory: nextInventory,
            storage: starportId ? { ...prev.storage, [starportId]: nextStorage } : prev.storage,
            ownedShips: nextOwnedShips,
            currentCargoWeight: nextCargoWeight,
            credits: typeof result?.commanderState?.credits === 'number' ? result.commanderState.credits : prev.credits
        }
    };
}



export async function executeFabricationTransaction({
    backendSocket,
    buildRequestPayload,
    buildStateUpdate,
    starportId,
    blueprintData,
    blueprintItem,
    ingredients,
    avgQL,
    setGameState,
    hydrateItem,
    hydrateVessel,
    showNotification
}) {
    const result = await backendSocket.requestFabricateBlueprint(buildRequestPayload({
        starportId,
        blueprintData,
        blueprintItem,
        ingredients
    }));

    if (!result) {
        showNotification('FABRICATION FAILED: Backend timeout.', 'error');
        return { ok: false, error: 'timeout' };
    }

    if (!result.ok) {
        showNotification(getFabricationErrorMessage(result.error), 'error');
        return result;
    }

    setGameState(prev => buildStateUpdate({
        prev,
        result,
        starportId,
        hydrateItem,
        hydrateVessel
    }).nextState);

    if (result?.commanderState && typeof result.commanderState.credits === 'number') {
        window.dispatchEvent(new CustomEvent('sectorfall:commander_state', { detail: result.commanderState }));
    }

    showNotification(getFabricationSuccessMessage(result, blueprintData, avgQL), 'success');
    return result;
}

export function buildRefineryRequestPayload({ starportId, item, source, filteredIndex = -1, inventory = [], stationStorage = [] }) {
    const sourceKey = String(source || '').trim().toLowerCase() === 'ship' ? 'ship' : 'storage';
    const sourceItems = sourceKey === 'ship'
        ? (Array.isArray(inventory) ? inventory.filter(i => i?.type === 'resource' && !i?.isRefined) : [])
        : (Array.isArray(stationStorage) ? stationStorage.filter(i => i?.type === 'resource' && !i?.isRefined) : []);
    const selectedItem = sourceItems[filteredIndex] || item || null;

    return {
        starportId,
        itemId: selectedItem?.id || item?.id || null,
        source: sourceKey
    };
}

export function buildRefineryStateUpdateFromResult({ prev, result, starportId, hydrateItem }) {
    const nextInventory = (Array.isArray(result?.cargo) ? result.cargo : prev.inventory).map(entry => hydrateItem(entry));
    const nextStorage = (Array.isArray(result?.storage) ? result.storage : (prev.storage?.[starportId] || [])).map(entry => hydrateItem(entry));
    const nextCargoWeight = nextInventory.reduce((sum, cargoItem) => sum + (parseFloat(cargoItem.weight) || 0), 0);

    return {
        nextInventory,
        nextStorage,
        nextCargoWeight,
        nextState: {
            ...prev,
            inventory: nextInventory,
            storage: starportId ? { ...prev.storage, [starportId]: nextStorage } : prev.storage,
            currentCargoWeight: nextCargoWeight
        }
    };
}
