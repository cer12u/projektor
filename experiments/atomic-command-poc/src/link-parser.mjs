export const PARSER_VERSION='projektor-links-v1';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
function scanContentLinks(markdown){
 // Code fences and inline code are intentionally not link syntax. Raw source is never changed.
 const masked=markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm,m=>' '.repeat(m.length)).replace(/`+[^`\n]*`+/g,m=>' '.repeat(m.length));
 const rx=new RegExp(`projektor:(wiki|issue)\/(${uuid})|\\[\\[([^\\]\\n]+)\\]\\]|\\[[^\\]\\n]*\\]\\((https?:\\/\\/[^\\s)]+)\\)`,'g');
 const found=[];for(const m of masked.matchAll(rx))found.push({ordinal:found.length,rawTarget:m[1]?`projektor:${m[1]}/${m[2]}`:m[3]??m[4],kind:m[1]?'stable_id':m[3]?'title':'external',offset:m.index,end:m.index+m[0].length});return found;
}
export const parseContentLinkSpans=scanContentLinks;
export const parseContentLinks=markdown=>scanContentLinks(markdown).map(({end,...item})=>item);
