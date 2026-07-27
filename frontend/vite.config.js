import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:5001',
    },
  },
  build: {
    outDir: 'build',
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('react-dom') || id.includes('react-router')) return 'vendor-react';
          if (id.includes('chart.js') || id.includes('react-chartjs')) return 'vendor-charts';
          if (id.includes('react-reader') || id.includes('jszip')) return 'vendor-reader';
          if (id.includes('@zxing')) return 'vendor-barcode';
          if (id.includes('node_modules')) return 'vendor-misc';
        },
      },
    },
  },
})
