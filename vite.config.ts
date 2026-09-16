import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/server/**', '**/output/**', '**/.playwright-cli/**'] },
    watch: { ignored: ['**/.data/**', '**/output/**', '**/.playwright-cli/**'] },
  },
});
