/**
 * validate.js
 *
 * Phase 3: Boot-time integrity checks so the item/blueprint system can't silently drift.
 *
 * This is intentionally non-throwing in production: it logs actionable warnings.
 */

import { ITEM_CATALOG } from "./catalog.js";
import { BLUEPRINT_REGISTRY } from "../blueprints.js";
import { STARTER_LOADOUTS_V2 } from "./starters.js";
import { validateStatsIntegrity } from "../stats/validate.js";
import { validateShipsIntegrity } from "../ships/validate.js";

let __ran = false;

export function validateItemBlueprintIntegrity({ verbose = true } = {}) {
  if (__ran) return { ok: true, issues: [] };
  __ran = true;

  const issues = [];

  const push = (kind, msg, extra = {}) => {
    issues.push({ kind, msg, ...extra });
  };

  // -----------------------------
  // 1) Starter loadouts
  // -----------------------------
  try {
    for (const [shipType, entries] of Object.entries(STARTER_LOADOUTS_V2 || {})) {
      for (const entry of entries || []) {
        const key = entry?.itemKey;
        if (!key) {
          push("starter", `Starter entry missing itemKey for ${shipType}.`, { shipType, entry });
          continue;
        }
        if (!ITEM_CATALOG[key]) {
          push(
            "starter",
            `Starter itemKey not found in ITEM_CATALOG: ${key} (shipType=${shipType})`,
            { shipType, itemKey: key }
          );
        }
      }
    }
  } catch (e) {
    push("starter", `Starter validation crashed: ${e?.message || e}`);
  }

  // -----------------------------
  // 2) Blueprint outputs
  // -----------------------------
  try {
    const blueprints = Array.isArray(BLUEPRINT_REGISTRY) ? BLUEPRINT_REGISTRY : Object.values(BLUEPRINT_REGISTRY || {});

    for (const bp of blueprints) {
      if (!bp) continue;
      const outputType = String(bp.outputType || "").toLowerCase();

      // Ships are resolved via shipRegistry/resolveShipId; they don't need ITEM_CATALOG
      if (outputType === "ship") continue;

      const outId = bp.outputItemId || bp.outputItemKey;

      if (!outId) {
        push(
          "blueprint",
          `Blueprint has no outputItemId/outputItemKey (id=${bp.id || "<no-id>"}, outputId=${bp.outputId || ""}, outputType=${bp.outputType || ""}).`,
          { blueprintId: bp.id, outputId: bp.outputId, outputType: bp.outputType }
        );
        continue;
      }

      if (!ITEM_CATALOG[outId]) {
        push(
          "blueprint",
          `Blueprint output not found in ITEM_CATALOG: ${outId} (blueprint=${bp.id || "<no-id>"}).`,
          { blueprintId: bp.id, outputItemId: outId }
        );
      }

      // Optional sanity checks
      if (bp.outputItemKey && bp.outputItemId && bp.outputItemKey !== bp.outputItemId) {
        push(
          "blueprint",
          `Blueprint outputItemKey != outputItemId (${bp.outputItemKey} vs ${bp.outputItemId}) for blueprint=${bp.id || "<no-id>"}.`,
          { blueprintId: bp.id, outputItemKey: bp.outputItemKey, outputItemId: bp.outputItemId }
        );
      }
    }
  } catch (e) {
    push("blueprint", `Blueprint validation crashed: ${e?.message || e}`);
  }

  // -----------------------------
  // 3) Stats resolution integrity
  // -----------------------------
  try {
    const statsRes = validateStatsIntegrity({ verbose: false });
    for (const it of statsRes.issues || []) issues.push(it);
  } catch (e) {
    push("stats", `Stats validation crashed: ${e?.message || e}`);
  }

  const ok = issues.length === 0;

  if (verbose) {
    if (ok) {
      console.log("[Integrity] Item/Blueprint/Ship integrity: OK");
    } else {
      console.warn(`[Integrity] Item/Blueprint integrity: ${issues.length} issue(s) found.`);
      // Print a compact actionable list
      for (const it of issues.slice(0, 50)) {
        console.warn(` - [${it.kind}] ${it.msg}`);
      }
      if (issues.length > 50) {
        console.warn(` - ...and ${issues.length - 50} more.`);
      }
      console.warn("[Integrity] Fix by ensuring catalog.js contains the referenced item ids, and blueprints.js outputs map to those ids.");
    }
  }

  return { ok, issues };
}