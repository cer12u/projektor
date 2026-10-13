// @module browser-session
// @role adapter

export function newNonce(){return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
