import { cloudService } from './CloudService.js';

function getBackendSocket() {
    return window.backendSocket || null;
}

function requireCommanderId() {
    const commanderId = cloudService.user?.id;
    if (!commanderId) throw new Error("Unauthorized: Commander ID missing.");
    return commanderId;
}


function requireMarketBackend(ws) {
    if (!ws) {
        throw new Error('Market backend unavailable. Please reconnect and try again.');
    }
    return ws;
}

export const MarketSystem = {
    async fetchMarketData(starportId, filter) {
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestMarketData) {
            throw new Error('Market backend does not support market data requests.');
        }
        const result = await ws.requestMarketData({ starportId, filter });
        if (!result?.ok) throw new Error(result?.error || 'Failed to fetch market data.');
        return filter === 'buy_orders'
            ? { buyOrders: Array.isArray(result.buyOrders) ? result.buyOrders : [] }
            : { listings: Array.isArray(result.listings) ? result.listings : [] };
    },

    async createSellOrder(item_type, quantity, price_per_uni, starport_id, item_data = null) {
        requireCommanderId();
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestCreateSellOrder) {
            throw new Error('Market backend does not support sell order creation.');
        }
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
    },

    async createBuyOrder(item_type, quantity, price_per_uni, starport_id) {
        requireCommanderId();
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestCreateBuyOrder) {
            throw new Error('Market backend does not support buy order creation.');
        }
        const result = await ws.requestCreateBuyOrder({ itemType: item_type, quantity, pricePerUnit: price_per_uni, starportId: starport_id });
        if (!result?.ok) throw new Error(result?.error || 'Failed to create buy order.');
        return result.order || result;
    },

    async buyListing(listing_id, buyer_id, starport_id = null, quantity = 1) {
        requireCommanderId();
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestBuyListing) {
            throw new Error('Market backend does not support listing purchases.');
        }
        const result = await ws.requestBuyListing({ listingId: listing_id, quantity, starportId: starport_id });
        if (!result?.ok) throw new Error(result?.error || 'Failed to buy listing.');
        return result;
    },

    async cancelSellOrder(listing_id, starport_id = null) {
        requireCommanderId();
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestCancelSellOrder) {
            throw new Error('Market backend does not support sell order cancellation.');
        }
        const result = await ws.requestCancelSellOrder({ listingId: listing_id, starportId: starport_id });
        if (!result?.ok) throw new Error(result?.error || 'Failed to cancel sell order.');
        return result;
    },

    async cancelBuyOrder(order_id, starport_id = null) {
        requireCommanderId();
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestCancelBuyOrder) {
            throw new Error('Market backend does not support buy order cancellation.');
        }
        const result = await ws.requestCancelBuyOrder({ orderId: order_id, starportId: starport_id });
        if (!result?.ok) throw new Error(result?.error || 'Failed to cancel buy order.');
        return result;
    },

    async seedNPCBlueprints(starport_id) {
        const ws = requireMarketBackend(getBackendSocket());
        if (!ws.requestSeedNpcBlueprints) {
            throw new Error('Market backend does not support market seeding.');
        }
        const result = await ws.requestSeedNpcBlueprints({ starportId: starport_id });
        if (!result?.ok) throw new Error(result?.error || 'Failed to seed market vendor.');
        return result;
    }
};

export default MarketSystem;