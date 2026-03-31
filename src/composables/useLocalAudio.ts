import { ref, type Ref } from 'vue'

export interface LocalAudioOptions {
  /** FFT window size (default: 2048) */
  fftSize?: number
  /** Number of output frequency bands (default: 80) */
  bins?: number
  /** Lowest frequency in Hz (default: 100) */
  startFreq?: number
  /** Highest frequency in Hz (default: 18000) */
  endFreq?: number
}

export interface LocalAudioReturn {
  /** Reactive FFT magnitude data (0-255 per bin) */
  fftData: Ref<Uint8Array>
  /** Whether local audio capture is active */
  isActive: Ref<boolean>
  /** Start audio capture and FFT processing */
  start: () => Promise<void>
  /** Stop audio capture */
  stop: () => void
}

export function useLocalAudio(options?: LocalAudioOptions): LocalAudioReturn {
  const fftSize = options?.fftSize ?? 2048
  const bins = options?.bins ?? 80
  const startFreq = options?.startFreq ?? 100
  const endFreq = options?.endFreq ?? 18000

  const fftData = ref<Uint8Array>(new Uint8Array(bins))
  const isActive = ref(false)

  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let analyserNode: AnalyserNode | null = null
  let animationFrameId: number | null = null
  let processor: any = null // FftProcessor from WASM
  let timeDomainBuffer: Float32Array<ArrayBuffer> | null = null

  function tick() {
    if (!analyserNode || !processor || !timeDomainBuffer) return

    analyserNode.getFloatTimeDomainData(timeDomainBuffer)
    const result = processor.process(timeDomainBuffer)
    fftData.value = result

    animationFrameId = requestAnimationFrame(tick)
  }

  async function start() {
    if (isActive.value) return

    // Lazy-load WASM module
    const wasmModule = await import('../../wasm/pkg/fft_wasm')
    const { FftProcessor } = wasmModule

    // Request microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })

    audioContext = new AudioContext()
    sourceNode = audioContext.createMediaStreamSource(mediaStream)

    // Use AnalyserNode as a sample buffer (we do our own FFT in WASM)
    analyserNode = audioContext.createAnalyser()
    analyserNode.fftSize = fftSize
    sourceNode.connect(analyserNode)

    // Create WASM FFT processor
    processor = new FftProcessor(
      fftSize,
      bins,
      startFreq,
      endFreq,
      audioContext.sampleRate
    )

    timeDomainBuffer = new Float32Array(fftSize)
    isActive.value = true
    animationFrameId = requestAnimationFrame(tick)
  }

  function stop() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }

    if (processor) {
      processor.free()
      processor = null
    }

    if (sourceNode) {
      sourceNode.disconnect()
      sourceNode = null
    }

    if (audioContext) {
      audioContext.close()
      audioContext = null
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }

    analyserNode = null
    timeDomainBuffer = null
    isActive.value = false
    fftData.value = new Uint8Array(bins)
  }

  return { fftData, isActive, start, stop }
}
