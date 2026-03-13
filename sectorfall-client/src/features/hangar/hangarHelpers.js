import { SHIP_REGISTRY } from '../../shipRegistry.js';
import { resolveShipId, resolveShipRegistryKey } from '../../data/ships/catalog.js';

export const prettifyShipId = (value) => {
  const s = String(value || '').trim();
  if (!s) return 'UNKNOWN SHIP';

  const cleaned = s
    .replace(/^ship_/, '')
    .replace(/_t\d+$/i, '')
    .replace(/_/g, ' ')
    .trim();

  return cleaned ? cleaned.toUpperCase() : s.toUpperCase();
};

export const getShipDisplayName = (shipTypeOrId) => {
  const sid = resolveShipId(shipTypeOrId) || shipTypeOrId;
  const regKey = resolveShipRegistryKey(sid) || sid;
  const cfg = SHIP_REGISTRY[regKey] || SHIP_REGISTRY[sid] || SHIP_REGISTRY[shipTypeOrId];
  return cfg?.name || cfg?.displayName || cfg?.label || prettifyShipId(shipTypeOrId);
};

export const getShipClassLabel = (shipTypeOrId) => {
  const sid = resolveShipId(shipTypeOrId) || shipTypeOrId;
  const regKey = resolveShipRegistryKey(sid) || sid;
  const cfg = SHIP_REGISTRY[regKey] || SHIP_REGISTRY[sid] || SHIP_REGISTRY[shipTypeOrId];
  const candidate = cfg?.classLabel || cfg?.className || cfg?.hullClass || cfg?.role || cfg?.classId;
  if (!candidate) return 'VESSEL';
  if (String(candidate).toLowerCase().startsWith('ship_')) return 'VESSEL';
  return String(candidate).toUpperCase();
};

export const getShipRegistryConfig = (shipTypeOrId) => {
  const regKey = resolveShipRegistryKey(shipTypeOrId) || shipTypeOrId;
  return SHIP_REGISTRY[regKey] || SHIP_REGISTRY[shipTypeOrId] || null;
};

export const buildHangarShipRecord = (ship) => {
  const registry = getShipRegistryConfig(ship?.type) || getShipRegistryConfig(ship?.item_id);
  const resolvedType = ship?.type || ship?.item_id || registry?.classId || null;

  return {
    ...ship,
    type: resolvedType,
    classId: registry?.classId || resolvedType,
    isShip: true
  };
};
