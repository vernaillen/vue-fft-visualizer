<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, toRefs } from 'vue'
import { useLocalAudio } from '../composables/useLocalAudio'

/**
 * Aurora Borealis Visualizer - Flowing curtains of light
 *
 * Creates layered, flowing aurora effects that respond to audio FFT data.
 * Supports 'websocket' mode (external server) or 'local' mode (browser mic + WASM FFT).
 */

const props = withDefaults(defineProps<{
  /** Data source mode: 'websocket' for external server, 'local' for browser mic + WASM FFT */
  mode?: 'websocket' | 'local'
  /** WebSocket URL (required when mode='websocket') */
  websocketUrl?: string
  /** Overall intensity (0-1) */
  intensity?: number
  /** Base wave speed multiplier (used when autoSpeed is false) */
  speed?: number
  /** Color palette */
  palette?: 'classic' | 'warm' | 'cool' | 'rainbow'
  /** Base number of aurora layers (used when autoLayers is false) */
  layers?: number
  /** Automatically adjust speed based on audio */
  autoSpeed?: boolean
  /** Automatically adjust layers based on audio */
  autoLayers?: boolean
}>(), {
  mode: 'websocket',
  intensity: 0.7,
  speed: 1.0,
  palette: 'classic',
  layers: 4,
  autoSpeed: false,
  autoLayers: false
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

// Dynamic values (smoothed)
let dynamicSpeed = 1.0
let dynamicLayers = 4.0
let smoothedBass = 0
let smoothedMid = 0
let smoothedHigh = 0

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
let uIntensityLoc: WebGLUniformLocation | null = null
let uSpeedLoc: WebGLUniformLocation | null = null
let uPaletteLoc: WebGLUniformLocation | null = null
let uLayersLoc: WebGLUniformLocation | null = null

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
  uniform float u_intensity;
  uniform float u_speed;
  uniform int u_palette;
  uniform float u_layers;  // Float for smooth transitions

  // Simplex-like noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  // Fractal noise
  float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      value += amplitude * snoise(p);
      p *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  // Get aurora color based on palette and position
  vec3 getAuroraColor(float t, float layer) {
    vec3 c1, c2, c3;

    if (u_palette == 0) {
      // Classic - green to blue to purple
      c1 = vec3(0.15, 0.85, 0.4);   // Green
      c2 = vec3(0.2, 0.6, 0.9);    // Blue
      c3 = vec3(0.5, 0.25, 0.75);  // Purple
    } else if (u_palette == 1) {
      // Warm - pink to orange to yellow
      c1 = vec3(0.95, 0.4, 0.55);  // Pink
      c2 = vec3(1.0, 0.6, 0.25);   // Orange
      c3 = vec3(1.0, 0.85, 0.4);   // Yellow
    } else if (u_palette == 2) {
      // Cool - cyan to blue to indigo
      c1 = vec3(0.3, 0.9, 0.85);   // Cyan
      c2 = vec3(0.25, 0.5, 0.9);   // Blue
      c3 = vec3(0.35, 0.25, 0.7);  // Indigo
    } else {
      // Rainbow - slow shift through spectrum
      float hue = t * 0.5 + layer * 0.12 + u_time * 0.02;
      hue = fract(hue);
      // Smooth HSV to RGB
      vec3 rgb = clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      // Soften the colors
      rgb = mix(rgb, vec3(0.7), 0.15);
      return rgb;
    }

    // Smooth color mixing with sine interpolation
    float mixVal = t + layer * 0.1;
    mixVal = fract(mixVal);
    // Use smoothstep for softer color transitions
    float smooth1 = smoothstep(0.0, 0.5, mixVal);
    float smooth2 = smoothstep(0.5, 1.0, mixVal);

    vec3 color = mix(c1, c2, smooth1);
    color = mix(color, c3, smooth2);
    return color;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;

    // Time with speed control
    float time = u_time * u_speed * 0.3;

    // Base aurora intensity from audio
    float audioIntensity = 0.5 + u_bass * 0.3 + u_mid * 0.2;
    audioIntensity *= u_intensity;

    vec3 color = vec3(0.0);

    // Create multiple aurora layers - spread out vertically
    int maxLayers = int(ceil(u_layers));
    for (int i = 0; i < 6; i++) {
      if (i >= maxLayers) break;

      float layerIndex = float(i);

      // Fade factor for smooth layer transitions (last layer fades based on fractional part)
      float layerFade = clamp(u_layers - layerIndex, 0.0, 1.0);

      float layerPhase = layerIndex * 1.3;

      // Each layer at a different vertical position - well separated
      float baseY = 0.2 + layerIndex * 0.14;

      // Gentle sine wave curtain movement
      float wave1 = sin(uv.x * 1.2 + time * 0.4 + layerPhase) * 0.06;
      float wave2 = sin(uv.x * 2.1 - time * 0.25 + layerPhase * 0.7) * 0.03;

      // Add subtle noise for organic feel
      float noiseVal = fbm(vec2(uv.x * 0.4 + time * 0.1, layerIndex * 2.0), 2) * 0.04;

      float curtainY = baseY + wave1 + wave2 + noiseVal;

      // Distance from this layer's center line
      float dist = abs(uv.y - curtainY);

      // Wide gaussian-like falloff for soft horizontal bands
      float bandWidth = 0.1 + u_bass * 0.06;
      float aurora = exp(-dist * dist / (2.0 * bandWidth * bandWidth));

      // Subtle horizontal brightness variation
      float horizVar = 0.8 + 0.2 * sin(uv.x * 0.8 + time * 0.15 + layerPhase);
      aurora *= horizVar;

      // Fade at screen edges
      aurora *= smoothstep(0.0, 0.15, uv.y);
      aurora *= smoothstep(1.0, 0.65, uv.y);

      // Subtle pulsing with audio
      float pulse = 1.0 + u_bass * 0.15 * sin(time * 1.5 + layerIndex);
      aurora *= pulse;

      // Layer opacity (includes fade for partial layers)
      float layerOpacity = (0.85 - layerIndex * 0.08) * layerFade;
      aurora *= layerOpacity;

      // Color - each layer gets its own color from palette
      float colorT = layerIndex / 5.0 + time * 0.015;
      vec3 layerColor = getAuroraColor(colorT, layerIndex);

      // Accumulate
      color += layerColor * aurora * audioIntensity * 0.6;
    }

    // Very sparse star field
    float stars = snoise(uv * 200.0);
    stars = smoothstep(0.92, 1.0, stars) * 0.15;
    stars *= smoothstep(0.5, 0.9, uv.y);
    color += vec3(stars);

    // Dark background
    vec3 bgColor = vec3(0.008, 0.012, 0.03);
    color = max(color, bgColor);

    // Tone mapping
    color = color / (color + vec3(0.7));

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

  // Create fullscreen quad
  positionBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1, 1,   1, -1,   1, 1
  ]), gl.STATIC_DRAW)

  const positionLoc = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(positionLoc)
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

  // Get uniform locations
  uResolutionLoc = gl.getUniformLocation(program, 'u_resolution')
  uTimeLoc = gl.getUniformLocation(program, 'u_time')
  uBassLoc = gl.getUniformLocation(program, 'u_bass')
  uMidLoc = gl.getUniformLocation(program, 'u_mid')
  uHighLoc = gl.getUniformLocation(program, 'u_high')
  uIntensityLoc = gl.getUniformLocation(program, 'u_intensity')
  uSpeedLoc = gl.getUniformLocation(program, 'u_speed')
  uPaletteLoc = gl.getUniformLocation(program, 'u_palette')
  uLayersLoc = gl.getUniformLocation(program, 'u_layers')

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

  // Smooth audio values for less jittery response
  const smoothFactor = 0.11
  smoothedBass += (bassEnergy.value - smoothedBass) * smoothFactor
  smoothedMid += (midEnergy.value - smoothedMid) * smoothFactor
  smoothedHigh += (highEnergy.value - smoothedHigh) * smoothFactor

  // Calculate dynamic values based on audio
  let effectiveSpeed = currentSpeed.value
  let effectiveLayers = currentLayers.value

  if (currentAutoSpeed.value) {
    // Speed responds to mids and highs - range 0.3 to 2.5
    const targetSpeed = 0.5 + smoothedMid * 1.5 + smoothedHigh * 1.0
    dynamicSpeed += (targetSpeed - dynamicSpeed) * 0.06
    effectiveSpeed = dynamicSpeed
  }

  if (currentAutoLayers.value) {
    // Layers respond to overall energy - range 1.5 to 6
    const energy = smoothedBass * 0.5 + smoothedMid * 0.3 + smoothedHigh * 0.2
    const targetLayers = 1.5 + energy * 4.5
    dynamicLayers += (targetLayers - dynamicLayers) * 0.05
    effectiveLayers = dynamicLayers
  }

  const paletteIndex = currentPalette.value === 'classic' ? 0 :
                       currentPalette.value === 'warm' ? 1 :
                       currentPalette.value === 'cool' ? 2 : 3

  gl.uniform2f(uResolutionLoc, canvas.width, canvas.height)
  gl.uniform1f(uTimeLoc, time)
  gl.uniform1f(uBassLoc, bassEnergy.value)
  gl.uniform1f(uMidLoc, midEnergy.value)
  gl.uniform1f(uHighLoc, highEnergy.value)
  gl.uniform1f(uIntensityLoc, currentIntensity.value)
  gl.uniform1f(uSpeedLoc, effectiveSpeed)
  gl.uniform1i(uPaletteLoc, paletteIndex)
  gl.uniform1f(uLayersLoc, effectiveLayers)

  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

function connectWebSocket() {
  if (websocket || !props.websocketUrl) return

  console.log('[AuroraVisualizer] Connecting to:', props.websocketUrl)
  websocket = new WebSocket(props.websocketUrl)
  websocket.binaryType = 'arraybuffer'

  websocket.onopen = () => {
    console.log('[AuroraVisualizer] Connected')
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
          console.log(`[AuroraVisualizer] Config: ${config.bins} bins @ ${config.fps}fps`)
        }
      } catch (e) {
        console.warn('[AuroraVisualizer] Failed to parse config:', e)
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
    console.error('[AuroraVisualizer] Error:', event)
    emit('error', 'WebSocket connection error')
  }

  websocket.onclose = () => {
    console.log('[AuroraVisualizer] Disconnected')
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
    console.error('[AuroraVisualizer] Local audio error:', e)
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
  const dpr = window.devicePixelRatio || 1

  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`

  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
}

const {
  intensity: currentIntensity,
  speed: currentSpeed,
  palette: currentPalette,
  layers: currentLayers,
  autoSpeed: currentAutoSpeed,
  autoLayers: currentAutoLayers
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
    console.error('[AuroraVisualizer] Failed to initialize WebGL')
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
  <div ref="containerRef" class="aurora-visualizer">
    <canvas ref="canvasRef" class="aurora-canvas" />
    <div class="aurora-stats">
      <span v-if="isConnected" class="connected">{{ fps }}fps</span>
      <span v-else class="disconnected">Disconnected</span>
    </div>
  </div>
</template>

<style scoped>
.aurora-visualizer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100px;
  background: #020205;
  border-radius: 8px;
  overflow: hidden;
}

.aurora-canvas {
  width: 100%;
  height: 100%;
}

.aurora-stats {
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
