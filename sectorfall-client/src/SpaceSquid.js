import * as THREE from 'three';

/**
 * SpaceSquid: A 2D-in-3D bio-creature with animated sprite sheet and floating movement.
 */
export class SpaceSquid {
    // Static cache for processed textures to prevent redundant canvas operations
    static textureCache = new Map();

    /**
     * @param {THREE.Scene} scene - The Three.js scene to add the squid to.
     * @param {string} textureUrl - URL of the sprite sheet.
     * @param {Object} options - Configuration for animation and movement.
     */
    constructor(scene, textureUrl, options = {}) {
        this.scene = scene;
        this.id = `bio-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        
        // Animation Settings
        this.tilesX = options.tilesX || 4; 
        this.tilesY = options.tilesY || 1;
        this.fps = options.fps || 2; 
        this.totalFrames = options.totalFrames || 4;
        
        // Create two sprites for seamless cross-fading
        this.material = new THREE.SpriteMaterial({ 
            transparent: true,
            color: 0xffffff,
            depthWrite: false,
            depthTest: true,
            blending: options.blending || THREE.NormalBlending,
            opacity: 0
        });

        this.isReady = false; // Flag to prevent rendering junk frames during processing

        // Unique cache key based on URL and animation tiling parameters
        const cacheKey = `${textureUrl}_${this.tilesX}_${this.tilesY}_${this.totalFrames}`;

        if (SpaceSquid.textureCache.has(cacheKey)) {
            const cached = SpaceSquid.textureCache.get(cacheKey);
            this.frameUVs = cached.frameUVs;
            this.frameAnchors = cached.frameAnchors;
            this.setupTexture(cached.texture);
        } else {
            // Load texture and process alpha
            const loader = new THREE.TextureLoader();
            loader.load(textureUrl, (tex) => {
                const lowUrl = textureUrl.toLowerCase();
                let processedTex;
                if (lowUrl.includes('.jpg') || lowUrl.includes('.webp')) {
                    processedTex = this.processJpgAlpha(tex);
                } else {
                    processedTex = tex;
                }

                processedTex.minFilter = THREE.LinearFilter;
                processedTex.magFilter = THREE.LinearFilter;
                processedTex.generateMipmaps = false; 
                processedTex.wrapS = processedTex.wrapT = THREE.ClampToEdgeWrapping;
                
                // Save to cache
                SpaceSquid.textureCache.set(cacheKey, {
                    texture: processedTex,
                    frameUVs: this.frameUVs,
                    frameAnchors: this.frameAnchors
                });

                this.setupTexture(processedTex);
            });
        }

        this.sprite = new THREE.Sprite(this.material);
        this.sprite.renderOrder = 10;
        this.sprite.position.z = 0;

        this.baseSize = options.size || 350; // Updated default to match GameManager scale
        this.sprite.scale.set(this.baseSize, this.baseSize, 1);
        
        this.scene.add(this.sprite);

        // State
        this.currentFrame = 0;
        this.animationTimer = 0;
        this.animationDirection = 1; 
        this.frameCenters = []; // To store calculated anchors for each frame
        
        // Stats & Identity for NPCAI
        this.isBio = true;
        this.type = 'BIO'; 
        this.classId = options.classId || 'Small Bio-Creature';
        this.isPassiveUntilAttacked = options.isPassiveUntilAttacked !== false;
        this.isAggravated = false;
        
        this.collisionRadius = (options.size || 350) * 0.15; 
        this.radius = this.collisionRadius; 
        
        this.stats = {
            hp: options.hp || 5000,
            maxHp: options.hp || 5000,
            shields: 0, 
            maxShields: 0, 
            energy: 100,
            maxEnergy: 100,
            turnSpeed: options.turnSpeed || 0.05,
            maxSpeed: options.maxSpeed || 6.5
        };
        
        this.locking = { state: 'Idle', timer: 0, entity: null };
        this.fittings = {}; 
        this.cooldowns = { pulse: 0, dash: 0 };
        this.rotation = Math.random() * Math.PI * 2;

        // Biological entities use gas-cloud collision instead of solid rebound
        this.isGasCloud = true;

        // Movement State
        this.position = options.position ? options.position.clone() : new THREE.Vector3();
        this.velocity = new THREE.Vector2(0, 0); 
        
        // Floating/Bobbing Constants
        this.bobPhase = Math.random() * Math.PI * 2;
        this.bobSpeed = options.bobSpeed || 0.015; // Synced with GameManager
        this.bobAmplitude = options.bobAmplitude || 10;
        
        this.visualOffset = options.visualOffset !== undefined ? options.visualOffset : 0; 
        
        // --- Collision Mesh ---
        // Instead of one big circle, we define a "spine" of smaller circles
        // that follow the squid's orientation.
        this.collisionCircles = [];
        this.updateCollisionCircles();

        this.isDestroyed = false;
    }

    /**
     * Common setup for texture regardless if it was cached or freshly processed.
     */
    setupTexture(processedTex) {
        // CRITICAL: Clone the texture so each squid has its own unique repeat/offset properties.
        this.texture = processedTex.clone();
        this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
        this.texture.needsUpdate = true;
        this.material.map = this.texture;
        
        // Immediately apply first frame state
        if (this.frameUVs && this.frameUVs[0]) {
            const uv = this.frameUVs[0];
            const anchor = this.frameAnchors[0];
            this.texture.repeat.set(uv.width, uv.height);
            this.texture.offset.set(uv.x, uv.y);
            this.sprite.center.set(anchor.x, anchor.y);
            this.isReady = true;
        }
        
        this.material.needsUpdate = true;
    }

    /**
     * Updates the positions of the collision circles based on current rotation.
     */
    updateCollisionCircles() {
        const headX = this.position.x;
        const headY = this.position.y;
        
        // Direction vectors
        // The head always faces 'forward' (where forward = -sin, cos of rotation)
        const forward = new THREE.Vector2(-Math.sin(this.rotation), Math.cos(this.rotation));
        const backward = forward.clone().multiplyScalar(-1);
        
        // We define 4 circles along the length of the squid
        // Tightened radii significantly to match the visual "spine" better
        this.collisionCircles = [
            // 1. Head (Main focus) - reduced to 7% of baseSize
            { x: headX, y: headY, radius: this.baseSize * 0.07 },
            // 2. Upper Body - reduced to 5% of baseSize
            { x: headX + backward.x * this.baseSize * 0.15, y: headY + backward.y * this.baseSize * 0.15, radius: this.baseSize * 0.05 },
            // 3. Lower Body - reduced to 4% of baseSize
            { x: headX + backward.x * this.baseSize * 0.30, y: headY + backward.y * this.baseSize * 0.30, radius: this.baseSize * 0.04 },
            // 4. Tentacles (Tail) - reduced to 3% of baseSize
            { x: headX + backward.x * this.baseSize * 0.50, y: headY + backward.y * this.baseSize * 0.50, radius: this.baseSize * 0.03 }
        ];

        // Update the primary radius for broad gas-cloud detection.
        // Set to 30% of baseSize to create a very tight atmospheric hazard that strictly follows the creature's core.
        this.radius = this.baseSize * 0.30; 
    }

    /**
     * Converts a JPG texture into a CanvasTexture and calculates 
     * stable anchor points for every frame.
     */
    processJpgAlpha(texture) {
        const img = texture.image;
        const w = img.width;
        const h = img.height;
        const tilesX = this.tilesX;
        const tilesY = this.tilesY;

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Using integer-locked tile dimensions to prevent sub-pixel jitter
        const intTileW = Math.floor(w / tilesX);
        const intTileH = Math.floor(h / tilesY);

        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const threshold = 28; 
        const softEdge = 15; 

        // Pass 1: Global Threshold & Head Detection (Integer Locked)
        const frameData = [];
        for (let i = 0; i < this.totalFrames; i++) {
            const row = Math.floor(i / tilesX);
            const col = i % tilesX;
            const sx = col * intTileW;
            const sy = row * intTileH;
            
            const tileData = ctx.getImageData(sx, sy, intTileW, intTileH).data;
            let peakX = intTileW / 2, peakY = intTileH / 2, maxB = -1;

            for (let ty = 0; ty < intTileH; ty++) {
                for (let tx = 0; tx < intTileW; tx++) {
                    const idx = (ty * intTileW + tx) * 4;
                    const b = (tileData[idx] + tileData[idx+1] + tileData[idx+2]) / 3;
                    if (b > maxB) { maxB = b; peakX = tx; peakY = ty; }
                }
            }

            let sumX = 0, sumY = 0, totalW = 0;
            for (let ny = peakY - 30; ny <= peakY + 30; ny++) {
                for (let nx = peakX - 30; nx <= peakX + 30; nx++) {
                    if (nx < 0 || nx >= intTileW || ny < 0 || ny >= intTileH) continue;
                    const idx = (ny * intTileW + nx) * 4;
                    const b = (tileData[idx] + tileData[idx+1] + tileData[idx+2]) / 3;
                    if (b > 80) {
                        const weight = Math.pow(b / 255, 4); 
                        sumX += nx * weight; sumY += ny * weight; totalW += weight;
                    }
                }
            }
            const headX = totalW > 0 ? sumX / totalW : peakX;
            const headY = totalW > 0 ? sumY / totalW : peakY;
            
            frameData.push({ 
                absX: sx + headX, 
                absY: sy + headY,
                sx, sy, headX, headY, row, col 
            });
        }

        // Pass 2: Ownership & Hard Boundary Clearing
        for (let i = 0; i < data.length; i += 4) {
            const px = (i / 4) % w;
            const py = Math.floor((i / 4) / w);
            const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
            
            if (brightness < threshold) {
                data[i + 3] = Math.max(0, ((brightness - (threshold - softEdge)) / softEdge) * 255);
            } else {
                data[i + 3] = 255;
            }

            const tCol = Math.floor(px / intTileW);
            const tRow = Math.floor(py / intTileH);
            const tIdx = tRow * tilesX + tCol;

            if (tIdx >= 0 && tIdx < frameData.length && data[i + 3] > 0) {
                const myHead = frameData[tIdx];
                const distToMyHeadSq = Math.pow(px - myHead.absX, 2) + Math.pow(py - myHead.absY, 2);
                
                // Ownership check: If this pixel is closer to another head, it's an intruder.
                // We give a slight 10% bias to the "native" head to prevent aggressive clipping.
                let isIntruder = false;
                for (let n = 0; n < frameData.length; n++) {
                    if (n === tIdx) continue;
                    const other = frameData[n];
                    const distToOtherSq = Math.pow(px - other.absX, 2) + Math.pow(py - other.absY, 2);
                    if (distToOtherSq < distToMyHeadSq * 0.9) {
                        isIntruder = true;
                        break;
                    }
                }

                // Hard Boundary Guards: Clear edges of the tile box aggressively
                const tileL = tCol * intTileW;
                const tileT = tRow * intTileH;
                const tileR = (tCol + 1) * intTileW;
                const tileB = (tRow + 1) * intTileH;
                const edgeDist = Math.min(px - tileL, tileR - 1 - px, py - tileT, tileB - 1 - py);

                if (isIntruder || edgeDist < 5) {
                    data[i + 3] = 0;
                } else if (edgeDist < 20) {
                    // Soft ramp only for non-intruder pixels near the edge
                    data[i + 3] *= (edgeDist - 5) / 15;
                }
            }
        }
        ctx.putImageData(imageData, 0, 0);

        // Pass 3: Mathematically Perfect UV & Anchor Finalization
        // We MUST use the same integer-locked dimensions for UVs that we used for clearing.
        this.frameUVs = [];
        this.frameAnchors = [];

        // Tight UV Padding to ensure we never touch the "uncleaned" outer pixels.
        // Increased to 15px to ensure no linear filtering artifacts.
        const uvPadX = 15.0 / w; 
        const uvPadY = 15.0 / h;

        for (let i = 0; i < this.totalFrames; i++) {
            const f = frameData[i];
            
            // Calculate UVs based on the EXACT pixel coordinates used in Pass 1 & 2
            const uvX = f.sx / w;
            const uvY = 1.0 - ((f.sy + intTileH) / h); 

            this.frameUVs.push({
                x: uvX + uvPadX,
                y: uvY + uvPadY,
                width: (intTileW / w) - (uvPadX * 2),
                height: (intTileH / h) - (uvPadY * 2)
            });

            this.frameAnchors.push({
                x: f.headX / intTileW,
                y: 1.0 - (f.headY / intTileH)
            });
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.flipY = true;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        return tex;
    }

    /**
     * Update the squid's animation and position.
     */
    update(delta, playerPos, playerVelocity, playerIsAimingAtMe) {
        if (this.isDestroyed || !this.isReady) return;

        if (this.fps > 0) {
            this.animationTimer += delta;
            const frameDuration = 1 / this.fps;
            if (this.animationTimer >= frameDuration) {
                this.currentFrame += this.animationDirection;
                if (this.currentFrame >= this.totalFrames - 1) {
                    this.currentFrame = this.totalFrames - 1;
                    this.animationDirection = -1;
                } else if (this.currentFrame <= 0) {
                    this.currentFrame = 0;
                    this.animationDirection = 1;
                }
                this.animationTimer %= frameDuration;
            }

            if (this.texture && this.frameUVs && this.frameUVs[this.currentFrame]) {
                const uv = this.frameUVs[this.currentFrame];
                const anchor = this.frameAnchors[this.currentFrame];
                
                // 1. Swap the texture frame
                this.texture.repeat.set(uv.width, uv.height);
                this.texture.offset.set(uv.x, uv.y);
                
                // 2. PIN THE HEAD: Using the per-frame anchor calculated in processJpgAlpha
                // to keep the head at the world position.
                this.sprite.center.set(anchor.x, anchor.y);
            }
        }

        // 2. AI & Movement
        if (this.ai) {
            this.sprite.position.x = this.position.x;
            this.sprite.position.y = this.position.y;
            this.ai.update(delta, playerPos, playerVelocity, playerIsAimingAtMe);
            this.position.x = this.sprite.position.x;
            this.position.y = this.sprite.position.y;
            
            // Sync collision mesh
            this.updateCollisionCircles();
        }
        
        // 3. Apply Visual Effects (Bobbing & Pulsing)
        const elapsed = Date.now() * 0.001;
        const bobY = Math.sin(elapsed * this.bobSpeed + this.bobPhase) * this.bobAmplitude;
        const pulseFreq = 0.15; // Slow, deep breathing cycle (6.6s)
        const pulse = Math.sin(elapsed * pulseFreq * Math.PI * 2) * 0.5 + 0.5;
        const scaleFactor = 1.0 + pulse * 0.05;
        const finalScale = this.baseSize * scaleFactor;

        this.sprite.position.set(this.position.x, this.position.y + bobY, 0);
        this.sprite.scale.set(finalScale, finalScale, 1);

        // Visual properties
        // Re-applying the 180-degree offset plus a 15-degree anti-clockwise correction (0.26 radians)
        // to ensure the head leads and tentacles trail correctly.
        this.material.rotation = this.rotation + Math.PI + (15 * Math.PI / 180);
        this.material.opacity = 0.85 + pulse * 0.15; 

        // 5. Update coordinates
        this.x = this.position.x;
        this.y = this.position.y;
    }

    /**
     * Clean up resources.
     */
    destroy() {
        this.isDestroyed = true;
        this.scene.remove(this.sprite);
        this.material.dispose();
        this.texture.dispose();
    }
}
