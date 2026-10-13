// @module verification
// @role browser-fixture
// Expand only the extracted hook-free presenter; keep stateful boundaries explicit.
export const Fragment=Symbol('Fragment');export function jsx(type,props,key){if(typeof type==='function'&&type.name==='ManagementSetupView')return type(props);return{type,props,key};}export const jsxs=jsx;
