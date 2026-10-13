// @module platform.d1
// @role transaction-contract
export type AuthDB = Pick<D1Database, 'prepare' | 'batch'>;
export type SqlValue = string | number | null;
/** SQL text is trusted adapter code. Every request value belongs in values. */
export interface Sql { readonly text: string; readonly values: readonly SqlValue[] }
export const sql = (text: string, ...values: SqlValue[]): Sql => ({ text, values });
