/**
 * items.registry.js
 *
 * CLEAN ITEM STRUCTURE (Phase 1):
 * - ITEM_CATALOG remains the current template store (backwards compatible).
 * - This registry provides a single "definition" view that other systems should reference.
 *
 * Notes:
 * - For now, itemKey === item_id (template id). This lets us migrate without breaking saves.
 * - Later you can move to semantic keys (e.g. "shield.array.s.common") without changing runtime logic.
 */

import { ITEM_CATALOG } from "./catalog.js";

/**
 * Canonical item definitions keyed by itemKey (currently equal to template item_id).
 */
export const ITEMS = Object.freeze(
  Object.fromEntries(
    Object.entries(ITEM_CATALOG).map(([itemId, tpl]) => [
      itemId,
      {
        itemKey: itemId,
        item_id: tpl.item_id || itemId,
        type: tpl.type,
        subtype: tpl.subtype,
        name: tpl.name,
        rarity: tpl.rarity,
        size: tpl.size || tpl.weaponsize || tpl.moduleSize,
        template: tpl,
      },
    ])
  )
);

export function getItemDef(itemKey) {
  return ITEMS[itemKey] || null;
}

export function getItemTemplate(itemKey) {
  return ITEM_CATALOG[itemKey] || null;
}