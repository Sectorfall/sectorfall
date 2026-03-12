/**
 * systemsRegistry.js
 * Extracted from GameManager to keep GameManager lean.
 */

export const SYSTEMS_REGISTRY = {
    'cygnus-prime': {
        name: 'Cygnus Prime',
        cluster: 'alpha',
        sector: '01',
        security: 'Full (1.0)',
        securityValue: 1.0,
        tier: 1,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 75,
        hasStarport: true,
        controlledBy: 'OMNI DIRECTORATE',
        coords: { x: 0, y: 0 },
        sun: { pos: { x: 350, y: 250 }, size: 180 },
        planet: { pos: { x: -700, y: -400 }, size: 90 },
        anomaly: { 
            id: 'anomaly-cygnus-prime',
            name: 'VORTEX ANOMALY',
            pos: { x: 1500, y: 1000 }, 
            size: 450
        },
        belts: [] // Now handled procedurally
    },
    'aurelia-ridge': {
        name: 'Aurelia Ridge',
        cluster: 'alpha',
        sector: '02',
        security: 'Secure (0.9)',
        securityValue: 0.9,
        tier: 1,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 200,
        hasStarport: false,
        hasWarpGate: true,
        warpGatePos: { x: 1200, y: 1200 },
        coords: { x: 150, y: -100 },
        sun: { pos: { x: -450, y: 350 }, size: 240 },
        planet: { pos: { x: 600, y: -200 }, size: 70 },
        belts: []
    },
    'novara-reach': {
        name: 'Novara Reach',
        cluster: 'alpha',
        sector: '05',
        security: 'Secure (0.8)',
        securityValue: 0.8,
        tier: 1,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 200,
        hasStarport: false,
        coords: { x: -120, y: 150 },
        sun: { pos: { x: 0, y: -600 }, size: 150 },
        planet: { pos: { x: -500, y: 400 }, size: 120 },
        belts: []
    },
    'krios-void': {
        name: 'Krios Void',
        cluster: 'alpha',
        sector: '09',
        security: 'Secure (0.8)',
        securityValue: 0.8,
        tier: 1,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 150,
        hasStarport: false,
        coords: { x: 280, y: 200 },
        sun: { pos: { x: 800, y: 0 }, size: 120 },
        planet: { pos: { x: -400, y: -400 }, size: 450, rotationSpeed: 0.0015 },
        belts: []
    },
    'helios-fringe': {
        name: 'Helios Fringe',
        cluster: 'alpha',
        sector: '12',
        security: 'Secure (0.7)',
        securityValue: 0.7,
        tier: 1,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 250,
        hasStarport: false,
        coords: { x: -300, y: -50 },
        sun: { pos: { x: -200, y: -150 }, size: 300 },
        planet: { pos: { x: 400, y: 450 }, size: 110 },
        belts: []
    },
    // CLUSTER BETA SYSTEMS (0.5 - 0.7 security)
    'solaris-bay': {
        name: 'Solaris Bay',
        cluster: 'beta',
        sector: 'B1',
        security: 'Secure (0.7)',
        securityValue: 0.7,
        tier: 2,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 200,
        hasStarport: false,
        hasWarpGate: true,
        warpGatePos: { x: 1500, y: 1500 },
        coords: { x: 120, y: 200 },
        sun: { pos: { x: 350, y: 250 }, size: 180 },
        planet: { pos: { x: -700, y: -400 }, size: 90 },
        belts: []
    },
    'veiled-nebula': {
        name: 'Veiled Nebula',
        cluster: 'beta',
        sector: 'B2',
        security: 'Mid (0.6)',
        securityValue: 0.6,
        tier: 2,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 300,
        coords: { x: -180, y: 100 },
        sun: { pos: { x: -450, y: 350 }, size: 240 },
        planet: { pos: { x: 600, y: -200 }, size: 70 },
        belts: []
    },
    'obsidian-void': {
        name: 'Obsidian Void',
        cluster: 'beta',
        sector: 'B3',
        security: 'Mid (0.5)',
        securityValue: 0.5,
        tier: 2,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 150,
        coords: { x: 250, y: -150 },
        sun: { pos: { x: 0, y: -600 }, size: 150 },
        planet: { pos: { x: -500, y: 400 }, size: 120 },
        belts: []
    },
    'plasma-fringe': {
        name: 'Plasma Fringe',
        cluster: 'beta',
        sector: 'B4',
        security: 'Secure (0.7)',
        securityValue: 0.7,
        tier: 2,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 250,
        coords: { x: -50, y: -250 },
        sun: { pos: { x: 800, y: 0 }, size: 120 },
        planet: { pos: { x: -400, y: -400 }, size: 450 },
        belts: []
    },
    'iron-reach': {
        name: 'Iron Reach',
        cluster: 'beta',
        sector: 'B5',
        security: 'Mid (0.6)',
        securityValue: 0.6,
        tier: 2,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 200,
        hasStarport: true,
        starportType: 'industrial',
        controlledBy: 'FERRON INDUSTRIAL GUILD',
        coords: { x: -300, y: -80 },
        sun: { pos: { x: -200, y: -150 }, size: 300 },
        planet: { pos: { x: 400, y: 450 }, size: 110 },
        belts: []
    },
    'pulsar-point': {
        name: 'Pulsar Point',
        cluster: 'beta',
        sector: 'B6',
        security: 'Mid (0.5)',
        securityValue: 0.5,
        tier: 2,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 250,
        coords: { x: 350, y: 80 },
        sun: { pos: { x: 100, y: 100 }, size: 200 },
        planet: { pos: { x: -200, y: -200 }, size: 150 },
        belts: []
    },
    // CLUSTER GAMMA SYSTEMS (0.2 - 0.4 security)
    'void-reach': {
        name: 'Void Reach',
        cluster: 'gamma',
        sector: 'G1',
        security: 'Low (0.3)',
        securityValue: 0.3,
        tier: 3,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 300,
        coords: { x: 0, y: 0 },
        sun: { pos: { x: 350, y: 250 }, size: 180 },
        planet: { pos: { x: -700, y: -400 }, size: 90 },
        belts: []
    },
    'shattered-echo': {
        name: 'Shattered Echo',
        cluster: 'gamma',
        sector: 'G2',
        security: 'Low (0.2)',
        securityValue: 0.2,
        tier: 3,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 200,
        coords: { x: 150, y: -100 },
        sun: { pos: { x: -450, y: 350 }, size: 240 },
        planet: { pos: { x: 600, y: -200 }, size: 70 },
        belts: []
    },
    'abyssal-rift': {
        name: 'Abyssal Rift',
        cluster: 'gamma',
        sector: 'G3',
        security: 'Low (0.4)',
        securityValue: 0.4,
        tier: 3,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 400,
        hasWarpGate: true,
        warpGatePos: { x: 1200, y: 1200 },
        coords: { x: -120, y: 150 },
        sun: { pos: { x: 0, y: -600 }, size: 150 },
        planet: { pos: { x: -500, y: 400 }, size: 120 },
        belts: []
    },
    'obsidian-fringe': {
        name: 'Obsidian Fringe',
        cluster: 'gamma',
        sector: 'G4',
        security: 'Low (0.3)',
        securityValue: 0.3,
        tier: 3,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 150,
        hasStarport: true,
        starportType: 'cartel',
        controlledBy: 'CRIMSON RIFT CARTEL',
        coords: { x: 280, y: 200 },
        sun: { pos: { x: 800, y: 0 }, size: 120 },
        planet: { pos: { x: -400, y: -400 }, size: 450 },
        belts: []
    },
    'nebula-heart': {
        name: 'Nebula Heart',
        cluster: 'gamma',
        sector: 'G5',
        security: 'Low (0.2)',
        securityValue: 0.2,
        tier: 3,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 250,
        coords: { x: -300, y: -50 },
        sun: { pos: { x: -200, y: -150 }, size: 300 },
        planet: { pos: { x: 400, y: 450 }, size: 110 },
        belts: []
    },
    // CLUSTER DELTA SYSTEMS (0.0 - 0.1 security)
    'event-horizon': {
        name: 'Event Horizon',
        cluster: 'delta',
        sector: 'D1',
        security: 'Null (0.1)',
        securityValue: 0.1,
        tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 500,
        coords: { x: 0, y: 0 },
        sun: { pos: { x: 350, y: 250 }, size: 180 },
        planet: { pos: { x: -700, y: -400 }, size: 90 },
        belts: []
    },
    'frozen-waste': {
        name: 'Frozen Waste',
        cluster: 'delta',
        sector: 'D2',
        security: 'Null (0.0)',
        securityValue: 0.0,
        tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 300,
        coords: { x: 75, y: -50 },
        sun: { pos: { x: -450, y: 350 }, size: 240 },
        planet: { pos: { x: 600, y: -200 }, size: 70 },
        belts: []
    },
    'dark-core': {
        name: 'Dark Core',
        cluster: 'delta',
        sector: 'D3',
        security: 'Null (0.0)',
        securityValue: 0.0,
        tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 450,
        coords: { x: -60, y: 75 },
        sun: { pos: { x: 0, y: -600 }, size: 150 },
        planet: { pos: { x: -500, y: 400 }, size: 120 },
        belts: []
    },
    'terminal-void': {
        name: 'Terminal Void',
        cluster: 'delta',
        sector: 'D4',
        security: 'Null (0.1)',
        securityValue: 0.1,
        tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 200,
        hasWarpGate: true,
        warpGatePos: { x: 1200, y: 1200 },
        coords: { x: 140, y: 100 },
        sun: { pos: { x: 800, y: 0 }, size: 120 },
        planet: { pos: { x: -400, y: -400 }, size: 450 },
        belts: []
    },
    'stygian-reach': {
        name: 'Stygian Reach',
        cluster: 'delta',
        sector: 'D5',
        security: 'Null (0.0)',
        securityValue: 0.0,
        tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'],
        nebulaCount: 350,
        coords: { x: -150, y: -25 },
        sun: { pos: { x: -200, y: -150 }, size: 300 },
        planet: { pos: { x: 400, y: 450 }, size: 110 },
        belts: []
    },
    'abyssal-maw': {
        name: 'Abyssal Maw', cluster: 'delta', sector: 'D6', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 450, coords: { x: -225, y: 150 },
        sun: { pos: { x: 150, y: 150 }, size: 200 }, planet: { pos: { x: -350, y: -250 }, size: 95 }, belts: []
    },
    'entropy-pulse': {
        name: 'Entropy Pulse', cluster: 'delta', sector: 'D7', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 400, coords: { x: 240, y: -110 },
        sun: { pos: { x: -100, y: -200 }, size: 250 }, planet: { pos: { x: 400, y: 300 }, size: 85 }, belts: []
    },
    'singularity-edge': {
        name: 'Singularity Edge', cluster: 'delta', sector: 'D8', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 550, coords: { x: -50, y: -225 },
        sun: { pos: { x: 300, y: 0 }, size: 180 }, planet: { pos: { x: -400, y: 400 }, size: 120 }, belts: []
    },
    'oblivion-fringe': {
        name: 'Oblivion Fringe', cluster: 'delta', sector: 'D9', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 300, coords: { x: 275, y: 75 },
        sun: { pos: { x: 0, y: 400 }, size: 220 }, planet: { pos: { x: -500, y: -300 }, size: 75 }, belts: []
    },
    'zenith-null': {
        name: 'Zenith Null', cluster: 'delta', sector: 'D10', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 420, coords: { x: -260, y: -90 },
        sun: { pos: { x: -300, y: 100 }, size: 280 }, planet: { pos: { x: 450, y: -400 }, size: 105 }, belts: []
    },
    'nadir-point': {
        name: 'Nadir Point', cluster: 'delta', sector: 'D11', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 380, coords: { x: 100, y: 260 },
        sun: { pos: { x: 400, y: -200 }, size: 190 }, planet: { pos: { x: -200, y: 500 }, size: 90 }, belts: []
    },
    'calamity-rift': {
        name: 'Calamity Rift', cluster: 'delta', sector: 'D12', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 600, coords: { x: -175, y: -275 },
        sun: { pos: { x: 200, y: 350 }, size: 210 }, planet: { pos: { x: -600, y: 100 }, size: 130 }, belts: []
    },
    'penumbra-gate': {
        name: 'Penumbra Gate', cluster: 'delta', sector: 'D13', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 320, coords: { x: 310, y: -200 },
        sun: { pos: { x: -450, y: -100 }, size: 240 }, planet: { pos: { x: 300, y: -500 }, size: 80 }, belts: []
    },
    'umbra-shard': {
        name: 'Umbra Shard', cluster: 'delta', sector: 'D14', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 480, coords: { x: -340, y: 25 },
        sun: { pos: { x: 350, y: -300 }, size: 170 }, planet: { pos: { x: -200, y: 600 }, size: 115 }, belts: []
    },
    'gloom-basin': {
        name: 'Gloom Basin', cluster: 'delta', sector: 'D15', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 350, coords: { x: 200, y: 300 },
        sun: { pos: { x: -500, y: 200 }, size: 300 }, planet: { pos: { x: 600, y: -150 }, size: 100 }, belts: []
    },
    'silent-echo': {
        name: 'Silent Echo', cluster: 'delta', sector: 'D16', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 500, coords: { x: -375, y: -150 },
        sun: { pos: { x: 100, y: -450 }, size: 230 }, planet: { pos: { x: -400, y: -600 }, size: 90 }, belts: []
    },
    'whispering-void': {
        name: 'Whispering Void', cluster: 'delta', sector: 'D17', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 410, coords: { x: 400, y: 50 },
        sun: { pos: { x: -600, y: -250 }, size: 260 }, planet: { pos: { x: 200, y: 450 }, size: 110 }, belts: []
    },
    'revenant-reach': {
        name: 'Revenant Reach', cluster: 'delta', sector: 'D18', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 460, coords: { x: -75, y: 310 },
        sun: { pos: { x: 450, y: 400 }, size: 195 }, planet: { pos: { x: -300, y: -700 }, size: 125 }, belts: []
    },
    'spectre-point': {
        name: 'Spectre Point', cluster: 'delta', sector: 'D19', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 390, coords: { x: 350, y: -325 },
        sun: { pos: { x: -200, y: 550 }, size: 215 }, planet: { pos: { x: 500, y: 350 }, size: 95 }, belts: []
    },
    'phantom-sector': {
        name: 'Phantom Sector', cluster: 'delta', sector: 'D20', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 520, coords: { x: -425, y: 225 },
        sun: { pos: { x: 600, y: -100 }, size: 185 }, planet: { pos: { x: -450, y: 700 }, size: 140 }, belts: []
    },
    'wraith-cluster': {
        name: 'Wraith Cluster', cluster: 'delta', sector: 'D21', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 370, coords: { x: 150, y: -310 },
        sun: { pos: { x: -700, y: 300 }, size: 275 }, planet: { pos: { x: 150, y: -450 }, size: 88 }, belts: []
    },
    'banshee-call': {
        name: 'Banshee Call', cluster: 'delta', sector: 'D22', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 580, coords: { x: -100, y: -320 },
        sun: { pos: { x: 500, y: -500 }, size: 240 }, planet: { pos: { x: -350, y: 800 }, size: 112 }, belts: []
    },
    'nightmare-realm': {
        name: 'Nightmare Realm', cluster: 'delta', sector: 'D23', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 440, coords: { x: 460, y: -150 },
        sun: { pos: { x: -350, y: -700 }, size: 205 }, planet: { pos: { x: 650, y: 400 }, size: 128 }, belts: []
    },
    'dread-anchor': {
        name: 'Dread Anchor', cluster: 'delta', sector: 'D24', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 490, coords: { x: -475, y: -75 },
        sun: { pos: { x: 750, y: 300 }, size: 225 }, planet: { pos: { x: -550, y: -400 }, size: 135 }, belts: []
    },
    'despair-horizon': {
        name: 'Despair Horizon', cluster: 'delta', sector: 'D25', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 430, coords: { x: 75, y: 330 },
        sun: { pos: { x: -800, y: -400 }, size: 290 }, planet: { pos: { x: 400, y: -800 }, size: 118 }, belts: []
    },
    'hopes-end': {
        name: 'Hopes End', cluster: 'delta', sector: 'D26', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 510, coords: { x: -500, y: 250 },
        sun: { pos: { x: 300, y: 850 }, size: 180 }, planet: { pos: { x: -800, y: 200 }, size: 145 }, belts: []
    },
    'omega-void': {
        name: 'Omega Void', cluster: 'delta', sector: 'D27', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 360, coords: { x: 425, y: 310 },
        sun: { pos: { x: -400, y: -900 }, size: 210 }, planet: { pos: { x: -150, y: 950 }, size: 95 }, belts: []
    },
    'alpha-decay': {
        name: 'Alpha Decay', cluster: 'delta', sector: 'D28', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 620, coords: { x: -550, y: -250 },
        sun: { pos: { x: 900, y: 0 }, size: 250 }, planet: { pos: { x: -900, y: -900 }, size: 150 }, belts: []
    },
    'quantum-grave': {
        name: 'Quantum Grave', cluster: 'delta', sector: 'D29', security: 'Null (0.1)', securityValue: 0.1, tier: 4,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 470, coords: { x: 550, y: 200 },
        sun: { pos: { x: -950, y: 600 }, size: 235 }, planet: { pos: { x: 800, y: -700 }, size: 105 }, belts: []
    },
    'stellar-tomb': {
        name: 'Stellar Tomb', cluster: 'delta', sector: 'D30', security: 'Null (0.0)', securityValue: 0.0, tier: 5,
        nebulaTypes: ['blue', 'purple', 'gold'], nebulaCount: 550, coords: { x: -250, y: 340 },
        sun: { pos: { x: 0, y: -1100 }, size: 300 }, planet: { pos: { x: 1000, y: 1000 }, size: 160 }, belts: []
    }
};

export const STARPORT_TO_SYSTEM = {
    'CYGNUS_PRIME_STARPORT': 'cygnus-prime',
    'IRON_REACH_STARPORT': 'iron-reach',
    'OBSIDIAN_FRINGE_STARPORT': 'obsidian-fringe'
};

export const SYSTEM_TO_STARPORT = Object.fromEntries(
    Object.entries(STARPORT_TO_SYSTEM).map(([port, sys]) => [sys, port])
);