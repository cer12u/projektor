// Supply independently obtained metadata/review files. No production defaults.
import {strictJson} from './strict-json.mjs';
import {readFile} from 'node:fs/promises';
import {preflight} from './preflight.mjs';
const [root,profileFile,observedFile,reviewFile,...extra]=process.argv.slice(2);
if(!root||!profileFile||!observedFile||!reviewFile||extra.length){
 console.error('Usage: node --experimental-vm-modules release/check.mjs ROOT PROFILE_JSON OBSERVED_JSON REVIEW_JSON');process.exitCode=2;
}else{
 try{
  const json=async path=>strictJson(await readFile(path,'utf8'));
  const result=await preflight(root,await json(profileFile),await json(observedFile),await json(reviewFile));
  console.log(JSON.stringify(result));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
