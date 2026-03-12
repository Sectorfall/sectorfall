import * as THREE from 'three';
import { cloudService } from './CloudService.js';
import { backendSocket } from './websocket.js';
import { uuid } from './utils.js';

// Accent colors used by LootObject visuals
const RARITY_ACCENT_COLORS = {
  common: 0xffffff,
  rare: 0x00ccff,
  epic: 0xa335ee,
  legendary: 0xffcc00,
  mythic: 0xffcc00
};

class LootObject {
    constructor(scene, manager, itemData, position) {
        this.scene = scene;
        this.manager = manager;
        this.itemData = itemData;
        this.expired = false;
        this.position = position.clone();
        this.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 1,
            (Math.random() - 0.5) * 1,
            0
        );
        this.friction = 0.98;
        this.startTime = Date.now();
        this.maxLifetime = 300000; // 5 minutes

        // Visuals
        const rarity = (itemData.rarity || 'common').toLowerCase();
        const color = RARITY_ACCENT_COLORS[rarity] || 0xffffff;
        const colorHex = '#' + new THREE.Color(color).getHexString();

        // Sprite
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');

        // Draw a glowing orb/crate for loot
        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.3, colorHex);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending });
        this.sprite = new THREE.Sprite(material);
        this.sprite.position.copy(this.position);
        this.sprite.scale.set(40, 40, 1);
        this.sprite.renderOrder = 15;
        this.scene.add(this.sprite);

        // Floating Text
        this.textSprite = this.createLabel(itemData.name, colorHex);
        this.textSprite.position.copy(this.position).add(new THREE.Vector3(0, 30, 0));
        this.scene.add(this.textSprite);
    }

    createLabel(text, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 44px "JetBrains Mono", monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 4;
        ctx.fillText(text.toUpperCase(), 256, 32);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(170, 22, 1);
        sprite.renderOrder = 100;
        return sprite;
    }

    async update(dt, currentTime, playerPos) {
        if (this.expired) return;

        // Life time check
        if (currentTime - this.startTime > this.maxLifetime) {
            this.expired = true;
            return;
        }

        // Apply physics
        this.velocity.multiplyScalar(this.friction);
        this.position.add(this.velocity);

        // Tractor Beam Logic
        const distToPlayer = this.position.distanceTo(playerPos);
        const autoCollectRange = 40; // Proximity pickup

        // Dynamic capacity check: check if this specific item can fit
        const itemWeight = parseFloat(this.itemData.weight || 0.1);
        const canFit = (this.manager.stats.currentCargoWeight + itemWeight) <= this.manager.stats.cargoHold;
        const isCargoFull = !canFit;

        if (distToPlayer < autoCollectRange && !isCargoFull) {
            await this.collect();
            return;
        }

        // Ore fragments (resource) get 100m range (350), others get 50m (175)
        const tractorRange = this.itemData.type === 'resource' ? 350 : 175;

        if (distToPlayer < tractorRange && !isCargoFull) {
            const pullForce = 0.25;
            const dir = new THREE.Vector3().subVectors(playerPos, this.position).normalize();
            this.velocity.add(dir.multiplyScalar(pullForce));

            // Visual Beam
            if (!this.beam) {
                const material = new THREE.LineBasicMaterial({ 
                    color: 0x00ffff, 
                    transparent: true, 
                    opacity: 0.5,
                    blending: THREE.AdditiveBlending 
                });
                const geometry = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(0, 0, 0),
                    new THREE.Vector3(0, 0, 0)
                ]);
                this.beam = new THREE.Line(geometry, material);
                this.beam.renderOrder = 10;
                this.scene.add(this.beam);
            }

            const points = [
                this.position.clone(),
                playerPos.clone()
            ];
            this.beam.geometry.setFromPoints(points);
            this.beam.material.opacity = 0.3 + Math.sin(currentTime * 0.02) * 0.2;
            this.beam.visible = true;
        } else {
            if (this.beam) this.beam.visible = false;
        }

        // Update visuals
        const zoomScale = this.manager.cameraDistance / 1400;
        this.sprite.position.copy(this.position);

        const bobbing = Math.sin(currentTime * 0.005) * 5 * zoomScale;
        const verticalOffset = 30 * zoomScale;
        this.textSprite.position.copy(this.position).add(new THREE.Vector3(0, verticalOffset + bobbing, 0));
        this.textSprite.scale.set(170 * zoomScale, 22 * zoomScale, 1);

        // Pulse effect
        const pulse = 0.8 + Math.sin(currentTime * 0.01) * 0.2;
        this.sprite.scale.set(40 * pulse, 40 * pulse, 1);
    }

    async collect() {
        if (this.expired || this.isCollecting || this.collectResolved) return;

        // Ensure we have an authoritative ID before attempting collection
        // If it's a local spawn still waiting for network confirmation, we wait
        const objectId = this.itemData.id;
        if (!objectId || objectId === 'undefined') {
            console.warn("[LootObject] Attempted collection without authoritative ID. Retrying...");
            this.velocity.add(new THREE.Vector3((Math.random()-0.5)*2, (Math.random()-0.5)*2, 0));
            return;
        }

        this.isCollecting = true;
        this.collectPending = true;

        const success = await this.manager.requestLootCollection(objectId, this.itemData);

        if (success) {
            this.collectResolved = true;
            this.expired = true;
            if (this.manager.synth) {
                try {
                    this.manager.synth.triggerAttackRelease("C5", "32n", Tone.now());
                } catch (e) {}
            }
        } else {
            // Server rejected or object not found/already collected
            this.isCollecting = false;
            this.collectPending = false;
            this.velocity.add(new THREE.Vector3((Math.random()-0.5)*5, (Math.random()-0.5)*5, 0));
        }
    }

    destroy() {
        if (this.beam) {
            this.scene.remove(this.beam);
            this.beam.geometry.dispose();
            this.beam.material.dispose();
        }
        this.scene.remove(this.sprite);
        this.scene.remove(this.textSprite);
        if (this.sprite.material.map) this.sprite.material.map.dispose();
        this.sprite.material.dispose();
        if (this.textSprite.material.map) this.textSprite.material.map.dispose();
        this.textSprite.material.dispose();
    }
}

// -----------------------------------------------------
// AUTHORITATIVE VITALS RULES
// - Never reset hp/shields/energy on spawn if a valid value exists
// - Only default to max values if value is missing or invalid
// - EC2 is authoritative in space; hydration must respect incoming values
// -----------------------------------------------------

export class WorldObjectsService {
  constructor(scene, manager) {
    this.scene = scene;
    this.manager = manager;
    this.lootObjects = [];
  }

  /**
   * Per-frame update for loot/world objects.
   * Called from GameManager.update().
   */
  update(dt, currentTime) {
    if (!this.manager?.ship || !this.manager.ship.sprite) return;
    const playerPos = this.manager.ship.sprite.position;

    for (let i = this.lootObjects.length - 1; i >= 0; i--) {
      const loot = this.lootObjects[i];
      loot.update(dt, currentTime, playerPos);
      if (loot.expired) {
        loot.destroy();
        this.lootObjects.splice(i, 1);
      }
    }
  }

  /**
   * Authoritative spawn (Supabase) + local visual instantiation.
   * Keeps old GameManager.spawnLoot() behavior but moved out of GameManager.
   */
  async spawnLoot(itemData, position, systemId = 'cygnus-prime') {
    // SANITIZATION GUARD: Ensure position is a Vector3 and payload is safe
    const safePos = (position instanceof THREE.Vector3) ? position.clone() :
      new THREE.Vector3(position?.x || 0, position?.y || 0, position?.z || 0);

    const safeItemData = { ...(itemData || {}) };
    // Ensure amount and weight are finite numbers if present
    if ('amount' in safeItemData) safeItemData.amount = Number(Number(safeItemData.amount).toFixed(2));
    if ('weight' in safeItemData) safeItemData.weight = Number(Number(safeItemData.weight).toFixed(2));

    let authoritativeId = null;

    // 1) Authoritative persistence (prefer EC2, fallback to direct Supabase only if needed)
    const ec2Ready = !!backendSocket && !!backendSocket.socket && backendSocket.socket.readyState === WebSocket.OPEN && !backendSocket.isDocked;
    if (ec2Ready && typeof backendSocket.sendSpawnWorldObject === 'function') {
      const spawnedObj = await backendSocket.sendSpawnWorldObject(
        safeItemData.type || 'loot',
        safeItemData,
        safePos
      );
      if (spawnedObj && (spawnedObj.object_id || spawnedObj.id)) {
        authoritativeId = spawnedObj.object_id || spawnedObj.id;
        console.log(`[WorldObjects] Manifested authoritative loot record via EC2: ${authoritativeId}`);
      } else {
        console.warn("[WorldObjects] EC2 authoritative spawn failed.");
        return null;
      }
    } else if (cloudService.user) {
      const spawnedObj = await cloudService.spawnWorldObject(
        safeItemData.type || 'loot',
        safeItemData,
        safePos,
        systemId
      );

      if (spawnedObj && (spawnedObj.object_id || spawnedObj.id)) {
        authoritativeId = spawnedObj.object_id || spawnedObj.id;
        console.log(`[WorldObjects] Manifested authoritative loot record: ${authoritativeId}`);
      } else {
        console.warn("[WorldObjects] AUTHORITATIVE SPAWN FAILED. Client registration aborted to prevent state drift.");
        return null;
      }
    }

    // 2) Local visual instantiation
    const loot = new LootObject(this.scene, this.manager, { ...safeItemData, id: authoritativeId }, safePos);
    this.lootObjects.push(loot);
    return loot;
  }

  /**
   * Called when we receive a network/world object spawn (from EC2 or Supabase realtime).
   */
  onNetworkObjectSpawned(obj) {
    if (!obj || (!obj.data && !obj.payload && !obj.data_json)) return;

    const objectId = obj.object_id || obj.id;
    if (!objectId) return;

    // Check if we already have this object locally
    const existing = this.lootObjects.find(l => l.itemData?.id === objectId);
    if (existing) return;

    console.log(`[WorldObjects] Spawning network object: ${objectId} (${obj.type})`);

    const itemData = {
      ...(obj.data || obj.payload || obj.data_json),
      id: objectId,
      networkSpawned: true
    };

    const position = new THREE.Vector3(Number(obj.x) || 0, Number(obj.y) || 0, 0);

    const loot = new LootObject(this.scene, this.manager, itemData, position);
    this.lootObjects.push(loot);
  }

  /**
   * Called when we receive a network/world object removal (someone else collected it).
   */
  onNetworkObjectRemoved(objectId) {
    if (!objectId) return;

    const lootIdx = this.lootObjects.findIndex(l => l.itemData?.id === objectId);
    if (lootIdx !== -1) {
      console.log(`[WorldObjects] Removing collected network object: ${objectId}`);
      const loot = this.lootObjects[lootIdx];
      loot.expired = true;
    }
  }

  /**
   * Cleanup helper for scene transitions.
   */
  clearAll() {
    for (let i = this.lootObjects.length - 1; i >= 0; i--) {
      try {
        this.lootObjects[i].destroy();
      } catch (e) {}
    }
    this.lootObjects = [];
  }
}