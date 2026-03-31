<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, toRefs } from 'vue'
import { useLocalAudio } from '../composables/useLocalAudio'

/**
 * Mycelium Network Visualizer - Audio-reactive organic growth visualization
 *
 * Creates an evolving network of branches that grow and respond to audio FFT data.
 * Supports 'websocket' mode (external server) or 'local' mode (browser mic + WASM FFT).
 */

interface Branch {
  x1: number
  y1: number
  x2: number
  y2: number
  dirX: number
  dirY: number
  age: number
  maxAge: number
  generation: number
}

interface Spore {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
}

interface GrowthPoint {
  x: number
  y: number
  dirX: number
  dirY: number
  generation: number
}

const props = withDefaults(defineProps<{
  /** Data source mode: 'websocket' for external server, 'local' for browser mic + WASM FFT */
  mode?: 'websocket' | 'local'
  /** WebSocket URL (required when mode='websocket') */
  websocketUrl?: string
  /** Sensitivity to audio (0-1) */
  sensitivity?: number
  /** Growth speed multiplier */
  growthSpeed?: number
  /** Maximum number of branches for performance */
  maxBranches?: number
  /** Spore particle intensity (0-1) */
  sporeIntensity?: number
  /** Color scheme for the network */
  colorScheme?: 'green' | 'blue' | 'purple'
}>(), {
  mode: 'websocket',
  sensitivity: 0.5,
  growthSpeed: 1.0,
  maxBranches: 500,
  sporeIntensity: 0.5,
  colorScheme: 'green'
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

// FFT data
const serverBins = ref(80)
const fftData = ref<Uint8Array>(new Uint8Array(80))

// Network state
const branches = ref<Branch[]>([])
const spores = ref<Spore[]>([])
const growthPoints = ref<GrowthPoint[]>([])

// Audio analysis
const bassEnergy = ref(0)
const midEnergy = ref(0)
const highEnergy = ref(0)
const prevBassEnergy = ref(0)
const bassTransient = ref(false)

// Local audio (WASM FFT)
const localAudio = useLocalAudio()

// WebSocket
let websocket: WebSocket | null = null
let animationId: number | null = null
let frameCount = 0
let lastFpsTime = 0

// WebGL state
let gl: WebGLRenderingContext | null = null
let branchProgram: WebGLProgram | null = null
let sporeProgram: WebGLProgram | null = null
let branchBuffer: WebGLBuffer | null = null
let sporeBuffer: WebGLBuffer | null = null

// Shader locations for branches
let branchResolutionLoc: WebGLUniformLocation | null = null
let branchColorSchemeLoc: WebGLUniformLocation | null = null

// Shader locations for spores
let sporeResolutionLoc: WebGLUniformLocation | null = null
let sporeColorSchemeLoc: WebGLUniformLocation | null = null

// Branch vertex shader
const branchVertexShader = `
  attribute vec2 a_position;
  attribute float a_age;
  attribute float a_generation;

  uniform vec2 u_resolution;

  varying float v_age;
  varying float v_generation;

  void main() {
    // Convert from pixel coords to clip space
    vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0.0, 1.0);
    v_age = a_age;
    v_generation = a_generation;
  }
`

// Branch fragment shader
const branchFragmentShader = `
  precision mediump float;

  uniform int u_colorScheme;

  varying float v_age;
  varying float v_generation;

  void main() {
    // Fade based on age (0 = new/bright, 1 = old/dim)
    float fade = 1.0 - v_age;

    // Also fade by generation (deeper = dimmer)
    float genFade = 1.0 - (v_generation * 0.1);
    float alpha = fade * genFade * 0.8;

    vec3 color;
    if (u_colorScheme == 0) {
      // Green - bioluminescent
      color = mix(vec3(0.1, 0.8, 0.3), vec3(0.4, 1.0, 0.6), fade);
    } else if (u_colorScheme == 1) {
      // Blue - deep ocean
      color = mix(vec3(0.1, 0.3, 0.8), vec3(0.3, 0.7, 1.0), fade);
    } else {
      // Purple - mystical
      color = mix(vec3(0.5, 0.1, 0.8), vec3(0.8, 0.4, 1.0), fade);
    }

    gl_FragColor = vec4(color, alpha);
  }
`

// Spore vertex shader
const sporeVertexShader = `
  attribute vec2 a_position;
  attribute float a_life;
  attribute float a_size;

  uniform vec2 u_resolution;

  varying float v_life;

  void main() {
    vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0.0, 1.0);
    gl_PointSize = a_size;
    v_life = a_life;
  }
`

// Spore fragment shader
const sporeFragmentShader = `
  precision mediump float;

  uniform int u_colorScheme;

  varying float v_life;

  void main() {
    // Circular point with soft edges
    vec2 center = gl_PointCoord - vec2(0.5);
    float dist = length(center);
    if (dist > 0.5) discard;

    float softness = 1.0 - (dist * 2.0);
    float alpha = softness * v_life * 0.9;

    vec3 color;
    if (u_colorScheme == 0) {
      color = vec3(0.5, 1.0, 0.7);
    } else if (u_colorScheme == 1) {
      color = vec3(0.5, 0.8, 1.0);
    } else {
      color = vec3(0.9, 0.6, 1.0);
    }

    gl_FragColor = vec4(color, alpha);
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

function createProgram(glCtx: WebGLRenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = createShader(glCtx, glCtx.VERTEX_SHADER, vsSource)
  const fs = createShader(glCtx, glCtx.FRAGMENT_SHADER, fsSource)
  if (!vs || !fs) return null

  const program = glCtx.createProgram()
  if (!program) return null

  glCtx.attachShader(program, vs)
  glCtx.attachShader(program, fs)
  glCtx.linkProgram(program)

  if (!glCtx.getProgramParameter(program, glCtx.LINK_STATUS)) {
    console.error('Program link error:', glCtx.getProgramInfoLog(program))
    return null
  }

  return program
}

function initWebGL(): boolean {
  const canvas = canvasRef.value
  if (!canvas) return false

  gl = canvas.getContext('webgl', {
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: false
  })

  if (!gl) {
    console.error('WebGL not supported')
    return false
  }

  // Enable blending for transparency
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  // Create branch program
  branchProgram = createProgram(gl, branchVertexShader, branchFragmentShader)
  if (!branchProgram) return false

  branchResolutionLoc = gl.getUniformLocation(branchProgram, 'u_resolution')
  branchColorSchemeLoc = gl.getUniformLocation(branchProgram, 'u_colorScheme')

  // Create spore program
  sporeProgram = createProgram(gl, sporeVertexShader, sporeFragmentShader)
  if (!sporeProgram) return false

  sporeResolutionLoc = gl.getUniformLocation(sporeProgram, 'u_resolution')
  sporeColorSchemeLoc = gl.getUniformLocation(sporeProgram, 'u_colorScheme')

  // Create buffers
  branchBuffer = gl.createBuffer()
  sporeBuffer = gl.createBuffer()

  return true
}

function initNetwork(clearAll = true) {
  const canvas = canvasRef.value
  if (!canvas) return

  if (clearAll) {
    // Clear existing state only on full reset
    branches.value = []
    spores.value = []
    growthPoints.value = []
  }

  // Create initial growth points spread across the bottom
  const bottomY = canvas.height - 20
  const numPoints = 5

  for (let i = 0; i < numPoints; i++) {
    const x = (canvas.width * (i + 0.5)) / numPoints + (Math.random() - 0.5) * 50
    growthPoints.value.push({
      x,
      y: bottomY,
      dirX: (Math.random() - 0.5) * 0.3,
      dirY: -0.8 - Math.random() * 0.2,
      generation: 0
    })
  }
}

function spawnNewGrowthPoint() {
  const canvas = canvasRef.value
  if (!canvas || branches.value.length === 0) return

  // Spawn from a random branch endpoint (prefer younger branches)
  const recentBranches = branches.value.filter(b => b.age < 0.7)
  const sourceBranches = recentBranches.length > 0 ? recentBranches : branches.value
  if (sourceBranches.length === 0) return

  const source = sourceBranches[Math.floor(Math.random() * sourceBranches.length)]!

  // Random direction with slight upward bias
  const angle = Math.random() * Math.PI * 2
  let dirX = Math.cos(angle) * 0.7
  let dirY = Math.sin(angle) * 0.7 - 0.3  // Upward bias

  // Normalize
  const len = Math.sqrt(dirX * dirX + dirY * dirY)
  dirX /= len
  dirY /= len

  growthPoints.value.push({
    x: source.x2,
    y: source.y2,
    dirX,
    dirY,
    generation: source.generation + 1
  })
}

function analyzeFFT(data: Uint8Array) {
  const bins = data.length
  const bassBins = Math.floor(bins * 0.125)  // 0-12.5% for bass
  const midEnd = Math.floor(bins * 0.5)      // 12.5-50% for mids

  // Calculate bass energy (average of bass bins)
  let bassSum = 0
  for (let i = 0; i < bassBins; i++) {
    bassSum += data[i]!
  }
  prevBassEnergy.value = bassEnergy.value
  bassEnergy.value = bassSum / bassBins / 255

  // Calculate mid energy
  let midSum = 0
  for (let i = bassBins; i < midEnd; i++) {
    midSum += data[i]!
  }
  midEnergy.value = midSum / (midEnd - bassBins) / 255

  // Calculate high energy
  let highSum = 0
  for (let i = midEnd; i < bins; i++) {
    highSum += data[i]!
  }
  highEnergy.value = highSum / (bins - midEnd) / 255

  // Detect bass transients (sudden increase)
  const transientThreshold = 0.15 * currentSensitivity.value
  bassTransient.value = (bassEnergy.value - prevBassEnergy.value) > transientThreshold
}

function updateNetwork() {
  const canvas = canvasRef.value
  if (!canvas) return

  const speed = currentGrowthSpeed.value
  const sens = currentSensitivity.value
  const maxBranch = currentMaxBranches.value

  // Age all branches very slowly so network builds up
  const ageRate = 0.0002 + bassEnergy.value * 0.0001
  for (const branch of branches.value) {
    branch.age += ageRate * speed
  }

  // Remove old branches
  branches.value = branches.value.filter(b => b.age < 1.0)

  // Ensure we always have some growth points
  const minGrowthPoints = 3
  while (growthPoints.value.length < minGrowthPoints) {
    if (branches.value.length > 0) {
      spawnNewGrowthPoint()
    } else {
      initNetwork(false)
      break
    }
  }

  // Update growth points and create new branches
  const newGrowthPoints: GrowthPoint[] = []

  for (const gp of growthPoints.value) {
    if (branches.value.length >= maxBranch) break

    // Calculate growth direction with organic wandering
    const wanderAmount = 0.15 + midEnergy.value * sens * 0.2
    const dirVariation = (Math.random() - 0.5) * wanderAmount

    let newDirX = gp.dirX + dirVariation
    let newDirY = gp.dirY + (Math.random() - 0.5) * wanderAmount * 0.3

    // Normalize direction
    const len = Math.sqrt(newDirX * newDirX + newDirY * newDirY)
    newDirX /= len
    newDirY /= len

    // Growth length - longer segments to form visible network
    const growthLen = (12 + bassEnergy.value * 20) * speed

    const newX = gp.x + newDirX * growthLen
    const newY = gp.y + newDirY * growthLen

    // Check bounds
    const margin = 10
    const inBounds = newX > margin && newX < canvas.width - margin &&
                     newY > margin && newY < canvas.height - margin

    if (inBounds) {
      // Create branch
      branches.value.push({
        x1: gp.x,
        y1: gp.y,
        x2: newX,
        y2: newY,
        dirX: newDirX,
        dirY: newDirY,
        age: 0,
        maxAge: 1,
        generation: gp.generation
      })

      // Continue growth from this point
      newGrowthPoints.push({
        x: newX,
        y: newY,
        dirX: newDirX,
        dirY: newDirY,
        generation: gp.generation
      })

      // Branching probability - base rate plus audio influence
      const branchProb = 0.08 + midEnergy.value * sens * 0.2 + highEnergy.value * sens * 0.1
      if (Math.random() < branchProb && gp.generation < 12) {
        // Create a branch off to the side
        const branchAngle = (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.7)
        const cos = Math.cos(branchAngle)
        const sin = Math.sin(branchAngle)
        const branchDirX = newDirX * cos - newDirY * sin
        const branchDirY = newDirX * sin + newDirY * cos

        newGrowthPoints.push({
          x: newX,
          y: newY,
          dirX: branchDirX,
          dirY: branchDirY,
          generation: gp.generation + 1
        })
      }
    } else {
      // Hit boundary - spawn new growth point from existing network
      spawnNewGrowthPoint()
    }
  }

  // Replace old growth points with new ones
  growthPoints.value = newGrowthPoints

  // Limit growth points to prevent explosion
  const maxGrowthPoints = 30 + Math.floor(sens * 20)
  if (growthPoints.value.length > maxGrowthPoints) {
    // Keep a mix of old and new growth points
    growthPoints.value = growthPoints.value.slice(-maxGrowthPoints)
  }

  // Spawn spores on bass transients
  if (bassTransient.value && currentSporeIntensity.value > 0) {
    spawnSpores()
  }

  // Update spores
  updateSpores()
}

function spawnSpores() {
  const intensity = currentSporeIntensity.value
  const count = Math.floor(5 + intensity * 20)

  // Spawn from random growth points or branch endpoints
  const sources = growthPoints.value.length > 0 ? growthPoints.value :
    branches.value.slice(-10).map(b => ({ x: b.x2, y: b.y2 }))

  for (let i = 0; i < count && sources.length > 0; i++) {
    const source = sources[Math.floor(Math.random() * sources.length)]!
    const angle = Math.random() * Math.PI * 2
    const speed = 1 + Math.random() * 3

    spores.value.push({
      x: source.x,
      y: source.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      maxLife: 1,
      size: 3 + Math.random() * 5
    })
  }

  // Limit spores
  if (spores.value.length > 200) {
    spores.value = spores.value.slice(-200)
  }
}

function updateSpores() {
  for (const spore of spores.value) {
    spore.x += spore.vx
    spore.y += spore.vy
    spore.vy += 0.02  // Slight gravity
    spore.vx *= 0.99  // Drag
    spore.vy *= 0.99
    spore.life -= 0.02
  }

  // Remove dead spores
  spores.value = spores.value.filter(s => s.life > 0)
}

function render() {
  if (!gl || !branchProgram || !sporeProgram) return

  const canvas = canvasRef.value
  if (!canvas) return

  // Clear with dark background
  gl.clearColor(0.02, 0.02, 0.03, 1.0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const colorSchemeIndex = currentColorScheme.value === 'green' ? 0 :
                           currentColorScheme.value === 'blue' ? 1 : 2

  // Render branches
  if (branches.value.length > 0) {
    gl.useProgram(branchProgram)
    gl.uniform2f(branchResolutionLoc, canvas.width, canvas.height)
    gl.uniform1i(branchColorSchemeLoc, colorSchemeIndex)

    // Build vertex data: x, y, age, generation for each vertex
    const vertexData: number[] = []
    for (const b of branches.value) {
      // Start point
      vertexData.push(b.x1, b.y1, b.age, b.generation)
      // End point
      vertexData.push(b.x2, b.y2, b.age, b.generation)
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, branchBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertexData), gl.DYNAMIC_DRAW)

    const posLoc = gl.getAttribLocation(branchProgram, 'a_position')
    const ageLoc = gl.getAttribLocation(branchProgram, 'a_age')
    const genLoc = gl.getAttribLocation(branchProgram, 'a_generation')

    const stride = 4 * 4  // 4 floats * 4 bytes
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(ageLoc)
    gl.vertexAttribPointer(ageLoc, 1, gl.FLOAT, false, stride, 8)
    gl.enableVertexAttribArray(genLoc)
    gl.vertexAttribPointer(genLoc, 1, gl.FLOAT, false, stride, 12)

    gl.lineWidth(1.5)
    gl.drawArrays(gl.LINES, 0, branches.value.length * 2)
  }

  // Render spores
  if (spores.value.length > 0) {
    gl.useProgram(sporeProgram)
    gl.uniform2f(sporeResolutionLoc, canvas.width, canvas.height)
    gl.uniform1i(sporeColorSchemeLoc, colorSchemeIndex)

    // Build vertex data: x, y, life, size
    const sporeData: number[] = []
    for (const s of spores.value) {
      sporeData.push(s.x, s.y, s.life, s.size)
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, sporeBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sporeData), gl.DYNAMIC_DRAW)

    const posLoc = gl.getAttribLocation(sporeProgram, 'a_position')
    const lifeLoc = gl.getAttribLocation(sporeProgram, 'a_life')
    const sizeLoc = gl.getAttribLocation(sporeProgram, 'a_size')

    const stride = 4 * 4
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(lifeLoc)
    gl.vertexAttribPointer(lifeLoc, 1, gl.FLOAT, false, stride, 8)
    gl.enableVertexAttribArray(sizeLoc)
    gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, stride, 12)

    gl.drawArrays(gl.POINTS, 0, spores.value.length)
  }
}

function connectWebSocket() {
  if (websocket || !props.websocketUrl) return

  console.log('[MyceliumVisualizer] Connecting to:', props.websocketUrl)
  websocket = new WebSocket(props.websocketUrl)
  websocket.binaryType = 'arraybuffer'

  websocket.onopen = () => {
    console.log('[MyceliumVisualizer] Connected')
    isConnected.value = true
    emit('connected')
    initNetwork()
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
          console.log(`[MyceliumVisualizer] Config: ${config.bins} bins @ ${config.fps}fps`)
        }
      } catch (e) {
        console.warn('[MyceliumVisualizer] Failed to parse config:', e)
      }
      return
    }

    // Handle binary FFT data
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
    console.error('[MyceliumVisualizer] Error:', event)
    emit('error', 'WebSocket connection error')
  }

  websocket.onclose = () => {
    console.log('[MyceliumVisualizer] Disconnected')
    isConnected.value = false
    websocket = null
    emit('disconnected')
    stopRendering()
  }
}

function disconnectWebSocket() {
  if (websocket) {
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
    initNetwork()
    startRendering()
  } catch (e) {
    console.error('[MyceliumVisualizer] Local audio error:', e)
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
    updateNetwork()
    render()
    animationId = requestAnimationFrame(renderLoop)

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

  // Reinitialize network for new dimensions
  if (isConnected.value) {
    initNetwork()
  }
}

// Create reactive refs from props
const {
  sensitivity: currentSensitivity,
  growthSpeed: currentGrowthSpeed,
  maxBranches: currentMaxBranches,
  sporeIntensity: currentSporeIntensity,
  colorScheme: currentColorScheme
} = toRefs(props)

// Watch local audio FFT data
watch(localAudio.fftData, (newData) => {
  if (props.mode !== 'local' || !localAudio.isActive.value) return
  fftData.value = newData
  analyzeFFT(newData)
  frameCount++
})

// Watch for websocketUrl changes - reconnect
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
    console.error('[MyceliumVisualizer] Failed to initialize WebGL')
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
    if (branchBuffer) gl.deleteBuffer(branchBuffer)
    if (sporeBuffer) gl.deleteBuffer(sporeBuffer)
    if (branchProgram) gl.deleteProgram(branchProgram)
    if (sporeProgram) gl.deleteProgram(sporeProgram)
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
    class="mycelium-visualizer"
  >
    <canvas
      ref="canvasRef"
      class="mycelium-canvas"
    />
    <div class="mycelium-stats">
      <span v-if="isConnected" class="connected">
        {{ branches.length }} branches | {{ spores.length }} spores | {{ fps }}fps
      </span>
      <span v-else class="disconnected">Disconnected</span>
    </div>
  </div>
</template>

<style scoped>
.mycelium-visualizer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100px;
  background: #050508;
  border-radius: 8px;
  overflow: hidden;
}

.mycelium-canvas {
  width: 100%;
  height: 100%;
}

.mycelium-stats {
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
