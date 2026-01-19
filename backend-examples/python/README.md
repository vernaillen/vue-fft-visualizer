# Python FFT Server

A Python WebSocket server that captures audio from ALSA and streams FFT data.

## Requirements

- Python 3.10+
- Linux with ALSA (for audio capture)

## Installation

```bash
cd backend-examples/python
pip install -r requirements.txt
```

## Usage

```bash
# Use default audio device
python fft_server.py

# Specify ALSA device
python fft_server.py --device hw:0,0

# Custom port
python fft_server.py --port 8080
```

## ALSA Device Names

List available devices:
```bash
arecord -L
```

Common device names:
- `default` - System default capture device
- `hw:0,0` - First hardware device
- `plughw:0,0` - Hardware device with format conversion
- `pulse` - PulseAudio (if installed)

## Configuration

Edit the constants in `fft_server.py`:

```python
SAMPLE_RATE = 48000      # Audio sample rate
FFT_SIZE = 1024          # FFT window size
FFT_BINS = 80            # Number of frequency bands
FFT_FPS = 120            # Target frames per second
FFT_START_FREQ = 100.0   # Lowest frequency (Hz)
FFT_END_FREQ = 18000.0   # Highest frequency (Hz)
```

## How It Works

1. Opens ALSA capture device
2. Reads audio in small chunks (256 samples)
3. Maintains rolling buffer for FFT window
4. Applies Hann window to reduce spectral leakage
5. Computes FFT using numpy
6. Maps FFT bins to exponentially-spaced frequency bands
7. Applies A-weighting to match human hearing
8. Converts to dB scale and normalizes to 0-255
9. Streams as binary WebSocket messages
