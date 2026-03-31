import { ref, onUnmounted, type Ref } from 'vue'

export interface WebSocketFftOptions {
  /** FFT window size (default: 2048) */
  fftSize?: number
  /** Number of output frequency bands (default: 80) */
  bins?: number
  /** Lowest frequency in Hz (default: 100) */
  startFreq?: number
  /** Highest frequency in Hz (default: 18000) */
  endFreq?: number
}

export interface WebSocketFftReturn {
  /** Reactive FFT magnitude data (0-255 per bin) */
  fftData: Ref<Uint8Array>
  /** Whether the WebSocket is connected */
  isConnected: Ref<boolean>
  /** Connect to a WebSocket URL streaming PCM audio */
  connect: (url: string) => void
  /** Disconnect from the WebSocket */
  disconnect: () => void
  /** Process a Float32Array of PCM samples directly (for manual feeding) */
  processSamples: (samples: Float32Array) => void
}

export function useWebSocketFft(options?: WebSocketFftOptions): WebSocketFftReturn {
  const fftSize = options?.fftSize ?? 2048
  const bins = options?.bins ?? 80
  const startFreq = options?.startFreq ?? 100
  const endFreq = options?.endFreq ?? 18000

  const fftData = ref<Uint8Array>(new Uint8Array(bins))
  const isConnected = ref(false)

  let processor: any = null
  let websocket: WebSocket | null = null
  let sampleRate: number | null = null
  let configuredBitDepth: number = 16
  let configuredChannels: number = 2

  // Accumulation buffer for partial frames
  let accumulationBuffer = new Float32Array(0)

  async function initProcessor(rate: number) {
    if (processor) {
      processor.free()
      processor = null
    }
    sampleRate = rate

    const wasmModule = await import('../../wasm/pkg/fft_wasm')
    const { FftProcessor } = wasmModule
    processor = new FftProcessor(fftSize, bins, startFreq, endFreq, sampleRate)
  }

  function pcmToFloat32(buffer: ArrayBuffer, bitDepth: number, channels: number): Float32Array {
    let mono: Float32Array

    if (bitDepth === 16) {
      const int16 = new Int16Array(buffer)
      const frameCount = Math.floor(int16.length / channels)
      mono = new Float32Array(frameCount)
      for (let i = 0; i < frameCount; i++) {
        // Mix channels to mono
        let sum = 0
        for (let ch = 0; ch < channels; ch++) {
          sum += int16[i * channels + ch]!
        }
        mono[i] = sum / channels / 32768
      }
    } else if (bitDepth === 24) {
      const bytes = new Uint8Array(buffer)
      const bytesPerSample = 3
      const frameCount = Math.floor(bytes.length / (bytesPerSample * channels))
      mono = new Float32Array(frameCount)
      for (let i = 0; i < frameCount; i++) {
        let sum = 0
        for (let ch = 0; ch < channels; ch++) {
          const offset = (i * channels + ch) * bytesPerSample
          // Little-endian 24-bit signed
          let sample = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
          if (sample & 0x800000) sample |= 0xFF000000 // sign extend
          sum += sample
        }
        mono[i] = sum / channels / 8388608
      }
    } else if (bitDepth === 32) {
      const int32 = new Int32Array(buffer)
      const frameCount = Math.floor(int32.length / channels)
      mono = new Float32Array(frameCount)
      for (let i = 0; i < frameCount; i++) {
        let sum = 0
        for (let ch = 0; ch < channels; ch++) {
          sum += int32[i * channels + ch]!
        }
        mono[i] = sum / channels / 2147483648
      }
    } else {
      return new Float32Array(0)
    }

    return mono
  }

  function processAccumulatedSamples() {
    if (!processor) return

    while (accumulationBuffer.length >= fftSize) {
      const frame = accumulationBuffer.slice(0, fftSize)
      accumulationBuffer = accumulationBuffer.slice(fftSize)
      fftData.value = processor.process(frame)
    }
  }

  function processSamples(samples: Float32Array) {
    if (!processor) return

    // Append to accumulation buffer
    const newBuffer = new Float32Array(accumulationBuffer.length + samples.length)
    newBuffer.set(accumulationBuffer)
    newBuffer.set(samples, accumulationBuffer.length)
    accumulationBuffer = newBuffer

    processAccumulatedSamples()
  }

  function connect(url: string) {
    disconnect()

    websocket = new WebSocket(url)
    websocket.binaryType = 'arraybuffer'

    websocket.onopen = () => {
      isConnected.value = true
    }

    websocket.onmessage = async (event) => {
      const data = event.data

      // Handle config message
      if (typeof data === 'string') {
        try {
          const config = JSON.parse(data)
          if (config.type === 'config' && config.mode === 'pcm') {
            configuredBitDepth = config.bitDepth || 16
            configuredChannels = config.channels || 2
            await initProcessor(config.sampleRate || 48000)
          }
        } catch {
          // ignore non-JSON messages
        }
        return
      }

      // Handle binary PCM data
      if (data instanceof ArrayBuffer && processor) {
        const samples = pcmToFloat32(data, configuredBitDepth, configuredChannels)
        processSamples(samples)
      }
    }

    websocket.onerror = () => {
      isConnected.value = false
    }

    websocket.onclose = () => {
      isConnected.value = false
      websocket = null
    }
  }

  function disconnect() {
    if (websocket) {
      websocket.onopen = null
      websocket.onmessage = null
      websocket.onerror = null
      websocket.onclose = null
      websocket.close()
      websocket = null
    }
    isConnected.value = false
    accumulationBuffer = new Float32Array(0)
  }

  function cleanup() {
    disconnect()
    if (processor) {
      processor.free()
      processor = null
    }
  }

  onUnmounted(cleanup)

  return { fftData, isConnected, connect, disconnect, processSamples }
}
