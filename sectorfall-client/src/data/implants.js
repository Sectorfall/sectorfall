/**
 * AUTO-EXTRACTED from GameManager_refactored.js
 * Purpose: keep GameManager lean; pure data exports.
 */

export const IMPLANT_REGISTRY = {
    'neural-accelerator': {
        id: 'implant-neural-accelerator',
        name: 'Neural Accelerator',
        slot: 'brain',
        rarity: 'rare',
        requiredStatType: 'Neural Stability',
        description: 'Overclocks the synaptic pathways, increasing reaction speed and targeting precision.',
        stats: { tracking: 5, baseAccuracy: 0.05 },
        requirements: [{ resource: 'ORGANIC BIO-MATERIAL', amount: 5 }]
    },
    'ocular-sensor-mk1': {
        id: 'implant-ocular-sensor-mk1',
        name: 'Ocular Sensor Mk.I',
        slot: 'eye',
        rarity: 'uncommon',
        requiredStatType: 'Bio-Tolerance',
        description: 'Enhanced ocular processing for long-range targeting and scanning.',
        stats: { scanRange: 100, lockOnRange: 200 },
        requirements: [{ resource: 'ORGANIC BIO-MATERIAL', amount: 8 }]
    },
    'bio-cardio-pump': {
        id: 'implant-bio-cardio-pump',
        name: 'Bio-Cardio Pump',
        slot: 'chest',
        rarity: 'rare',
        requiredStatType: 'Motor Integration',
        description: 'A biological pump that regulates adrenaline flow, improving physical endurance and power management.',
        stats: { baseEnergyRecharge: 1, reactorRegulation: 5 },
        requirements: [{ resource: 'ORGANIC BIO-MATERIAL', amount: 5 }]
    },
    'synaptic-feedback-loop': {
        id: 'implant-synaptic-feedback-loop',
        name: 'Synaptic Feedback Loop',
        slot: 'brain',
        rarity: 'epic',
        requiredStatType: 'Neural Stability',
        description: 'Creates a closed-loop neural circuit that significantly improves cognitive processing of complex systems.',
        stats: { cpu: 15, nanoProgramming: 10 },
        requirements: [{ resource: 'ORGANIC BIO-MATERIAL', amount: 3 }]
    },
    'kinetic-stabilizer-arm': {
        id: 'implant-kinetic-stabilizer-arm',
        name: 'Kinetic Stabilizer',
        slot: 'rightArm',
        rarity: 'rare',
        requiredStatType: 'Motor Integration',
        description: 'Micro-servos integrated into the arm structure to minimize weapon recoil and jitter.',
        stats: { kineticCannonProficiency: 8, tracking: 3 },
        requirements: [{ resource: 'ORGANIC BIO-MATERIAL', amount: 5 }]
    }
};