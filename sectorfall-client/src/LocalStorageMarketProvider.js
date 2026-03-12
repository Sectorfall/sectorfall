import { cloudService } from './CloudService.js';
import { uuid } from './utils.js';
import { BLUEPRINT_REGISTRY } from './GameManager.js';

/**
 * LocalStorageMarketProvider.js
 * Provides a functional fallback for the Galactic Marketplace using LocalStorage.
 * Handles listings, buy orders, matching, and credit/inventory transfers.
 */

const MARKET_KEY = 'arc_space_market_data';

export const LocalStorageMarketProvider = {
    _getMarket() {
        const raw = localStorage.getItem(MARKET_KEY);
        return raw ? JSON.parse(raw) : { listings: [], buyOrders: [] };
    },

    _saveMarket(data) {
        localStorage.setItem(MARKET_KEY, JSON.stringify(data));
    },

    async fetchMarketData(starportId, filter = 'listings') {
        const market = this._getMarket();
        const normalizedStarport = String(starportId).toLowerCase().trim();
        
        if (filter === 'buy_orders') {
            return { 
                buyOrders: market.buyOrders.filter(o => 
                    o.starport_id === normalizedStarport && o.status === 'open'
                ) 
            };
        }
        
        return { 
            listings: market.listings.filter(l => 
                l.starport_id === normalizedStarport && l.status === 'open'
            ) 
        };
    },

    async createSellOrder(item_type, quantity, price_per_uni, starport_id, seller_id) {
        // 1. Verify and deduct inventory via CloudService
        const inventory = await cloudService.getInventoryState(seller_id, starport_id);
        const items = Array.isArray(inventory?.items) ? [...inventory.items] : [];
        
        const isBlueprint = item_type.startsWith('blueprint-');
        const itemIndex = items.findIndex(i => {
            if (isBlueprint) {
                return i.type === 'blueprint' && (i.blueprintId === item_type || i.item_id === item_type);
            }
            return i.type === item_type || i.item_id === item_type || i.name === item_type;
        });

        if (itemIndex === -1) throw new Error(`Item ${item_type} not found in inventory.`);
        
        const currentQty = items[itemIndex].quantity || items[itemIndex].amount || 0;
        if (currentQty < quantity) throw new Error("Insufficient quantity to sell.");

        // Deduct items
        const newQty = currentQty - quantity;
        if (newQty > 0) {
            if (items[itemIndex].quantity !== undefined) items[itemIndex].quantity = newQty;
            else items[itemIndex].amount = newQty;
        } else {
            items.splice(itemIndex, 1);
        }

        await cloudService.saveInventoryState(seller_id, starport_id, items, "market_sell_local");

        // 2. Add to local market
        const market = this._getMarket();
        const commander = await cloudService.getCommanderData(seller_id);
        
        const newListing = {
            listing_id: uuid(),
            starport_id: starport_id.toLowerCase().trim(),
            seller_id,
            seller_name: commander?.name || "Unknown Pilot",
            item_type,
            quantity,
            price_per_uni,
            status: 'open',
            created_at: new Date().toISOString()
        };

        market.listings.push(newListing);
        this._saveMarket(market);
        
        await this.matchOrders(starport_id, item_type);
        return newListing;
    },

    async createBuyOrder(item_type, quantity, price_per_uni, starport_id, buyer_id) {
        const totalCost = quantity * price_per_uni;
        const buyerCredits = await cloudService.getCredits(buyer_id);
        
        if (buyerCredits < totalCost) throw new Error("Insufficient credits for buy order.");

        // Deduct credits via CloudService
        await cloudService.updateCommanderData(buyer_id, { 
            credits: buyerCredits - totalCost 
        });

        const market = this._getMarket();
        const newOrder = {
            order_id: uuid(),
            starport_id: starport_id.toLowerCase().trim(),
            buyer_id,
            item_type,
            quantity,
            price_per_uni,
            status: 'open',
            created_at: new Date().toISOString()
        };

        market.buyOrders.push(newOrder);
        this._saveMarket(market);

        await this.matchOrders(starport_id, item_type);
        return newOrder;
    },

    async buyListing(listing_id, buyer_id) {
        const market = this._getMarket();
        const listingIndex = market.listings.findIndex(l => l.listing_id === listing_id);
        if (listingIndex === -1) throw new Error("Listing not found.");
        
        const listing = market.listings[listingIndex];
        if (listing.status !== 'open') throw new Error("Listing no longer active.");
        if (listing.seller_id === buyer_id) throw new Error("Cannot buy your own listing.");

        const buyerCredits = await cloudService.getCredits(buyer_id);
        console.log(`[DEBUG] Provider credits: ${buyerCredits}`);
        console.log(`[DEBUG] Listing price: ${listing.price_per_uni}`);
        if (buyerCredits < listing.price_per_uni) throw new Error("Insufficient credits.");

        // Financials
        await cloudService.updateCommanderData(buyer_id, { credits: buyerCredits - listing.price_per_uni });
        const seller = await cloudService.getCommanderData(listing.seller_id);
        if (seller) {
            await cloudService.updateCommanderData(listing.seller_id, { credits: (seller.credits || 0) + listing.price_per_uni });
        }

        // Inventory Transfer
        const inv = await cloudService.getInventoryState(buyer_id, listing.starport_id);
        const items = Array.isArray(inv?.items) ? [...inv.items] : [];
        
        const isBlueprint = String(listing.item_type).toLowerCase().startsWith('blueprint-') || String(listing.item_type).toLowerCase().startsWith('bp-');
        const existingIdx = items.findIndex(i => {
            if (isBlueprint) {
                return i.type === 'blueprint' && (i.blueprintId === listing.item_type || i.item_id === listing.item_type);
            }
            return i.type === listing.item_type || i.item_id === listing.item_type;
        });
        
        if (existingIdx !== -1) {
            if (items[existingIdx].quantity !== undefined) items[existingIdx].quantity += 1;
            else items[existingIdx].amount += 1;
            console.log('[DEBUG] Stored item after purchase:', items[existingIdx]);
        } else {
            const newItem = {
                id: uuid(),
                type: isBlueprint ? 'blueprint' : listing.item_type,
                item_id: listing.item_type,
                name: listing.item_type.split('-').map(s => s.toUpperCase()).join(' '),
                quantity: 1,
                rarity: 'common'
            };
            
            if (isBlueprint) {
                newItem.blueprintId = listing.item_type;
                newItem.subtype = 'manufacturing-data';
            }

            items.push(newItem);
            console.log('[DEBUG] Stored item after purchase:', newItem);
        }
        await cloudService.saveInventoryState(buyer_id, listing.starport_id, items, "market_buy_local");

        // Update listing
        listing.quantity -= 1;
        if (listing.quantity <= 0) listing.status = 'closed';
        
        this._saveMarket(market);
        return { success: true };
    },

    async cancelSellOrder(listing_id, commander_id) {
        const market = this._getMarket();
        const idx = market.listings.findIndex(l => l.listing_id === listing_id);
        if (idx === -1) throw new Error("Listing not found.");
        const listing = market.listings[idx];
        if (listing.seller_id !== commander_id) throw new Error("Unauthorized.");

        // Return items
        const inv = await cloudService.getInventoryState(commander_id, listing.starport_id);
        const items = Array.isArray(inv?.items) ? [...inv.items] : [];
        
        const isBlueprint = String(listing.item_type).toLowerCase().startsWith('blueprint-') || String(listing.item_type).toLowerCase().startsWith('bp-');
        const itemIdx = items.findIndex(i => {
            if (isBlueprint) {
                return i.type === 'blueprint' && (i.blueprintId === listing.item_type || i.item_id === listing.item_type);
            }
            return i.type === listing.item_type || i.item_id === listing.item_type;
        });
        
        if (itemIdx !== -1) {
            if (items[itemIdx].quantity !== undefined) items[itemIdx].quantity += listing.quantity;
            else items[itemIdx].amount += listing.quantity;
        } else {
            const newItem = {
                id: uuid(),
                type: isBlueprint ? 'blueprint' : listing.item_type,
                item_id: listing.item_type,
                name: listing.item_type.split('-').map(s => s.toUpperCase()).join(' '),
                quantity: listing.quantity,
                rarity: 'common'
            };
            
            if (isBlueprint) {
                newItem.blueprintId = listing.item_type;
                newItem.subtype = 'manufacturing-data';
            }
            
            items.push(newItem);
        }
        await cloudService.saveInventoryState(commander_id, listing.starport_id, items, "market_cancel_local");

        listing.status = 'cancelled';
        this._saveMarket(market);
    },

    async cancelBuyOrder(order_id, commander_id) {
        const market = this._getMarket();
        const idx = market.buyOrders.findIndex(o => o.order_id === order_id);
        if (idx === -1) throw new Error("Order not found.");
        const order = market.buyOrders[idx];
        if (order.buyer_id !== commander_id) throw new Error("Unauthorized.");

        // Return credits
        const currentCredits = await cloudService.getCredits(commander_id);
        await cloudService.updateCommanderData(commander_id, { 
            credits: currentCredits + (order.quantity * order.price_per_uni) 
        });

        order.status = 'cancelled';
        this._saveMarket(market);
    },

    async matchOrders(starport_id, item_type) {
        const market = this._getMarket();
        const starport = starport_id.toLowerCase().trim();
        
        const listings = market.listings.filter(l => l.starport_id === starport && l.item_type === item_type && l.status === 'open')
            .sort((a, b) => a.price_per_uni - b.price_per_uni);
        const buyOrders = market.buyOrders.filter(o => o.starport_id === starport && o.item_type === item_type && o.status === 'open')
            .sort((a, b) => b.price_per_uni - a.price_per_uni);

        for (const order of buyOrders) {
            for (const listing of listings) {
                if (order.status !== 'open' || listing.status !== 'open') continue;
                if (order.price_per_uni >= listing.price_per_uni) {
                    const tradeQty = Math.min(order.quantity, listing.quantity);
                    const sellPrice = listing.price_per_uni;

                    // Processing transfer is complex in local-sync, but we apply it locally
                    order.quantity -= tradeQty;
                    listing.quantity -= tradeQty;
                    if (order.quantity <= 0) order.status = 'filled';
                    if (listing.quantity <= 0) listing.status = 'filled';

                    // Update storage
                    this._saveMarket(market);
                }
            }
        }
    },

    async seedNPCBlueprints(starport_id) {
        const starport = starport_id.toUpperCase().trim();
        const lastRefreshKey = `arc_market_vendor_refresh_${starport.toLowerCase()}`;
        const NPC_ID = '00000000-0000-0000-0000-000000000001';
        const now = Date.now();

        // 1-Hour Throttle: Only regenerate if enough time has passed
        const lastRefresh = localStorage.getItem(lastRefreshKey);
        if (lastRefresh && (now - parseInt(lastRefresh)) < 3600000) {
            return; 
        }

        console.log(`[Market] Regenerating OMNI DIRECTORATE inventory for ${starport}...`);
        const market = this._getMarket();
        
        // MIGRATION: Purge any legacy 'falcon-chassis' entries from the market data
        const initialListingCount = market.listings.length;
        market.listings = market.listings.filter(l => l.item_type !== 'falcon-chassis');
        if (market.listings.length !== initialListingCount) {
            console.log(`[Market] Purged ${initialListingCount - market.listings.length} legacy falcon-chassis listings.`);
        }

        // Remove existing NPC listings for this starport to regenerate
        market.listings = market.listings.filter(l => 
            !(l.seller_id === NPC_ID && l.starport_id === starport.toLowerCase())
        );

        // 1. Guaranteed Items - Use BLUEPRINT_REGISTRY keys as IDs
        const itemsToAdd = [
            { id: 'omni-scout-chassis', price: 1500, qty: 5 } // OMNI Scout Blueprint (Registry Key: omni-scout-chassis)
        ];

        // 2. Rarity-Weighted Pool
        const pool = [
            { id: 'blueprint-common-mining-laser-s', price: 400, weight: 70 },
            { id: 'blueprint-common-flux-laser-s', price: 400, weight: 70 },
            { id: 'blueprint-common-pulse-cannon-s', price: 450, weight: 70 },
            { id: 'blueprint-uncommon-flux-laser-s', price: 1200, weight: 20 },
            { id: 'blueprint-uncommon-pulse-cannon-s', price: 1350, weight: 20 },
            { id: 'blueprint-rare-flux-laser-s', price: 3500, weight: 10 }
        ];

        // Add 4-6 random items from the pool based on weights
        const randomCount = Math.floor(Math.random() * 3) + 4;
        for (let i = 0; i < randomCount; i++) {
            const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
            let roll = Math.random() * totalWeight;
            
            for (const item of pool) {
                if (roll < item.weight) {
                    // Check if already adding this item (to avoid duplicates, just increase qty)
                    const existing = itemsToAdd.find(it => it.id === item.id);
                    if (existing) {
                        existing.qty += Math.floor(Math.random() * 5) + 5;
                    } else {
                        itemsToAdd.push({ 
                            id: item.id, 
                            price: item.price, 
                            qty: Math.floor(Math.random() * 5) + 5 
                        });
                    }
                    break;
                }
                roll -= item.weight;
            }
        }

        // 3. Commit to Market
        itemsToAdd.forEach(item => {
            market.listings.push({
                listing_id: uuid(),
                starport_id: starport.toLowerCase(),
                seller_id: NPC_ID,
                seller_name: "OMNI DIRECTORATE",
                item_type: item.id,
                quantity: item.qty,
                price_per_uni: item.price,
                status: 'open',
                created_at: new Date().toISOString()
            });
        });

        localStorage.setItem(lastRefreshKey, now.toString());
        this._saveMarket(market);
        console.log(`[Market] Vendor refresh complete for ${starport}. ${itemsToAdd.length} unique items stocked.`);
    }
};