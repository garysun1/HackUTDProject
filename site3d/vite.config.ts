import { defineConfig } from 'vite';
const THREE_ADDONS = ['three/addons/controls/OrbitControls.js', 'three/addons/renderers/CSS2DRenderer.js', 'three/addons/lines/Line2.js', 'three/addons/lines/LineMaterial.js', 'three/addons/lines/LineGeometry.js'];
export default defineConfig({ server: { port: 5174, strictPort: true }, optimizeDeps: { include: ['three', ...THREE_ADDONS] }, resolve: { dedupe: ['three'] }, build: { target: 'es2022', chunkSizeWarningLimit: 1200 } });
