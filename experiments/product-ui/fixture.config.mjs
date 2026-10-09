import {defineConfig} from 'vite';
export default defineConfig({build:{target:'es2023',outDir:'dist-fixture',rollupOptions:{input:'fixture.html'}}});
