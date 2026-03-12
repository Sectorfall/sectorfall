/**
 * validate.js
 *
 * Ship integrity checks for hulls, aliases, owned ship records, and blueprint outputs.
 */

import { SHIP_HULLS, SHIP_ID_ALIASES } from "./ships.registry.js";
import { BLUEPRINT_REGISTRY } from "../blueprints.js";

export function validateShipsIntegrity({ verbose = true } = {}) {
  const issues = [];
  const push = (kind, msg, extra = {}) => issues.push({ kind, msg, ...extra });

  try {
    for (const [shipId, hull] of Object.entries(SHIP_HULLS || {})) {
      if (!hull) {
        push("ship", `Missing hull object for ${shipId}.`, { shipId });
        continue;
      }
      if (!hull.ship_id) push("ship", `Hull missing ship_id: ${shipId}.`, { shipId });
      if (!hull.name) push("ship", `Hull missing name: ${shipId}.`, { shipId });
      if (!hull.spriteUrl) push("ship", `Hull missing spriteUrl: ${shipId}.`, { shipId });
      if (!Number.isFinite(Number(hull.hp)) || Number(hull.hp) <= 0) push("ship", `Hull has invalid hp: ${shipId}.`, { shipId, hp: hull.hp });
      if (String(shipId).toLowerCase().includes("warhound") || String(hull.name || "").toLowerCase().includes("warhound")) {
        push("ship", `Deprecated hull reference still present: ${shipId}.`, { shipId });
      }
    }
  } catch (e) {
    push("ship", `Ship hull validation crashed: ${e?.message || e}`);
  }

  try {
    for (const [alias, shipId] of Object.entries(SHIP_ID_ALIASES || {})) {
      if (!SHIP_HULLS[shipId]) {
        push("ship-alias", `Ship alias points to missing hull: ${alias} -> ${shipId}`, { alias, shipId });
      }
    }
  } catch (e) {
    push("ship-alias", `Ship alias validation crashed: ${e?.message || e}`);
  }

  try {
    const blueprints = Array.isArray(BLUEPRINT_REGISTRY) ? BLUEPRINT_REGISTRY : Object.values(BLUEPRINT_REGISTRY || {});
    for (const bp of blueprints) {
      if (!bp || String(bp.outputType || "").toLowerCase() !== "ship") continue;
      const outputShipId = bp.outputShipId || bp.outputItemId || null;
      if (!outputShipId) {
        push("ship-blueprint", `Ship blueprint missing explicit outputShipId: ${bp.id || bp.name || "<no-id>"}`, { blueprintId: bp.id });
        continue;
      }
      if (!SHIP_HULLS[outputShipId]) {
        push("ship-blueprint", `Ship blueprint outputShipId not found in hull registry: ${outputShipId}`, { blueprintId: bp.id, outputShipId });
      }
    }
  } catch (e) {
    push("ship-blueprint", `Ship blueprint validation crashed: ${e?.message || e}`);
  }

  if (verbose && typeof console !== "undefined") {
    if (issues.length === 0) console.log("[Integrity] Ship integrity: OK");
    else issues.forEach((issue) => console.warn(`[Integrity] ${issue.kind}: ${issue.msg}`, issue));
  }

  return { ok: issues.length === 0, issues };
}