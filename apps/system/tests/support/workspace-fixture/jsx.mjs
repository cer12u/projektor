// @module verification
// @role tooling-test-presentation
// These presenters contain no hooks. Execute them while keeping stateful child boundaries explicit.
export const Fragment=Symbol('Fragment');
export function jsx(type,props,key){if(typeof type==='function'&&(type.name.endsWith('View')||type.name==='LoginForm'))return type(props);return{type,props,key};}
export const jsxs=jsx;
