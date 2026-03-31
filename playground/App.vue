<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { FFTVisualizer, AuroraVisualizer, BlobVisualizer } from '../src'

// FFT Visualizer Controls
const bands = ref<10 | 20 | 40 | 80>(40)
const ledBars = ref(false)
const showPeaks = ref(true)
const noiseFloor = ref(60)
const smoothing = ref(0.5)
const peakDecay = ref(0.99)
const gradient = ref<'classic' | 'rainbow' | 'blue'>('rainbow')
const gradientDirection = ref<'vertical' | 'horizontal'>('horizontal')

// Aurora Visualizer Controls
const auroraIntensity = ref(0.7)
const auroraSpeed = ref(1.0)
const auroraPalette = ref<'classic' | 'warm' | 'cool' | 'rainbow'>('classic')
const auroraLayers = ref(4)
const auroraAutoSpeed = ref(true)
const auroraAutoLayers = ref(true)

// Blob Visualizer Controls
const blobSpeed = ref(0.3)
const blobNoiseStrength = ref(0.3)
const blobNoiseDensity = ref(1.5)
const blobHue = ref(0.5)
const blobPalette = ref<'rainbow' | 'warm' | 'cool' | 'electric'>('rainbow')
const blobAutoReactive = ref(true)

// Mode & WebSocket URL
const mode = ref<'websocket' | 'local'>('local')
const wsUrl = ref('ws://10.0.2.213:3002')
const wsOptions = ['ws://10.0.2.213:3002', 'ws://127.0.0.1:3001']

// Component refs
const fftRef = ref<InstanceType<typeof FFTVisualizer>>()
const auroraRef = ref<InstanceType<typeof AuroraVisualizer>>()
const blobRef = ref<InstanceType<typeof BlobVisualizer>>()

// Fullscreen
const fftContainer = ref<HTMLElement>()
const auroraContainer = ref<HTMLElement>()
const blobContainer = ref<HTMLElement>()
const fullscreenEl = ref<Element | null>(null)

function toggleFullscreen(el: HTMLElement | undefined) {
  if (!el) return
  if (document.fullscreenElement === el) {
    document.exitFullscreen()
  } else {
    el.requestFullscreen()
  }
}

function onFullscreenChange() {
  fullscreenEl.value = document.fullscreenElement
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))
onUnmounted(() => document.removeEventListener('fullscreenchange', onFullscreenChange))

const anyConnected = computed(() =>
  fftRef.value?.isConnected || auroraRef.value?.isConnected || blobRef.value?.isConnected
)

function toggleConnection() {
  if (anyConnected.value) {
    fftRef.value?.disconnect()
    auroraRef.value?.disconnect()
    blobRef.value?.disconnect()
  } else {
    fftRef.value?.connect()
    auroraRef.value?.connect()
    blobRef.value?.connect()
  }
}
</script>

<template>
  <div class="playground">
    <header>
      <h1>FFT Visualizer Playground</h1>
      <div class="source-selector">
        <label>Mode</label>
        <select v-model="mode">
          <option value="local">Local (WASM)</option>
          <option value="websocket">WebSocket</option>
        </select>
        <template v-if="mode === 'websocket'">
          <select v-model="wsUrl">
            <option v-for="url in wsOptions" :key="url" :value="url">{{ url }}</option>
          </select>
        </template>
        <button
          class="connect-btn"
          :class="{ 'disconnect-btn': anyConnected }"
          @click="toggleConnection"
        >{{ anyConnected ? 'Disconnect' : 'Connect' }}</button>
      </div>
    </header>

    <div ref="fftContainer" class="visualizer-container">
      <FFTVisualizer
        ref="fftRef"
        :mode="mode"
        :websocket-url="wsUrl"
        :bands="bands"
        :led-bars="ledBars"
        :show-peaks="showPeaks"
        :noise-floor="noiseFloor"
        :smoothing="smoothing"
        :peak-decay="peakDecay"
        :gradient="gradient"
        :gradient-direction="gradientDirection"
      />
    </div>
    <button class="fullscreen-btn" @click="toggleFullscreen(fftContainer)">
      <svg v-if="fullscreenEl !== fftContainer" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6m10-10h-6V4m0 6l7-7M3 21l7-7"/></svg>
      {{ fullscreenEl === fftContainer ? 'Exit Fullscreen' : 'Fullscreen' }}
    </button>

    <div class="controls">
      <div class="control-group">
        <label>Bands</label>
        <select v-model="bands">
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="40">40</option>
          <option :value="80">80</option>
        </select>
      </div>

      <div class="control-group">
        <label>
          <input type="checkbox" v-model="ledBars" />
          LED Bars
        </label>
      </div>

      <div class="control-group">
        <label>
          <input type="checkbox" v-model="showPeaks" />
          Show Peaks
        </label>
      </div>

      <div class="control-group">
        <label>Noise Floor: {{ noiseFloor }}</label>
        <input type="range" v-model.number="noiseFloor" min="0" max="100" />
      </div>

      <div class="control-group">
        <label>Smoothing: {{ smoothing.toFixed(2) }}</label>
        <input type="range" v-model.number="smoothing" min="0" max="0.95" step="0.05" />
      </div>

      <div class="control-group">
        <label>Peak Drop: {{ peakDecay.toFixed(3) }}</label>
        <input type="range" v-model.number="peakDecay" min="0.9" max="0.999" step="0.001" />
      </div>

      <div class="control-group">
        <label>Gradient</label>
        <select v-model="gradient">
          <option value="classic">Classic</option>
          <option value="rainbow">Rainbow</option>
          <option value="blue">Blue</option>
        </select>
      </div>

      <div class="control-group">
        <label>Direction</label>
        <select v-model="gradientDirection">
          <option value="vertical">Vertical</option>
          <option value="horizontal">Horizontal</option>
        </select>
      </div>
    </div>

    <h2 class="section-title">Aurora Borealis</h2>

    <div ref="auroraContainer" class="visualizer-container aurora-container">
      <AuroraVisualizer
        ref="auroraRef"
        :mode="mode"
        :websocket-url="wsUrl"
        :intensity="auroraIntensity"
        :speed="auroraSpeed"
        :palette="auroraPalette"
        :layers="auroraLayers"
        :auto-speed="auroraAutoSpeed"
        :auto-layers="auroraAutoLayers"
      />
    </div>
    <button class="fullscreen-btn" @click="toggleFullscreen(auroraContainer)">
      <svg v-if="fullscreenEl !== auroraContainer" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6m10-10h-6V4m0 6l7-7M3 21l7-7"/></svg>
      {{ fullscreenEl === auroraContainer ? 'Exit Fullscreen' : 'Fullscreen' }}
    </button>

    <div class="controls">
      <div class="control-group">
        <label>Intensity: {{ auroraIntensity.toFixed(2) }}</label>
        <input type="range" v-model.number="auroraIntensity" min="0.2" max="1.5" step="0.05" />
      </div>

      <div class="control-group">
        <label>
          <input type="checkbox" v-model="auroraAutoSpeed" />
          Auto Speed
        </label>
        <template v-if="!auroraAutoSpeed">
          <input type="range" v-model.number="auroraSpeed" min="0.2" max="3" step="0.1" />
          <span>{{ auroraSpeed.toFixed(1) }}</span>
        </template>
      </div>

      <div class="control-group">
        <label>
          <input type="checkbox" v-model="auroraAutoLayers" />
          Auto Layers
        </label>
        <template v-if="!auroraAutoLayers">
          <input type="range" v-model.number="auroraLayers" min="1" max="6" step="1" />
          <span>{{ auroraLayers }}</span>
        </template>
      </div>

      <div class="control-group">
        <label>Palette</label>
        <select v-model="auroraPalette">
          <option value="classic">Classic</option>
          <option value="warm">Warm</option>
          <option value="cool">Cool</option>
          <option value="rainbow">Rainbow</option>
        </select>
      </div>
    </div>

    <h2 class="section-title">Organic Blob</h2>

    <div ref="blobContainer" class="visualizer-container blob-container">
      <BlobVisualizer
        ref="blobRef"
        :mode="mode"
        :websocket-url="wsUrl"
        :speed="blobSpeed"
        :noise-strength="blobNoiseStrength"
        :noise-density="blobNoiseDensity"
        :hue="blobHue"
        :palette="blobPalette"
        :auto-reactive="blobAutoReactive"
      />
    </div>
    <button class="fullscreen-btn" @click="toggleFullscreen(blobContainer)">
      <svg v-if="fullscreenEl !== blobContainer" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6m10-10h-6V4m0 6l7-7M3 21l7-7"/></svg>
      {{ fullscreenEl === blobContainer ? 'Exit Fullscreen' : 'Fullscreen' }}
    </button>

    <div class="controls">
      <div class="control-group">
        <label>Speed: {{ blobSpeed.toFixed(2) }}</label>
        <input type="range" v-model.number="blobSpeed" min="0.05" max="1.0" step="0.05" />
      </div>

      <div class="control-group">
        <label>Noise: {{ blobNoiseStrength.toFixed(2) }}</label>
        <input type="range" v-model.number="blobNoiseStrength" min="0.05" max="0.6" step="0.05" />
      </div>

      <div class="control-group">
        <label>Density: {{ blobNoiseDensity.toFixed(1) }}</label>
        <input type="range" v-model.number="blobNoiseDensity" min="0.5" max="4.0" step="0.1" />
      </div>

      <div class="control-group">
        <label>Hue: {{ blobHue.toFixed(2) }}</label>
        <input type="range" v-model.number="blobHue" min="0" max="1" step="0.05" />
      </div>

      <div class="control-group">
        <label>Palette</label>
        <select v-model="blobPalette">
          <option value="rainbow">Rainbow</option>
          <option value="warm">Warm</option>
          <option value="cool">Cool</option>
          <option value="electric">Electric</option>
        </select>
      </div>

      <div class="control-group">
        <label>
          <input type="checkbox" v-model="blobAutoReactive" />
          Audio Reactive
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playground {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

header {
  margin-bottom: 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
}

.source-selector {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.visualizer-container {
  height: 300px;
  margin-bottom: 0.5rem;
  border-radius: 8px;
  overflow: hidden;
}

.visualizer-container:fullscreen {
  height: 100%;
  border-radius: 0;
}

.aurora-container {
  height: 100vh;
}

.blob-container {
  height: 80vh;
}

.section-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin-top: 2rem;
  margin-bottom: 1rem;
}

.controls {
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.control-group label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

select, .connect-btn {
  background: #222;
  color: #eee;
  border: 1px solid #444;
  padding: 0.5rem;
  border-radius: 4px;
  cursor: pointer;
}

select:hover, .connect-btn:hover {
  border-color: #666;
}

.connect-btn {
  background: #1a5c2a;
  border-color: #2a8c3a;
  padding: 0.5rem 1rem;
  font-weight: 600;
}

.connect-btn:hover {
  background: #238636;
}

.disconnect-btn {
  background: #6b2020;
  border-color: #a03030;
}

.disconnect-btn:hover {
  background: #8b3030;
}

.fullscreen-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: none;
  color: #888;
  border: none;
  padding: 0.25rem 0;
  margin-bottom: 1rem;
  font-size: 0.75rem;
  font-family: monospace;
  cursor: pointer;
}

.fullscreen-btn:hover {
  color: #eee;
}

input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  cursor: pointer;
}

input[type="range"] {
  width: 120px;
  cursor: pointer;
}
</style>
