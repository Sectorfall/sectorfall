/**
 * Stats integrity validation
 *
 * Phase 3 (stats): detect catalog/blueprint items that cannot resolve stats.
 * Non-throwing: logs actionable warnings.
 */

import { ITEM_CATALOG } from "../items/catalog.js";
import { BLUEPRINT_REGISTRY } from "../blueprints.js";
import { resolveStatsForItem } from "./stats.helpers.js";

function needsStats(item) {
  if (!item) return false;
  const t = String(item.type || "").toLowerCase();
  // resource/loot/currency/etc
  if (["ore", "resource", "material", "commodity", "currency", "consumable", "blueprint", "ship"].includes(t)) return false;
  // Anything that can be equipped should have stats.
  return ["weapon", "shield", "thruster", "drone-module", "module"].includes(t) || !!item.size || !!item.weaponsize;
}

export function validateStatsIntegrity({ verbose = true } = {}) {
  const issues = [];
  const push = (kind, msg, extra = {}) => issues.push({ kind, msg, ...extra });

  // 1) Catalog items
  try {
    for (const [itemId, item] of Object.entries(ITEM_CATALOG || {})) {
      if (!needsStats(item)) continue;
      const hydrated = resolveStatsForItem({ ...item, item_id: itemId });
      if (!hydrated) {
        push(
          "stats",
          `Catalog item has no resolvable stats: ${itemId} (type=${item?.type || "?"}, name=${item?.name || "?"}).`,
          { itemId, type: item?.type, name: item?.name }
        );
      }
    }
  } catch (e) {
    push("stats", `Catalog stats validation crashed: ${e?.message || e}`);
  }

  // 2) Blueprint outputs
  try {
    const blueprints = Array.isArray(BLUEPRINT_REGISTRY) ? BLUEPRINT_REGISTRY : Object.values(BLUEPRINT_REGISTRY || {});
    for (const bp of blueprints) {
      if (!bp) continue;
      const outputType = String(bp.outputType || "").toLowerCase();
      if (outputType === "ship") continue;
      const outId = bp.outputItemId || bp.outputItemKey;
      if (!outId) continue;
      const tpl = ITEM_CATALOG?.[outId];
      if (!tpl) continue; // handled by items validator
      if (!needsStats(tpl)) continue;
      const hydrated = resolveStatsForItem({ ...tpl, item_id: outId });
      if (!hydrated) {
        push(
          "stats",
          `Blueprint output item has no resolvable stats: ${outId} (blueprint=${bp.id || "<no-id>"}).`,
          { blueprintId: bp.id, outputItemId: outId }
        );
      }
    }
  } catch (e) {
    push("stats", `Blueprint stats validation crashed: ${e?.message || e}`);
  }

  const ok = issues.length === 0;

  if (verbose) {
    if (ok) {
      console.log("[Integrity] Stats integrity: OK");
    } else {
      console.warn(`[Integrity] Stats integrity: ${issues.length} issue(s) found.`);
      for (const it of issues.slice(0, 50)) console.warn(` - [${it.kind}] ${it.msg}`);
      if (issues.length > 50) console.warn(` - ...and ${issues.length - 50} more.`);
      console.warn("[Integrity] Fix by adding missing mappings in stats.helpers.js (or correcting item type/size/name to match existing config tables)." );
    }
  }

  return { ok, issues };
}