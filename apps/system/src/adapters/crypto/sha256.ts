// @module platform.crypto
// @role hash-primitives
// UTF-8 SHA-256 shared by the private importer and connector runtime (no Buffer).
export async function digest(value:string):Promise<string>{
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
