// LootRules.js
// Pure functions for loot -> inventory normalization and stacking rules.

export function isOreResource(loot = {}) {
  return (
    (loot.type === "resource") &&
    typeof loot.oreType === "string" && loot.oreType.length > 0 &&
    typeof loot.qlBand === "string" && loot.qlBand.length > 0
  );
}

export function normalizeOreInventoryItem(loot = {}, amount = 1) {
  const oreType = loot.oreType;
  const qlBand = loot.qlBand;
  const safeAmount = Number.isFinite(amount) ? Math.max(1, Math.floor(amount)) : 1;

  const qlList = Array.isArray(loot.qlList)
    ? [...loot.qlList]
    : (Number.isFinite(loot.ql) ? Array.from({ length: safeAmount }, () => Math.floor(loot.ql)) : []);

  return {
    ...loot,
    type: "resource",
    oreType,
    qlBand,
    name: `${oreType} [${qlBand}]`,
    description: loot.description || `Unrefined ${oreType}.`,
    maxStack: 999,
    amount: safeAmount,
    qlList,
  };
}

export function calcCargoWeight(items = []) {
  let total = 0;
  for (const it of items) {
    const w = parseFloat(it?.weight);
    const a = Number.isFinite(it?.amount) ? it.amount : 1;
    total += (Number.isFinite(w) ? w : 0.1) * a;
  }
  return total;
}

/**
 * Merge an inventory item into an items array with stacking.
 * Ore/resources stack by oreType+qlBand+rarity.
 * Non-ore stacks by type+name+rarity+quality.
 */
export function mergeIntoInventory(items = [], invItem = {}) {
  const out = Array.isArray(items) ? [...items] : [];
  const item = { ...invItem };

  const canStack = (item.maxStack || 1) > 1;

  if (!canStack) {
    out.push(item);
    return out;
  }

  if (isOreResource(item)) {
    const idx = out.findIndex((it) =>
      it &&
      it.type === "resource" &&
      it.oreType === item.oreType &&
      it.qlBand === item.qlBand &&
      (it.rarity || "common") === (item.rarity || "common") &&
      (it.amount || 0) < (it.maxStack || item.maxStack || 999)
    );

    if (idx !== -1) {
      const existing = { ...out[idx] };
      const max = existing.maxStack || 999;
      const space = max - (existing.amount || 0);
      const add = Math.min(space, item.amount || 1);

      existing.amount = (existing.amount || 0) + add;

      const exQL = Array.isArray(existing.qlList) ? [...existing.qlList] : [];
      const addQL = Array.isArray(item.qlList) ? item.qlList.slice(0, add) : [];
      existing.qlList = exQL.concat(addQL);

      out[idx] = existing;

      const remainder = (item.amount || 1) - add;
      if (remainder > 0) {
        const remQL = Array.isArray(item.qlList) ? item.qlList.slice(add, add + remainder) : [];
        out.push({ ...item, id: `loot-${crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`, amount: remainder, qlList: remQL });
      }
      return out;
    }

    out.push(item);
    return out;
  }

  const idx = out.findIndex((it) =>
    it &&
    it.type === item.type &&
    it.name === item.name &&
    (it.rarity || "common") === (item.rarity || "common") &&
    (Number.isFinite(it.quality) ? it.quality : 50) === (Number.isFinite(item.quality) ? item.quality : 50) &&
    (it.amount || 0) < (it.maxStack || item.maxStack || 1)
  );

  if (idx !== -1) {
    const existing = { ...out[idx] };
    const space = (existing.maxStack || item.maxStack || 1) - (existing.amount || 0);
    const add = Math.min(space, item.amount || 1);
    existing.amount = (existing.amount || 0) + add;
    out[idx] = existing;

    const remainder = (item.amount || 1) - add;
    if (remainder > 0) {
      out.push({ ...item, id: `loot-${crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`, amount: remainder });
    }
    return out;
  }

  out.push(item);
  return out;
}