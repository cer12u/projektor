// Read-only translation of the unprovisioned Wrangler template for local workerd
// verification. This does not select a live target or authorize deployment.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export async function readHostingTemplate(url=new URL('../wrangler.hosting.example.json',import.meta.url)) {
 const config=JSON.parse(await readFile(url,'utf8'));
 const assets=config.assets;
 if(config.main!=='service/entry.mjs'||assets?.directory!=='../product-ui/dist'||
    assets.binding!=='ASSETS'||assets.html_handling!=='none'||assets.not_found_handling!=='single-page-application'||
    !Array.isArray(assets.run_worker_first)||assets.run_worker_first.some(path=>typeof path!=='string'||!path.startsWith('/')||path.includes('!')))
  throw Error('HOSTING_TEMPLATE_INVALID');
 return {
  config,
  scriptPath:fileURLToPath(new URL(config.main,url)),
  modulesRoot:fileURLToPath(new URL('./',url)),
  compatibilityDate:config.compatibility_date,
  compatibilityFlags:config.compatibility_flags,
  modulesRules:config.rules.map(({type,globs,fallthrough})=>({type,include:globs,fallthrough})),
  assets:{
   directory:fileURLToPath(new URL(assets.directory+'/',url)),
   binding:assets.binding,
   routerConfig:{has_user_worker:true,static_routing:{user_worker:assets.run_worker_first}},
   assetConfig:{html_handling:assets.html_handling,not_found_handling:assets.not_found_handling},
  },
 };
}
