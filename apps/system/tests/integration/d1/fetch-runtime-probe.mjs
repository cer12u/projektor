// @module verification
// @role fetch-runtime-probe
import{Miniflare,convertV4MiniflareOptions}from'miniflare';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:`export default{async fetch(){try{const r=await fetch('https://synthetic-owner.cloudflareaccess.com/cdn-cgi/access/certs',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(5000)});return Response.json({status:r.status});}catch(e){return Response.json({name:e.name,message:e.message});}}}`,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],outboundService:()=>Response.json({keys:[]}),cf:false,host:'127.0.0.1',port:0}));try{console.log(await(await mf.dispatchFetch('https://synthetic.invalid/')).text());}finally{await mf.dispose()}
