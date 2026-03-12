import * as THREE from 'three';

/**
 * NPC AI System for ARC Space Flight
 * Implements layered behavior: Awareness, Combat Roles, Movement, Decisions, and Weaponry.
 */

export const NPC_ROLES = {
    CHASER: { preferredDistance: 280, aggression: 0.9, movement: 'zig-zag', firingRange: 450 },
    ORBITER: { preferredDistance: 280, aggression: 0.7, movement: 'orbit', firingRange: 500 },
    STRIKER: { preferredDistance: 180, aggression: 1.0, movement: 'boost-in', firingRange: 350 },
    KITER: { preferredDistance: 400, aggression: 0.5, movement: 'drift-out', firingRange: 600 },
    SWARM: { preferredDistance: 250, aggression: 0.8, movement: 's-curve', firingRange: 450 },
    BRUISER: { preferredDistance: 320, aggression: 0.8, movement: 'direct', firingRange: 500 },
    SNIPER: { preferredDistance: 800, aggression: 0.4, movement: 'drift-out', firingRange: 1200 },
    SPAWNER: { preferredDistance: 600, aggression: 0.6, movement: 'orbit', firingRange: 800 },
    STATIONARY: { preferredDistance: 0, aggression: 1.0, movement: 'none', firingRange: 1000 },
    CONVOY: { preferredDistance: 0, aggression: 0.0, movement: 'path', firingRange: 0 }
};

export const NPC_INTENTS = {
    CLOSE_DISTANCE: 'close_distance',
    MAINTAIN_ORBIT: 'maintain_orbit',
    EVADE: 'evade',
    CHARGE_ATTACK: 'charge_attack',
    RETREAT: 'retreat',
    REPOSITION: 'reposition',
    FOCUS_FIRE: 'focus_fire',
    SPREAD_OUT: 'spread_out',
    FLY_PAST: 'fly_past',
    STALK: 'stalk',
    WINDING: 'winding',
    DASHING: 'dashing',
    SPAWNING: 'spawning',
    FOLLOW_PATH: 'follow_path'
};

export class NPCAI {
    constructor(npc, gameManager) {
        this.npc = npc;
        this.gm = gameManager;
        
        // Layer 1: Awareness & Memory
        this.awareness = {
            detectionRange: 1200,
            lostTargetRange: 2000,
            threatMemory: 0,
            threatDuration: 1000 + Math.random() * 2000, // 1-3 seconds
            lastKnownPlayerPos: new THREE.Vector2(),
            isAware: false,
            lostTargetTimer: 0
        };

        // Layer 2: Combat Role
        const roles = Object.keys(NPC_ROLES);
        this.roleId = roles[Math.floor(Math.random() * roles.length)];
        this.role = NPC_ROLES[this.roleId];

        // Layer 3: Movement Layer
        this.movement = {
            pattern: 'none',
            orbitDir: Math.random() > 0.5 ? 1 : -1,
            zigZagTimer: Math.random() * 10,
            sCurveTimer: Math.random() * 10,
            boostTimer: 0,
            dodgeCooldown: 0,
            strafeDir: 1,
            strafeTimer: 0,
            flyPastTarget: new THREE.Vector2(),
            smoothedSteer: new THREE.Vector2() // For colossal stability
        };

        // Layer 4: Combat Decision Layer
        this.decision = {
            intent: NPC_INTENTS.REPOSITION,
            nextDecisionTime: 0
        };

        // Layer 5: Weapon Behaviour Layer
        this.weaponry = {
            burstTimer: 0,
            burstActive: false,
            burstCount: 0,
            lastFireTime: 0
        };

        // Layer 6: Behaviour Spice (Pilot Personality)
        this.personality = {
            wobblePhase: Math.random() * Math.PI * 2,
            isNervous: false,
            isConfident: false,
            aggressionModifier: 1.0,
            overconfidenceTriggered: false
        };
    }

    update(delta, playerPos, playerVelocity, playerIsAimingAtMe) {
        if (!this.npc.sprite) return;

        // Update Animation
        if (this.npc.frameCount > 1) {
            this.npc.animTimer += delta;
            const fps = this.npc.fps || 6.6; // Default to original 6.6 if not specified
            const frameTime = 1 / fps; 
            if (this.npc.animTimer >= frameTime) {
                this.npc.animTimer = 0;
                this.npc.currentFrame = (this.npc.currentFrame + 1) % this.npc.frameCount;
                if (this.npc.sprite.material.map) {
                    this.npc.sprite.material.map.offset.x = this.npc.currentFrame / this.npc.frameCount;
                }
            }
        }

        const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
        const distToPlayer = playerPos ? npcPos.distanceTo(playerPos) : Infinity;

        // 1. Awareness Layer (2D Sensors)
        this.updateAwareness(delta, distToPlayer, playerPos, playerVelocity);
        
        if (!this.awareness.isAware) {
            this.handleLostTarget(delta);
            return;
        }

        // 2. Combat Decision Layer (Every 0.3 - 1.0s)
        this.updateDecisions(delta, distToPlayer, playerIsAimingAtMe, playerPos);

        // 3. Behaviour Spice
        this.updateSpice(delta, distToPlayer);

        // 4. Movement Layer (Vector Patterns)
        const steerForce = this.calculateMovement(delta, npcPos, playerPos, playerVelocity);
        
        // Jitter wobble micro-behaviour removed to ensure movement doesn't interfere with hit-chance
        this.applyPhysics(delta, steerForce, playerPos);

        // 5. Weapon Behaviour Layer
        this.updateWeaponry(delta, distToPlayer, playerPos, playerVelocity);
    }

    updateAwareness(delta, distToPlayer, playerPos, playerVelocity) {
        // If the NPC is a bio creature that is passive until attacked, 
        // they only become aware if they have been aggravated by damage.
        if (this.npc.isPassiveUntilAttacked && !this.npc.isAggravated) {
            this.awareness.isAware = false;
            return;
        }

        // Distance-based detection (1000m) + Relative velocity check
        const detectionThreshold = 1000;
        const speedFactor = playerVelocity ? playerVelocity.length() / 5 : 0;
        const effectiveDetectionRange = detectionThreshold * (1 + speedFactor);

        if (playerPos && distToPlayer < effectiveDetectionRange) {
            // Line-of-fire check (simplified: is the player close enough and not blocked?)
            // Threat memory (1-3 seconds)
            this.awareness.isAware = true;
            this.awareness.threatMemory = this.awareness.threatDuration;
            this.awareness.lastKnownPlayerPos.copy(playerPos);
            this.awareness.lostTargetTimer = 0;
        } else if (this.awareness.threatMemory > 0) {
            this.awareness.threatMemory -= delta * 1000;
        } else {
            this.awareness.isAware = false;
        }
    }

    handleLostTarget(delta) {
        // Bio-creatures that are passive don't try to "find" the target they lost.
        // They just immediately enter idle movement.
        if (this.npc.isPassiveUntilAttacked && !this.npc.isAggravated) {
            this.idleMovement(delta);
            return;
        }

        // Standard NPC "Lost target" behaviour: NPC drifts towards last known position then idles
        this.awareness.lostTargetTimer += delta;
        
        if (this.awareness.lostTargetTimer < 5) {
            const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
            const toLastPos = new THREE.Vector2().subVectors(this.awareness.lastKnownPlayerPos, npcPos);
            if (toLastPos.length() > 100) {
                const steer = toLastPos.normalize().multiplyScalar(0.05);
                this.applyPhysics(delta, steer, this.awareness.lastKnownPlayerPos);
            } else {
                this.idleMovement(delta);
            }
        } else {
            this.idleMovement(delta);
        }
    }

    updateDecisions(delta, distToPlayer, playerIsAimingAtMe, playerPos) {
        const now = Date.now();
        if (now < this.decision.nextDecisionTime) return;

        // Biological Creature Decision Tree
        if (this.npc.isBio) {
            this.decision.nextDecisionTime = now + 200 + Math.random() * 300; // Faster reactions
            
            // If already winding, dashing or spawning, don't interrupt
            if (this.decision.intent === NPC_INTENTS.WINDING || this.decision.intent === NPC_INTENTS.DASHING || this.decision.intent === NPC_INTENTS.SPAWNING) {
                return;
            }

            const isBoss = this.npc.classId === 'Large Bio-Creature';

            // BOSS BEHAVIOUR: Dash if player is within 1200m (well outside standoff range)
            const dashRange = isBoss ? 1200 : 800;
            const pulseRange = isBoss ? 300 : 180;
            const spawnRange = 1000;

            if (this.npc.canSpawn && distToPlayer < spawnRange && (!this.npc.cooldowns.spawn || now > this.npc.cooldowns.spawn)) {
                this.decision.intent = NPC_INTENTS.SPAWNING;
                this.npc.spawningStartTime = now;
                this.npc.spawningDuration = 2000; // 2s spawning animation
                return;
            }

            // Larvae should pulse if very close
            if (distToPlayer < pulseRange && (!this.npc.cooldowns.pulse || now > this.npc.cooldowns.pulse)) {
                this.triggerBioPulse(now);
                // After pulse, might want to reposition
                this.decision.intent = NPC_INTENTS.STALK;
                this.decision.nextDecisionTime = now + 500;
                return;
            }

            if (playerPos && (this.npc.isAggravated || !this.npc.isPassiveUntilAttacked) && distToPlayer < dashRange && (!this.npc.cooldowns.dash || now > this.npc.cooldowns.dash)) {
                // Check if we are reasonably facing the player (loosen dot product to 0.2)
                const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
                const playerPosVec = new THREE.Vector2(playerPos.x, playerPos.y);
                const toPlayer = new THREE.Vector2().subVectors(playerPosVec, npcPos).normalize();
                const forward = new THREE.Vector2(-Math.sin(this.npc.rotation), Math.cos(this.npc.rotation));
                
                if (forward.dot(toPlayer) > 0.2) { 
                    this.decision.intent = NPC_INTENTS.WINDING;
                    this.npc.windingStartTime = now;
                    this.npc.windingDuration = isBoss ? 2500 : 1200; // Significantly increased build-up time
                    // Set next decision time to immediately after winding duration
                    this.decision.nextDecisionTime = now + this.npc.windingDuration + 100;
                    return;
                }
            }
            
            this.decision.intent = NPC_INTENTS.STALK;
            return;
        }

        // Standard NPC Decision Tree
        this.decision.nextDecisionTime = now + 300 + Math.random() * 700;

        // Convoy Role Decision
        if (this.npc.roleId === 'CONVOY') {
            const beingAttacked = this.npc.stats.hp < this.npc.stats.maxHp || this.npc.stats.shields < this.npc.stats.maxShields;
            if (beingAttacked && distToPlayer < 600) {
                this.decision.intent = NPC_INTENTS.EVADE;
            } else {
                this.decision.intent = NPC_INTENTS.FOLLOW_PATH;
            }
            return;
        }

        const hpRatio = this.npc.stats.hp / this.npc.stats.maxHp;
        const squadCount = this.gm.npcs.filter(n => n.patrolId === this.npc.patrolId).length;

        // Intent conditions
        const isAggressive = this.personality.aggressionModifier > 1.1 || this.personality.isConfident;
        const isShieldsLow = this.npc.stats.shields < (this.npc.stats.maxShields * 0.3);
        const isLocking = this.npc.locking.state === 'Priming';

        // Check if current fly-past is complete
        if (this.decision.intent === NPC_INTENTS.FLY_PAST) {
            const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
            const distToFlyPastTarget = npcPos.distanceTo(this.movement.flyPastTarget);
            // Smaller threshold (150m) and checking if we are close to the target to return to dogfighting
            if (distToFlyPastTarget < 150) {
                this.decision.intent = NPC_INTENTS.MAINTAIN_ORBIT;
            }
            return; 
        }

        if (hpRatio < 0.2 && squadCount === 1) {
            this.decision.intent = NPC_INTENTS.RETREAT; 
        } else if (distToPlayer < 180) { // Slightly tighter evasion trigger
            this.decision.intent = NPC_INTENTS.EVADE; 
        } else if (playerPos && Math.random() < 0.35 && distToPlayer < 800) {
            // Reduced chance and range for jousting to favor circling
            this.decision.intent = NPC_INTENTS.FLY_PAST;
            
            const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
            const playerShipPos = new THREE.Vector2(playerPos.x, playerPos.y);
            const toPlayer = new THREE.Vector2().subVectors(playerShipPos, npcPos).normalize();
            
            // Tight jousts: 250m to 500m past the player
            const passDist = 250 + Math.random() * 250;
            // Narrower passes: 50m to 150m side offset
            const sideOffset = (50 + Math.random() * 100) * this.movement.orbitDir;
            
            const sideDir = new THREE.Vector2(toPlayer.y, -toPlayer.x).multiplyScalar(sideOffset);
            
            this.movement.flyPastTarget.copy(playerShipPos).add(toPlayer.multiplyScalar(passDist)).add(sideDir);
        } else if (isLocking) {
            this.decision.intent = NPC_INTENTS.MAINTAIN_ORBIT; // Orbit while locking
        } else if (isShieldsLow && !isAggressive) {
            this.decision.intent = NPC_INTENTS.EVADE; // Shields low and not aggressive -> evade
        } else if (distToPlayer > this.role.preferredDistance + 200) {
            this.decision.intent = NPC_INTENTS.CLOSE_DISTANCE; // Player far -> close distance
        } else {
            this.decision.intent = NPC_INTENTS.MAINTAIN_ORBIT;
        }

        // Pilot Personality states
        this.personality.isConfident = squadCount > 2;
        this.personality.isNervous = (squadCount === 1 && hpRatio < 0.4) || (playerIsAimingAtMe && Math.random() < 0.3);
    }

    updateSpice(delta, distToPlayer) {
        const playerHpRatio = this.gm.stats.hp / this.gm.stats.maxHp;
        const playerVulnerable = playerHpRatio < 0.3 || this.gm.stats.shields < 50;
        
        // Aggression spike when player is vulnerable
        if (playerVulnerable) {
            this.personality.aggressionModifier = 1.5;
        } else if (this.personality.isConfident) {
            this.personality.aggressionModifier = 1.2;
        } else if (this.personality.isNervous) {
            this.personality.aggressionModifier = 0.6;
        } else {
            this.personality.aggressionModifier = 1.0;
        }
    }

    calculateMovement(delta, npcPos, playerPos, playerVelocity) {
        const steerForce = new THREE.Vector2(0, 0);
        
        // If no playerPos, we can't calculate relative vectors
        if (!playerPos) {
            return steerForce;
        }

        const toPlayer = new THREE.Vector2().subVectors(playerPos, npcPos).normalize();
        const dist = npcPos.distanceTo(playerPos);
        const isBoss = this.npc.classId === 'Large Bio-Creature';

        switch (this.decision.intent) {
            case NPC_INTENTS.FLY_PAST:
                // High speed run towards the flyPastTarget
                const toFlyPast = new THREE.Vector2().subVectors(this.movement.flyPastTarget, npcPos).normalize();
                steerForce.add(toFlyPast).normalize().multiplyScalar(0.55); // Increased from 0.4 for higher joust speed
                break;

            case NPC_INTENTS.CLOSE_DISTANCE:
                // Direct approach - very minimal zig-zag to maintain focus
                this.movement.zigZagTimer += delta * 2;
                const zigDir = new THREE.Vector2(toPlayer.y, -toPlayer.x).multiplyScalar(Math.sin(this.movement.zigZagTimer) * 0.08);
                steerForce.add(toPlayer).add(zigDir).normalize().multiplyScalar(0.18 * this.personality.aggressionModifier);
                break;

            case NPC_INTENTS.MAINTAIN_ORBIT:
                // Orbiting (CW/CCW) - increased radial force to prevent drifting too far
                const orbitVec = new THREE.Vector2(toPlayer.y * this.movement.orbitDir, -toPlayer.x * this.movement.orbitDir);
                const radialSpring = toPlayer.clone().multiplyScalar((dist - this.role.preferredDistance) * 0.06);
                // Significantly increased orbital magnitude to ensure they are always moving
                steerForce.add(orbitVec.multiplyScalar(0.7)).add(radialSpring).normalize().multiplyScalar(0.28);
                break;

            case NPC_INTENTS.EVADE:
                // Smooth lateral dodging while still keeping pressure on the player
                this.movement.sCurveTimer += delta * 1.5;
                const sideDir = new THREE.Vector2(toPlayer.y, -toPlayer.x).multiplyScalar(Math.sin(this.movement.sCurveTimer) * 0.4);
                const distError = dist - this.role.preferredDistance;
                // Softened push back if inside preferred distance to keep combat tighter
                const forwardPush = toPlayer.clone().multiplyScalar(distError > 0 ? 0.4 : -0.5);
                steerForce.add(forwardPush).add(sideDir).normalize().multiplyScalar(0.25);
                break;

            case NPC_INTENTS.CHARGE_ATTACK:
                // Boost-in
                steerForce.add(toPlayer).normalize().multiplyScalar(0.3 * this.personality.aggressionModifier);
                break;

            case NPC_INTENTS.RETREAT:
                // Break-off manoeuvres / Drift-out
                steerForce.add(toPlayer.clone().multiplyScalar(-1)).normalize().multiplyScalar(0.25);
                break;

            case NPC_INTENTS.SPREAD_OUT:
                // Move away from nearby allies
                const neighbors = this.gm.npcs.filter(n => n.id !== this.npc.id && n.patrolId === this.npc.patrolId);
                const separation = new THREE.Vector2(0, 0);
                neighbors.forEach(n => {
                    const d = npcPos.distanceTo(new THREE.Vector2(n.x, n.y));
                    if (d < 300) {
                        separation.add(new THREE.Vector2().subVectors(npcPos, new THREE.Vector2(n.x, n.y)).normalize().multiplyScalar(1 - d / 300));
                    }
                });
                steerForce.add(separation.multiplyScalar(0.2)).add(toPlayer.clone().multiplyScalar(0.05));
                break;

            case NPC_INTENTS.STALK:
                // BOSS BEHAVIOUR: Maintain a tactical standoff distance of 600m if aggravated.
                // Standard bio-creatures (Larvae) use direct pursuit for impact, but wait at a ready distance.
                const preferredDist = isBoss ? 600 : 350; 
                
                // Add organic wobble to the stalking movement
                this.movement.sCurveTimer += delta * 2;
                const wobble = new THREE.Vector2(toPlayer.y, -toPlayer.x).multiplyScalar(Math.sin(this.movement.sCurveTimer) * 0.15);
                
                // Add separation even in stalk mode for bios
                const bios = this.gm.npcs.filter(n => n.id !== this.npc.id && n.isBio);
                const bioSeparation = new THREE.Vector2(0, 0);
                bios.forEach(n => {
                    const neighborPos = new THREE.Vector2(n.x, n.y);
                    const d = npcPos.distanceTo(neighborPos);
                    const minSep = isBoss ? 500 : 180;
                    if (d < minSep) {
                        bioSeparation.add(new THREE.Vector2().subVectors(npcPos, neighborPos).normalize().multiplyScalar(1 - d / minSep));
                    }
                });

                if (preferredDist > 0) {
                    const distError = dist - preferredDist;
                    // If too far, move in. If too close, back off.
                    const thrust = distError > 0 ? 0.35 : -0.6;
                    steerForce.add(toPlayer.clone().multiplyScalar(thrust)).add(bioSeparation.multiplyScalar(0.5)).add(wobble);
                } else {
                    // Predatory stalking: Direct pursuit with separation. 
                    steerForce.add(toPlayer).add(bioSeparation.multiplyScalar(0.4)).add(wobble).normalize().multiplyScalar(0.45);
                }
                break;

            case NPC_INTENTS.FOLLOW_PATH:
                // Move towards current path target
                const pathTarget = this.npc.pathTarget;
                if (pathTarget) {
                    const toPathTarget = new THREE.Vector2().subVectors(pathTarget, npcPos).normalize();
                    steerForce.add(toPathTarget).normalize().multiplyScalar(0.12); // Steady pace
                } else {
                    this.idleMovement(delta);
                }
                break;

            case NPC_INTENTS.WINDING:
                // Lock in place and vibrate during telegraph
                this.npc.velocity.set(0, 0); // Absolute stop for telegraph
                const vibrate = new THREE.Vector2((Math.random() - 0.5) * 3.0, (Math.random() - 0.5) * 3.0); // Even more violent vibration
                return vibrate; // Return immediately to bypass avoidance/other steering during buildup

            case NPC_INTENTS.DASHING:
                // Extreme forward thrust - bypass max speed significantly for burst feel
                // Reduced dash force for Larvae (from 8.0 to 5.0) for better control
                const dashForce = isBoss ? 15.0 : 5.0; 
                const dashDir = this.movement.dashVector || toPlayer;
                steerForce.add(dashDir).normalize().multiplyScalar(dashForce);

                // Leave a trail of corrosive ink clouds (Larvae leave smaller trails)
                if (!this.movement.inkTimer) this.movement.inkTimer = 0;
                this.movement.inkTimer -= delta * 1000;
                if (this.movement.inkTimer <= 0) {
                    const cloudRadius = isBoss ? 80 : 30;
                    this.gm.createInkCloud(this.npc.sprite.position, cloudRadius, 10000);
                    this.movement.inkTimer = 100; // Slower trail drop
                }
                break;

            default:
                steerForce.add(toPlayer).multiplyScalar(0.1);
                break;
        }

        // --- ARC PRESSURE: Get out of players weapon firing arc ---
        const playerIsAimingAtMe = this.gm.target && this.gm.target.id === this.npc.id;
        if (playerIsAimingAtMe) {
            // Apply lateral force to slide out of the player's crosshairs
            const lateralEvade = new THREE.Vector2(toPlayer.y, -toPlayer.x).multiplyScalar(this.movement.orbitDir * 0.2);
            steerForce.add(lateralEvade);
        }

        // Avoid Restricted Zones (Integrated sensors)
        const restricted = this.gm.entities.filter(e => e.type === 'Starport' || e.type === 'WarpGate');
        restricted.forEach(r => {
            const rPos = new THREE.Vector2(r.x, r.y);
            const d = npcPos.distanceTo(rPos);
            const safeRadius = r.radius + 1000;
            if (d < safeRadius) {
                const avoid = new THREE.Vector2().subVectors(npcPos, rPos).normalize();
                steerForce.add(avoid.multiplyScalar((1 - d / safeRadius) * 0.4));
            }
        });

        // --- ASTEROID AVOIDANCE ---
        // Find asteroids in immediate vicinity
        const asteroids = this.gm.entities.filter(e => e.type === 'Asteroid');
        asteroids.forEach(asteroid => {
            const aPos = new THREE.Vector2(asteroid.x, asteroid.y);
            const distToAsteroid = npcPos.distanceTo(aPos);
            const avoidanceRadius = asteroid.radius + 150; // Extra buffer
            
            if (distToAsteroid < avoidanceRadius) {
                const avoidDir = new THREE.Vector2().subVectors(npcPos, aPos).normalize();
                // Strength increases exponentially as NPC gets closer to surface
                const force = Math.pow(1 - (distToAsteroid / avoidanceRadius), 2) * 2.0;
                steerForce.add(avoidDir.multiplyScalar(force));
            }
        });

        // --- BIO-CREATURE SEPARATION (Social Distancing) ---
        // Prevents bio-creatures from stacking into a single "super-sprite"
        if (this.npc.isBio) {
            const neighbors = this.gm.npcs.filter(n => n.id !== this.npc.id && n.isBio);
            neighbors.forEach(neighbor => {
                const nPos = new THREE.Vector2(neighbor.x, neighbor.y);
                const d = npcPos.distanceTo(nPos);
                // Separation radius depends on the size of the creatures
                const minSep = (this.npc.radius || 50) + (neighbor.radius || 50);
                if (d < minSep && d > 0) {
                    const separation = new THREE.Vector2().subVectors(npcPos, nPos).normalize();
                    // Weight increases as they get closer
                    const weight = Math.pow(1 - (d / minSep), 2) * 1.5;
                    steerForce.add(separation.multiplyScalar(weight));
                }
            });
        }

        // CRITICAL PLAYER AVOIDANCE (Danger Zone)
        // Bio-creatures have a normalized safety radius to match their scale
        // Reduced to 150m for bios to allow closer engagement
        const playerSafetyRadius = this.npc.isBio ? 200 : 200; 
        if (dist < playerSafetyRadius) {
            const avoidPlayer = toPlayer.clone().multiplyScalar(-1);
            const ratio = 1 - (dist / playerSafetyRadius);
            const avoidStrength = Math.pow(ratio, 2) * (this.npc.isBio ? 2.5 : 3.0); 
            steerForce.add(avoidPlayer.multiplyScalar(avoidStrength));
        }

        // SMOOTHING PASS: For colossal bios, we lerp the steerForce to prevent high-frequency jitter
        if (this.npc.isBio) {
            // Damping is reduced during dashing for more immediate lunge response
            const damping = this.decision.intent === NPC_INTENTS.DASHING ? delta * 15 : delta * 4;
            this.movement.smoothedSteer.lerp(steerForce, damping); 
            return this.movement.smoothedSteer;
        }

        return steerForce;
    }

    updateWeaponry(delta, distToPlayer, playerPos, playerVelocity) {
        if (!this.gm.ship || !this.gm.ship.sprite || !playerPos) return;

        const now = Date.now();

        // --- BIO-CREATURE ABILITY LOGIC ---
        if (this.npc.isBio) {
            const isBoss = this.npc.classId === 'Large Bio-Creature';
            
            // Handle Winding/Dashing transitions
            if (this.decision.intent === NPC_INTENTS.WINDING) {
                if (now > this.npc.windingStartTime + this.npc.windingDuration) {
                    this.decision.intent = NPC_INTENTS.DASHING;
                    this.npc.dashStartTime = now;
                    // Reduced dash duration for Larvae (from 800 to 450) to prevent overshooting
                    this.npc.dashDuration = isBoss ? 1200 : 450; 
                    
                    // Lock the dash vector so it doesn't track during the lunge
                    const shipPos = new THREE.Vector2(this.gm.ship.sprite.position.x, this.gm.ship.sprite.position.y);
                    const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
                    this.movement.dashVector = new THREE.Vector2().subVectors(shipPos, npcPos).normalize();

                    // Trigger visual dash alert
                    if (this.gm.createBioPulseEffect) {
                        this.gm.createBioPulseEffect(this.npc.sprite.position, 80);
                    }
                }
                return;
            }

            if (this.decision.intent === NPC_INTENTS.DASHING) {
                if (now > this.npc.dashStartTime + this.npc.dashDuration) {
                    this.decision.intent = NPC_INTENTS.STALK;
                    this.npc.cooldowns.dash = now + 4000 + Math.random() * 2000; // Randomized cooldown for natural rhythm
                    
                    // Reset dash vector
                    this.movement.dashVector = null;
                    
                    // Trigger pulse and ink immediately after a dash completes
                    this.triggerBioPulse(now);
                } else {
                    // Check for impact damage during dash
                    // We NO LONGER stop on impact, allowing the creature to fly through.
                    const shipPos = new THREE.Vector2(this.gm.ship.sprite.position.x, this.gm.ship.sprite.position.y);
                    const shipRadius = this.gm.ship.collisionRadius || 25;
                    const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
                    
                    let impactDetected = false;
                    if (this.npc.collisionCircles && this.npc.collisionCircles.length > 0) {
                        for (const circle of this.npc.collisionCircles) {
                            const d = shipPos.distanceTo(new THREE.Vector2(circle.x, circle.y));
                            if (d < shipRadius + circle.radius) {
                                impactDetected = true;
                                break;
                            }
                        }
                    } else {
                        const combinedRadius = (this.npc.radius || 20) + shipRadius;
                        if (npcPos.distanceTo(shipPos) < combinedRadius) { 
                            impactDetected = true;
                        }
                    }

                    if (impactDetected && (!this.npc.lastImpactTime || now > this.npc.lastImpactTime + 500)) { 
                        this.gm.applyDirectDamage(this.gm.ship, 140, 'kinetic');
                        this.npc.lastImpactTime = now;
                        
                        // Pulse immediately on impact but don't stop the dash
                        this.triggerBioPulse(now);
                    }
                }
                return;
            }

            if (this.decision.intent === NPC_INTENTS.SPAWNING) {
                if (now > this.npc.spawningStartTime + this.npc.spawningDuration) {
                    // Logic to spawn larvae
                    if (this.gm.spawnLarvaeFromParent) {
                        this.gm.spawnLarvaeFromParent(this.npc);
                    }
                    this.decision.intent = NPC_INTENTS.STALK;
                    this.npc.cooldowns.spawn = now + 10000 + Math.random() * 5000;
                }
                return;
            }

            // Radial Pulse trigger
            if (distToPlayer < 180 && (!this.npc.cooldowns.pulse || now > this.npc.cooldowns.pulse)) {
                this.triggerBioPulse(now);
            }
            return;
        }

        // --- ALWAYS TRY TO LOCK IF IN RANGE ---
        const shipConfig = this.gm.getNpcConfig ? this.gm.getNpcConfig(this.npc.shipType) : null;
        const lockRange = shipConfig ? (shipConfig.lockOnRange || 700) : 700;
        
        if (distToPlayer <= lockRange) {
            this.gm.updateNpcLocking(this.npc, this.gm.ship);
        } else if (this.npc.locking.state !== 'Idle') {
            this.npc.locking.state = 'Idle';
            this.npc.locking.entity = null;
        }

        // --- AI AIMING LOGIC ---
        // For hit-scan weapons like Flux Lasers, we aim DIRECTLY at the target.
        // Leading is only for projectile weapons (missiles/autocannons).
        const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
        const toTarget = new THREE.Vector2().subVectors(playerPos, npcPos).normalize();
        const forward = new THREE.Vector2(-Math.sin(this.npc.rotation), Math.cos(this.npc.rotation));
        const dot = forward.dot(toTarget);
        const angleToTarget = Math.acos(Math.min(1, Math.max(-1, dot)));

        // Delay fire until angle is good
        const isRetreating = this.decision.intent === NPC_INTENTS.RETREAT;
        // Expanded to 37 degrees (0.65 rad) to match the new 45-degree hardpoint tracking arcs
        const angleThreshold = 0.65; 
        
        // BIO-CREATURE OVERRIDE: Creatures with noLockOn don't wait for 'Locked' state in the same way,
        // but they still check if the gm thinks they are locked (which is instant for them).
        const isLocked = this.npc.locking.state === 'Locked';

        const canFire = this.awareness.isAware && 
                        distToPlayer < this.role.firingRange && 
                        angleToTarget < angleThreshold && 
                        isLocked &&
                        !isRetreating;

        if (canFire) {
            // Fire in aggressive bursts
            this.weaponry.burstTimer -= delta;
            if (this.weaponry.burstTimer <= 0) {
                if (this.weaponry.burstActive) {
                    this.weaponry.burstActive = false;
                    this.weaponry.burstTimer = 0.2 + Math.random() * 0.4; // Dramatically reduced pause between bursts
                } else {
                    this.weaponry.burstActive = true;
                    // Count-based burst: 20 to 40 shots for more sustained fire
                    this.weaponry.burstCount = 20 + Math.floor(Math.random() * 20);
                    this.weaponry.burstTimer = 0; 
                }
            }

            if (this.weaponry.burstActive) {
                // Fire ALL available weapon slots
                Object.keys(this.npc.fittings).forEach(slotId => {
                    if (slotId.startsWith('weapon')) {
                        this.gm.npcFireWeapon(this.npc, slotId, this.gm.ship);
                    }
                });
                
                // Only decrement if we actually attempted a shot on the primary weapon
                if (this.npc.weaponCooldowns && this.npc.weaponCooldowns['weapon1'] <= 0) {
                    this.weaponry.burstCount--;
                    if (this.weaponry.burstCount <= 0) {
                        this.weaponry.burstActive = false;
                        this.weaponry.burstTimer = 0.3 + Math.random() * 0.6; // Faster recovery
                    }
                }
            }
        } else {
            // Realigning: stay ready
            this.weaponry.burstActive = false;
            this.weaponry.burstTimer = Math.max(0, this.weaponry.burstTimer - delta);
        }
    }

    applyPhysics(delta, steerForce, lookAtTarget) {
        if (!this.npc.sprite) return;
        
        // --- STATIONARY OVERRIDE ---
        if (this.npc.stationary) {
            this.npc.rotation += 0.001; 
            if (this.npc.sprite.isMesh) {
                this.npc.sprite.rotation.z = this.npc.rotation;
            } else {
                this.npc.sprite.material.rotation = this.npc.rotation;
            }
            this.npc.velocity.set(0, 0);
            return;
        }

        const npcPos = new THREE.Vector2(this.npc.sprite.position.x, this.npc.sprite.position.y);
        const distToPlayer = lookAtTarget ? npcPos.distanceTo(lookAtTarget) : Infinity;
        const dangerZone = 200;
        const isTooClose = distToPlayer < dangerZone;
        
        // --- TURN LAYER ---
        // Bio-creatures turn towards their velocity vector when not explicitly aiming
        let targetLookDir = new THREE.Vector2(-Math.sin(this.npc.rotation), Math.cos(this.npc.rotation));
        
        if (this.npc.isBio) {
            if (this.npc.isAggravated && this.decision.intent === NPC_INTENTS.DASHING) {
                // LOCK ROTATION: During the dash, only face the locked dash vector. 
                // Do not turn toward the player or any other force.
                if (this.movement.dashVector) targetLookDir.copy(this.movement.dashVector);
            } else if (this.npc.isAggravated && (this.decision.intent === NPC_INTENTS.WINDING || this.decision.intent === NPC_INTENTS.STALK)) {
                // Combat aiming: Face the player when aggravated and NOT dashing
                if (lookAtTarget) targetLookDir.subVectors(lookAtTarget, npcPos).normalize();
            } else if (steerForce.length() > 0.01) {
                // Movement alignment: Face the direction of INTENDED travel (steerForce)
                targetLookDir.copy(steerForce).normalize();
            } else if (this.npc.velocity.length() > 0.1) {
                // Drift alignment: Face current velocity if no active steering
                targetLookDir.copy(this.npc.velocity).normalize();
            }
        } else {
            targetLookDir.copy(steerForce).normalize();
            
            const shouldFacePlayer = this.awareness.isAware && 
                                     distToPlayer < this.role.firingRange * 1.2 && 
                                     this.decision.intent !== NPC_INTENTS.RETREAT &&
                                     !isTooClose;

            if (shouldFacePlayer && lookAtTarget) {
                targetLookDir.subVectors(lookAtTarget, npcPos).normalize();
            } else if (isTooClose && lookAtTarget) {
                targetLookDir.copy(steerForce).normalize();
            }
        }

        // Apply rotation
        if (targetLookDir.length() > 0.01) {
            const targetRotation = Math.atan2(-targetLookDir.x, targetLookDir.y);
            let diff = targetRotation - this.npc.rotation;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            
            // Bio-creatures have majestic, heavy turns.
            // Turn speed is governed primarily by the npc.stats.turnSpeed (0.018).
            let turnSpeedMod = 1.0; 
            const turnAmount = Math.max(-this.npc.stats.turnSpeed * turnSpeedMod, Math.min(this.npc.stats.turnSpeed * turnSpeedMod, diff));
            this.npc.rotation += turnAmount;
        }

        // --- THRUST LAYER ---
        const forward = new THREE.Vector2(-Math.sin(this.npc.rotation), Math.cos(this.npc.rotation));
        const right = new THREE.Vector2(forward.y, -forward.x);
        
        // Project steerForce onto forward and lateral axes
        const forwardProj = steerForce.dot(forward);
        const lateralProj = steerForce.dot(right);
        
        // Bio-creatures only fly straight: No lateral thrust and no reverse thrust.
        const lateralEfficiency = this.npc.isBio ? 0.0 : 0.75; 
        let forwardThrust = this.npc.isBio ? Math.max(0, forwardProj) : Math.max(-0.2, forwardProj);
        
        const thrustVec = forward.clone().multiplyScalar(forwardThrust)
                          .add(right.clone().multiplyScalar(lateralProj * lateralEfficiency));

        // Bio-creatures use majestic force to reach their 65m/s target speed
        // Bio-creatures use heavy, organic force to reach their 12m/s target speed
        const massFactor = this.npc.isBio ? 0.6 : 1.0; 
        this.npc.velocity.add(thrustVec.multiplyScalar(massFactor));

        // AUTO-BRAKE: If we are moving towards the player and are too close, kill momentum.
        if (isTooClose && lookAtTarget) {
            const dirToPlayer = new THREE.Vector2().subVectors(lookAtTarget, npcPos).normalize();
            const currentVelDir = this.npc.velocity.clone().normalize();
            const movingTowardsPlayer = currentVelDir.dot(dirToPlayer) > 0;
            if (movingTowardsPlayer) {
                this.npc.velocity.multiplyScalar(0.85); // Heavier braking for responsiveness
            }
        }
        
        // Drag and Max Speed
        // Bio-creatures have higher drag (0.98) to ground their massive momentum
        const drag = this.npc.isBio ? 0.98 : 0.95; 
        this.npc.velocity.multiplyScalar(drag); 
        const speed = this.npc.velocity.length();
        
        // DASH OVERRIDE: Allow much higher speeds during the dashing intent
        const currentMaxSpeed = (this.npc.isBio && this.decision.intent === NPC_INTENTS.DASHING) 
                                ? this.npc.stats.maxSpeed * 3.5 
                                : this.npc.stats.maxSpeed;

        if (speed > currentMaxSpeed) {
            this.npc.velocity.setLength(currentMaxSpeed);
        }
        
        // Use delta for position updates for frame-rate independence
        const dtMult = delta * 60;
        this.npc.sprite.position.x += this.npc.velocity.x * dtMult;
        this.npc.sprite.position.y += this.npc.velocity.y * dtMult;
        
        // Simple bio-creatures and standard NPCs update their sprite rotation here.
        // Complex ones like SpaceSquid will overwrite this in their own specialized update loop.
        if (this.npc.sprite.material) {
            const offset = this.npc.frameCount > 1 ? Math.PI / 2 : 0;
            this.npc.sprite.material.rotation = this.npc.rotation + offset;
        }
        
        this.npc.x = this.npc.sprite.position.x;
        this.npc.y = this.npc.sprite.position.y;

        // Stat regen
        this.npc.stats.energy = Math.min(this.npc.stats.maxEnergy, this.npc.stats.energy + 0.1);
        this.npc.stats.shields = Math.min(this.npc.stats.maxShields, this.npc.stats.shields + 0.05);

        if (this.npc.weaponCooldowns && this.npc.weaponCooldowns.weapon1 > 0) {
            this.npc.weaponCooldowns.weapon1 = Math.max(0, this.npc.weaponCooldowns.weapon1 - 0.016);
        }
    }

    idleMovement(delta) {
        if (this.npc.isBio) {
            // Bio-creatures "Prowl" with a simple, extremely slow wander
            this.movement.sCurveTimer += delta * 0.2; 
            const forward = new THREE.Vector2(-Math.sin(this.npc.rotation), Math.cos(this.npc.rotation));
            
            // Allow very slight organic rotation over time
            if (Math.random() < 0.01) {
                this.npc.rotation += (Math.random() - 0.5) * 0.02;
            }
            
            this.applyPhysics(delta, forward.multiplyScalar(0.08), null);
        } else {
            // Standard NPC idle: simple forward drift
            const wander = new THREE.Vector2(-Math.sin(this.npc.rotation), Math.cos(this.npc.rotation)).multiplyScalar(0.01);
            this.applyPhysics(delta, wander, null);
            
            if (Math.random() < 0.005) {
                this.npc.rotation += (Math.random() - 0.5) * 0.15;
            }
        }
    }

    triggerBioPulse(now) {
        // COORDINATION: Don't pulse if a neighbor is already pulsing
        const neighbors = this.gm.npcs.filter(n => n.id !== this.npc.id && n.isBio);
        const nearNeighborPulsing = neighbors.some(n => n.lastPulseTime && now < n.lastPulseTime + 1000 && n.sprite.position.distanceTo(this.npc.sprite.position) < 200);
        
        if (!nearNeighborPulsing) {
            if (this.gm.createBioPulseEffect) {
                // Determine pulse radius based on creature class
                const isBoss = this.npc.classId === 'Large Bio-Creature';
                const pulseRadius = isBoss ? 400 : 150;
                const pulseDamage = isBoss ? 250 : 65;
                
                this.gm.createBioPulseEffect(this.npc.sprite.position, pulseRadius);
                this.gm.applyAoEDamage(this.npc.sprite.position, pulseRadius, pulseDamage, 'energy', this.npc.id);
                
                // NEW: Release ink cloud on pulse
                if (this.gm.createInkCloud) {
                    const inkRadius = isBoss ? 150 : 80;
                    this.gm.createInkCloud(this.npc.sprite.position, inkRadius, 8000);
                }
                
                this.npc.cooldowns.pulse = now + (isBoss ? 8000 : 3000);
                this.npc.lastPulseTime = now;
            }
        }
    }
}
