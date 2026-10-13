// @module platform.crypto
// @role crypto-primitives
import { timingSafeEqual } from 'node:crypto';
import { argon2id } from './generated/hash-wasm.js';
export const ARGON = {memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32} as const;
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}
export async function digest(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
}
export function constantEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export async function hashPassword(password:string):Promise<string>{
  return argon2id({...ARGON,password,salt:crypto.getRandomValues(new Uint8Array(16)),outputType:'encoded'});
}
export async function setupInputHash(token:string,password:string):Promise<string>{
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(password))).toString('hex');
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = encoded.match(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/);
  if (!match) throw new Error('Unsupported stored password parameters');
  const hash = await argon2id({...ARGON, password, salt: Buffer.from(match[1], 'base64'), outputType: 'binary'});
  const expected = Buffer.from(match[2], 'base64');
  return hash.byteLength === expected.byteLength && timingSafeEqual(hash, expected);
}
