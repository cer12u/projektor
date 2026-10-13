// @module platform.runtime
// @role readiness
import type { AuthDB } from "./primitives";
/** Operational readiness read without business mutation or identity projection. */
export async function readDatabaseHealth(db:AuthDB):Promise<void>{await db.prepare('SELECT 1 AS reachable').first();}
export async function readRequestGate(db:AuthDB):Promise<string|undefined>{
 const gate=await db.prepare('SELECT mode FROM write_gate WHERE id=1').first<{mode:string}>();return gate?.mode;
}
