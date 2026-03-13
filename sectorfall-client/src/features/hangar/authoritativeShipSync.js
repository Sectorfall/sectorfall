export const createAuthoritativeShipStateHandler = ({
  gameState,
  setGameState,
  gameManagerRef,
  sanitizeAuthoritativeFittings,
  resolveShipId,
  resolveShipRegistryKey,
  SHIP_REGISTRY,
  hydrateVessel,
  getShipDisplayName,
  getShipClassLabel
}) => {
  return (event) => {
    const detail = event?.detail || {};
    const nextCombatStats = detail.combat_stats && typeof detail.combat_stats === 'object'
      ? detail.combat_stats
      : ((detail.combatStats && typeof detail.combatStats === 'object') ? detail.combatStats : null);
    const nextResistances = detail.resistances && typeof detail.resistances === 'object' ? detail.resistances : null;
    const nextFittings = sanitizeAuthoritativeFittings(
      detail.fittings,
      detail.active_ship_stats?.fittings,
      gameManagerRef.current?.fittings,
      gameManagerRef.current?.ship?.fittings,
      gameManagerRef.current?.gameState?.fittings
    );
    const resolvedMaxHp = typeof detail.maxHp === 'number' ? detail.maxHp : (typeof nextCombatStats?.maxHp === 'number' ? nextCombatStats.maxHp : null);
    const resolvedMaxShields = typeof detail.maxShields === 'number' ? detail.maxShields : (typeof nextCombatStats?.maxShields === 'number' ? nextCombatStats.maxShields : null);
    const resolvedMaxEnergy = typeof detail.maxEnergy === 'number' ? detail.maxEnergy : (typeof nextCombatStats?.maxEnergy === 'number' ? nextCombatStats.maxEnergy : null);
    const resolvedArmor = typeof detail.armor === 'number' ? detail.armor : (typeof nextCombatStats?.armor === 'number' ? nextCombatStats.armor : null);
    const authoritativeShipId = resolveShipId(
      nextCombatStats?.shipId
      || detail.shipId
      || detail.ship_id
      || detail.shipType
      || detail.ship_type
      || null
    ) || null;
    const activeShipRecord = (gameState.ownedShips || []).find((ship) => ship && ship.id === gameState.activeShipId)
      || (gameState.hangarShips || []).find((ship) => ship && ship.id === gameState.activeShipId)
      || null;
    const currentLiveShipId = resolveShipId(
      gameManagerRef.current?.ship?.type
      || activeShipRecord?.type
      || gameState.shipClass
      || gameState.activeShipId
      || null
    ) || null;

    console.log('[Authoritative Ship State]', {
      shipId: authoritativeShipId,
      currentLiveShipId,
      hp: detail.hp,
      maxHp: resolvedMaxHp,
      shields: detail.shields,
      maxShields: resolvedMaxShields,
      energy: detail.energy,
      maxEnergy: resolvedMaxEnergy,
      armor: resolvedArmor,
      resistances: nextResistances,
      combat_stats: nextCombatStats,
      fittings: nextFittings
    });

    if (
      authoritativeShipId
      && authoritativeShipId !== currentLiveShipId
      && typeof gameManagerRef.current?.rebuildShip === 'function'
    ) {
      const registryKey = resolveShipRegistryKey(authoritativeShipId) || authoritativeShipId;
      const registryShip = SHIP_REGISTRY[registryKey] || SHIP_REGISTRY[authoritativeShipId] || null;
      if (registryShip) {
        const rebuiltShip = hydrateVessel(
          {
            ...registryShip,
            id: gameState.activeShipId || activeShipRecord?.id || authoritativeShipId,
            type: authoritativeShipId,
            name: getShipDisplayName(authoritativeShipId)
          },
          {
            ...(activeShipRecord || {}),
            id: gameState.activeShipId || activeShipRecord?.id || authoritativeShipId,
            type: authoritativeShipId,
            name: getShipDisplayName(authoritativeShipId),
            hp: typeof detail.hp === 'number' ? detail.hp : activeShipRecord?.hp,
            maxHp: typeof resolvedMaxHp === 'number' ? resolvedMaxHp : activeShipRecord?.maxHp,
            shields: typeof detail.shields === 'number' ? detail.shields : activeShipRecord?.shields,
            maxShields: typeof resolvedMaxShields === 'number' ? resolvedMaxShields : activeShipRecord?.maxShields,
            energy: typeof detail.energy === 'number' ? detail.energy : activeShipRecord?.energy,
            maxEnergy: typeof resolvedMaxEnergy === 'number' ? resolvedMaxEnergy : activeShipRecord?.maxEnergy,
            armor: typeof resolvedArmor === 'number' ? resolvedArmor : activeShipRecord?.armor,
            resistances: nextResistances || activeShipRecord?.resistances,
            combatStats: nextCombatStats || activeShipRecord?.combatStats,
            fittings: nextFittings
          },
          {
            hp: typeof detail.hp === 'number' ? detail.hp : undefined,
            maxHp: typeof resolvedMaxHp === 'number' ? resolvedMaxHp : undefined,
            shields: typeof detail.shields === 'number' ? detail.shields : undefined,
            maxShields: typeof resolvedMaxShields === 'number' ? resolvedMaxShields : undefined,
            energy: typeof detail.energy === 'number' ? detail.energy : undefined,
            maxEnergy: typeof resolvedMaxEnergy === 'number' ? resolvedMaxEnergy : undefined,
            fittings: nextFittings
          }
        );
        gameManagerRef.current.rebuildShip(rebuiltShip);
        console.log('[Authoritative Ship State] rebuildShip applied for authoritative ship:', authoritativeShipId);
      }
    }

    setGameState(prev => ({
      ...prev,
      shipName: authoritativeShipId ? getShipDisplayName(authoritativeShipId) : prev.shipName,
      shipClass: authoritativeShipId ? getShipClassLabel(authoritativeShipId) : prev.shipClass,
      hp: typeof detail.hp === 'number' ? detail.hp : prev.hp,
      maxHp: typeof resolvedMaxHp === 'number' ? resolvedMaxHp : prev.maxHp,
      shields: typeof detail.shields === 'number' ? detail.shields : prev.shields,
      maxShields: typeof resolvedMaxShields === 'number' ? resolvedMaxShields : prev.maxShields,
      energy: typeof detail.energy === 'number' ? detail.energy : prev.energy,
      maxEnergy: typeof resolvedMaxEnergy === 'number' ? resolvedMaxEnergy : prev.maxEnergy,
      armor: typeof resolvedArmor === 'number' ? resolvedArmor : prev.armor,
      resistances: nextResistances || prev.resistances,
      combatStats: nextCombatStats || prev.combatStats,
      fittings: sanitizeAuthoritativeFittings(nextFittings, prev.fittings),
      ownedShips: Array.isArray(prev.ownedShips)
        ? prev.ownedShips.map((ship) => {
            if (!ship || ship.id !== prev.activeShipId) return ship;
            return {
              ...ship,
              type: authoritativeShipId || ship.type,
              name: authoritativeShipId ? getShipDisplayName(authoritativeShipId) : ship.name,
              classId: authoritativeShipId ? getShipClassLabel(authoritativeShipId) : ship.classId,
              hp: typeof detail.hp === 'number' ? detail.hp : ship.hp,
              maxHp: typeof resolvedMaxHp === 'number' ? resolvedMaxHp : ship.maxHp,
              shields: typeof detail.shields === 'number' ? detail.shields : ship.shields,
              maxShields: typeof resolvedMaxShields === 'number' ? resolvedMaxShields : ship.maxShields,
              energy: typeof detail.energy === 'number' ? detail.energy : ship.energy,
              maxEnergy: typeof resolvedMaxEnergy === 'number' ? resolvedMaxEnergy : ship.maxEnergy,
              armor: typeof resolvedArmor === 'number' ? resolvedArmor : ship.armor,
              resistances: nextResistances || ship.resistances,
              combatStats: nextCombatStats || ship.combatStats,
              fittings: sanitizeAuthoritativeFittings(nextFittings, ship.fittings),
              kineticRes: nextResistances ? Number(nextResistances.kinetic || 0) : ship.kineticRes,
              thermalRes: nextResistances ? Number(nextResistances.thermal || 0) : ship.thermalRes,
              blastRes: nextResistances ? Number(nextResistances.blast || 0) : ship.blastRes
            };
          })
        : prev.ownedShips
    }));

    if (gameManagerRef.current?.stats) {
      if (typeof detail.hp === 'number') gameManagerRef.current.stats.hp = detail.hp;
      if (typeof resolvedMaxHp === 'number') gameManagerRef.current.stats.maxHp = resolvedMaxHp;
      if (typeof detail.shields === 'number') gameManagerRef.current.stats.shields = detail.shields;
      if (typeof resolvedMaxShields === 'number') gameManagerRef.current.stats.maxShields = resolvedMaxShields;
      if (typeof detail.energy === 'number') gameManagerRef.current.stats.energy = detail.energy;
      if (typeof resolvedMaxEnergy === 'number') gameManagerRef.current.stats.maxEnergy = resolvedMaxEnergy;
      if (typeof resolvedArmor === 'number') gameManagerRef.current.stats.armor = resolvedArmor;
      if (detail.resistances && typeof detail.resistances === 'object') {
        gameManagerRef.current.stats.kineticRes = Number(detail.resistances.kinetic || 0);
        gameManagerRef.current.stats.thermalRes = Number(detail.resistances.thermal || 0);
        gameManagerRef.current.stats.blastRes = Number(detail.resistances.blast || 0);
        gameManagerRef.current.stats.resistances = { ...detail.resistances };
      }
      if (detail.combat_stats && typeof detail.combat_stats === 'object') {
        gameManagerRef.current.stats.combatStats = detail.combat_stats;
      } else if (detail.combatStats && typeof detail.combatStats === 'object') {
        gameManagerRef.current.stats.combatStats = detail.combatStats;
      }
      gameManagerRef.current.fittings = sanitizeAuthoritativeFittings(nextFittings, gameManagerRef.current.fittings);
      gameManagerRef.current.gameState = {
        ...(gameManagerRef.current.gameState || {}),
        fittings: sanitizeAuthoritativeFittings(nextFittings, gameManagerRef.current.gameState?.fittings)
      };
    }

    if (gameManagerRef.current?.ship) {
      if (typeof detail.hp === 'number') gameManagerRef.current.ship.hp = detail.hp;
      if (typeof resolvedMaxHp === 'number') gameManagerRef.current.ship.maxHp = resolvedMaxHp;
      if (typeof detail.shields === 'number') gameManagerRef.current.ship.shields = detail.shields;
      if (typeof resolvedMaxShields === 'number') gameManagerRef.current.ship.maxShields = resolvedMaxShields;
      if (typeof detail.energy === 'number') gameManagerRef.current.ship.energy = detail.energy;
      if (typeof resolvedMaxEnergy === 'number') gameManagerRef.current.ship.maxEnergy = resolvedMaxEnergy;
      if (typeof resolvedArmor === 'number') gameManagerRef.current.ship.armor = resolvedArmor;
      if (detail.resistances && typeof detail.resistances === 'object') {
        gameManagerRef.current.ship.resistances = { ...detail.resistances };
        gameManagerRef.current.ship.kineticRes = Number(detail.resistances.kinetic || 0);
        gameManagerRef.current.ship.thermalRes = Number(detail.resistances.thermal || 0);
        gameManagerRef.current.ship.blastRes = Number(detail.resistances.blast || 0);
      }
      if (detail.combat_stats && typeof detail.combat_stats === 'object') {
        gameManagerRef.current.ship.combatStats = detail.combat_stats;
      } else if (detail.combatStats && typeof detail.combatStats === 'object') {
        gameManagerRef.current.ship.combatStats = detail.combatStats;
      }
      gameManagerRef.current.ship.fittings = sanitizeAuthoritativeFittings(nextFittings, gameManagerRef.current.ship.fittings);
    }
  };
};
