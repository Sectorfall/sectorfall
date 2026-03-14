import { calculateCargoTotals } from './inventoryHelpers.js';

export function buildCargoTransferRequestPayload({ item, starportId, direction }) {
  return {
    starportId,
    itemId: String(item?.id || item?.instance_id || item?.instanceId || '').trim() || null,
    direction
  };
}

export function applyCargoTransferResult(prev, result, starportId) {
  const nextInventory = Array.isArray(result?.cargo) ? result.cargo : (Array.isArray(prev?.inventory) ? prev.inventory : []);
  const nextStationStorage = Array.isArray(result?.storage) ? result.storage : (prev?.storage?.[starportId] || []);
  const { weight: nextShipWeight, volume: nextShipVolume } = calculateCargoTotals(nextInventory);

  return {
    nextInventory,
    nextStationStorage,
    nextShipWeight,
    nextShipVolume,
    nextState: {
      ...prev,
      inventory: nextInventory,
      storage: { ...(prev?.storage || {}), [starportId]: nextStationStorage },
      currentCargoWeight: nextShipWeight,
      currentCargoVolume: nextShipVolume
    }
  };
}

export function syncDockedCargoToGameManager(gameManagerRef, nextInventory, nextShipWeight, nextShipVolume) {
  if (!gameManagerRef?.current) return;
  gameManagerRef.current.stats.currentCargoWeight = nextShipWeight;
  gameManagerRef.current.stats.currentCargoVolume = nextShipVolume;
  gameManagerRef.current.inventory = nextInventory;
}

export function getCargoTransferDirection(kind) {
  return kind === 'toShip' ? 'to_ship' : 'to_storage';
}

export function getCargoTransferErrorMessage(result, fallback = 'TRANSFER FAILED') {
  const code = String(result?.error || '').trim().toLowerCase();
  switch (code) {
    case 'not_docked':
      return 'TRANSFER FAILED: VESSEL MUST BE DOCKED AT STARPORT';
    case 'wrong_starport':
      return 'TRANSFER FAILED: WRONG STARPORT';
    case 'missing_item':
      return 'TRANSFER FAILED: ITEM ID MISSING';
    case 'item_not_found':
      return 'TRANSFER FAILED: ITEM NOT FOUND';
    case 'invalid_direction':
      return 'TRANSFER FAILED: INVALID TRANSFER DIRECTION';
    case 'persist_failed':
      return 'TRANSFER FAILED: BACKEND PERSIST FAILED';
    default:
      return fallback;
  }
}
