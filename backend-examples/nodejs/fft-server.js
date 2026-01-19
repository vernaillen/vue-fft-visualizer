#!/usr/bin/env node
/**
 * FFT WebSocket Server - Node.js Example
 *
 * Captures audio from system input, computes FFT, and streams frequency
 * data to WebSocket clients for visualization.
 *
 * Requirements:
 *     npm install ws fft.js naudiodon
 *
 * Usage:
 *     node fft-server.js [--port 3001] [--device 0]
 *
 * Protocol:
 *     1. Client connects to ws://host:port/
 *     2. Server sends config: {"type":"config","mode":"fft","bins":80,"fps":120}
 *     3. Server streams binary: 80 bytes of uint8 (frequency magnitudes 0-255)
 */

const { WebSocketServer } = require('ws')
const FFT = require('fft.js')
const portAudio = require('naudiodon')

// Configuration
const SAMPLE_RATE = 48000
const CHANNELS = 2
const FFT_SIZE = 1024
const FFT_BINS = 80
const FFT_FPS = 120
const FFT_START_FREQ = 100.0
const FFT_END_FREQ = 18000.0

// Parse command line args
const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const deviceIndex = args.indexOf('--device')
const PORT = portIndex !== -1 ? parseInt(args[portIndex + 1]) : 3001
const DEVICE_ID = deviceIndex !== -1 ? parseInt(args[deviceIndex + 1]) : -1

class FFTServer {
  constructor() {
    this.clients = new Set()
    this.audioInput = null
    this.fft = new FFT(FFT_SIZE)
    this.fftBuffer = new Float32Array(FFT_SIZE)
    this.fftBufferPos = 0
    this.fftWindow = this.createHannWindow(FFT_SIZE)
    this.lastFftTime = 0
    this.fftInterval = 1000 / FFT_FPS

    // Pre-compute frequency band edges and A-weighting
    this.bandEdges = this.computeBandEdges()
    this.aWeights = this.computeAWeights()
  }

  createHannWindow(size) {
    const window = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)))
    }
    return window
  }

  computeBandEdges() {
    const n = Math.log2(FFT_END_FREQ / FFT_START_FREQ) / FFT_BINS
    const edges = []
    let freq = FFT_START_FREQ

    for (let i = 0; i < FFT_BINS; i++) {
      const freqLo = freq
      freq *= Math.pow(2, n)
      edges.push([freqLo, freq])
    }
    return edges
  }

  computeAWeights() {
    const c1 = Math.pow(12194.217, 2)
    const c2 = Math.pow(20.598997, 2)
    const c3 = Math.pow(107.65265, 2)
    const c4 = Math.pow(737.86223, 2)

    const n = Math.log2(FFT_END_FREQ / FFT_START_FREQ) / FFT_BINS
    const weights = new Float32Array(FFT_BINS)
    let freq = FFT_START_FREQ

    for (let i = 0; i < FFT_BINS; i++) {
      const centerFreq = freq * Math.pow(2, n / 2)
      const f2 = centerFreq * centerFreq

      const numerator = c1 * f2 * f2
      const denominator = (f2 + c2) * Math.sqrt((f2 + c3) * (f2 + c4)) * (f2 + c1)

      weights[i] = denominator > 0 ? 1.2589 * numerator / denominator : 0
      freq *= Math.pow(2, n)
    }
    return weights
  }

  interpolateFFT(magnitude, freq) {
    const binWidth = SAMPLE_RATE / FFT_SIZE
    const binPos = freq / binWidth
    const binLo = Math.floor(binPos)
    const binHi = Math.min(binLo + 1, magnitude.length - 1)
    const ratio = binPos - binLo

    const clampedLo = Math.max(0, Math.min(binLo, magnitude.length - 1))
    return magnitude[clampedLo] + (magnitude[binHi] - magnitude[clampedLo]) * ratio
  }

  computeFFT(samples) {
    const now = Date.now()
    if (now - this.lastFftTime < this.fftInterval) {
      return null
    }

    // Convert stereo int16 to mono float
    const numFrames = samples.length / (CHANNELS * 2) // 2 bytes per sample
    const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength)

    for (let i = 0; i < numFrames && this.fftBufferPos < FFT_SIZE; i++) {
      let sum = 0
      for (let ch = 0; ch < CHANNELS; ch++) {
        const offset = (i * CHANNELS + ch) * 2
        sum += view.getInt16(offset, true) / 32768.0
      }
      this.fftBuffer[this.fftBufferPos++] = sum / CHANNELS
    }

    if (this.fftBufferPos < FFT_SIZE) {
      return null
    }

    this.lastFftTime = now
    this.fftBufferPos = 0

    // Apply window
    const windowed = new Float32Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) {
      windowed[i] = this.fftBuffer[i] * this.fftWindow[i]
    }

    // Compute FFT
    const complexOut = this.fft.createComplexArray()
    const complexIn = this.fft.toComplexArray(windowed)
    this.fft.transform(complexOut, complexIn)

    // Get magnitude
    const magnitude = new Float32Array(FFT_SIZE / 2 + 1)
    for (let i = 0; i <= FFT_SIZE / 2; i++) {
      const re = complexOut[2 * i]
      const im = complexOut[2 * i + 1]
      magnitude[i] = Math.sqrt(re * re + im * im) / FFT_SIZE
    }

    // Map to frequency bands
    const spectrum = new Float32Array(FFT_BINS)
    const binWidth = SAMPLE_RATE / FFT_SIZE

    for (let i = 0; i < FFT_BINS; i++) {
      const [freqLo, freqHi] = this.bandEdges[i]
      let bandMag = Math.max(
        this.interpolateFFT(magnitude, freqLo),
        this.interpolateFFT(magnitude, freqHi)
      )

      const binLo = Math.floor(freqLo / binWidth) + 1
      const binHi = Math.min(Math.floor(freqHi / binWidth), magnitude.length - 1)

      if (binHi >= binLo) {
        for (let j = binLo; j <= binHi; j++) {
          bandMag = Math.max(bandMag, magnitude[j])
        }
      }

      spectrum[i] = bandMag * this.aWeights[i]
    }

    // Convert to dB and normalize
    const result = new Uint8Array(FFT_BINS)
    const minDb = -85, maxDb = -25

    for (let i = 0; i < FFT_BINS; i++) {
      const db = 20 * Math.log10(spectrum[i] + 1e-10)
      const normalized = (db - minDb) / (maxDb - minDb)
      result[i] = Math.floor(Math.max(0, Math.min(1, normalized)) * 255)
    }

    return result
  }

  startAudioCapture() {
    console.log('Starting audio capture...')

    const devices = portAudio.getDevices()
    console.log('Available audio devices:')
    devices.forEach((d, i) => {
      if (d.maxInputChannels > 0) {
        console.log(`  [${i}] ${d.name} (${d.maxInputChannels} in)`)
      }
    })

    const deviceId = DEVICE_ID >= 0 ? DEVICE_ID : portAudio.getDefaultInputDevice().id

    this.audioInput = new portAudio.AudioIO({
      inOptions: {
        channelCount: CHANNELS,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: SAMPLE_RATE,
        deviceId: deviceId,
        framesPerBuffer: 256
      }
    })

    this.audioInput.on('data', (data) => {
      const fftData = this.computeFFT(data)
      if (fftData) {
        this.broadcast(fftData)
      }
    })

    this.audioInput.on('error', (err) => {
      console.error('Audio error:', err)
    })

    this.audioInput.start()
    console.log(`Audio capture started on device ${deviceId}`)
  }

  stopAudioCapture() {
    if (this.audioInput) {
      this.audioInput.quit()
      this.audioInput = null
      console.log('Audio capture stopped')
    }
  }

  broadcast(data) {
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(data)
      }
    }
  }

  start() {
    const wss = new WebSocketServer({ port: PORT })

    wss.on('connection', (ws) => {
      console.log(`Client connected. Total: ${this.clients.size + 1}`)

      // Send config
      ws.send(JSON.stringify({
        type: 'config',
        mode: 'fft',
        bins: FFT_BINS,
        fps: FFT_FPS
      }))

      this.clients.add(ws)

      // Start capture on first client
      if (this.clients.size === 1) {
        this.startAudioCapture()
      }

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log(`Client disconnected. Total: ${this.clients.size}`)

        // Stop capture when no clients
        if (this.clients.size === 0) {
          this.stopAudioCapture()
        }
      })

      ws.on('error', (err) => {
        console.error('WebSocket error:', err)
        this.clients.delete(ws)
      })
    })

    console.log(`FFT server started on ws://0.0.0.0:${PORT}`)

    // Handle shutdown
    process.on('SIGINT', () => {
      console.log('Shutting down...')
      this.stopAudioCapture()
      wss.close()
      process.exit(0)
    })
  }
}

const server = new FFTServer()
server.start()
