// @module administration
// @role contracts
import type {Identity} from "../../modules/identity/dto";
export interface ManagementProps {
  identity:Identity;
  identityChanged:(identity:Identity)=>void;
}
