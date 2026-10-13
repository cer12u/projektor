// @module delivery
// @role security
import { constantEqual } from "../../adapters/crypto/passwords";
import { ApiError } from "../../adapters/protocol-errors";
export const SESSION_COOKIE = '__Host-projektor_session';
export const LOGIN_COOKIE = '__Host-projektor_login';
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export function readCookie(request: Request, name: string): string | null {
  const values = (request.headers.get('Cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  if (values.length > 1) throw new ApiError(401,'unauthenticated');
  if (!values.length) return null;
  const token = values[0].slice(name.length+1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export function requireOrigin(request: Request, origin: string): void {
  if (new URL(request.url).origin !== origin || request.headers.get('Origin') !== origin) throw new ApiError(403,'csrf_rejected');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') throw new ApiError(403,'csrf_rejected');
}
export function requireCsrf(request: Request, auth: {csrf_token:string|null}): void {
  const token = request.headers.get('X-CSRF-Token');
  if (!token || !auth.csrf_token || !constantEqual(token,auth.csrf_token)) throw new ApiError(403,'csrf_rejected');
}

export const OWNER_BROWSER_COOKIE='__Host-projektor_owner_setup';
