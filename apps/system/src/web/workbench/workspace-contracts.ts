// @module workbench
// @role contracts
import type {Identity} from "../../modules/identity/dto";
import type {SessionConsumer} from '../session/access';
export interface WorkspaceProps {
  identity:Identity;
  reauth:()=>void;
  identityChanged:(identity:Identity)=>void;
  onEditor:(consumer:SessionConsumer|null)=>void;
}
