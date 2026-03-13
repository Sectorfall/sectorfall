import { getTradeItemDisplayName, getTradeItemIdentifier } from './tradeHelpers.js';

export async function createTradeListingTransaction({ MarketSystem, cloudService, item, price, quantity, currentStarportId, userId }) {
    await MarketSystem.createSellOrder(
        getTradeItemIdentifier(item),
        quantity,
        parseFloat(price),
        currentStarportId,
        item
    );

    const updatedStorage = await cloudService.getInventoryState(userId, currentStarportId);
    return {
        updatedStorageItems: updatedStorage?.items || [],
        successMessage: `Listed ${quantity}x ${getTradeItemDisplayName(item)} for ${price} Cr/unit.`
    };
}

export async function buyTradeListingTransaction({ MarketSystem, cloudService, listing, quantity, buyerId, currentStarportId }) {
    const marketResult = await MarketSystem.buyListing(listing.id, buyerId, currentStarportId, quantity);
    const updatedStorage = await cloudService.getInventoryState(buyerId, currentStarportId);
    return {
        marketResult,
        updatedStorageItems: updatedStorage?.items || [],
        successMessage: `Purchased ${getTradeItemDisplayName(listing?.item || listing)} for ${listing.price} Cr.`
    };
}

export async function createTradeBuyOrderTransaction({ MarketSystem, itemType, quantity, pricePerUni, currentStarportId }) {
    const marketResult = await MarketSystem.createBuyOrder(itemType, quantity, pricePerUni, currentStarportId);
    const refreshedMarket = await MarketSystem.fetchMarketData(currentStarportId, 'buy_orders');
    return {
        marketResult,
        buyOrders: refreshedMarket?.buyOrders || [],
        successMessage: `Posted Buy Order for ${quantity}x ${String(itemType || '').toUpperCase()}.`
    };
}

export async function cancelTradeListingTransaction({ MarketSystem, cloudService, listingId, currentStarportId, userId }) {
    await MarketSystem.cancelSellOrder(listingId);
    const updatedStorage = await cloudService.getInventoryState(userId, currentStarportId);
    return {
        updatedStorageItems: updatedStorage?.items || [],
        successMessage: 'Market listing cancelled. Item returned to regional storage.'
    };
}
