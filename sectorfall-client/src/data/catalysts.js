/**
 * AUTO-EXTRACTED from GameManager_refactored.js
 * Purpose: keep GameManager lean; pure data exports.
 */

export const FLUX_CATALYSTS = {
    'quantum-uplifter': {
        id: 'catalyst-quantum-uplifter',
        name: 'Quantum Uplifter',
        rarity: 'common',
        description: 'A compact energy cell that floods an item with low-grade quantum charge. Used to convert a Common item into an Uncommon.'
    },
    'nano-infusion-chip': {
        id: 'catalyst-nano-infusion-chip',
        name: 'Nano-Infusion Chip',
        rarity: 'common',
        description: 'A micro-engineered chip that injects nanites into dormant circuitry, activating a single new low-tier modifier on an item.'
    },
    'pattern-rewriter': {
        id: 'catalyst-pattern-rewriter',
        name: 'Pattern Rewriter',
        rarity: 'uncommon',
        description: 'A waveform-scrambling tool that destabilizes an item’s internal modulation pattern, causing its stats to shift into a new configuration.'
    },
    'molecular-purge-cell': {
        id: 'catalyst-molecular-purge-cell',
        name: 'Molecular Purge Cell',
        rarity: 'uncommon',
        description: 'A sterilizing energy capsule that strips an item down to its raw molecular lattice, removing every modifier while preserving rarity.'
    },
    'fault-line-scrubber': {
        id: 'catalyst-fault-line-scrubber',
        name: 'Fault-Line Scrubber',
        rarity: 'uncommon',
        description: 'A targeted disruption tool that collapses one modulation channel at random, without disturbing the rest.'
    },
    'singularity-catalyst': {
        id: 'catalyst-singularity-catalyst',
        name: 'Singularity Catalyst',
        rarity: 'rare',
        description: 'A miniature artificial singularity that collapses and reforms the item’s internal structure, generating randomized modifiers.'
    },
    'entropy-reconstructor': {
        id: 'catalyst-entropy-reconstructor',
        name: 'Entropy Reconstructor',
        rarity: 'rare',
        description: 'A volatile entropy core that tears apart every modulation on an item and rebuilds them from scratch.'
    },
    'reality-recalibrator': {
        id: 'catalyst-reality-recalibrator',
        name: 'Reality Recalibrator',
        rarity: 'rare',
        description: 'A precision quantum stabilizer that fine-tunes the numerical values of existing modifiers toward their maximum potential.'
    },
    'imperial-charge-core': {
        id: 'catalyst-imperial-charge-core',
        name: 'Imperial Charge Core',
        rarity: 'rare',
        description: 'A high-density power core that injects enough energy to open a new major modulation slot, adding a powerful effect.'
    },
    'ascendant-modulator': {
        id: 'catalyst-ascendant-modulator',
        name: 'Ascendant Modulator',
        rarity: 'very_rare',
        description: 'A rare, unstable modulator capable of imprinting an Ascendant-grade property onto an item.'
    }
};

export const CATALYST_DROP_TABLES = {
    'Scout': {
        chance: 0.10,
        weights: { common: 1.0, uncommon: 0, rare: 0, very_rare: 0 }
    },
    'OMNI INTERCEPTOR': {
        chance: 0.15,
        weights: { common: 0.80, uncommon: 0.20, rare: 0, very_rare: 0 }
    },
    'Gunship': {
        chance: 0.25,
        weights: { common: 0.50, uncommon: 0.40, rare: 0.10, very_rare: 0 }
    },
    'Destroyer': {
        chance: 0.35,
        weights: { common: 0.30, uncommon: 0.50, rare: 0.20, very_rare: 0.05 } // Added tiny very_rare chance to Destroyer
    }
};