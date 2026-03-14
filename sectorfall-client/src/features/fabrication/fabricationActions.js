import { buildFabricationIngredientPayload, resolveFabricationBlueprintId } from './fabricationHelpers.js';

export function buildFabricationRequestPayload({ starportId, blueprintData, blueprintItem, ingredients }) {
    return {
        starportId,
        blueprintInstanceId: blueprintItem.id,
        blueprintId: resolveFabricationBlueprintId(blueprintData),
        ingredients: buildFabricationIngredientPayload(ingredients)
    };
}

export function buildFabricationStateUpdate({ prev, result, starportId, hydrateItem, hydrateVessel }) {
    const nextInventory = (Array.isArray(result.cargo) ? result.cargo : prev.inventory).map(item => hydrateItem(item));
    const nextStorage = (Array.isArray(result.storage) ? result.storage : (prev.storage?.[starportId] || [])).map(item => hydrateItem(item));
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


function resolveRefineryInstanceId(entry) {
    if (!entry || typeof entry !== 'object') return null;

    return entry.id
        || entry.instance_id
        || entry.instanceId
        || entry.item_instance_id
        || entry.itemInstanceId
        || null;
}

export function buildRefineryRequestPayload({ starportId, item, source, filteredIndex = -1, inventory = [], stationStorage = [] }) {
    const sourceKey = String(source || '').trim().toLowerCase() === 'ship' ? 'ship' : 'storage';
    const sourceItems = sourceKey === 'ship'
        ? (Array.isArray(inventory) ? inventory.filter(i => i?.type === 'resource' && !i?.isRefined) : [])
        : (Array.isArray(stationStorage) ? stationStorage.filter(i => i?.type === 'resource' && !i?.isRefined) : []);
    const selectedItem = sourceItems[filteredIndex] || item || null;
    const selectedItemId = resolveRefineryInstanceId(selectedItem) || resolveRefineryInstanceId(item);

    return {
        starportId,
        itemId: selectedItemId,
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
