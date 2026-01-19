# Rust FFT Server

A Rust WebSocket server that captures audio using cpal and streams FFT data.

## Requirements

- Rust 1.70+
- ALSA development libraries (Linux) or CoreAudio (macOS)

### Installing Dependencies

**Ubuntu/Debian:**
```bash
sudo apt install libasound2-dev
```

**macOS:**
No additional dependencies (uses CoreAudio).

**Windows:**
No additional dependencies (uses WASAPI).

## Building

```bash
cd backend-examples/rust
cargo build --release
```

## Usage

```bash
# Use default audio device
cargo run --release

# Custom port
cargo run --release -- --port 8080
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port` | 3001 | WebSocket server port |

## Configuration

Edit the constants in `src/main.rs`:

```rust
const SAMPLE_RATE: u32 = 48000;      // Audio sample rate
const FFT_SIZE: usize = 1024;        // FFT window size
const FFT_BINS: usize = 80;          // Number of frequency bands
const FFT_FPS: u32 = 120;            // Target frames per second
const FFT_START_FREQ: f32 = 100.0;   // Lowest frequency (Hz)
const FFT_END_FREQ: f32 = 18000.0;   // Highest frequency (Hz)
```

## Dependencies

- **cpal** - Cross-platform audio I/O
- **rustfft** - High-performance FFT implementation
- **tokio** - Async runtime
- **tokio-tungstenite** - WebSocket support
- **serde** - JSON serialization
- **clap** - Command-line argument parsing

## Performance

The Rust implementation offers:
- Low memory footprint
- Minimal CPU usage
- No garbage collection pauses
- Native performance

Ideal for embedded systems or resource-constrained environments.
