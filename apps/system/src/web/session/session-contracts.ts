// @module browser-session
// @role contracts
import type {Identity} from "../../modules/identity/dto";
/** The session coordinator can flush/dispose a consumer without knowing an editor implementation. */
export interface SessionConsumer { flush(): Promise<void>; dispose(): void; }
export interface LoginInput { loginId: FormDataEntryValue | null; password: FormDataEntryValue | null; }
export type AuthorityLease=()=>boolean;
export interface PrincipalReader {read():Promise<Identity>}
export interface AppSessionModel {
  identity:Identity|null;loading:boolean;busy:boolean;ready:boolean;message:string;
  attach:(consumer:SessionConsumer|null)=>void;
  identityChanged:(identity:Identity)=>void;
  prepareLogin:()=>void;
  reauth:()=>void;
  login:(input:LoginInput,clearInput:()=>void)=>Promise<void>;
  logout:()=>Promise<void>;
}
