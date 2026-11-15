import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep the large 3D vendor code in its own long-cacheable chunk.
        manualChunks(id) {
          if (/node_modules\/(three|@react-three|three-stdlib|troika|camera-controls|meshline|maath)/.test(id)) return 'three';
          if (/node_modules\/(react|react-dom|scheduler|zustand)\//.test(id)) return 'react';
        },
      },
    },
  },
});
