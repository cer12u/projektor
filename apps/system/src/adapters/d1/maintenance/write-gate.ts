// @module maintenance
// @role gate-state
import type { AuthDB } from "../primitives";
import { ApiError } from "../../protocol-errors";
export async function setWriteMode(db:AuthDB,mode:'open'|'stopped',expectedEpoch:number){
 const r=await db.prepare("UPDATE write_gate SET mode=?,epoch=epoch+1 WHERE id=1 AND epoch=? AND mode<>'importing'").bind(mode,expectedEpoch).run();if(r.meta.changes!==1)throw new ApiError(409,'write_gate_changed');return db.prepare('SELECT mode,epoch FROM write_gate WHERE id=1').first();
}

