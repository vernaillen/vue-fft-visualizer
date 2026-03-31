import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import dts from 'vite-plugin-dts'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { resolve } from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    wasm(),
    topLevelAwait(),
    ...(mode !== 'playground' ? [dts({
      insertTypesEntry: true,
      include: ['src/**/*.ts', 'src/**/*.vue']
    })] : [])
  ],
  build: mode === 'playground'
    ? {}
    : {
        lib: {
          entry: resolve(__dirname, 'src/index.ts'),
          name: 'VueFFTVisualizer',
          fileName: 'vue-fft-visualizer',
          formats: ['es'] as const
        },
        rollupOptions: {
          external: ['vue'],
          output: {
            globals: {
              vue: 'Vue'
            }
          }
        }
      }
}))
