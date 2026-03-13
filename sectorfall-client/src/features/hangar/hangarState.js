import { useEffect, useMemo, useState } from 'react';
import { resolveShipId } from '../../data/ships/catalog.js';

function numOr(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function useStationInteriorHangarState(gameState) {
  const [view, setView] = useState('hangar');
  const [repairMenuShipId, setRepairMenuShipId] = useState(null);
  const [repairProgress, setRepairProgress] = useState(0);
  const [selectedShipId, setSelectedShipId] = useState(gameState.activeShipId);

  const activeOwnedShip = useMemo(
    () => (gameState.ownedShips || []).find((ship) => ship && ship.id === gameState.activeShipId) || null,
    [gameState.ownedShips, gameState.activeShipId]
  );

  const allShips = useMemo(() => {
    return [
      ...(activeOwnedShip ? [activeOwnedShip] : []),
      ...(gameState.hangarShips || []),
      ...((gameState.ownedShips || []).filter((ship) => ship && ship.id !== gameState.activeShipId))
    ].filter((ship, idx, arr) => ship && arr.findIndex((candidate) => candidate && candidate.id === ship.id) === idx);
  }, [activeOwnedShip, gameState.hangarShips, gameState.ownedShips, gameState.activeShipId]);

  const selectedShip = useMemo(() => {
    return allShips.find((ship) => ship.id === selectedShipId)
      || allShips.find((ship) => ship.id === gameState.activeShipId)
      || allShips[0]
      || null;
  }, [allShips, selectedShipId, gameState.activeShipId]);

  const selectedShipIsActive = Boolean(selectedShip && selectedShip.id === gameState.activeShipId);

  const telemetryShip = useMemo(() => {
    if (!selectedShip) return null;

    if (!selectedShipIsActive) {
      return {
        ...selectedShip,
        type: resolveShipId(selectedShip.type) || selectedShip.type,
        armor: 0,
        resistances: {},
        combat_stats: null,
        combatStats: null,
        kineticRes: 0,
        thermalRes: 0,
        blastRes: 0
      };
    }

    const activeCombatStats = (gameState.combatStats && typeof gameState.combatStats === 'object')
      ? gameState.combatStats
      : ((gameState.combat_stats && typeof gameState.combat_stats === 'object') ? gameState.combat_stats : null);

    const selectedCombatStats = (selectedShip.combat_stats && typeof selectedShip.combat_stats === 'object')
      ? selectedShip.combat_stats
      : ((selectedShip.combatStats && typeof selectedShip.combatStats === 'object') ? selectedShip.combatStats : null);

    return {
      ...selectedShip,
      type: resolveShipId(gameState.shipClass || selectedShip.type) || selectedShip.type,
      hp: numOr(gameState.hp, numOr(selectedShip.hp, 0)),
      maxHp: numOr(gameState.maxHp, numOr(selectedShip.maxHp, numOr(selectedShip.hp, 0))),
      shields: numOr(gameState.shields, numOr(selectedShip.shields, 0)),
      maxShields: numOr(gameState.maxShields, numOr(selectedShip.maxShields, numOr(selectedShip.shields, 0))),
      energy: numOr(gameState.energy, numOr(selectedShip.energy, 0)),
      maxEnergy: numOr(gameState.maxEnergy, numOr(selectedShip.maxEnergy, numOr(selectedShip.energy, 0))),
      armor: numOr(gameState.armor, 0),
      resistances: (gameState.resistances && typeof gameState.resistances === 'object') ? gameState.resistances : {},
      combat_stats: activeCombatStats || selectedCombatStats,
      combatStats: activeCombatStats || selectedCombatStats,
      fittings: gameState.fittings || selectedShip.fittings || {}
    };
  }, [selectedShip, selectedShipIsActive, gameState]);

  useEffect(() => {
    if (!selectedShipId && gameState.activeShipId) {
      setSelectedShipId(gameState.activeShipId);
    }
  }, [selectedShipId, gameState.activeShipId]);

  return {
    view,
    setView,
    repairMenuShipId,
    setRepairMenuShipId,
    repairProgress,
    setRepairProgress,
    selectedShipId,
    setSelectedShipId,
    allShips,
    selectedShip,
    selectedShipIsActive,
    telemetryShip
  };
}
