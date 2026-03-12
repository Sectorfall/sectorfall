/**
 * starterLoadouts.js (compat)
 *
 * This file is kept for backwards compatibility.
 * The canonical starter definitions now live in ./starters.js.
 */

import { STARTER_LOADOUTS_V2, getStarterLoadout } from "./starters.js";

export const STARTER_LOADOUTS = Object.freeze(
  Object.fromEntries(
    Object.entries(STARTER_LOADOUTS_V2).map(([shipType, entries]) => [
      shipType,
      entries.map((e) => e.itemKey),
    ])
  )
);

export function getStarterItemIds(shipType) {
  return getStarterLoadout(shipType).map((e) => e.itemKey);
}