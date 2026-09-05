// MapLibre 6 locates its module worker relative to import.meta.url. Vite's
// dependency optimizer relocates the main module, so serve the worker and its
// shared module at explicit local URLs in both development and built output.
import {mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
const pkg=require.resolve('maplibre-gl/package.json');
const source=join(dirname(pkg),'dist');
const out=new URL('../public/maplibre/',import.meta.url);
mkdirSync(out,{recursive:true});
for(const name of ['maplibre-gl-worker.mjs','maplibre-gl-shared.mjs'])copyFileSync(join(source,name),new URL(name,out));
copyFileSync(join(dirname(pkg),'LICENSE.txt'),new URL('LICENSE.txt',out));
writeFileSync(new URL('version.txt',out),JSON.parse(readFileSync(pkg,'utf8')).version+'\n');
console.log('Prepared local MapLibre module worker.');
