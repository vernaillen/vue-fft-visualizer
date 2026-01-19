# Node.js FFT Server

A Node.js WebSocket server that captures audio using PortAudio and streams FFT data.

## Requirements

- Node.js 18+
- PortAudio library (for naudiodon)

### Installing PortAudio

**macOS:**
```bash
brew install portaudio
```

**Ubuntu/Debian:**
```bash
sudo apt install libportaudio2 portaudio19-dev
```

**Windows:**
PortAudio is bundled with naudiodon on Windows.

## Installation

```bash
cd backend-examples/nodejs
npm install
```

## Usage

```bash
# Use default audio device
npm start

# Or with options
node fft-server.js --port 8080 --device 2
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 3001 | WebSocket server port |
| `--device` | -1 | Audio device ID (-1 = default) |

## Finding Audio Devices

The server prints available input devices on startup:

```
Available audio devices:
  [0] Built-in Microphone (2 in)
  [1] Soundflower (2ch) (2 in)
  [2] Soundflower (64ch) (64 in)
```

Use `--device N` to select a specific device.

## Configuration

Edit the constants in `fft-server.js`:

```javascript
const SAMPLE_RATE = 48000      // Audio sample rate
const FFT_SIZE = 1024          // FFT window size
const FFT_BINS = 80            // Number of frequency bands
const FFT_FPS = 120            // Target frames per second
const FFT_START_FREQ = 100.0   // Lowest frequency (Hz)
const FFT_END_FREQ = 18000.0   // Highest frequency (Hz)
```

## Capturing System Audio

To visualize system audio output (not microphone):

**macOS:** Install [BlackHole](https://github.com/ExistentialAudio/BlackHole) or Soundflower

**Linux:** Use PulseAudio monitor source or create a loopback

**Windows:** Use [VB-Cable](https://vb-audio.com/Cable/) or WASAPI loopback
