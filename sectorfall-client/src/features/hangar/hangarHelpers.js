import { SHIP_REGISTRY } from '../../shipRegistry.js';
import { resolveShipId, resolveShipRegistryKey } from '../../data/ships/catalog.js';

const DEFAULT_FITTINGS = {
  weapon1: null,
  weapon2: null,
  active1: null,
  passive1: null,
  passive2: null,
  rig1: null,
  synapse1: null,
  synapse2: null,
  synapse3: null
};

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

export const buildHangarShipRecord = (hangarRow, options = {}) => {
  const { hydrateVessel, fallbackShipType = 'OMNI SCOUT' } = options;
  const config = hangarRow?.ship_config || {};
  const type = config.type || config.item_id || fallbackShipType;
  const registryKey = resolveShipRegistryKey(type) || type;
  const registry = SHIP_REGISTRY[registryKey] || SHIP_REGISTRY[type] || SHIP_REGISTRY[fallbackShipType] || {};

  const baseRecord = {
    ...registry,
    ...config,
    id: hangarRow?.ship_id || config.id,
    type,
    classId: config.classId || registry.classId || type,
    isShip: true,
    hp: config.hp ?? registry.hp,
    energy: config.energy ?? registry.baseEnergy,
    fittings: config.fittings || DEFAULT_FITTINGS,
    dbId: hangarRow?.id
  };

  return typeof hydrateVessel === 'function' ? hydrateVessel(baseRecord, baseRecord) : baseRecord;
};


export const resolveCurrentStarportId = (systemId, systemToStarport = {}) => {
  const key = String(systemId || '').trim();
  return key ? (systemToStarport[key] || null) : null;
};
