export function getFormattedFittingTitle(slot) {
    if (slot.type === 'outfit') return `BODY SLOT: ${slot.fullName}`;
    if (slot.type === 'implant') return `IMPLANT LOCATION: ${slot.fullName}`;
    if (slot.type === 'weapon') return `HARDPOINT: WEAPON ${slot.id.replace('weapon', '')}`;
    if (slot.type === 'mining') return 'HARDPOINT: MINING LASER';
    if (slot.type === 'active') return 'SYSTEM: CORE FITTING';
    if (slot.type === 'passive') return 'SYSTEM: UTILITY FITTING';
    if (slot.type === 'rig') return 'HULL: RIG FITTING';
    return `HARDPOINT: ${slot.type.toUpperCase()}`;
}

export function getFittingHardwareTitle(slot) {
    if (slot.type === 'active') return 'CORE HARDWARE';
    if (slot.type === 'passive') return 'UTILITY HARDWARE';
    return `${slot.type.toUpperCase()} HARDWARE`;
}

function getRequiredCommanderStatValue(gameState, item, getCommanderStats) {
    if (!item?.requiredStatType || !item?.requiredStatValue) return { statError: false, currentStatValue: 0 };
    const stats = getCommanderStats(gameState);
    const currentStatValue = item.requiredStatType === 'Neural Stability'
        ? stats.neuralStability
        : item.requiredStatType === 'Bio-Tolerance'
            ? stats.bioTolerance
            : item.requiredStatType === 'Motor Integration'
                ? stats.motorIntegration
                : 0;
    return {
        statError: currentStatValue < item.requiredStatValue,
        currentStatValue
    };
}

export function evaluateFittingCandidate({
    item,
    slot,
    gameState,
    isDocked,
    equipped,
    isShipFitting,
    getLiveShipResources,
    getCommanderStats
}) {
    let pwrError = false;
    let cpuError = false;

    if (isShipFitting) {
        const nextFittings = { ...gameState.fittings, [slot.id]: item };
        const { power, cpu } = getLiveShipResources(nextFittings);
        pwrError = power > gameState.maxPowerGrid;
        cpuError = cpu > gameState.maxCpu;
    }

    const { statError } = getRequiredCommanderStatValue(gameState, item, getCommanderStats);
    const buttonTitle = !isDocked
        ? 'Module fitting is only available while docked at a Starport.'
        : (statError ? `Insufficient ${item.requiredStatType}` : '');
    const actionLabel = !isDocked
        ? 'LOCKED'
        : (statError ? 'STAT REQ' : ((pwrError || cpuError) ? 'LIMIT EXCEEDED' : (equipped ? 'SWAP' : 'INSTALL')));

    return {
        pwrError,
        cpuError,
        statError,
        buttonTitle,
        actionLabel
    };
}

export function buildInstallFittingWarning({ item, nextPowerGrid, nextCpu, maxPowerGrid, maxCpu }) {
    return {
        moduleName: item.name,
        powerDeficit: Math.max(0, nextPowerGrid - maxPowerGrid),
        cpuDeficit: Math.max(0, nextCpu - maxCpu)
    };
}
