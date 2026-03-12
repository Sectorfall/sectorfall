import * as Tone from 'tone';
import * as THREE from 'three';

/**
 * AudioManager handles all sound generation, spatial positioning, and audio lifecycle.
 * It uses Tone.js for high-quality synthesis and spatial panning.
 */
class AudioManager {
    constructor() {
        this.initialized = false;
        this.masterVolume = -12; // Base volume in dB
        this.spatialNodes = new Map();
        this.pannerPool = [];
        this.maxPanners = 16;
        this.listener = Tone.getListener();
        
        // Master Output chain
        this.limiter = new Tone.Limiter(-1).toDestination();
        this.compressor = new Tone.Compressor({
            threshold: -24,
            ratio: 12,
            attack: 0.003,
            release: 0.25
        }).connect(this.limiter);
        
        this.mainOut = new Tone.Gain(this.masterVolume, 'db').connect(this.compressor);

        // Core Synths
        this.uiSynth = new Tone.MonoSynth({
            oscillator: { type: "sine" },
            envelope: { attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.2 }
        }).connect(this.mainOut);

        this.explosionSynth = new Tone.NoiseSynth({
            noise: { type: 'brown' },
            envelope: { attack: 0.005, decay: 0.5, sustain: 0 }
        }).connect(this.mainOut);

        this.laserSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "triangle" },
            envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.1 }
        }).connect(this.mainOut);

        // Spatial Sound Map
        this.activeSpatialSounds = new Set();
    }

    async init() {
        if (this.initialized) return;
        await Tone.start();
        this.initialized = true;
        console.log("[AudioManager] Audio Context Started");
        
        // Pre-fill panner pool
        for (let i = 0; i < this.maxPanners; i++) {
            const panner = new Tone.Panner3D({
                panningModel: 'HRTF',
                distanceModel: 'exponential',
                rolloffFactor: 1.5,
                refDistance: 100,
                maxDistance: 2500
            }).connect(this.mainOut);
            this.pannerPool.push({ panner, inUse: false });
        }
    }

    /**
     * Synchronize the Tone.js listener with the Three.js camera.
     */
    updateListener(camera) {
        if (!this.initialized || !camera) return;
        
        // Update listener position
        this.listener.positionX.value = camera.position.x;
        this.listener.positionY.value = camera.position.y;
        this.listener.positionZ.value = camera.position.z;

        // Update listener orientation
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        
        this.listener.forwardX.value = forward.x;
        this.listener.forwardY.value = forward.y;
        this.listener.forwardZ.value = forward.z;
        
        this.listener.upX.value = up.x;
        this.listener.upY.value = up.y;
        this.listener.upZ.value = up.z;
    }

    /**
     * Play a spatialized sound at a specific position.
     * @param {string} type - 'laser', 'explosion', 'pulse'
     * @param {THREE.Vector3} position - 3D position of the sound source
     * @param {Object} options - { note, duration, volume }
     */
    playSpatialSound(type, position, options = {}) {
        if (!this.initialized) return;

        const pannerObj = this.getNextAvailablePanner();
        if (!pannerObj) return;

        const { panner } = pannerObj;
        pannerObj.inUse = true;

        // Update panner position
        panner.positionX.value = position.x;
        panner.positionY.value = position.y;
        panner.positionZ.value = position.z || 0;

        const note = options.note || "C3";
        const duration = options.duration || "16n";
        const time = Tone.now();

        switch (type) {
            case 'laser':
                this.laserSynth.disconnect();
                this.laserSynth.connect(panner);
                this.laserSynth.triggerAttackRelease(note, duration, time);
                break;
            case 'explosion':
                this.explosionSynth.disconnect();
                this.explosionSynth.connect(panner);
                this.explosionSynth.triggerAttackRelease(duration, time);
                break;
            case 'pulse':
                // Procedural pulse sound
                const osc = new Tone.Oscillator(note, "sine").connect(panner).start(time).stop(time + 0.1);
                const env = new Tone.AmplitudeEnvelope({ attack: 0.01, decay: 0.05, sustain: 0, release: 0.05 }).connect(panner);
                osc.connect(env);
                env.triggerAttackRelease(0.1, time);
                break;
        }

        // Return panner to pool after estimated duration
        setTimeout(() => {
            pannerObj.inUse = false;
        }, 1000); // 1s safety buffer
    }

    getNextAvailablePanner() {
        return this.pannerPool.find(p => !p.inUse) || this.pannerPool[0];
    }

    playUISound(note = "C4", duration = "32n") {
        if (!this.initialized) return;
        this.uiSynth.triggerAttackRelease(note, duration, Tone.now());
    }
}

export const audioManager = new AudioManager();
