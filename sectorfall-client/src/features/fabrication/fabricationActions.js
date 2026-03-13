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

function resolveSelectedRefineryItem({ sourceItems, filteredIndex, fallbackItem }) {
    return sourceItems[filteredIndex] || fallbackItem || null;
}

function resolveRefinedQuality(selectedItem) {
    if (selectedItem?.qlList?.length > 0) {
        const sum = selectedItem.qlList.reduce((a, b) => a + b, 0);
        return Number((sum / selectedItem.qlList.length).toFixed(1));
    }

    if (typeof selectedItem?.qlBand === 'string' && selectedItem.qlBand.includes('-')) {
        const parts = selectedItem.qlBand.split('-').map(p => parseInt(p.trim(), 10));
        if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            return Math.floor((parts[0] + parts[1]) / 2);
        }
    }

    const parsedBand = parseInt(selectedItem?.qlBand, 10);
    if (Number.isFinite(parsedBand)) {
        return parsedBand;
    }

    return 1;
}

export function buildRefineryStateUpdate({ prev, starportId, item, source, filteredIndex = -1, stationCapacity = 1000 }) {
    if (!starportId) {
        return { ok: false, error: 'not_docked' };
    }

    const currentStationCargo = prev.storage?.[starportId] || [];
    const nextInventory = [...prev.inventory];
    const nextStationStorage = [...currentStationCargo];

    const sourceItems = source === 'ship'
        ? nextInventory.filter(i => i.type === 'resource' && !i.isRefined)
        : nextStationStorage.filter(i => i.type === 'resource' && !i.isRefined);

    const selectedItem = resolveSelectedRefineryItem({
        sourceItems,
        filteredIndex,
        fallbackItem: item
    });

    if (!selectedItem) {
        return { ok: false, error: 'selected_item_not_found' };
    }

    const itemWeight = parseFloat(selectedItem.weight) || (Number(selectedItem.amount || 0) * 0.1);
    const currentStationWeight = currentStationCargo.reduce((sum, cargoItem) => sum + (parseFloat(cargoItem.weight) || 5), 0);

    if (currentStationWeight + itemWeight > stationCapacity) {
        return { ok: false, error: 'storage_capacity' };
    }

    const oreType = selectedItem.oreType || selectedItem.name.split(' [')[0].replace(/ Ore/i, '');
    const refinedName = `Refined ${oreType}`;
    const refinedQL = resolveRefinedQuality(selectedItem);
    const refinedAmount = Math.floor(Number(selectedItem.amount || 0) * 0.75);

    if (source === 'ship') {
        const selectedIndex = nextInventory.indexOf(selectedItem);
        if (selectedIndex === -1) {
            return { ok: false, error: 'ship_item_not_found' };
        }
        nextInventory.splice(selectedIndex, 1);
    } else {
        const selectedIndex = nextStationStorage.indexOf(selectedItem);
        if (selectedIndex === -1) {
            return { ok: false, error: 'storage_item_not_found' };
        }
        nextStationStorage.splice(selectedIndex, 1);
    }

    const existingInStorage = nextStationStorage.find(storageItem => (
        storageItem.isRefined &&
        storageItem.oreType === oreType &&
        storageItem.qlBand === refinedQL
    ));

    if (existingInStorage) {
        existingInStorage.amount += refinedAmount;
        existingInStorage.weight = (parseFloat(existingInStorage.weight) + itemWeight).toFixed(1);
    } else {
        nextStationStorage.push({
            id: `${refinedName}-Refined-QL-${refinedQL}-${Date.now()}`,
            name: `${refinedName} [QL ${refinedQL}]`,
            oreType,
            type: 'resource',
            isRefined: true,
            amount: refinedAmount,
            weight: itemWeight.toFixed(1),
            qlBand: refinedQL,
            rarity: selectedItem.rarity || 'common',
            description: `High-purity ${oreType}. Refined to an exact average quality of ${refinedQL} from ${selectedItem.qlList?.length || 'legacy'} raw units.`
        });
    }

    const nextShipWeight = nextInventory.reduce((sum, cargoItem) => sum + (parseFloat(cargoItem.weight) || 0), 0);

    return {
        ok: true,
        starportId,
        selectedItem,
        oreType,
        refinedName,
        refinedQL,
        refinedAmount,
        nextInventory,
        nextStationStorage,
        nextShipWeight,
        nextState: {
            ...prev,
            inventory: nextInventory,
            storage: { ...prev.storage, [starportId]: nextStationStorage },
            currentCargoWeight: nextShipWeight
        }
    };
}
