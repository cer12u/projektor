// @module administration
// @role model
import type {Permission} from "../../modules/identity/dto";
export const managementPermissions: readonly Permission[] = ['view', 'edit', 'assign', 'transition', 'execute', 'manage'];
export const managementIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
export const managementScopeIdPattern = /^(?:[A-Za-z0-9_-]{1,128}|workspace:[a-fA-F0-9-]{36})$/;
export function scopeIdentifier(value:unknown):value is string{return typeof value==='string'&&managementScopeIdPattern.test(value);}
export function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_management_response');return value as Record<string,unknown>;}
export function identifier(value:unknown):value is string{return typeof value==='string'&&managementIdPattern.test(value);}
export function integer(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
export function permissions(value:unknown):value is Permission[]{return Array.isArray(value)&&value.every(v=>managementPermissions.includes(v as Permission))&&new Set(value).size===value.length;}
