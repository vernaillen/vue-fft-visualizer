import FFTVisualizer from './components/FFTVisualizer.vue'

export { FFTVisualizer }
export { useLocalAudio } from './composables/useLocalAudio'
export type { AudioDevice, AudioSourceType, LocalAudioOptions, LocalAudioReturn } from './composables/useLocalAudio'
export { useWebSocketFft } from './composables/useWebSocketFft'
export type { WebSocketFftOptions, WebSocketFftReturn } from './composables/useWebSocketFft'
