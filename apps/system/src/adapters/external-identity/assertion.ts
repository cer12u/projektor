// @module identity
// @role external-verifier
import type {AssertionVerifier} from "../../modules/identity/ports";
import {verifyAccessAssertion} from "./access-assertion";
import {verifyOwner,ownerConfiguration,type SetupStage} from "./owner-access-assertion";
import {IdentityError} from "../../modules/identity/outcomes";
import {ApiError} from "../protocol-errors";
export const assertionVerifier:AssertionVerifier={
 ownerConfiguration,
 async agent(...args){try{return await verifyAccessAssertion(...args);}catch(error){if(error instanceof ApiError)throw new IdentityError(error.status===401?'unauthenticated':error.status===403?'forbidden':'unavailable',error.code,error.fields);throw new IdentityError('unavailable','identity_provider_unavailable');}},
 async owner(assertion,configuration){
  let stage:SetupStage='jwt_header';
  try{return await verifyOwner(assertion,configuration,value=>{stage=value;});}
  catch{const unavailable=['jwks_fetch','jwks_body','key_import'].includes(stage);throw new IdentityError(unavailable?'unavailable':'forbidden',unavailable?'identity_provider_unavailable':'owner_initial_rejected');}
 }
};
