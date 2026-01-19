<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

/**
 * FFT Visualizer - High-performance WebGL spectrum analyzer
 *
 * Receives pre-computed FFT data via WebSocket and renders using WebGL.
 * Supports configurable frequency bands, LED effect, and peak indicators.
 *
 * WebSocket Protocol:
 * 1. Connect to websocketUrl
 * 2. Server sends config: {"type":"config","mode":"fft","bins":80,"fps":120}
 * 3. Server streams binary: N bytes of uint8 (frequency magnitudes 0-255)
 */

const props = withDefaults(defineProps<{
  /** WebSocket URL to connect to for FFT data */
  websocketUrl: string
  /** Show peak indicators above bars */
  showPeaks?: boolean
  /** Peak decay rate (0.99 = slow decay, 0.9 = fast decay) */
  peakDecay?: number
  /** Number of frequency bands to display (aggregates if server sends more) */
  bands?: 10 | 20 | 40 | 80
  /** Enable LED segment effect */
  ledBars?: boolean
  /** Bar color gradient - array of {stop, color} or preset name */
  gradient?: 'classic' | 'rainbow' | 'blue' | Array<{stop: number, color: string}>
}>(), {
  showPeaks: true,
  peakDecay: 0.997,
  bands: 80,
  ledBars: false,
  gradient: 'classic'
})

const emit = defineEmits<{
  connected: []
  disconnected: []
  error: [error: string]
}>()

// Canvas and WebGL
const canvasRef = ref<HTMLCanvasElement>()
const containerRef = ref<HTMLElement>()
const isConnected = ref(false)
const fps = ref(0)

// FFT data (server sends N bins, we aggregate for display)
const serverBins = ref(80)
const fftData = ref<Uint8Array>(new Uint8Array(80))
const peakData = ref<Float32Array>(new Float32Array(80))

// Display data (aggregated to props.bands)
const displayBins = computed(() => props.bands)
const displayFftData = ref<Uint8Array>(new Uint8Array(props.bands))
const displayPeakData = ref<Float32Array>(new Float32Array(props.bands))

// Aggregate bins down to fewer bands (max of each group)
function aggregateBins(source: Uint8Array, targetBands: number): Uint8Array {
  if (targetBands >= source.length) return source

  const result = new Uint8Array(targetBands)
  const ratio = source.length / targetBands

  for (let i = 0; i < targetBands; i++) {
    const startBin = Math.floor(i * ratio)
    const endBin = Math.floor((i + 1) * ratio)
    let maxVal = 0
    for (let j = startBin; j < endBin; j++) {
      if (source[j]! > maxVal) maxVal = source[j]!
    }
    result[i] = maxVal
  }
  return result
}

function aggregatePeaks(source: Float32Array, targetBands: number): Float32Array {
  if (targetBands >= source.length) return source

  const result = new Float32Array(targetBands)
  const ratio = source.length / targetBands

  for (let i = 0; i < targetBands; i++) {
    const startBin = Math.floor(i * ratio)
    const endBin = Math.floor((i + 1) * ratio)
    let maxVal = 0
    for (let j = startBin; j < endBin; j++) {
      if (source[j]! > maxVal) maxVal = source[j]!
    }
    result[i] = maxVal
  }
  return result
}

// WebSocket
let websocket: WebSocket | null = null
let animationId: number | null = null
let frameCount = 0
let lastFpsTime = 0

// WebGL state
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let positionBuffer: WebGLBuffer | null = null
let fftTexture: WebGLTexture | null = null
let peakTexture: WebGLTexture | null = null

// Shader locations
let uResolutionLoc: WebGLUniformLocation | null = null
let uBinsLoc: WebGLUniformLocation | null = null
let uShowPeaksLoc: WebGLUniformLocation | null = null
let uLedBarsLoc: WebGLUniformLocation | null = null
let uFftDataLoc: WebGLUniformLocation | null = null
let uPeakDataLoc: WebGLUniformLocation | null = null

const vertexShaderSource = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

const fragmentShaderSource = `
  precision mediump float;

  uniform vec2 u_resolution;
  uniform float u_bins;
  uniform bool u_showPeaks;
  uniform bool u_ledBars;
  uniform sampler2D u_fftData;
  uniform sampler2D u_peakData;

  // Classic gradient: red -> orange -> yellow
  vec3 getGradientColor(float t) {
    vec3 red = vec3(0.76, 0.08, 0.0);
    vec3 orange = vec3(1.0, 0.55, 0.0);
    vec3 yellow = vec3(1.0, 0.77, 0.0);

    if (t < 0.6) {
      return mix(red, orange, t / 0.6);
    } else {
      return mix(orange, yellow, (t - 0.6) / 0.4);
    }
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;

    // Calculate which bar we're in
    float barIndex = floor(uv.x * u_bins);
    float barLocalX = fract(uv.x * u_bins);

    // Gap between bars (10% of bar width)
    float gap = 0.1;
    if (barLocalX > (1.0 - gap)) {
      gl_FragColor = vec4(0.04, 0.04, 0.04, 1.0);
      return;
    }

    // LED effect: create horizontal segments
    float ledSegments = 64.0;
    float ledGap = 0.25;
    float segmentY = fract(uv.y * ledSegments);
    bool inLedGap = u_ledBars && segmentY > (1.0 - ledGap);

    // Sample FFT value for this bar
    float texCoord = (barIndex + 0.5) / u_bins;
    float fftValue = texture2D(u_fftData, vec2(texCoord, 0.5)).r;
    float peakValue = texture2D(u_peakData, vec2(texCoord, 0.5)).r;

    // Check if we're in the bar area
    if (uv.y <= fftValue) {
      if (inLedGap) {
        gl_FragColor = vec4(0.04, 0.04, 0.04, 1.0);
      } else {
        vec3 color = getGradientColor(uv.y);
        gl_FragColor = vec4(color, 1.0);
      }
    } else if (u_showPeaks && uv.y >= peakValue - 0.003 && uv.y <= peakValue + 0.003) {
      if (u_ledBars) {
        float peakSegment = floor(peakValue * ledSegments) / ledSegments;
        if (uv.y >= peakSegment && uv.y <= peakSegment + (1.0 / ledSegments) * (1.0 - ledGap)) {
          gl_FragColor = vec4(1.0, 1.0, 1.0, 0.9);
        } else {
          gl_FragColor = vec4(0.04, 0.04, 0.04, 1.0);
        }
      } else {
        gl_FragColor = vec4(1.0, 1.0, 1.0, 0.8);
      }
    } else {
      gl_FragColor = vec4(0.04, 0.04, 0.04, 1.0);
    }
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

  // Create shaders
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)

  if (!vertexShader || !fragmentShader) return false

  // Create program
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

  // Create full-screen quad
  positionBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1
  ]), gl.STATIC_DRAW)

  const positionLoc = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(positionLoc)
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

  // Get uniform locations
  uResolutionLoc = gl.getUniformLocation(program, 'u_resolution')
  uBinsLoc = gl.getUniformLocation(program, 'u_bins')
  uShowPeaksLoc = gl.getUniformLocation(program, 'u_showPeaks')
  uLedBarsLoc = gl.getUniformLocation(program, 'u_ledBars')
  uFftDataLoc = gl.getUniformLocation(program, 'u_fftData')
  uPeakDataLoc = gl.getUniformLocation(program, 'u_peakData')

  // Create textures for FFT and peak data
  fftTexture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, fftTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  peakTexture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, peakTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // Set texture units
  gl.uniform1i(uFftDataLoc, 0)
  gl.uniform1i(uPeakDataLoc, 1)

  return true
}

function connect() {
  if (websocket) return

  console.log('[FFTVisualizer] Connecting to:', props.websocketUrl)
  websocket = new WebSocket(props.websocketUrl)
  websocket.binaryType = 'arraybuffer'

  websocket.onopen = () => {
    console.log('[FFTVisualizer] Connected')
    isConnected.value = true
    emit('connected')
    startRendering()
  }

  websocket.onmessage = (event) => {
    const data = event.data

    // Handle config message
    if (typeof data === 'string') {
      try {
        const config = JSON.parse(data)
        if (config.type === 'config' && config.mode === 'fft') {
          serverBins.value = config.bins || 80
          fftData.value = new Uint8Array(serverBins.value)
          peakData.value = new Float32Array(serverBins.value)
          displayFftData.value = new Uint8Array(displayBins.value)
          displayPeakData.value = new Float32Array(displayBins.value)
          console.log(`[FFTVisualizer] Config: ${config.bins} server bins, displaying ${displayBins.value} bands @ ${config.fps}fps`)
        }
      } catch (e) {
        console.warn('[FFTVisualizer] Failed to parse config:', e)
      }
      return
    }

    // Handle binary FFT data
    if (data instanceof ArrayBuffer) {
      const newData = new Uint8Array(data)
      if (newData.length === serverBins.value) {
        fftData.value = newData

        // Update peaks on raw data
        for (let i = 0; i < serverBins.value; i++) {
          const value = newData[i]! / 255
          if (value > peakData.value[i]!) {
            peakData.value[i] = value
          } else {
            peakData.value[i]! *= props.peakDecay
          }
        }

        // Aggregate to display bands
        displayFftData.value = aggregateBins(fftData.value, displayBins.value)
        displayPeakData.value = aggregatePeaks(peakData.value, displayBins.value)

        frameCount++
      }
    }
  }

  websocket.onerror = (event) => {
    console.error('[FFTVisualizer] Error:', event)
    emit('error', 'WebSocket connection error')
  }

  websocket.onclose = () => {
    console.log('[FFTVisualizer] Disconnected')
    isConnected.value = false
    websocket = null
    emit('disconnected')
    stopRendering()
  }
}

function disconnect() {
  if (websocket) {
    websocket.close()
    websocket = null
  }
  stopRendering()
  isConnected.value = false
}

function startRendering() {
  if (animationId) return

  const render = () => {
    drawSpectrum()
    animationId = requestAnimationFrame(render)

    // Calculate FPS
    const now = performance.now()
    if (now - lastFpsTime >= 1000) {
      fps.value = frameCount
      frameCount = 0
      lastFpsTime = now
    }
  }

  lastFpsTime = performance.now()
  frameCount = 0
  render()
}

function stopRendering() {
  if (animationId) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
}

function drawSpectrum() {
  if (!gl || !program) return

  const canvas = canvasRef.value
  if (!canvas) return

  const numBins = displayBins.value

  // Update FFT texture with display data
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, fftTexture)
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.LUMINANCE,
    numBins, 1, 0,
    gl.LUMINANCE, gl.UNSIGNED_BYTE,
    displayFftData.value
  )

  // Update peak texture (convert float to uint8)
  const peakUint8 = new Uint8Array(numBins)
  for (let i = 0; i < numBins; i++) {
    peakUint8[i] = Math.min(255, Math.floor(displayPeakData.value[i]! * 255))
  }
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, peakTexture)
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.LUMINANCE,
    numBins, 1, 0,
    gl.LUMINANCE, gl.UNSIGNED_BYTE,
    peakUint8
  )

  // Set uniforms
  gl.uniform2f(uResolutionLoc, canvas.width, canvas.height)
  gl.uniform1f(uBinsLoc, numBins)
  gl.uniform1i(uShowPeaksLoc, props.showPeaks ? 1 : 0)
  gl.uniform1i(uLedBarsLoc, props.ledBars ? 1 : 0)

  // Draw
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
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

// Watch for bands prop changes
watch(() => props.bands, (newBands) => {
  displayFftData.value = new Uint8Array(newBands)
  displayPeakData.value = new Float32Array(newBands)
})

// Watch for websocketUrl changes - reconnect
watch(() => props.websocketUrl, () => {
  disconnect()
  connect()
})

onMounted(() => {
  handleResize()

  if (!initWebGL()) {
    console.error('[FFTVisualizer] Failed to initialize WebGL')
    emit('error', 'WebGL initialization failed')
    return
  }

  window.addEventListener('resize', handleResize)
  connect()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  disconnect()

  // Cleanup WebGL resources
  if (gl) {
    if (fftTexture) gl.deleteTexture(fftTexture)
    if (peakTexture) gl.deleteTexture(peakTexture)
    if (positionBuffer) gl.deleteBuffer(positionBuffer)
    if (program) gl.deleteProgram(program)
  }
})

// Expose methods for external control
defineExpose({
  connect,
  disconnect,
  isConnected
})
</script>

<template>
  <div
    ref="containerRef"
    class="fft-visualizer"
  >
    <canvas
      ref="canvasRef"
      class="fft-canvas"
    />
    <div class="fft-stats">
      <span v-if="isConnected" class="connected">{{ displayBins }} bands @ {{ fps }}fps</span>
      <span v-else class="disconnected">Disconnected</span>
    </div>
  </div>
</template>

<style scoped>
.fft-visualizer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100px;
  background: #0a0a0a;
  border-radius: 8px;
  overflow: hidden;
}

.fft-canvas {
  width: 100%;
  height: 100%;
}

.fft-stats {
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
