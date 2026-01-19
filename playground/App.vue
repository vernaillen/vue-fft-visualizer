<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { FFTVisualizer } from '../src'

// Controls
const bands = ref<10 | 20 | 40 | 80>(40)
const ledBars = ref(false)
const showPeaks = ref(true)

// Mock WebSocket server
const mockWsUrl = ref('')

class MockFFTServer {
  private clients: Set<WebSocket> = new Set()
  private intervalId: number | null = null
  private phase = 0

  constructor(private port: number = 9999) {}

  start() {
    // Create a mock WebSocket URL using a blob
    const serverCode = this.generateServerCode()
    const blob = new Blob([serverCode], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }

  private generateServerCode(): string {
    // This won't work as WebSocket server - we need a different approach
    return ''
  }
}

// Since we can't create a real WebSocket server in browser,
// we'll create a mock WebSocket class that the component can use
class MockWebSocket {
  static instance: MockWebSocket | null = null

  binaryType: string = 'arraybuffer'
  readyState = 1 // OPEN

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  private intervalId: number | null = null
  private phase = 0
  private bassPhase = 0
  private midPhase = 0

  constructor(url: string) {
    MockWebSocket.instance = this

    // Simulate connection
    setTimeout(() => {
      this.onopen?.(new Event('open'))

      // Send config
      const config = JSON.stringify({
        type: 'config',
        mode: 'fft',
        bins: 80,
        fps: 60
      })
      this.onmessage?.(new MessageEvent('message', { data: config }))

      // Start streaming mock FFT data
      this.intervalId = window.setInterval(() => {
        const fftData = this.generateFFTData()
        this.onmessage?.(new MessageEvent('message', { data: fftData.buffer }))
      }, 1000 / 60) // 60fps
    }, 100)
  }

  private generateFFTData(): Uint8Array {
    const bins = 80
    const data = new Uint8Array(bins)

    // Animate phases
    this.phase += 0.05
    this.bassPhase += 0.08
    this.midPhase += 0.03

    for (let i = 0; i < bins; i++) {
      const freq = i / bins

      // Base level decreases with frequency (more bass)
      let value = (1 - freq * 0.7) * 0.6

      // Add some "music-like" peaks
      // Bass bump (bins 0-10)
      if (i < 15) {
        value += Math.sin(this.bassPhase + i * 0.3) * 0.3 + 0.2
      }

      // Mid bump (bins 20-40)
      if (i > 15 && i < 45) {
        value += Math.sin(this.midPhase + i * 0.2) * 0.25
      }

      // High shimmer
      if (i > 50) {
        value += Math.sin(this.phase * 2 + i * 0.5) * 0.15
      }

      // Add randomness
      value += (Math.random() - 0.5) * 0.15

      // Clamp and convert to uint8
      value = Math.max(0, Math.min(1, value))
      data[i] = Math.floor(value * 255)
    }

    return data
  }

  send(data: any) {
    // Ignore client messages
  }

  close() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.onclose?.(new CloseEvent('close'))
  }
}

// Override global WebSocket for mock URL
const originalWebSocket = window.WebSocket
const MOCK_URL = 'ws://mock-fft-server/'

onMounted(() => {
  // Patch WebSocket to intercept mock URL
  (window as any).WebSocket = function(url: string, protocols?: string | string[]) {
    if (url === MOCK_URL) {
      return new MockWebSocket(url) as any
    }
    return new originalWebSocket(url, protocols)
  }
  mockWsUrl.value = MOCK_URL
})

onUnmounted(() => {
  // Restore original WebSocket
  window.WebSocket = originalWebSocket
  MockWebSocket.instance?.close()
})
</script>

<template>
  <div class="playground">
    <header>
      <h1>FFT Visualizer Playground</h1>
      <p class="subtitle">Mock data - no backend required</p>
    </header>

    <div class="visualizer-container">
      <FFTVisualizer
        v-if="mockWsUrl"
        :websocket-url="mockWsUrl"
        :bands="bands"
        :led-bars="ledBars"
        :show-peaks="showPeaks"
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
</style>
