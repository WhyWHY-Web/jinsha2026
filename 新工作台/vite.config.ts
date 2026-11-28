import { defineConfig } from 'vite'
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:8732', '/assets/source': 'http://127.0.0.1:8732' } },
  build: { manifest:true, rolldownOptions: { output: { codeSplitting: { groups: [
    { name:'vendor-maplibre', test:/node_modules[\\/](maplibre-gl|@maplibre)[\\/]/ },
  ] } } } }
})
