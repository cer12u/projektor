// @module tooling.architecture
// @role syntax
// Stable syntax-inspection facade, with no embedded implementation.
export {scriptExtensions,tagStyle} from './file-types.mjs';
export {moduleTags} from './tags.mjs';
export {parseImports} from './imports.mjs';
export {classifySpecifier,resolveImport} from './resolution.mjs';
