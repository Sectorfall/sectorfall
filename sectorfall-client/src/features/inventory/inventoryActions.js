import { mergeTransferredItemIntoList, removeSingleTransferredItemFromList, calculateCargoTotals } from './inventoryHelpers.js';

export function buildTransferToStationState(prev, item, starportId) {
  const nextInventory = removeSingleTransferredItemFromList(prev.inventory, item);
  const nextStationStorage = mergeTransferredItemIntoList(prev.storage[starportId] || [], item);
  const { weight: nextShipWeight, volume: nextShipVolume } = calculateCargoTotals(nextInventory);

  return {
    nextInventory,
    nextStationStorage,
    nextShipWeight,
    nextShipVolume,
    nextState: {
      ...prev,
      inventory: nextInventory,
      storage: { ...prev.storage, [starportId]: nextStationStorage },
      currentCargoWeight: nextShipWeight,
      currentCargoVolume: nextShipVolume
    }
  };
}

export function buildTransferToShipState(prev, item, starportId) {
  const nextStationStorage = removeSingleTransferredItemFromList(prev.storage[starportId] || [], item);
  const nextInventory = mergeTransferredItemIntoList(prev.inventory, item);
  const { weight: nextShipWeight, volume: nextShipVolume } = calculateCargoTotals(nextInventory);

  return {
    nextInventory,
    nextStationStorage,
    nextShipWeight,
    nextShipVolume,
    nextState: {
      ...prev,
      inventory: nextInventory,
      storage: { ...prev.storage, [starportId]: nextStationStorage },
      currentCargoWeight: nextShipWeight,
      currentCargoVolume: nextShipVolume
    }
  };
}

export function buildDockedCargoCloudPayload(prev, {
  nextInventory,
  currentSystemId,
  telemetry = {}
}) {
  const activeShipType = (prev.ownedShips || []).find(s => s.id === prev.activeShipId)?.type || prev.shipClass;

  return {
    ship_type: activeShipType,
    cargo: nextInventory,
    fittings: prev.fittings,
    system_id: currentSystemId,
    isDocked: true,
    telemetry: {
      ...telemetry,
      cargo: nextInventory,
      fittings: prev.fittings,
      system_id: currentSystemId,
      isDocked: true,
      docked: true
    }
  };
}
