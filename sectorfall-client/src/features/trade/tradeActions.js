import { getTradeItemDisplayName, getTradeItemIdentifier } from './tradeHelpers.js';

export async function createTradeListingTransaction({ MarketSystem, item, price, quantity, currentStarportId }) {
    const marketResult = await MarketSystem.createSellOrder(
        getTradeItemIdentifier(item),
        quantity,
        parseFloat(price),
        currentStarportId,
        item
    );

    return {
        marketResult,
        updatedStorageItems: Array.isArray(marketResult?.storageItems) ? marketResult.storageItems : [],
        successMessage: `Listed ${quantity}x ${getTradeItemDisplayName(item)} for ${price} Cr/unit.`
    };
}

export async function buyTradeListingTransaction({ MarketSystem, listing, quantity, buyerId, currentStarportId }) {
    const marketResult = await MarketSystem.buyListing(listing.id, buyerId, currentStarportId, quantity);
    return {
        marketResult,
        updatedStorageItems: Array.isArray(marketResult?.storageItems) ? marketResult.storageItems : [],
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

export async function cancelTradeListingTransaction({ MarketSystem, listingId, currentStarportId }) {
    const marketResult = await MarketSystem.cancelSellOrder(listingId, currentStarportId);
    return {
        marketResult,
        updatedStorageItems: Array.isArray(marketResult?.storageItems) ? marketResult.storageItems : [],
        successMessage: 'Market listing cancelled. Item returned to regional storage.'
    };
}
