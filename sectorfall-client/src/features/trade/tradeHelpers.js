export function getCurrentTradeStarportId(currentSystemId, systemToStarport) {
    if (!currentSystemId || !systemToStarport) return null;
    return systemToStarport[currentSystemId] || null;
}

export function getTradeItemIdentifier(item) {
    return item?.item_id || item?.type || item?.id || null;
}

export function getTradeItemDisplayName(item) {
    return item?.name || item?.item_type || item?.type || 'item';
}

export function buildTradeStorageState(prev, currentStarportId, updatedStorageItems, hydrateItem) {
    if (!currentStarportId) return prev;
    const rawItems = Array.isArray(updatedStorageItems) ? updatedStorageItems : [];
    return {
        ...prev,
        storage: {
            ...prev.storage,
            [currentStarportId]: rawItems.map(hydrateItem)
        }
    };
}

export function getCommanderCreditsFromResult(result, fallbackCredits) {
    return typeof result?.commanderState?.credits === 'number'
        ? result.commanderState.credits
        : fallbackCredits;
}
