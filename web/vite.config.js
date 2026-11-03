import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), personal: resolve(import.meta.dirname, 'p.html') } } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4961' } },
});
