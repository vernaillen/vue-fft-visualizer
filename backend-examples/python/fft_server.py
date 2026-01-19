#!/usr/bin/env python3
"""
FFT WebSocket Server - Python Example

Captures audio from an ALSA device, computes FFT, and streams frequency
data to WebSocket clients for visualization.

Requirements:
    pip install websockets numpy pyalsaaudio

Usage:
    python fft_server.py [--device default] [--port 3001]

Protocol:
    1. Client connects to ws://host:port/
    2. Server sends config: {"type":"config","mode":"fft","bins":80,"fps":120}
    3. Server streams binary: 80 bytes of uint8 (frequency magnitudes 0-255)
"""

import argparse
import asyncio
import json
import signal
from dataclasses import dataclass
from typing import Optional

import alsaaudio
import numpy as np
from websockets.asyncio.server import serve, ServerConnection

# Audio capture settings
SAMPLE_RATE = 48000
CHANNELS = 2
FORMAT = alsaaudio.PCM_FORMAT_S16_LE
PERIOD_SIZE = 256

# FFT settings
FFT_SIZE = 1024
FFT_BINS = 80
FFT_FPS = 120
FFT_START_FREQ = 100.0
FFT_END_FREQ = 18000.0


@dataclass
class Client:
    websocket: ServerConnection


class FFTServer:
    def __init__(self, device: str = 'default', port: int = 3001):
        self.device = device
        self.port = port
        self.clients: list[Client] = []
        self.pcm: Optional[alsaaudio.PCM] = None
        self.running = False

        # FFT state
        self._fft_buffer = np.zeros(FFT_SIZE, dtype=np.float32)
        self._fft_buffer_pos = 0
        self._fft_window = np.hanning(FFT_SIZE).astype(np.float32)
        self._last_fft_time = 0.0
        self._fft_interval = 1.0 / FFT_FPS

        # Pre-compute frequency band edges and A-weighting
        self._band_edges = self._compute_band_edges()
        self._a_weights = self._compute_a_weights()

    def _compute_band_edges(self) -> list[tuple[float, float]]:
        """Compute exponentially-spaced frequency band edges."""
        n = np.log2(FFT_END_FREQ / FFT_START_FREQ) / FFT_BINS
        band_edges = []
        freq = FFT_START_FREQ

        for _ in range(FFT_BINS):
            freq_lo = freq
            freq *= (2 ** n)
            freq_hi = freq
            band_edges.append((freq_lo, freq_hi))

        return band_edges

    def _compute_a_weights(self) -> np.ndarray:
        """Compute A-weighting curve to match human hearing."""
        c1 = 12194.217 ** 2
        c2 = 20.598997 ** 2
        c3 = 107.65265 ** 2
        c4 = 737.86223 ** 2

        n = np.log2(FFT_END_FREQ / FFT_START_FREQ) / FFT_BINS
        weights = np.zeros(FFT_BINS, dtype=np.float32)

        freq = FFT_START_FREQ
        for i in range(FFT_BINS):
            center_freq = freq * (2 ** (n / 2))
            f2 = center_freq ** 2

            numerator = c1 * f2 * f2
            denominator = ((f2 + c2) *
                          np.sqrt((f2 + c3) * (f2 + c4)) *
                          (f2 + c1))

            weights[i] = 1.2589 * numerator / denominator if denominator > 0 else 0
            freq *= (2 ** n)

        return weights

    def _interpolate_fft(self, magnitude: np.ndarray, freq: float) -> float:
        """Interpolate FFT magnitude at a specific frequency."""
        bin_width = SAMPLE_RATE / FFT_SIZE
        bin_pos = freq / bin_width
        bin_lo = int(bin_pos)
        bin_hi = min(bin_lo + 1, len(magnitude) - 1)
        ratio = bin_pos - bin_lo

        bin_lo = max(0, min(bin_lo, len(magnitude) - 1))

        value = magnitude[bin_lo] + (magnitude[bin_hi] - magnitude[bin_lo]) * ratio
        return value if not np.isnan(value) else 0.0

    def _open_device(self) -> None:
        """Open ALSA capture device."""
        print(f"Opening ALSA device '{self.device}'")
        self.pcm = alsaaudio.PCM(
            type=alsaaudio.PCM_CAPTURE,
            mode=alsaaudio.PCM_NORMAL,
            device=self.device,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            format=FORMAT,
            periodsize=PERIOD_SIZE
        )

    def _close_device(self) -> None:
        """Close ALSA capture device."""
        if self.pcm:
            print(f"Closing ALSA device '{self.device}'")
            self.pcm.close()
            self.pcm = None

    def _compute_fft(self, data: bytes) -> Optional[bytes]:
        """Compute FFT and return frequency bins as uint8 array."""
        import time
        current_time = time.time()

        # Rate limit
        if current_time - self._last_fft_time < self._fft_interval:
            return None

        # Convert to float mono
        samples = np.frombuffer(data, dtype=np.int16)
        num_frames = len(samples) // CHANNELS
        stereo = samples.reshape(num_frames, CHANNELS)
        mono = stereo.mean(axis=1).astype(np.float32) / 32768.0

        # Add to rolling buffer
        space_available = FFT_SIZE - self._fft_buffer_pos
        samples_to_add = min(len(mono), space_available)

        self._fft_buffer[self._fft_buffer_pos:self._fft_buffer_pos + samples_to_add] = mono[:samples_to_add]
        self._fft_buffer_pos += samples_to_add

        if samples_to_add < len(mono):
            remaining = mono[samples_to_add:]
            shift_amount = len(remaining)
            self._fft_buffer[:-shift_amount] = self._fft_buffer[shift_amount:]
            self._fft_buffer[-shift_amount:] = remaining
            self._fft_buffer_pos = FFT_SIZE

        if self._fft_buffer_pos < FFT_SIZE:
            return None

        self._last_fft_time = current_time

        # Apply window and compute FFT
        windowed = self._fft_buffer * self._fft_window
        fft_result = np.fft.rfft(windowed)
        magnitude = np.abs(fft_result) / FFT_SIZE

        # Map to frequency bands
        spectrum = np.zeros(FFT_BINS, dtype=np.float32)
        bin_width = SAMPLE_RATE / FFT_SIZE

        for i, (freq_lo, freq_hi) in enumerate(self._band_edges):
            val_lo = self._interpolate_fft(magnitude, freq_lo)
            val_hi = self._interpolate_fft(magnitude, freq_hi)
            band_magnitude = max(val_lo, val_hi)

            bin_lo = int(freq_lo / bin_width) + 1
            bin_hi = int(freq_hi / bin_width)
            if bin_hi >= bin_lo and bin_lo < len(magnitude):
                bin_hi = min(bin_hi, len(magnitude) - 1)
                if bin_hi >= bin_lo:
                    band_magnitude = max(band_magnitude, np.max(magnitude[bin_lo:bin_hi + 1]))

            band_magnitude *= self._a_weights[i]
            spectrum[i] = band_magnitude

        # Convert to dB and normalize
        db_spectrum = 20 * np.log10(spectrum + 1e-10)
        min_db, max_db = -85.0, -25.0
        normalized = (db_spectrum - min_db) / (max_db - min_db)
        normalized = np.clip(normalized, 0, 1)

        return (normalized * 255).astype(np.uint8).tobytes()

    async def _capture_loop(self) -> None:
        """Main capture and broadcast loop."""
        print("Starting capture loop")

        try:
            while self.running and self.clients:
                length, data = self.pcm.read()

                if length < 0 or not data:
                    await asyncio.sleep(0.001)
                    continue

                fft_data = self._compute_fft(bytes(data))
                if fft_data is None:
                    await asyncio.sleep(0)
                    continue

                # Broadcast to all clients
                disconnected = []
                for client in self.clients:
                    try:
                        await client.websocket.send(fft_data)
                    except Exception:
                        disconnected.append(client)

                for client in disconnected:
                    self.clients.remove(client)

                await asyncio.sleep(0)

        except Exception as e:
            print(f"Capture loop error: {e}")
        finally:
            print("Capture loop ended")
            self._close_device()
            self.running = False

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        """Handle a WebSocket connection."""
        client = Client(websocket=websocket)

        # Send config
        config = json.dumps({
            'type': 'config',
            'mode': 'fft',
            'bins': FFT_BINS,
            'fps': FFT_FPS
        })
        await websocket.send(config)

        self.clients.append(client)
        print(f"Client connected. Total: {len(self.clients)}")

        # Start capture if first client
        if not self.running:
            self.running = True
            self._open_device()
            asyncio.create_task(self._capture_loop())

        try:
            async for _ in websocket:
                pass  # Keep alive
        finally:
            if client in self.clients:
                self.clients.remove(client)
            print(f"Client disconnected. Total: {len(self.clients)}")

    async def start(self) -> None:
        """Start the WebSocket server."""
        print(f"Starting FFT server on ws://0.0.0.0:{self.port}")

        stop = asyncio.Event()

        def signal_handler():
            print("Shutdown signal received")
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, signal_handler)

        async with serve(self._handle_connection, None, self.port) as server:
            print("FFT server started")
            await stop.wait()

        print("FFT server stopped")


def main():
    parser = argparse.ArgumentParser(description='FFT WebSocket Server')
    parser.add_argument('--device', default='default', help='ALSA device name')
    parser.add_argument('--port', type=int, default=3001, help='WebSocket port')
    args = parser.parse_args()

    server = FFTServer(device=args.device, port=args.port)
    asyncio.run(server.start())


if __name__ == '__main__':
    main()
