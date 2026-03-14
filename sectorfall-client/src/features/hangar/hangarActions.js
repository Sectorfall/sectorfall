export const createHangarActionHandlers = ({
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
    showNotification,
    requestShipActivation,
    repairShipAtStarport,
    cloudService,
    SYSTEM_TO_STARPORT,
    gameManagerRef
}) => {
    const handleShipActivationTransaction = async (ship) => {
        await requestShipActivation({
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
        });
    };

    const handleActivateShip = async (ship) => {
        await handleShipActivationTransaction(ship);
    };

    const handleDepositShip = async (ship) => {
        if (!isDocked || !cloudUser) {
            showNotification("DEPOSIT FAILED: VESSEL MUST BE DOCKED AT STARPORT", "error");
            return;
        }

        const currentSystemId = gameState.currentSystem?.id;
        const starportId = SYSTEM_TO_STARPORT[currentSystemId];

        if (!starportId) {
            showNotification("DEPOSIT FAILED: NO AUTHORITATIVE STARPORT ID", "error");
            return;
        }

        if (ship.id === gameState.activeShipId) {
            showNotification("DEPOSIT FAILED: CANNOT STORE CURRENTLY COMMANDED VESSEL", "error");
            return;
        }

        try {
            const registry = SHIP_REGISTRY[resolveShipRegistryKey(ship.type) || ship.type];
            const shipToSave = {
                ...ship,
                type: ship.type,
                classId: registry?.classId || ship.type,
                isShip: true
            };

            await cloudService.saveToHangar(cloudUser.id, starportId, ship.id, shipToSave);

            setGameState(prev => {
                const newState = {
                    ...prev,
                    ownedShips: prev.ownedShips.filter(s => s.id !== ship.id),
                    hangarShips: [...(prev.hangarShips || []), shipToSave]
                };
      // owned_ships manifest persistence removed; hangar_states is authoritative

                return newState;
            });

            const prettyPort = String(starportId)
                .replace(/_/g, ' ')
                .toLowerCase()
                .replace(/\b\w/g, c => c.toUpperCase());
            showNotification(`${ship.name} secured in hangar at ${prettyPort}.`, "success");
        } catch (err) {
            console.error("Deposit failed:", err);
            showNotification("DEPOSIT FAILED: Could not secure vessel in hangar.", "error");
        }
    };

    const handleCommandShip = async (shipId) => {
        const targetShip = gameState.ownedShips.find(s => s.id === shipId) || gameState.hangarShips.find(s => s.id === shipId);
        if (!targetShip) return;
        await handleShipActivationTransaction(targetShip);
    };

    const handleRepairShip = async (shipId, repairPercent) => {
        await repairShipAtStarport({
            shipId,
            repairPercent,
            cloudService,
            backendSocket,
            gameState,
            setGameState,
            gameManagerRef,
            showNotification,
            SYSTEM_TO_STARPORT
        });
    };

    return {
        handleActivateShip,
        handleDepositShip,
        handleCommandShip,
        handleRepairShip
    };
};
