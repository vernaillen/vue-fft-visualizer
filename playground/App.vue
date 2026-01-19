<script setup lang="ts">
import { ref } from 'vue'
import { FFTVisualizer } from '../src'

// Controls
const bands = ref<10 | 20 | 40 | 80>(80)
const ledBars = ref(false)
const showPeaks = ref(true)
const noiseFloor = ref(40)
const smoothing = ref(0.5)
const peakDecay = ref(0.99)
const gradient = ref<'classic' | 'rainbow' | 'blue'>('classic')
const gradientDirection = ref<'vertical' | 'horizontal'>('vertical')

// WebSocket URL - connect to the Rust backend
const wsUrl = ref('ws://localhost:3001')
</script>

<template>
  <div class="playground">
    <header>
      <h1>FFT Visualizer Playground</h1>
      <p class="subtitle">Connected to {{ wsUrl }}</p>
    </header>

    <div class="visualizer-container">
      <FFTVisualizer
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
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
}

.subtitle {
  color: #888;
  font-size: 0.875rem;
}

.visualizer-container {
  height: 300px;
  margin-bottom: 1.5rem;
  border-radius: 8px;
  overflow: hidden;
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

select {
  background: #222;
  color: #eee;
  border: 1px solid #444;
  padding: 0.5rem;
  border-radius: 4px;
  cursor: pointer;
}

select:hover {
  border-color: #666;
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
