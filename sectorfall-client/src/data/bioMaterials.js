/**
 * bioMaterials.js
 * Pure data registry for biological materials (no shaders / no asset URLs).
 * Used for loot tables, harvesting, and inventory hydration.
 */

export const BIO_MATERIAL_REGISTRY = {
  "organic-bio-material": {
    id: "resource-organic-bio-material",
    name: "ORGANIC BIO-MATERIAL",
    type: "bio-material",
    subtype: "harvested-material",
    rarity: "common",
    quality: 50,
    stack: 1,
    maxStack: 100,
    metadata: {},
    weight: 0.2,
    description:
      "A standardized composite of pulsing synaptic fibers and cellular clusters harvested from space-faring organisms."
  }
};