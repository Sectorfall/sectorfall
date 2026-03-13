import { hydrateItem } from '../../GameManager.js';

const STACKABLE_TRANSFER_TYPES = new Set(['resource', 'material', 'blueprint', 'bio-material', 'ore']);

export const canItemsStackForTransfer = (a, b) => {
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

export const mergeTransferredItemIntoList = (items, rawItem) => {
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

export const removeSingleTransferredItemFromList = (items, rawItem) => {
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

export const calculateCargoTotals = (items) => {
  return (items || []).reduce((totals, item) => {
    totals.weight += parseFloat(item?.weight) || 0;
    totals.volume += parseFloat(item?.volume) || (parseFloat(item?.weight) * 1.5) || 0;
    return totals;
  }, { weight: 0, volume: 0 });
};
