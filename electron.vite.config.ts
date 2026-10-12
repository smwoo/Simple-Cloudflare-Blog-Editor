import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  main: {
    // sharp and the AWS SDK must NOT be bundled: sharp loads a native binding
    // and resolves its own @img/sharp-<platform> package at runtime, which a
    // bundler cannot follow.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: path.resolve('src/main/index.ts') },
    },
    resolve: { conditions: ['node'] },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: path.resolve('src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: path.resolve('src/renderer/index.html') },
    },
  },
})
