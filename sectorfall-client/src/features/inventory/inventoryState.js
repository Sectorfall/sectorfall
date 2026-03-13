import { useMemo, useState } from 'react';

const MODULE_FILTER_TYPES = new Set(['module', 'weapon', 'shield', 'thruster', 'mining']);

export function filterCargoItems(items, filter) {
  const cargoItems = Array.isArray(items) ? items : [];
  if (filter === 'everything') return cargoItems;
  if (filter === 'module') {
    return cargoItems.filter(item => MODULE_FILTER_TYPES.has(item?.type));
  }
  if (filter === 'bio-material') {
    return cargoItems.filter(item => item?.type === 'bio-material');
  }
  return cargoItems.filter(item => item?.type === filter);
}

export function calculateFilteredCargoWeight(items) {
  const cargoItems = Array.isArray(items) ? items : [];
  return cargoItems.reduce((sum, item) => sum + (Number(item?.weight) || 0), 0);
}

export function calculateCargoCapacityPercent(currentCargoWeight, cargoHold) {
  const current = Number(currentCargoWeight) || 0;
  const hold = Number(cargoHold) || 0;
  if (hold <= 0) return 0;
  return (current / hold) * 100;
}

export function useCargoMenuState(gameState) {
  const [selectedItem, setSelectedItem] = useState(null);
  const [filter, setFilterState] = useState('everything');

  const cargoItems = Array.isArray(gameState?.inventory) ? gameState.inventory : [];

  const filteredItems = useMemo(() => filterCargoItems(cargoItems, filter), [cargoItems, filter]);
  const filteredWeight = useMemo(() => calculateFilteredCargoWeight(filteredItems), [filteredItems]);
  const capacityPercent = useMemo(
    () => calculateCargoCapacityPercent(gameState?.currentCargoWeight, gameState?.cargoHold),
    [gameState?.currentCargoWeight, gameState?.cargoHold]
  );

  const setFilter = (nextFilter) => {
    setFilterState(nextFilter);
    setSelectedItem(null);
  };

  return {
    selectedItem,
    setSelectedItem,
    filter,
    setFilter,
    cargoItems,
    filteredItems,
    filteredWeight,
    capacityPercent
  };
}
