import { useEffect, useState } from 'react';

export function useTradeHubState(gameState, deps) {
    const { cloudService, supabase, MarketSystem, SYSTEMS_REGISTRY, SYSTEM_TO_STARPORT } = deps;

    const [activeTab, setActiveTab] = useState('browser');
    const [activeRightTab, setActiveRightTab] = useState('inventory');
    const [marketFilter, setMarketFilter] = useState('commodities');
    const [selectedListing, setSelectedListing] = useState(null);
    const [isListingMode, setIsListingMode] = useState(false);
    const [isBuyOrderMode, setIsBuyOrderMode] = useState(false);
    const [isContractMode, setIsContractMode] = useState(false);
    const [selectedContract, setSelectedContract] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [contractReward, setContractReward] = useState('1000');
    const [contractCollateral, setContractCollateral] = useState('5000');
    const [contractDuration, setContractDuration] = useState(86400000);
    const [listPrice, setListPrice] = useState('');
    const [listQuantity, setListQuantity] = useState(1);
    const [buyItemType, setBuyItemType] = useState('organic-material');
    const [selectedInventoryItem, setSelectedInventoryItem] = useState(null);
    const [newMarketListings, setNewMarketListings] = useState([]);
    const [newBuyOrders, setNewBuyOrders] = useState([]);

    const currentSystemId = gameState.currentSystem?.id;
    const currentStarportId = SYSTEM_TO_STARPORT[currentSystemId];

    useEffect(() => {
        if (!currentStarportId) return;

        const fetchMarketData = async () => {
            if (marketFilter === 'commodities' || marketFilter === 'auctions') {
                MarketSystem.seedNPCBlueprints(currentStarportId).catch(e => console.warn('[TradeHub] NPC Seeding error:', e));

                try {
                    const result = await MarketSystem.fetchMarketData(currentStarportId, marketFilter);
                    if (result.listings) setNewMarketListings(result.listings);
                } catch (e) {
                    console.warn('[TradeHub] Market fetch error:', e);
                }
            } else if (marketFilter === 'buy_orders') {
                try {
                    const result = await MarketSystem.fetchMarketData(currentStarportId, marketFilter);
                    if (result.buyOrders) setNewBuyOrders(result.buyOrders);
                } catch (e) {
                    console.warn('[TradeHub] Buy order fetch error:', e);
                }
            }
        };

        fetchMarketData();

        const listingChannel = supabase.channel('market_listings_updates')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'market_listings',
                filter: `starport_id=eq.${currentStarportId}`
            }, () => fetchMarketData())
            .subscribe();

        const buyOrderChannel = supabase.channel('market_buy_orders_updates')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'market_buy_orders',
                filter: `starport_id=eq.${currentStarportId}`
            }, () => fetchMarketData())
            .subscribe();

        return () => {
            supabase.removeChannel(listingChannel);
            supabase.removeChannel(buyOrderChannel);
        };
    }, [marketFilter, currentStarportId, MarketSystem, supabase]);

    let listings = [];
    if (marketFilter === 'contracts') {
        listings = gameState.courierContracts?.filter(c => c.status === 'available') || [];
    } else if (marketFilter === 'commodities') {
        listings = newMarketListings.map(l => {
            const itemType = String(l.item_type || 'unknown');
            const itemDisplayName = String(
                l.item_name || l.item_data?.displayName || l.item_data?.name || l.item_type || 'Unknown'
            ).replace(/-/g, ' ').toUpperCase();
            let rarity = String(l.item_data?.rarity || '').trim().toLowerCase() || 'common';
            if (!l.item_data?.rarity) {
                if (itemType.includes('-uncommon-')) rarity = 'uncommon';
                else if (itemType.includes('-rare-')) rarity = 'rare';
                else if (itemType.includes('-epic-')) rarity = 'epic';
                else if (itemType.includes('-legendary-')) rarity = 'legendary';
                else if (itemType.includes('-mythic-')) rarity = 'mythic';
            }

            return {
                id: l.listing_id,
                sellerId: l.seller_id,
                sellerName: l.seller_id === '00000000-0000-0000-0000-000000000001' ? 'OMNI DIRECTORATE' : `Seller ID: ${l.seller_id.substring(0, 5)}`,
                price: parseFloat(l.price_per_uni),
                quantity: l.quantity,
                item: { name: itemDisplayName, rarity },
                originSystemId: currentSystemId,
                originSystemName: SYSTEMS_REGISTRY[currentSystemId]?.name || currentSystemId,
                originSector: SYSTEMS_REGISTRY[currentSystemId]?.sector || '??'
            };
        });
    } else if (marketFilter === 'buy_orders') {
        listings = newBuyOrders.map(o => {
            const itemType = String(o.item_type || 'unknown');
            const itemDisplayName = String(
                o.item_name || o.item_data?.displayName || o.item_data?.name || o.item_type || 'Unknown'
            ).replace(/-/g, ' ').toUpperCase();
            let rarity = String(o.item_data?.rarity || '').trim().toLowerCase() || 'common';
            if (!o.item_data?.rarity) {
                if (itemType.includes('-uncommon-')) rarity = 'uncommon';
                else if (itemType.includes('-rare-')) rarity = 'rare';
                else if (itemType.includes('-epic-')) rarity = 'epic';
                else if (itemType.includes('-legendary-')) rarity = 'legendary';
                else if (itemType.includes('-mythic-')) rarity = 'mythic';
            }

            return {
                id: o.order_id,
                buyerId: o.buyer_id,
                buyerName: `Buyer ID: ${o.buyer_id.substring(0, 5)}`,
                price: parseFloat(o.price_per_uni),
                quantity: o.quantity,
                item: { name: itemDisplayName, rarity },
                originSystemId: currentSystemId,
                originSystemName: SYSTEMS_REGISTRY[currentSystemId]?.name || currentSystemId,
                originSector: SYSTEMS_REGISTRY[currentSystemId]?.sector || '??'
            };
        });
    } else if (gameState.globalMarkets) {
        Object.entries(gameState.globalMarkets).forEach(([sysId, sysMarket]) => {
            const sysListings = (marketFilter === 'auctions' ? sysMarket.auctions : []) || [];
            sysListings.forEach(l => {
                listings.push({
                    ...l,
                    originSystemId: sysId,
                    originSystemName: SYSTEMS_REGISTRY[sysId]?.name || sysId,
                    originSector: SYSTEMS_REGISTRY[sysId]?.sector || '??'
                });
            });
        });
    }

    if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        listings = listings.filter(l => {
            const itemName = (l.item?.name || 'CONTRACT').toLowerCase();
            const price = (marketFilter === 'contracts' ? l.reward : l.price).toString();
            return itemName.includes(term) || price.includes(term);
        });
    }

    const myStorage = (gameState.regionalStorage && gameState.regionalStorage[currentSystemId] && gameState.regionalStorage[currentSystemId][cloudService.user?.id || 'local']) || [];
    const identifiedMyStorage = myStorage.map(item => ({ ...item, systemId: currentSystemId }));

    let globalStorage = [];
    const userId = cloudService.user?.id || 'local';
    Object.entries(gameState.regionalStorage || {}).forEach(([sysId, users]) => {
        if (users[userId]) {
            users[userId].forEach(item => {
                globalStorage.push({
                    ...item,
                    systemId: sysId,
                    systemName: SYSTEMS_REGISTRY[sysId]?.name || sysId
                });
            });
        }
    });

    if (activeTab === 'storage' && searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        globalStorage = globalStorage.filter(item => {
            const itemName = item.name.toLowerCase();
            const systemName = item.systemName.toLowerCase();
            return itemName.includes(term) || systemName.includes(term);
        });
    }

    return {
        activeTab, setActiveTab,
        activeRightTab, setActiveRightTab,
        marketFilter, setMarketFilter,
        selectedListing, setSelectedListing,
        isListingMode, setIsListingMode,
        isBuyOrderMode, setIsBuyOrderMode,
        isContractMode, setIsContractMode,
        selectedContract, setSelectedContract,
        searchTerm, setSearchTerm,
        contractReward, setContractReward,
        contractCollateral, setContractCollateral,
        contractDuration, setContractDuration,
        listPrice, setListPrice,
        listQuantity, setListQuantity,
        buyItemType, setBuyItemType,
        selectedInventoryItem, setSelectedInventoryItem,
        listings,
        myStorage,
        identifiedMyStorage,
        globalStorage,
        currentSystemId,
        currentStarportId,
    };
}
