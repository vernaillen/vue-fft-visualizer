<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, toRefs } from 'vue'
import { useLocalAudio } from '../composables/useLocalAudio'

/**
 * Blob Visualizer - Raymarched organic 3D blob
 *
 * Inspired by the Codrops "Creative WebGL Blobs" tutorial by Mario Carrillo.
 * Supports 'websocket' mode (external server) or 'local' mode (browser mic + WASM FFT).
 */

const props = withDefaults(defineProps<{
  /** Data source mode: 'websocket' for external server, 'local' for browser mic + WASM FFT */
  mode?: 'websocket' | 'local'
  /** WebSocket URL (required when mode='websocket') */
  websocketUrl?: string
  /** Animation speed multiplier */
  speed?: number
  /** Noise displacement strength */
  noiseStrength?: number
  /** Noise sampling density */
  noiseDensity?: number
  /** Base hue offset for cosine palette */
  hue?: number
  /** Color palette */
  palette?: 'rainbow' | 'warm' | 'cool' | 'electric'
  /** Automatically react to audio */
  autoReactive?: boolean
}>(), {
  mode: 'websocket',
  speed: 0.3,
  noiseStrength: 0.3,
  noiseDensity: 1.5,
  hue: 0.5,
  palette: 'rainbow',
  autoReactive: true,
})

const emit = defineEmits<{
  connected: []
  disconnected: []
  error: [error: string]
}>()

const canvasRef = ref<HTMLCanvasElement>()
const containerRef = ref<HTMLElement>()
const isConnected = ref(false)
const fps = ref(0)

// FFT data
const serverBins = ref(80)
const fftData = ref<Uint8Array>(new Uint8Array(80))

// Audio analysis
const bassEnergy = ref(0)
const midEnergy = ref(0)
const highEnergy = ref(0)

// Smoothed audio
let smoothedBass = 0
let smoothedMid = 0
let smoothedHigh = 0

// Mouse
let mouseX = 0
let mouseY = 0
let targetMouseX = 0
let targetMouseY = 0

// Local audio (WASM FFT)
const localAudio = useLocalAudio()

// WebSocket
let websocket: WebSocket | null = null
let animationId: number | null = null
let frameCount = 0
let lastFpsTime = 0

// WebGL state
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let positionBuffer: WebGLBuffer | null = null

// Uniforms
let uResolutionLoc: WebGLUniformLocation | null = null
let uTimeLoc: WebGLUniformLocation | null = null
let uBassLoc: WebGLUniformLocation | null = null
let uMidLoc: WebGLUniformLocation | null = null
let uHighLoc: WebGLUniformLocation | null = null
let uSpeedLoc: WebGLUniformLocation | null = null
let uNoiseStrengthLoc: WebGLUniformLocation | null = null
let uNoiseDensityLoc: WebGLUniformLocation | null = null
let uHueLoc: WebGLUniformLocation | null = null
let uPaletteLoc: WebGLUniformLocation | null = null
let uMouseLoc: WebGLUniformLocation | null = null

let startTime = 0

const vertexShaderSource = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

const fragmentShaderSource = `
  precision highp float;

  uniform vec2 u_resolution;
  uniform float u_time;
  uniform float u_bass;
  uniform float u_mid;
  uniform float u_high;
  uniform float u_speed;
  uniform float u_noiseStrength;
  uniform float u_noiseDensity;
  uniform float u_hue;
  uniform int u_palette;
  uniform vec2 u_mouse;

  // --- 3D Classic Perlin Noise (Stefan Gustavson) ---
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

  float cnoise(vec3 P) {
    vec3 Pi0 = floor(P);
    vec3 Pi1 = Pi0 + vec3(1.0);
    Pi0 = mod289(Pi0);
    Pi1 = mod289(Pi1);
    vec3 Pf0 = fract(P);
    vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz;
    vec4 iz1 = Pi1.zzzz;
    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0);
    vec4 ixy1 = permute(ixy + iz1);
    vec4 gx0 = ixy0 * (1.0 / 7.0);
    vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5);
    gy0 -= sz0 * (step(0.0, gy0) - 0.5);
    vec4 gx1 = ixy1 * (1.0 / 7.0);
    vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5);
    gy1 -= sz1 * (step(0.0, gy1) - 0.5);
    vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
    vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
    vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
    vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
    vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
    vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
    vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
    vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
    vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);
    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
  }

  // --- Rotation helpers ---
  vec3 rotateX(vec3 v, float a) {
    float s = sin(a), c = cos(a);
    return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
  }

  vec3 rotateY(vec3 v, float a) {
    float s = sin(a), c = cos(a);
    return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
  }

  // --- Cosine palette (Inigo Quilez) ---
  vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.28318 * (c * t + d));
  }

  void getPalette(int idx, out vec3 a, out vec3 b, out vec3 c, out vec3 d) {
    if (idx == 0) {
      // Rainbow (Codrops default)
      a = vec3(0.5); b = vec3(0.5); c = vec3(1.0); d = vec3(0.0, 0.1, 0.2);
    } else if (idx == 1) {
      // Warm (sunset)
      a = vec3(0.5, 0.5, 0.5); b = vec3(0.5, 0.5, 0.3);
      c = vec3(1.0, 0.7, 0.4); d = vec3(0.0, 0.15, 0.2);
    } else if (idx == 2) {
      // Cool (ocean)
      a = vec3(0.5, 0.5, 0.5); b = vec3(0.5, 0.5, 0.5);
      c = vec3(1.0, 1.0, 1.0); d = vec3(0.3, 0.2, 0.2);
    } else {
      // Electric
      a = vec3(0.5, 0.5, 0.5); b = vec3(0.5, 0.5, 0.5);
      c = vec3(2.0, 1.0, 0.0); d = vec3(0.5, 0.2, 0.25);
    }
  }

  // --- Blob SDF with noise deformation ---
  float blobSDF(vec3 p) {
    float t = u_time * u_speed;

    // Twist noise pattern (inspired by Codrops rotateY twist)
    float twistAngle = sin(p.y * 3.0 + t) * 0.4;
    vec3 tp = rotateY(p, twistAngle);

    // Noise displacement
    float n = cnoise(tp * u_noiseDensity + t);

    // Sphere SDF with noise
    float sphere = length(p) - 1.0;

    // Breathing pulse
    float breathe = 1.0 + 0.06 * sin(u_time * 0.8);

    return sphere / breathe - n * u_noiseStrength;
  }

  // --- Normal via central differences ---
  vec3 calcNormal(vec3 p) {
    float e = 0.003;
    return normalize(vec3(
      blobSDF(vec3(p.x + e, p.y, p.z)) - blobSDF(vec3(p.x - e, p.y, p.z)),
      blobSDF(vec3(p.x, p.y + e, p.z)) - blobSDF(vec3(p.x, p.y - e, p.z)),
      blobSDF(vec3(p.x, p.y, p.z + e)) - blobSDF(vec3(p.x, p.y, p.z - e))
    ));
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

    // Camera
    vec3 ro = vec3(0.0, 0.0, 3.8);
    vec3 rd = normalize(vec3(uv, -1.5));

    // Mouse rotation (smooth, subtle)
    ro = rotateX(ro, u_mouse.y * 0.3);
    rd = rotateX(rd, u_mouse.y * 0.3);
    ro = rotateY(ro, u_mouse.x * 0.3);
    rd = rotateY(rd, u_mouse.x * 0.3);

    // Raymarch
    float t = 0.0;
    float d = 0.0;
    vec3 p = ro;
    bool hit = false;
    float minDist = 100.0;

    for (int i = 0; i < 64; i++) {
      p = ro + rd * t;
      d = blobSDF(p);
      minDist = min(minDist, d);
      if (d < 0.001) { hit = true; break; }
      if (t > 10.0) break;
      t += d * 0.8;
    }

    // Palette parameters
    vec3 pa, pb, pc, pd;
    getPalette(u_palette, pa, pb, pc, pd);

    vec3 color = vec3(0.0);
    float alpha = 0.0;

    if (hit) {
      vec3 n = calcNormal(p);

      // Distortion at hit point (same noise as SDF)
      float time = u_time * u_speed;
      float twistAngle = sin(p.y * 3.0 + time) * 0.4;
      vec3 tp = rotateY(p, twistAngle);
      float distort = cnoise(tp * u_noiseDensity + time);

      // Cosine palette color driven by distortion
      color = cosPalette(u_hue + distort * 2.0, pa, pb, pc, pd);

      // Lighting
      vec3 lightDir = normalize(vec3(1.0, 1.0, 2.0));
      float diff = max(dot(n, lightDir), 0.0);
      float ambient = 0.3;

      // Fresnel rim light
      float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

      // Specular highlight
      vec3 refl = reflect(-lightDir, n);
      float spec = pow(max(dot(refl, -rd), 0.0), 32.0);

      color = color * (ambient + diff * 0.7)
            + color * fresnel * 0.3
            + vec3(spec * 0.15);

      // Audio brightness boost
      color *= 1.0 + u_bass * 0.4;

      alpha = 1.0;
    }

    // Glow around the blob (from near-miss rays)
    float glow = exp(-minDist * 5.0) * 0.2;
    glow *= (1.0 + u_bass * 0.5);
    vec3 glowColor = cosPalette(u_hue, pa, pb, pc, pd);
    color += glowColor * glow * (1.0 - alpha);

    // Dark background
    vec3 bg = vec3(0.008, 0.012, 0.03);
    color = max(color, bg * (1.0 - alpha));

    // Tone mapping
    color = color / (color + vec3(0.8));

    gl_FragColor = vec4(color, 1.0);
  }
`

function createShader(glCtx: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = glCtx.createShader(type)
  if (!shader) return null

  glCtx.shaderSource(shader, source)
  glCtx.compileShader(shader)

  if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
    console.error('Shader compile error:', glCtx.getShaderInfoLog(shader))
    glCtx.deleteShader(shader)
    return null
  }

  return shader
}

function initWebGL(): boolean {
  const canvas = canvasRef.value
  if (!canvas) return false

  gl = canvas.getContext('webgl', {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false
  })

  if (!gl) {
    console.error('WebGL not supported')
    return false
  }

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)

  if (!vertexShader || !fragmentShader) return false

  program = gl.createProgram()
  if (!program) return false

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program))
    return false
  }

  gl.useProgram(program)

  // Fullscreen quad
  positionBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1, 1,   1, -1,   1, 1
  ]), gl.STATIC_DRAW)

  const positionLoc = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(positionLoc)
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

  // Uniform locations
  uResolutionLoc = gl.getUniformLocation(program, 'u_resolution')
  uTimeLoc = gl.getUniformLocation(program, 'u_time')
  uBassLoc = gl.getUniformLocation(program, 'u_bass')
  uMidLoc = gl.getUniformLocation(program, 'u_mid')
  uHighLoc = gl.getUniformLocation(program, 'u_high')
  uSpeedLoc = gl.getUniformLocation(program, 'u_speed')
  uNoiseStrengthLoc = gl.getUniformLocation(program, 'u_noiseStrength')
  uNoiseDensityLoc = gl.getUniformLocation(program, 'u_noiseDensity')
  uHueLoc = gl.getUniformLocation(program, 'u_hue')
  uPaletteLoc = gl.getUniformLocation(program, 'u_palette')
  uMouseLoc = gl.getUniformLocation(program, 'u_mouse')

  startTime = performance.now()

  return true
}

function analyzeFFT(data: Uint8Array) {
  const bins = data.length
  const bassBins = Math.floor(bins * 0.125)
  const midEnd = Math.floor(bins * 0.5)

  let bassSum = 0
  for (let i = 0; i < bassBins; i++) {
    bassSum += data[i]!
  }
  bassEnergy.value = bassSum / bassBins / 255

  let midSum = 0
  for (let i = bassBins; i < midEnd; i++) {
    midSum += data[i]!
  }
  midEnergy.value = midSum / (midEnd - bassBins) / 255

  let highSum = 0
  for (let i = midEnd; i < bins; i++) {
    highSum += data[i]!
  }
  highEnergy.value = highSum / (bins - midEnd) / 255
}

function render() {
  if (!gl || !program) return

  const canvas = canvasRef.value
  if (!canvas) return

  const time = (performance.now() - startTime) / 1000

  // Smooth audio
  const smoothFactor = 0.11
  smoothedBass += (bassEnergy.value - smoothedBass) * smoothFactor
  smoothedMid += (midEnergy.value - smoothedMid) * smoothFactor
  smoothedHigh += (highEnergy.value - smoothedHigh) * smoothFactor

  // Smooth mouse (lerp toward target)
  mouseX += (targetMouseX - mouseX) * 0.04
  mouseY += (targetMouseY - mouseY) * 0.04

  // Calculate effective values with audio reactivity
  let effectiveSpeed = currentSpeed.value
  let effectiveStrength = currentNoiseStrength.value
  let effectiveHue = currentHue.value

  if (currentAutoReactive.value) {
    effectiveStrength += smoothedBass * 0.3
    effectiveHue += smoothedMid * 0.3
    effectiveSpeed += smoothedHigh * 0.4
  }

  const paletteIndex = currentPalette.value === 'rainbow' ? 0 :
                       currentPalette.value === 'warm' ? 1 :
                       currentPalette.value === 'cool' ? 2 : 3

  gl.uniform2f(uResolutionLoc, canvas.width, canvas.height)
  gl.uniform1f(uTimeLoc, time)
  gl.uniform1f(uBassLoc, smoothedBass)
  gl.uniform1f(uMidLoc, smoothedMid)
  gl.uniform1f(uHighLoc, smoothedHigh)
  gl.uniform1f(uSpeedLoc, effectiveSpeed)
  gl.uniform1f(uNoiseStrengthLoc, effectiveStrength)
  gl.uniform1f(uNoiseDensityLoc, currentNoiseDensity.value)
  gl.uniform1f(uHueLoc, effectiveHue)
  gl.uniform1i(uPaletteLoc, paletteIndex)
  gl.uniform2f(uMouseLoc, mouseX, mouseY)

  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

function connectWebSocket() {
  if (websocket || !props.websocketUrl) return

  console.log('[BlobVisualizer] Connecting to:', props.websocketUrl)
  websocket = new WebSocket(props.websocketUrl)
  websocket.binaryType = 'arraybuffer'

  websocket.onopen = () => {
    console.log('[BlobVisualizer] Connected')
    isConnected.value = true
    emit('connected')
    startRendering()
  }

  websocket.onmessage = (event) => {
    const data = event.data

    if (typeof data === 'string') {
      try {
        const config = JSON.parse(data)
        if (config.type === 'config' && config.mode === 'fft') {
          serverBins.value = config.bins || 80
          fftData.value = new Uint8Array(serverBins.value)
          console.log(`[BlobVisualizer] Config: ${config.bins} bins @ ${config.fps}fps`)
        }
      } catch (e) {
        console.warn('[BlobVisualizer] Failed to parse config:', e)
      }
      return
    }

    if (data instanceof ArrayBuffer) {
      const newData = new Uint8Array(data)
      if (newData.length === serverBins.value) {
        fftData.value = newData
        analyzeFFT(newData)
        frameCount++
      }
    }
  }

  websocket.onerror = (event) => {
    console.error('[BlobVisualizer] Error:', event)
    emit('error', 'WebSocket connection error')
  }

  websocket.onclose = () => {
    console.log('[BlobVisualizer] Disconnected')
    isConnected.value = false
    websocket = null
    emit('disconnected')
    stopRendering()
  }
}

function disconnectWebSocket() {
  if (websocket) {
    websocket.onopen = null
    websocket.onmessage = null
    websocket.onerror = null
    websocket.onclose = null
    websocket.close()
    websocket = null
  }
  stopRendering()
  isConnected.value = false
}

async function startLocalAudio() {
  try {
    await localAudio.start()
    isConnected.value = true
    emit('connected')
    startRendering()
  } catch (e) {
    console.error('[BlobVisualizer] Local audio error:', e)
    emit('error', e instanceof Error ? e.message : 'Failed to start local audio')
  }
}

function stopLocalAudio() {
  localAudio.stop()
  stopRendering()
  isConnected.value = false
  emit('disconnected')
}

function connect() {
  if (props.mode === 'local') {
    startLocalAudio()
  } else {
    connectWebSocket()
  }
}

function disconnect() {
  if (props.mode === 'local') {
    stopLocalAudio()
  } else {
    disconnectWebSocket()
  }
}

function startRendering() {
  if (animationId) return

  const renderLoop = () => {
    render()
    animationId = requestAnimationFrame(renderLoop)

    const now = performance.now()
    if (now - lastFpsTime >= 1000) {
      fps.value = frameCount
      frameCount = 0
      lastFpsTime = now
    }
  }

  lastFpsTime = performance.now()
  frameCount = 0
  renderLoop()
}

function stopRendering() {
  if (animationId) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
}

function handleResize() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return

  const rect = container.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)

  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`

  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
}

function handleMouseMove(e: MouseEvent) {
  const container = containerRef.value
  if (!container) return

  const rect = container.getBoundingClientRect()
  targetMouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1
  targetMouseY = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
}

function handleMouseLeave() {
  targetMouseX = 0
  targetMouseY = 0
}

const {
  speed: currentSpeed,
  noiseStrength: currentNoiseStrength,
  noiseDensity: currentNoiseDensity,
  hue: currentHue,
  palette: currentPalette,
  autoReactive: currentAutoReactive,
} = toRefs(props)

// Watch local audio FFT data
watch(localAudio.fftData, (newData) => {
  if (props.mode !== 'local' || !localAudio.isActive.value) return
  fftData.value = newData
  analyzeFFT(newData)
  frameCount++
})

watch(() => props.websocketUrl, () => {
  if (props.mode === 'websocket') {
    disconnect()
    connect()
  }
})

watch(() => props.mode, () => {
  disconnect()
  connect()
})

onMounted(() => {
  handleResize()

  if (!initWebGL()) {
    console.error('[BlobVisualizer] Failed to initialize WebGL')
    emit('error', 'WebGL initialization failed')
    return
  }

  window.addEventListener('resize', handleResize)
  connect()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  disconnect()

  if (gl) {
    if (positionBuffer) gl.deleteBuffer(positionBuffer)
    if (program) gl.deleteProgram(program)
  }
})

defineExpose({
  connect,
  disconnect,
  isConnected
})
</script>

<template>
  <div
    ref="containerRef"
    class="blob-visualizer"
    @mousemove="handleMouseMove"
    @mouseleave="handleMouseLeave"
  >
    <canvas ref="canvasRef" class="blob-canvas" />
    <div class="blob-stats">
      <span v-if="isConnected" class="connected">{{ fps }}fps</span>
      <span v-else class="disconnected">Disconnected</span>
    </div>
  </div>
</template>

<style scoped>
.blob-visualizer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100px;
  background: #020205;
  border-radius: 8px;
  overflow: hidden;
}

.blob-canvas {
  width: 100%;
  height: 100%;
}

.blob-stats {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 12px;
  font-family: monospace;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
}

.connected {
  color: #00ff88;
}

.disconnected {
  color: #ff4444;
}
</style>
