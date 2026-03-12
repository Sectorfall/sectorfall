// API Route: Market
// Build Version: 1.0.1 - Force Route Refresh
import { MarketSystem } from '../src/marketLogic.js';

export default async function handler(req, res) {
    console.log(`[API Market] Request: ${req.method}`, req.method === 'GET' ? req.query : req.body);

    try {
        if (req.method === 'GET') {
            const { starport_id, filter } = req.query || {};
            const result = await MarketSystem.fetchMarketData(starport_id, filter);
            return res.status(200).json(result);
        }

        if (req.method === 'POST') {
            const { action, ...payload } = req.body || {};
            let result;

            switch (action) {
                case 'buyListing':
                    result = await MarketSystem.buyListing(payload.listing_id, payload.commander_id);
                    break;
                case 'createSellOrder':
                    result = await MarketSystem.createSellOrder(payload.seller_id, payload.item_type, payload.quantity, payload.price_per_uni, payload.starport_id);
                    break;
                case 'createBuyOrder':
                    result = await MarketSystem.createBuyOrder(payload.buyer_id, payload.item_type, payload.quantity, payload.price_per_uni, payload.starport_id);
                    break;
                case 'cancelSellOrder':
                    result = await MarketSystem.cancelSellOrder(payload.listing_id, payload.commander_id);
                    break;
                case 'cancelBuyOrder':
                    result = await MarketSystem.cancelBuyOrder(payload.order_id, payload.commander_id);
                    break;
                case 'seedNPCBlueprints':
                    result = await MarketSystem.seedNPCBlueprints(payload.starport_id);
                    break;
                default:
                    return res.status(400).json({ error: `Unknown action: ${action}` });
            }

            return res.status(200).json(result || { success: true });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });
    } catch (e) {
        console.error(`[API Market] Error:`, e.message);
        return res.status(500).json({ error: e.message });
    }
}