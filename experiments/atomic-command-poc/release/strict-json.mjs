// Reject duplicate configuration keys instead of accepting the last value.
const own=(value,name)=>Object.prototype.hasOwnProperty.call(value,name);
export function strictJson(source) {
 let index = 0;
 const whitespace = () => { while (/[\x20\t\r\n]/.test(source[index] || '\0')) index++; };
 function value(depth) {
  if (depth > 16) throw Error('JSON nesting limit');
  whitespace();
  const first = source[index];
  if (first === '"') {
   const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(source.slice(index));
   if (!match) throw Error('Invalid JSON string');
   index += match[0].length;
   return JSON.parse(match[0]);
  }
  if (first === '{' || first === '[') {
   const object = first === '{';
   const result = object ? {} : [];
   const end = object ? '}' : ']';
   index++; whitespace();
   if (source[index] === end) { index++; return result; }
   while (true) {
    let key;
    if (object) {
     whitespace();
     if (source[index] !== '"') throw Error('Invalid JSON member');
     key = value(depth + 1); whitespace();
     if (own(result, key) || source[index++] !== ':') throw Error('Duplicate or invalid JSON member');
    }
    const item = value(depth + 1);
    if (object) Object.defineProperty(result,key,{value:item,enumerable:true,writable:true,configurable:true}); else result.push(item);
    whitespace();
    const next = source[index++];
    if (next === end) return result;
    if (next !== ',') throw Error('Invalid JSON separator');
   }
  }
  const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(index));
  if (!match) throw Error('Invalid JSON value');
  index += match[0].length;
  return JSON.parse(match[0]);
 }
 const result = value(0); whitespace();
 if (index !== source.length) throw Error('Trailing JSON data');
 return result;
}
