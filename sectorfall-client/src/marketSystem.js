import { cloudService } from './CloudService.js';
import { LocalStorageMarketProvider } from './LocalStorageMarketProvider.js';

function getBackendSocket() {
    return window.backendSocket || null;
}

function requireCommanderId() {
    const commanderId = cloudService.user?.id;
    if (!commanderId) throw new Error("Unauthorized: Commander ID missing.");
    return commanderId;
}

export const MarketSystem = {
    async fetchMarketData(starportId, filter) {
        const ws = getBackendSocket();
        if (ws?.requestMarketData) {
            const result = await ws.requestMarketData({ starportId, filter });
            if (!result?.ok) throw new Error(result?.error || 'Failed to fetch market data.');
            return filter === 'buy_orders'
                ? { buyOrders: Array.isArray(result.buyOrders) ? result.buyOrders : [] }
                : { listings: Array.isArray(result.listings) ? result.listings : [] };
        }
        return await LocalStorageMarketProvider.fetchMarketData(starportId, filter);
    },

    async createSellOrder(item_type, quantity, price_per_uni, starport_id, item_data = null) {
        requireCommanderId();
        const ws = getBackendSocket();
        if (ws?.requestCreateSellOrder) {
            console.log('[Market][Client] createSellOrder', {
                item_type,
                quantity,
                price_per_uni,
                starport_id,
                hasItemData: !!item_data,
                itemDataName: item_data?.name || null,
                itemDataType: item_data?.type || null
            });
            const result = await ws.requestCreateSellOrder({
                itemType: item_type,
                quantity,
                pricePerUnit: price_per_uni,
                starportId: starport_id,
                itemData: item_data
            });
            if (!result?.ok) throw new Error(result?.error || 'Failed to create sell order.');
            return result.listing || result;
        }
        const seller_id = cloudService.user?.id;
        return await LocalStorageMarketProvider.createSellOrder(item_type, quantity, price_per_uni, starport_id, seller_id);
    },

    async createBuyOrder(item_type, quantity, price_per_uni, starport_id) {
        requireCommanderId();
        const ws = getBackendSocket();
        if (ws?.requestCreateBuyOrder) {
            const result = await ws.requestCreateBuyOrder({ itemType: item_type, quantity, pricePerUnit: price_per_uni, starportId: starport_id });
            if (!result?.ok) throw new Error(result?.error || 'Failed to create buy order.');
            return result.order || result;
        }
        const buyer_id = cloudService.user?.id;
        return await LocalStorageMarketProvider.createBuyOrder(item_type, quantity, price_per_uni, starport_id, buyer_id);
    },

    async buyListing(listing_id, buyer_id, starport_id = null, quantity = 1) {
        requireCommanderId();
        const ws = getBackendSocket();
        if (ws?.requestBuyListing) {
            const result = await ws.requestBuyListing({ listingId: listing_id, quantity, starportId: starport_id });
            if (!result?.ok) throw new Error(result?.error || 'Failed to buy listing.');
            return result;
        }
        const commander_id = buyer_id || cloudService.user?.id;
        return await LocalStorageMarketProvider.buyListing(listing_id, commander_id);
    },

    async cancelSellOrder(listing_id, starport_id = null) {
        requireCommanderId();
        const ws = getBackendSocket();
        if (ws?.requestCancelSellOrder) {
            const result = await ws.requestCancelSellOrder({ listingId: listing_id, starportId: starport_id });
            if (!result?.ok) throw new Error(result?.error || 'Failed to cancel sell order.');
            return result;
        }
        return await LocalStorageMarketProvider.cancelSellOrder(listing_id, cloudService.user?.id);
    },

    async cancelBuyOrder(order_id, starport_id = null) {
        requireCommanderId();
        const ws = getBackendSocket();
        if (ws?.requestCancelBuyOrder) {
            const result = await ws.requestCancelBuyOrder({ orderId: order_id, starportId: starport_id });
            if (!result?.ok) throw new Error(result?.error || 'Failed to cancel buy order.');
            return result;
        }
        return await LocalStorageMarketProvider.cancelBuyOrder(order_id, cloudService.user?.id);
    },

    async seedNPCBlueprints(starport_id) {
        const ws = getBackendSocket();
        if (ws?.requestSeedNpcBlueprints) {
            const result = await ws.requestSeedNpcBlueprints({ starportId: starport_id });
            if (!result?.ok) throw new Error(result?.error || 'Failed to seed market vendor.');
            return result;
        }
        return await LocalStorageMarketProvider.seedNPCBlueprints(starport_id);
    }
};

export default MarketSystem;