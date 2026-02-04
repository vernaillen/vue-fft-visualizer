#!/usr/bin/env python3
"""Debug version of FFT server for Pi Audio"""

import asyncio
import json
import signal
import time
from typing import Optional

import alsaaudio
import numpy as np
from websockets.asyncio.server import serve, ServerConnection

# Audio capture settings for Pi Audio
SAMPLE_RATE = 96000
CHANNELS = 2
FORMAT = alsaaudio.PCM_FORMAT_S32_LE
PERIOD_SIZE = 1024

# FFT settings
FFT_SIZE = 2048
FFT_BINS = 80
FFT_FPS = 60
FFT_START_FREQ = 100.0
FFT_END_FREQ = 18000.0


class FFTServer:
    def __init__(self, device: str = 'gadget', port: int = 3002):
        self.device = device
        self.port = port
        self.clients: list[ServerConnection] = []
        self.pcm: Optional[alsaaudio.PCM] = None
        self.running = False

        # FFT state
        self._fft_buffer = np.zeros(FFT_SIZE, dtype=np.float32)
        self._fft_buffer_pos = 0
        self._fft_window = np.hanning(FFT_SIZE).astype(np.float32)
        self._last_fft_time = 0.0
        self._fft_interval = 1.0 / FFT_FPS
        self._frame_count = 0

        # Pre-compute frequency bands
        self._band_edges = self._compute_band_edges()
        self._a_weights = self._compute_a_weights()

    def _compute_band_edges(self):
        n = np.log2(FFT_END_FREQ / FFT_START_FREQ) / FFT_BINS
        edges = []
        freq = FFT_START_FREQ
        for _ in range(FFT_BINS):
            freq_lo = freq
            freq *= (2 ** n)
            edges.append((freq_lo, freq))
        return edges

    def _compute_a_weights(self):
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
            num = c1 * f2 * f2
            den = (f2 + c2) * np.sqrt((f2 + c3) * (f2 + c4)) * (f2 + c1)
            weights[i] = 1.2589 * num / den if den > 0 else 0
            freq *= (2 ** n)
        return weights

    def _open_device(self):
        print(f"Opening ALSA device '{self.device}' at {SAMPLE_RATE}Hz")
        self.pcm = alsaaudio.PCM(
            type=alsaaudio.PCM_CAPTURE,
            mode=alsaaudio.PCM_NONBLOCK,  # Non-blocking mode!
            device=self.device,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            format=FORMAT,
            periodsize=PERIOD_SIZE
        )
        print("Device opened successfully")

    def _compute_fft(self, data: bytes) -> Optional[bytes]:
        current_time = time.time()

        # Rate limit
        if current_time - self._last_fft_time < self._fft_interval:
            return None

        # Convert S32_LE stereo to float mono
        samples = np.frombuffer(data, dtype=np.int32)
        num_frames = len(samples) // CHANNELS
        if num_frames == 0:
            return None

        stereo = samples.reshape(num_frames, CHANNELS)
        mono = stereo.mean(axis=1).astype(np.float32) / 2147483648.0

        # Add to rolling buffer
        space = FFT_SIZE - self._fft_buffer_pos
        to_add = min(len(mono), space)
        self._fft_buffer[self._fft_buffer_pos:self._fft_buffer_pos + to_add] = mono[:to_add]
        self._fft_buffer_pos += to_add

        if to_add < len(mono):
            remaining = mono[to_add:]
            shift = len(remaining)
            self._fft_buffer[:-shift] = self._fft_buffer[shift:]
            self._fft_buffer[-shift:] = remaining
            self._fft_buffer_pos = FFT_SIZE

        if self._fft_buffer_pos < FFT_SIZE:
            return None

        self._last_fft_time = current_time

        # Compute FFT
        windowed = self._fft_buffer * self._fft_window
        fft_result = np.fft.rfft(windowed)
        magnitude = np.abs(fft_result) / FFT_SIZE

        # Map to frequency bands
        spectrum = np.zeros(FFT_BINS, dtype=np.float32)
        bin_width = SAMPLE_RATE / FFT_SIZE

        for i, (freq_lo, freq_hi) in enumerate(self._band_edges):
            bin_lo = int(freq_lo / bin_width)
            bin_hi = int(freq_hi / bin_width)
            bin_lo = max(0, min(bin_lo, len(magnitude) - 1))
            bin_hi = max(0, min(bin_hi, len(magnitude) - 1))

            if bin_hi >= bin_lo:
                spectrum[i] = np.max(magnitude[bin_lo:bin_hi + 1]) * self._a_weights[i]

        # Convert to dB and normalize
        db_spectrum = 20 * np.log10(spectrum + 1e-10)
        min_db, max_db = -80.0, -20.0
        normalized = (db_spectrum - min_db) / (max_db - min_db)
        normalized = np.clip(normalized, 0, 1)

        self._frame_count += 1
        return (normalized * 255).astype(np.uint8).tobytes()

    async def _capture_loop(self):
        print("Starting capture loop")
        last_status = time.time()
        frames_sent = 0

        try:
            while self.running and self.clients:
                try:
                    length, data = self.pcm.read()
                except alsaaudio.ALSAAudioError:
                    await asyncio.sleep(0.001)
                    continue

                if length <= 0 or not data:
                    await asyncio.sleep(0.001)
                    continue

                fft_data = self._compute_fft(bytes(data))

                if fft_data:
                    frames_sent += 1
                    disconnected = []
                    for ws in self.clients:
                        try:
                            await ws.send(fft_data)
                        except Exception:
                            disconnected.append(ws)
                    for ws in disconnected:
                        self.clients.remove(ws)

                # Status every 5 seconds
                now = time.time()
                if now - last_status > 5:
                    print(f"Status: {len(self.clients)} clients, {frames_sent} frames sent, buffer pos: {self._fft_buffer_pos}")
                    last_status = now
                    frames_sent = 0

                await asyncio.sleep(0)

        except Exception as e:
            print(f"Capture loop error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            print("Capture loop ended")
            if self.pcm:
                self.pcm.close()
                self.pcm = None
            self.running = False

    async def _handle_connection(self, websocket: ServerConnection):
        print(f"Client connected, total: {len(self.clients) + 1}")

        # Send config
        config = json.dumps({
            'type': 'config',
            'mode': 'fft',
            'bins': FFT_BINS,
            'fps': FFT_FPS
        })
        await websocket.send(config)

        self.clients.append(websocket)

        # Start capture if first client
        if not self.running:
            self.running = True
            self._open_device()
            asyncio.create_task(self._capture_loop())

        try:
            async for _ in websocket:
                pass
        finally:
            if websocket in self.clients:
                self.clients.remove(websocket)
            print(f"Client disconnected, total: {len(self.clients)}")

    async def start(self):
        print(f"Starting FFT server on ws://0.0.0.0:{self.port}")

        stop = asyncio.Event()

        def signal_handler():
            print("Shutdown signal")
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, signal_handler)

        async with serve(self._handle_connection, "0.0.0.0", self.port):
            print("Server ready - waiting for connections...")
            await stop.wait()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--device', default='gadget')
    parser.add_argument('--port', type=int, default=3002)
    args = parser.parse_args()

    server = FFTServer(device=args.device, port=args.port)
    asyncio.run(server.start())
