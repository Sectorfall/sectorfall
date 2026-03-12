/**
 * shaders.js
 * Central registry for all GLSL shader strings used by the client.
 * Extracted from the original monolithic GameManager to prevent "missing shader" runtime errors.
 *
 * Keep these as plain template strings so bundlers (and Rosebud) can import them safely.
 */
export const ANOMALY_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const ANOMALY_FRAGMENT_SHADER = `
    uniform sampler2D uMap;
    uniform float uOpacity;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
        // Multi-frequency wave distortion for unstable energy look
        float distStrength = 0.02;
        float distortion = sin(vUv.y * 30.0 + uTime * 4.0) * distStrength +
                           cos(vUv.x * 25.0 + uTime * 3.0) * distStrength;
        
        vec2 warpedUv = vUv + vec2(distortion);

        // Rotate distorted UVs around center (0.5, 0.5) for internal spin
        float angle = uTime * 0.25; 
        float s = sin(angle);
        float c = cos(angle);
        vec2 centeredUv = warpedUv - vec2(0.5);
        vec2 rotatedUv = vec2(
            centeredUv.x * c - centeredUv.y * s,
            centeredUv.x * s + centeredUv.y * c
        ) + vec2(0.5);

        vec4 tex = texture2D(uMap, rotatedUv);
        
        // Soft radial mask (using original vUv to keep mask boundary stable)
        float dist = distance(vUv, vec2(0.5));
        float mask = smoothstep(0.5, 0.2, dist); 
        
        // High-frequency energy flicker
        float flicker = 0.85 + 0.15 * sin(uTime * 15.0);
        
        gl_FragColor = vec4(tex.rgb * flicker, tex.a * uOpacity * mask);
    }
`;

export const SHIP_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const SHIP_FRAGMENT_SHADER = `
    uniform sampler2D uMap;
    uniform bool uKeyGreen;
    uniform bool uKeyWhite;
    uniform vec3 uColor;
    uniform float uDamage;
    uniform float uBrightness;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
        vec4 tex = texture2D(uMap, vUv);
        
        // Key out white backgrounds (near 1.0)
        if (uKeyWhite && tex.r > 0.98 && tex.g > 0.98 && tex.b > 0.98) {
            discard;
        }

        if (tex.a < 0.05) discard;

        vec3 finalColor = tex.rgb * uBrightness;

        // Key out green areas (simple version for re-coloring Interceptor)
        if (uKeyGreen) {
            float greenness = max(0.0, tex.g - max(tex.r, tex.b));
            if (greenness > 0.05) {
                // Desaturate the green part and multiply by uColor
                float gray = dot(finalColor, vec3(0.299, 0.587, 0.114));
                finalColor = vec3(gray) * uColor;
            }
        }

        // Damage effect: Flash red when uDamage > 0
        float flash = sin(uTime * 15.0) * 0.5 + 0.5;
        finalColor = mix(finalColor, vec3(1.0, 0.0, 0.0), uDamage * flash);

        gl_FragColor = vec4(finalColor, tex.a);
    }
`;

export const FLUX_BEAM_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const FLUX_BEAM_FRAGMENT_SHADER = `
    uniform float uTime;
    uniform float uOpacity;
    uniform vec3 uColor;
    uniform float uFluxJitter;
    varying vec2 vUv;

    // Standard Hash Noise
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    float noise(float x) {
        float i = floor(x);
        float f = fract(x);
        return mix(hash(i), hash(i + 1.0), smoothstep(0.0, 1.0, f));
    }

    void main() {
        // Core filament (extremely bright center)
        float distToCenter = abs(vUv.y - 0.5);
        float core = 1.0 - distToCenter * 12.0;
        core = clamp(core, 0.0, 1.0);
        core = pow(core, 2.0);

        // Scrolling flux energy
        float fluxScroll = uTime * 25.0;
        float flux = noise(vUv.x * 15.0 - fluxScroll);
        
        // Secondary outer glow
        float glow = 1.0 - distToCenter * 2.5;
        glow = clamp(glow, 0.0, 1.0);
        glow = pow(glow, 3.0);

        // Third wide bloom halo
        float bloom = 1.0 - distToCenter * 1.8;
        bloom = clamp(bloom, 0.0, 1.0);
        bloom = pow(bloom, 2.0);

        // Energy pulses traveling along the beam
        float pulses = step(0.8, fract(vUv.x * 2.0 - uTime * 10.0));
        
        // Jitter effect for instability
        float jitter = (noise(uTime * 50.0) - 0.5) * uFluxJitter;
        float finalGlow = glow * (0.7 + flux * 0.3 + jitter);
        
        // Color mixing: White core with tinted edges
        // Bloom layer adds extra intensity for additive blending
        vec3 color = mix(uColor, vec3(1.0), core * 0.9);
        color += uColor * pulses * 0.3; // Add travelling energy pulses
        color += uColor * bloom * 0.4; // Add wider bloom aura
        
        // Taper edges at start and end of beam
        float edgeTaper = smoothstep(0.0, 0.05, vUv.x) * (1.0 - smoothstep(0.95, 1.0, vUv.x));
        
        // Boost alpha and color intensity to simulate bloom
        float finalAlpha = (core * 2.0 + finalGlow + bloom * 0.5) * uOpacity * edgeTaper;
        
        gl_FragColor = vec4(color * (1.2 + core * 0.5), clamp(finalAlpha, 0.0, 1.0));
    }
`;