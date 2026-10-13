// @module identity
// @role private-password-crypto
import { hashPassword,verifyPassword } from "./passwords";
import { ApiError } from "../protocol-errors";
// Only isolate resource accounting is shared. No principal, token, password or request is retained.
let activeHashes = 0;
export async function checkedPassword(password: string, encoded: string): Promise<boolean> {
  return passwordSlot(()=>verifyPassword(password,encoded));
}
async function passwordSlot<T>(work:()=>Promise<T>):Promise<T>{
  if (activeHashes >= 2) throw new ApiError(503,'authentication_busy');
  activeHashes++;
  try { return await work(); } finally { activeHashes--; }
}
export function checkedPasswordHash(password:string):Promise<string>{return passwordSlot(()=>hashPassword(password));}
