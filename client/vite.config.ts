import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Lets the browser reach the socket server through this same origin —
      // no second port needs to be reachable/forwarded in dev.
      '/socket.io': {
        target: process.env.VITE_SERVER_URL ?? 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
