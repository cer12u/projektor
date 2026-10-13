// @module delivery
// @role protocol-input
import { ApiError } from "../../adapters/protocol-errors";
import { jsonInput } from "./input";
export async function readJsonInput(request:Request):Promise<Record<string,unknown>>{
 const value=await jsonInput(request,4096);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'invalid_input',{body:'object required'});
 return value as Record<string,unknown>;
}
