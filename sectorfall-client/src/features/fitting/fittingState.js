import { useState } from 'react';

export function useFittingState() {
    const [activeFittingSlot, setActiveFittingSlot] = useState(null);

    return {
        activeFittingSlot,
        setActiveFittingSlot,
        clearActiveFittingSlot: () => setActiveFittingSlot(null)
    };
}

export function getEquippedFittingItem(gameState, slot) {
    if (!slot) return null;
    if (slot.type === 'outfit') return gameState?.commanderOutfit?.[slot.id] || null;
    if (slot.type === 'implant') return gameState?.commanderImplants?.[slot.id] || null;
    return gameState?.fittings?.[slot.id] || null;
}

export function getFittingInventoryItems({ activeFittingSlot, gameState, isDocked, systemToStarport }) {
    if (!activeFittingSlot) return [];

    const currentSystemId = gameState?.currentSystem?.id;
    const starportId = systemToStarport?.[currentSystemId];
    const cargoItems = (gameState?.inventory || []).map(item => ({ ...item, location: 'cargo' }));
    const storageItems = (isDocked && starportId)
        ? ((gameState?.storage?.[starportId] || []).map(item => ({ ...item, location: 'storage' })))
        : [];

    return [...cargoItems, ...storageItems].filter(item => {
        if (activeFittingSlot.type === 'weapon') {
            return item.type === 'weapon' || item.type === 'mining';
        }
        if (activeFittingSlot.type === 'active') {
            return item.type === 'active' || item.type === 'shield';
        }
        if (activeFittingSlot.type === 'passive') {
            return item.type === 'passive' || item.type === 'thruster' || item.type === 'drone-module';
        }
        return item.type === activeFittingSlot.type;
    });
}

export function buildFittingSelectMenuProps({
    activeFittingSlot,
    gameState,
    isDocked,
    systemToStarport,
    onSelect,
    onUnfit,
    onToggleGroup,
    onClose
}) {
    return {
        slot: activeFittingSlot,
        equipped: getEquippedFittingItem(gameState, activeFittingSlot),
        inventory: getFittingInventoryItems({ activeFittingSlot, gameState, isDocked, systemToStarport }),
        onSelect,
        onUnfit,
        onToggleGroup,
        onClose,
        gameState,
        isDocked
    };
}
