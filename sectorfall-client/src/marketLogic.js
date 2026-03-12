import { cloudService } from './CloudService.js';
import { uuid } from './utils.js';

/**
 * MarketSystem.js
 * Implements the backend logic for the Galactic Marketplace.
 * USES IN-MEMORY STORAGE (Supabase is no longer used for market listings).
 * This ensures the market is effectively "reseeded" whenever the server process/instance boots.
 */

const IN_MEMORY_MARKET = {
    listings: [],
    buyOrders: []
};

export const MarketSystem = {
    /**
     * createSellOrder(user_id, item_type, quantity, price_per_uni, starport_id)
     */
    async createSellOrder(user_id, item_type, quantity, price_per_uni, starport_id) {
        if (!user_id) throw new Error("User ID required for market operations.");

        console.log(`[MarketSystem] Attempting to create sell order for ${quantity}x ${item_type} at ${starport_id}`);

        // 1. Get Storage Bay state
        const inventoryData = await cloudService.getInventoryState(user_id, starport_id);
        let storageItems = inventoryData ? [...(inventoryData.items || [])] : [];
        
        // Helper to find item index
        const findItemIndex = (list) => list.findIndex(i => 
            (i.item_id === item_type) || 
            (i.type === item_type) || 
            (i.id === item_type) ||
            (i.blueprintId === item_type) ||
            (i.materialKey === item_type) ||
            (i.name && i.name.toLowerCase() === item_type.toLowerCase())
        );

        let storageIndex = findItemIndex(storageItems);
        let currentStorageQty = storageIndex !== -1 ? (storageItems[storageIndex].quantity || storageItems[storageIndex].amount || 0) : 0;

        // 2. Pull from Ship Cargo if needed
        if (currentStorageQty < quantity) {
            const neededFromCargo = quantity - currentStorageQty;
            const shipData = await cloudService.loadFromCloud(user_id, starport_id);
            if (shipData && shipData.telemetry && shipData.telemetry.cargo) {
                let cargoItems = [...shipData.telemetry.cargo];
                let cargoIndex = findItemIndex(cargoItems);

                if (cargoIndex !== -1) {
                    let cargoItem = cargoItems[cargoIndex];
                    let currentCargoQty = cargoItem.quantity || cargoItem.amount || 0;

                    if (currentCargoQty >= neededFromCargo) {
                        const remainingCargoQty = currentCargoQty - neededFromCargo;
                        if (remainingCargoQty > 0) {
                            if (cargoItem.quantity !== undefined) cargoItem.quantity = remainingCargoQty;
                            if (cargoItem.amount !== undefined) cargoItem.amount = remainingCargoQty;
                        } else {
                            cargoItems.splice(cargoIndex, 1);
                        }

                        if (storageIndex !== -1) {
                            if (storageItems[storageIndex].quantity !== undefined) storageItems[storageIndex].quantity += neededFromCargo;
                            else storageItems[storageIndex].amount += neededFromCargo;
                        } else {
                            storageItems.push({ ...cargoItem, quantity: neededFromCargo });
                            storageIndex = storageItems.length - 1;
                        }

                        shipData.telemetry.cargo = cargoItems;
                        await cloudService.saveToCloud(user_id, starport_id, shipData);
                        currentStorageQty += neededFromCargo;
                    }
                }
            }
        }

        if (currentStorageQty < quantity) {
            throw new Error(`Insufficient quantity of '${item_type}' available. Have: ${currentStorageQty}, Need: ${quantity}`);
        }

        // 3. Remove from Storage Bay
        const itemToSell = storageItems[storageIndex];
        const finalStorageQty = currentStorageQty - quantity;
        if (finalStorageQty > 0) {
            if (itemToSell.quantity !== undefined) itemToSell.quantity = finalStorageQty;
            if (itemToSell.amount !== undefined) itemToSell.amount = finalStorageQty;
        } else {
            storageItems.splice(storageIndex, 1);
        }

        await cloudService.saveInventoryState(user_id, starport_id, storageItems, "market_createSellOrder");

        // 4. Insert into In-Memory Market
        const commanderData = await cloudService.getCommanderData(user_id);
        const newListing = {
            listing_id: uuid(),
            starport_id: starport_id.toLowerCase().trim(),
            seller_id: user_id,
            seller_name: commanderData?.name || "Unknown Pilot",
            item_type,
            quantity,
            price_per_uni,
            status: 'open',
            created_at: new Date().toISOString()
        };

        IN_MEMORY_MARKET.listings.push(newListing);
        await this.matchOrders(starport_id, item_type);
        return newListing;
    },

    async createBuyOrder(user_id, item_type, quantity, price_per_uni, starport_id) {
        if (!user_id) throw new Error("User ID required.");
        const totalEscrow = quantity * price_per_uni;
        
        const commanderData = await cloudService.getCommanderData(user_id);
        if (!commanderData || (commanderData.credits || 0) < totalEscrow) {
            throw new Error("Insufficient credits.");
        }

        await cloudService.updateCommanderData(user_id, { 
            credits: (commanderData.credits || 0) - totalEscrow 
        });

        const newOrder = {
            order_id: uuid(),
            starport_id: starport_id.toLowerCase().trim(),
            buyer_id: user_id,
            item_type,
            quantity,
            price_per_uni,
            status: 'open',
            created_at: new Date().toISOString()
        };

        IN_MEMORY_MARKET.buyOrders.push(newOrder);
        await this.matchOrders(starport_id, item_type);
        return newOrder;
    },

    async matchOrders(starport_id, item_type) {
        const starport = starport_id.toLowerCase().trim();
        const listings = IN_MEMORY_MARKET.listings.filter(l => l.starport_id === starport && l.item_type === item_type && l.status === 'open')
            .sort((a, b) => a.price_per_uni - b.price_per_uni);
        const buyOrders = IN_MEMORY_MARKET.buyOrders.filter(o => o.starport_id === starport && o.item_type === item_type && o.status === 'open')
            .sort((a, b) => b.price_per_uni - a.price_per_uni);

        for (const buyOrder of buyOrders) {
            for (const listing of listings) {
                if (buyOrder.status !== 'open' || listing.status !== 'open') continue;
                if (buyOrder.price_per_uni >= listing.price_per_uni) {
                    const tradeQty = Math.min(buyOrder.quantity, listing.quantity);
                    const sellPrice = listing.price_per_uni;
                    const buyPrice = buyOrder.price_per_uni;

                    buyOrder.quantity -= tradeQty;
                    listing.quantity -= tradeQty;
                    if (buyOrder.quantity <= 0) buyOrder.status = 'filled';
                    if (listing.quantity <= 0) listing.status = 'filled';

                    const totalSellerProceeds = tradeQty * sellPrice;
                    const totalBuyerRefund = tradeQty * (buyPrice - sellPrice);

                    // Financials
                    const sellerData = await cloudService.getCommanderData(listing.seller_id);
                    if (sellerData) {
                        await cloudService.updateCommanderData(listing.seller_id, { 
                            credits: (sellerData.credits || 0) + totalSellerProceeds 
                        });
                    }

                    if (totalBuyerRefund > 0) {
                        const bData = await cloudService.getCommanderData(buyOrder.buyer_id);
                        if (bData) {
                            await cloudService.updateCommanderData(buyOrder.buyer_id, { 
                                credits: (bData.credits || 0) + totalBuyerRefund 
                            });
                        }
                    }

                    // Item Transfer
                    const buyerInventory = await cloudService.getInventoryState(buyOrder.buyer_id, starport_id);
                    if (buyerInventory) {
                        let bItems = [...(buyerInventory.items || [])];
                        let bItemIndex = bItems.findIndex(i => i.item_id === item_type || i.id === item_type);
                        if (bItemIndex !== -1) {
                            if (bItems[bItemIndex].quantity !== undefined) bItems[bItemIndex].quantity += tradeQty;
                            else bItems[bItemIndex].amount += tradeQty;
                        } else {
                            bItems.push({ id: uuid(), item_id: item_type, type: item_type, quantity: tradeQty, rarity: 'common' });
                        }
                        await cloudService.saveInventoryState(buyOrder.buyer_id, starport_id, bItems, "market_matchOrders");
                    }
                }
            }
        }
    },

    async cancelSellOrder(listing_id, commander_id) {
        const idx = IN_MEMORY_MARKET.listings.findIndex(l => l.listing_id === listing_id);
        if (idx === -1) throw new Error("Listing not found.");
        const listing = IN_MEMORY_MARKET.listings[idx];
        if (listing.seller_id !== commander_id) throw new Error("Unauthorized.");

        const inventoryData = await cloudService.getInventoryState(commander_id, listing.starport_id);
        if (inventoryData) {
            let items = [...(inventoryData.items || [])];
            let itemIndex = items.findIndex(i => i.item_id === listing.item_type || i.id === listing.item_type);
            if (itemIndex !== -1) {
                if (items[itemIndex].quantity !== undefined) items[itemIndex].quantity += listing.quantity;
                else items[itemIndex].amount += listing.quantity;
            } else {
                items.push({ id: uuid(), item_id: listing.item_type, type: listing.item_type, quantity: listing.quantity, rarity: 'common' });
            }
            await cloudService.saveInventoryState(commander_id, listing.starport_id, items, "market_cancelSellOrder");
        }
        listing.status = 'cancelled';
    },

    async cancelBuyOrder(order_id, commander_id) {
        const idx = IN_MEMORY_MARKET.buyOrders.findIndex(o => o.order_id === order_id);
        if (idx === -1) throw new Error("Order not found.");
        const order = IN_MEMORY_MARKET.buyOrders[idx];
        if (order.buyer_id !== commander_id) throw new Error("Unauthorized.");

        const commanderData = await cloudService.getCommanderData(commander_id);
        if (commanderData) {
            await cloudService.updateCommanderData(commander_id, { 
                credits: (commanderData.credits || 0) + (order.quantity * order.price_per_uni) 
            });
        }
        order.status = 'cancelled';
    },

    async buyListing(listing_id, commander_id) {
        const idx = IN_MEMORY_MARKET.listings.findIndex(l => l.listing_id === listing_id);
        if (idx === -1) throw new Error("Listing not found.");
        const listing = IN_MEMORY_MARKET.listings[idx];
        if (listing.status !== 'open' || listing.quantity <= 0) throw new Error("Inactive listing.");
        if (listing.seller_id === commander_id) throw new Error("Self-purchase rejected.");

        const price = listing.price_per_uni;
        const buyerData = await cloudService.getCommanderData(commander_id);
        if (!buyerData || (buyerData.credits || 0) < price) throw new Error("Insufficient credits.");

        await cloudService.updateCommanderData(commander_id, { credits: (buyerData.credits || 0) - price });
        const sellerData = await cloudService.getCommanderData(listing.seller_id);
        if (sellerData) {
            await cloudService.updateCommanderData(listing.seller_id, { credits: (sellerData.credits || 0) + price });
        }

        const buyerInventory = await cloudService.getInventoryState(commander_id, listing.starport_id);
        if (buyerInventory) {
            let bItems = [...(buyerInventory.items || [])];
            let bItemIndex = bItems.findIndex(i => i.item_id === listing.item_type || i.id === listing.item_type);
            if (bItemIndex !== -1) {
                if (bItems[bItemIndex].quantity !== undefined) bItems[bItemIndex].quantity += 1;
                else bItems[bItemIndex].amount += 1;
            } else {
                bItems.push({ id: uuid(), item_id: listing.item_type, type: listing.item_type, quantity: 1, rarity: 'common' });
            }
            await cloudService.saveInventoryState(commander_id, listing.starport_id, bItems, "market_buyListing");
        }

        listing.quantity -= 1;
        if (listing.quantity <= 0) listing.status = 'closed';
        return { success: true };
    },

    async fetchMarketData(starport_id, filter = 'listings') {
        if (!starport_id) throw new Error("Starport ID required.");
        const starport = starport_id.toLowerCase().trim();
        
        if (filter === 'buy_orders') {
            return { buyOrders: IN_MEMORY_MARKET.buyOrders.filter(o => o.starport_id === starport && o.status === 'open') };
        } else {
            return { listings: IN_MEMORY_MARKET.listings.filter(l => l.starport_id === starport && l.status === 'open') };
        }
    },

    async seedNPCBlueprints(starport_id) {
        console.log(`[MarketSystem] In-Memory Seeding for ${starport_id}...`);
        const NPC_SELLER_ID = '00000000-0000-0000-0000-000000000001'; 
        const starport = starport_id.toLowerCase().trim();

        // Clear existing NPC listings for this starport
        IN_MEMORY_MARKET.listings = IN_MEMORY_MARKET.listings.filter(l => 
            !(l.seller_id === NPC_SELLER_ID && l.starport_id === starport)
        );

        const BLUEPRINTS = [
            { id: 'omni-scout-chassis', price: 1500, qty: 5 },
            { id: 'blueprint-common-mining-laser-s', price: 400, qty: 5 },
            { id: 'blueprint-common-flux-laser-s', price: 400, qty: 5 },
            { id: 'blueprint-common-pulse-cannon-s', price: 400, qty: 3 },
            { id: 'blueprint-common-ion-thruster-s', price: 400, qty: 3 },
            { id: 'blueprint-common-shield-module-s', price: 400, qty: 3 }
        ];

        for (const bp of BLUEPRINTS) {
            IN_MEMORY_MARKET.listings.push({
                listing_id: uuid(),
                starport_id: starport,
                seller_id: NPC_SELLER_ID,
                seller_name: "OMNI DIRECTORATE",
                item_type: bp.id,
                quantity: bp.qty,
                price_per_uni: bp.price,
                status: 'open',
                created_at: new Date().toISOString()
            });
        }
    }
};
