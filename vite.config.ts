import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';
export default defineConfig(({mode}) => {
  const env=loadEnv(mode,process.cwd(),'');
  const basePath=process.env.GITHUB_PAGES==='true'?'/sigmet-wiw2-astra':'';
  return {
    css:{postcss:{plugins:[tailwindcss()]}},
    define:{
      'process.env.NEXT_PUBLIC_MAPTILER_KEY':JSON.stringify(env.MAPTILER_API || ''),
      'process.env.NEXT_PUBLIC_BASE_PATH':JSON.stringify(basePath),
    },
    server:{host:'127.0.0.1',port:5173,strictPort:true,watch:{useFsEvents:false,usePolling:true,ignored:['**/data/aviation_sigmet/**','**/.venv/**','**/.cache/**']}},
    plugins:[vinext()],
  };
});
