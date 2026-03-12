/**
 * AUTO-EXTRACTED from GameManager_refactored.js
 * Purpose: keep GameManager lean; pure data exports.
 */

export const TRADE_CONFIG = {
    ORE_RP: 1.0,
    BLUEPRINT_RP: 150,
    SMALL_SHIP_RP: 1500,
    PRICE_BAND_MIN: 0.25,
    PRICE_BAND_MAX: 4.0,
    LISTING_FEE_PERCENT: 0.005,
    SALES_TAX_PERCENT: 0.03,
    RELIST_COOLDOWN: 60000,
    AUCTION_DURATIONS: [3600000, 21600000, 86400000, 259200000] // 1h, 6h, 24h, 72h in ms
};