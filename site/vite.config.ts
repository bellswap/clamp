import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The playground app (play.bellswap.fun). Runtime config comes from VITE_RPC_URL, VITE_BELL_URL and VITE_BOOK_JSON
// (the contents of deployments/book.json written by the deploy script); see src/config.ts.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js' } },
  },
});
