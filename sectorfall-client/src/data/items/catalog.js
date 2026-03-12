/**
 * catalog.js
 * Standalone item catalog (templates) for all items.
 *
 * This file MUST remain dependency-free (no imports) to avoid circular refs.
 *
 * Notes:
 * - item_id is the stable template id.
 * - id is the per-instance uuid added when the item is granted/crafted.
 * - quality here is a starter/template default (crafting can overwrite quality).
 */

const SIZE_META = {
    S: { label: 'Small', weight: 3.0, volume: 3.0 },
    M: { label: 'Medium', weight: 4.0, volume: 4.0 },
    L: { label: 'Large', weight: 5.0, volume: 5.0 }
};

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const makeItemId = (size, rarity, key) => {
    const sizePart = size === 'S' ? 'small' : (size === 'M' ? 'medium' : 'large');
    return `${sizePart}-${rarity}-${key}`;
};

const makeBase = ({ item_id, type, subtype, name, rarity, weaponsize, size, weight, volume, description }) => ({
    item_id,
    type,
    subtype,
    name,
    rarity,
    quality: 50,
    stack: 1,
    maxStack: 1,
    metadata: {},
    ...(weaponsize ? { weaponsize } : {}),
    ...(size ? { size } : {}),
    weight,
    volume,
    ...(description ? { description } : {})
});

const catalog = {};

// ------------------------------------------------------------
// Weapons (Flux / Pulse / Seeker)
// ------------------------------------------------------------
['S', 'M', 'L'].forEach((size) => {
    const { label, weight, volume } = SIZE_META[size];
    RARITIES.forEach((rarity) => {
        const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);

        // Flux Laser
        {
            const item_id = makeItemId(size, rarity, 'flux-laser');
            catalog[item_id] = makeBase({
                item_id,
                type: 'weapon',
                subtype: 'flux-laser',
                name: `${label} ${rarityLabel} Flux Laser`,
                rarity,
                weaponsize: size,
                weight,
                volume,
                description: 'High-performance thermal flux emitter.'
            });
        }

        // Pulse Cannon
        {
            const item_id = makeItemId(size, rarity, 'pulse-cannon');
            catalog[item_id] = makeBase({
                item_id,
                type: 'weapon',
                subtype: 'pulse-cannon',
                name: `${label} ${rarityLabel} Pulse Cannon`,
                rarity,
                weaponsize: size,
                weight,
                volume,
                description: 'Magazine-fed projectile accelerator.'
            });
        }

        // Seeker Pod (Missile Launcher)
        {
            const item_id = makeItemId(size, rarity, 'seeker-pod');
            catalog[item_id] = makeBase({
                item_id,
                type: 'weapon',
                subtype: 'missile-launcher',
                name: `${label} ${rarityLabel} Seeker Pod`,
                rarity,
                weaponsize: size,
                weight,
                volume,
                description: 'Automated homing missile launcher for tactical engagement.'
            });
        }
    });
});

// ------------------------------------------------------------
// Mining Lasers
// ------------------------------------------------------------
['S', 'M', 'L'].forEach((size) => {
    const { label, weight, volume } = SIZE_META[size];
    RARITIES.forEach((rarity) => {
        const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
        const item_id = makeItemId(size, rarity, 'mining-laser');
        catalog[item_id] = makeBase({
            item_id,
            type: 'mining',
            subtype: 'mining-laser',
            name: `${label} ${rarityLabel} Mining Laser`,
            rarity,
            weaponsize: size,
            weight,
            volume,
            description: 'Industrial ore extraction beam.'
        });
    });
});

// ------------------------------------------------------------
// Defensive + Utility Modules
// ------------------------------------------------------------
['S', 'M', 'L'].forEach((size) => {
    const { label, weight, volume } = SIZE_META[size];
    RARITIES.forEach((rarity) => {
        const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);

        // Shield Array
        {
            const item_id = makeItemId(size, rarity, 'shield-array');
            catalog[item_id] = makeBase({
                item_id,
                type: 'shield',
                subtype: 'shield-generator',
                name: `${label} ${rarityLabel} Shield Array`,
                rarity,
                size,
                weight,
                volume,
                description: 'Defensive energy barrier.'
            });
        }

        // Ion Thruster
        {
            const item_id = makeItemId(size, rarity, 'ion-thruster');
            catalog[item_id] = makeBase({
                item_id,
                type: 'thruster',
                subtype: 'ion-thruster',
                name: `${label} ${rarityLabel} Ion Thruster`,
                rarity,
                size,
                weight,
                volume,
                description: 'Auxiliary ion acceleration unit.'
            });
        }
    });
});

// ------------------------------------------------------------
// Drone Modules (Combat / Mining / Repair)
// IMPORTANT: name must match DRONE_MODULE_CONFIGS keys.
// ------------------------------------------------------------
const DRONE_FAMILIES = [
    { key: 'combat', label: 'Combat' },
    { key: 'mining', label: 'Mining' },
    { key: 'repair', label: 'Repair' }
];

['S', 'M', 'L'].forEach((size) => {
    const { label, weight, volume } = SIZE_META[size];
    RARITIES.forEach((rarity) => {
        DRONE_FAMILIES.forEach((fam) => {
            const item_id = makeItemId(size, rarity, `${fam.key}-drone-module`);
            // Name here is the authoritative key used by DRONE_MODULE_CONFIGS
            const configName = `${label} ${fam.label} Drone Module`;
            catalog[item_id] = makeBase({
                item_id,
                type: 'drone-module',
                subtype: 'drone-bay',
                name: configName,
                rarity,
                weaponsize: size,
                weight,
                volume,
                description: `Launches and controls ${fam.label.toLowerCase()} drones.`
            });
        });
    });
});

export const ITEM_CATALOG = catalog;