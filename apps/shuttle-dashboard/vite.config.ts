import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_SHUTTLE_API_TARGET ?? 'http://localhost:8791';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      '/api': apiTarget,
      '/shuttle-ws': {
        target: wsTarget,
        ws: true
      }
    }
  }
});
