import { buildHangarShipRecord } from './hangarHelpers.js';

export const requestShipActivation = async ({
  ship,
  isDocked,
  cloudUser,
  backendSocket,
  gameState,
  setGameState,
  hydrateVessel,
  resolveShipRegistryKey,
  getLiveShipResources,
  getShipDisplayName,
  getShipClassLabel,
  SHIP_REGISTRY,
  showNotification
}) => {
  if (!isDocked || !cloudUser) {
    showNotification('ACTIVATE FAILED: VESSEL MUST BE DOCKED AT STARPORT', 'error');
    return;
  }

  if (!backendSocket?.requestActivateShip) {
    showNotification('ACTIVATE FAILED: BACKEND COMMAND UNAVAILABLE', 'error');
    return;
  }

  const shipId = String(ship?.id || '').trim();
  if (!shipId) {
    showNotification('ACTIVATE FAILED: INVALID SHIP', 'error');
    return;
  }

  if (shipId === gameState.activeShipId) {
    showNotification(`${ship.name || 'Ship'} already current.`, 'info');
    return;
  }

  try {
    const result = await backendSocket.requestActivateShip({ shipId });
    if (!result?.ok) {
      showNotification(`ACTIVATE FAILED: ${String(result?.error || 'backend_rejected').replace(/_/g, ' ').toUpperCase()}`, 'error');
      return;
    }

    const targetShip = hydrateVessel(ship, ship);
    const shipConfig = SHIP_REGISTRY[resolveShipRegistryKey(targetShip.type) || targetShip.type] || SHIP_REGISTRY[targetShip.type] || {};
    const resources = getLiveShipResources(targetShip.fittings || {});

    setGameState(prev => {
      const currentActiveShip = (prev.ownedShips || []).find(s => s.id === prev.activeShipId)
        || (prev.hangarShips || []).find(s => s.id === prev.activeShipId)
        || null;

      const nextOwnedShips = (prev.ownedShips || []).filter(s => s.id !== shipId && s.id !== currentActiveShip?.id);
      nextOwnedShips.push(targetShip);

      const nextHangarShips = (prev.hangarShips || []).filter(s => s.id !== shipId && s.id !== currentActiveShip?.id);
      if (currentActiveShip && currentActiveShip.id !== shipId) {
        nextHangarShips.push({ ...currentActiveShip });
      }

      return {
        ...prev,
        hangarShips: nextHangarShips,
        ownedShips: nextOwnedShips,
        activeShipId: shipId,
        shipName: getShipDisplayName(targetShip.type),
        shipClass: getShipClassLabel(targetShip.type),
        fittings: targetShip.fittings || {},
        currentPowerGrid: resources.power,
        currentCpu: resources.cpu,
        maxHp: typeof targetShip.maxHp === 'number' ? targetShip.maxHp : (shipConfig.hp || prev.maxHp),
        hp: typeof targetShip.hp === 'number' ? targetShip.hp : (shipConfig.hp || prev.hp),
        armor: typeof targetShip.armor === 'number' ? targetShip.armor : (shipConfig.armor || prev.armor),
        kineticRes: typeof targetShip.kineticRes === 'number' ? targetShip.kineticRes : (shipConfig.kineticRes || prev.kineticRes),
        thermalRes: typeof targetShip.thermalRes === 'number' ? targetShip.thermalRes : (shipConfig.thermalRes || prev.thermalRes),
        blastRes: typeof targetShip.blastRes === 'number' ? targetShip.blastRes : (shipConfig.blastRes || prev.blastRes),
        maxEnergy: typeof targetShip.maxEnergy === 'number' ? targetShip.maxEnergy : (shipConfig.baseEnergy || prev.maxEnergy),
        energy: typeof targetShip.energy === 'number' ? targetShip.energy : (shipConfig.baseEnergy || prev.energy),
        reactorRecovery: shipConfig.baseEnergyRecharge || prev.reactorRecovery || 1.0,
        maxPowerGrid: shipConfig.basePG || prev.maxPowerGrid,
        maxCpu: shipConfig.baseCPU || prev.maxCpu,
        cargoHold: shipConfig.cargo || prev.cargoHold,
        baseAcceleration: shipConfig.acceleration || prev.baseAcceleration,
        maxSpeed: shipConfig.maxSpeed || prev.maxSpeed,
        rotationSpeed: shipConfig.rotationSpeed || prev.rotationSpeed,
        activeWeapons: []
      };
    });

    showNotification(`${targetShip.name} activated and previous vessel secured in hangar.`, 'success');
  } catch (error) {
    console.error('[HangarService] activateShip failed', error);
    showNotification('ACTIVATE FAILED: BACKEND REJECTED COMMAND', 'error');
  }
};

export const repairShipAtStarport = async ({
  shipId,
  repairPercent,
  cloudService,
  backendSocket,
  gameState,
  setGameState,
  gameManagerRef,
  showNotification,
  SYSTEM_TO_STARPORT
}) => {
  const userId = cloudService.user?.id;
  if (!userId) {
    console.warn('[HangarService] repairShipAtStarport: No user ID');
    return;
  }

  try {
    const result = await backendSocket.requestRepairShip({ shipId, repairPercent });

    if (!result) {
      showNotification('REPAIR FAILED: Backend timeout.', 'error');
      return;
    }

    if (!result.ok) {
      if (typeof result.credits === 'number') {
        setGameState(prev => ({ ...prev, credits: result.credits }));
      }
      const reasonMap = {
        not_docked: 'REPAIR FAILED: You must be docked.',
        invalid_request: 'REPAIR FAILED: Invalid repair request.',
        insufficient_credits: 'REPAIR FAILED: Insufficient credits.',
        nothing_to_repair: 'REPAIR FAILED: Hull is already at full integrity.',
        persist_failed: 'REPAIR FAILED: Persistence layer rejected the repair.'
      };
      showNotification(reasonMap[result.error] || 'REPAIR FAILED: Internal facility error.', 'error');
      return;
    }

    const currentStarportId = SYSTEM_TO_STARPORT[gameState.currentSystem?.id];
    let updatedHangar = [];
    if (currentStarportId) {
      updatedHangar = await cloudService.getHangarShips(userId, currentStarportId);
    }

    if (result.isActiveShip && gameManagerRef.current) {
      if (gameManagerRef.current.stats && typeof gameManagerRef.current.stats === 'object') {
        gameManagerRef.current.stats.hp = result.nextHp;
        if (typeof result.maxHp === 'number') {
          gameManagerRef.current.stats.maxHp = result.maxHp;
        }
      }
      if (gameManagerRef.current.ship) {
        gameManagerRef.current.ship.hp = result.nextHp;
        if (typeof result.maxHp === 'number') {
          gameManagerRef.current.ship.maxHp = result.maxHp;
        }
      }
    }

    setGameState(prev => {
      const nextOwnedShips = prev.ownedShips.map(s => {
        if (s.id === shipId) {
          return { ...s, hp: result.nextHp, maxHp: result.maxHp ?? s.maxHp };
        }
        return s;
      });

      const isNowActive = shipId === prev.activeShipId;
      const nextHp = isNowActive ? result.nextHp : prev.hp;

      return {
        ...prev,
        credits: typeof result.credits === 'number' ? result.credits : prev.credits,
        hp: nextHp,
        ownedShips: nextOwnedShips,
        hangarShips: updatedHangar.length > 0 ? updatedHangar.map(s => s.ship_config) : prev.hangarShips
      };
    });

    showNotification(`REPAIR COMPLETE: Hull integrity restored. Deducted ${Number(result.repairCost || 0).toLocaleString()} Cr.`, 'success');
  } catch (error) {
    console.error('[HangarService] repairShipAtStarport failed:', error);
    showNotification('REPAIR FAILED: Internal facility error. Credits not deducted.', 'error');
  }
};

export const transferShipToHangar = async ({
  item,
  cloudUser,
  starportId,
  cloudService,
  setGameState,
  showNotification,
  SHIP_REGISTRY
}) => {
  try {
    const registry = SHIP_REGISTRY[item.type || item.item_id];
    const shipToSave = {
      ...item,
      type: item.type || item.item_id,
      classId: registry?.classId || (item.type || item.item_id),
      isShip: true
    };
    await cloudService.saveToHangar(cloudUser.id, starportId, item.id, shipToSave);
    setGameState(prev => ({
      ...prev,
      ownedShips: prev.ownedShips.filter(s => s.id !== item.id),
      hangarShips: [...(prev.hangarShips || []), shipToSave]
    }));
    showNotification(`${item.name} transferred to hangar.`, 'success');
  } catch (err) {
    console.error('[HangarService] transferShipToHangar failed', err);
    showNotification('TRANSFER FAILED: Could not save to hangar.', 'error');
  }
};

export const transferShipFromHangar = async ({
  item,
  cloudUser,
  cloudService,
  setGameState,
  showNotification,
  hydrateVessel
}) => {
  try {
    await cloudService.removeFromHangar(cloudUser.id, item.id);
    setGameState(prev => {
      const hydratedShip = hydrateVessel(item, item);
      const newState = {
        ...prev,
        hangarShips: prev.hangarShips.filter(s => s.id !== item.id),
        ownedShips: [...prev.ownedShips, hydratedShip]
      };

      cloudService.updateCommanderData(cloudUser.id, {
        owned_ships: newState.ownedShips
      });

      return newState;
    });
    showNotification(`${item.name} activated from hangar.`, 'success');
  } catch (err) {
    console.error('[HangarService] transferShipFromHangar failed', err);
    showNotification('TRANSFER FAILED: Could not remove from hangar.', 'error');
  }
};


export const loadDockedStarportData = async ({
  isDocked,
  playerId,
  starportId,
  cloudService,
  hydrateItem,
  hydrateVessel
}) => {
  if (!isDocked || !playerId || !starportId) {
    return { stationStorage: [], hangarShips: [] };
  }

  const [inventoryState, hangarData] = await Promise.all([
    cloudService.getInventoryState(playerId, starportId),
    cloudService.getHangarShips(playerId, starportId)
  ]);

  const stationStorage = (Array.isArray(inventoryState?.items) ? inventoryState.items : [])
    .filter(i => i.type !== 'ship' && !i.isShip)
    .map(item => (typeof hydrateItem === 'function' ? hydrateItem(item) : item));

  const hangarShips = (hangarData || []).map(h => buildHangarShipRecord(h, {
    hydrateVessel,
    fallbackShipType: 'OMNI SCOUT'
  }));

  return { stationStorage, hangarShips };
};
