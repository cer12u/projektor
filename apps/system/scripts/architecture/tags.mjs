// @module tooling.architecture
// @role tags
import ts from 'typescript';
export function moduleTags(text, style, marker = 'module') {
  const patterns = {
    slash: /^\s*\/\/\s*@module\s+([^\s]+)\s*$/gm,
    css: /^\s*\/\*\s*@module\s+([^\s]+)\s*\*\/\s*$/gm,
    html: /^\s*<!--\s*@module\s+([^\s]+)\s*-->\s*$/gm,
    hash: /^\s*#\s*@module\s+([^\s]+)\s*$/gm,
    sql: /^\s*--\s*@module\s+([^\s]+)\s*$/gm,
  };
  if(marker !== 'module') for(const name of Object.keys(patterns)) patterns[name]=new RegExp(patterns[name].source.replaceAll('@module','@'+marker),patterns[name].flags);
  if (style === 'slash') {
    // Collect parser-recognized comments, so a template/string cannot spoof a tag.
    const tree=ts.createSourceFile('tag-source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const comments=new Map();
    const collect=(ranges=[])=>{for(const range of ranges) comments.set(range.pos,text.slice(range.pos,range.end));};
    function visit(node){collect(ts.getLeadingCommentRanges(text,node.pos));collect(ts.getTrailingCommentRanges(text,node.end));ts.forEachChild(node,visit);}
    collect(ts.getLeadingCommentRanges(text,0));visit(tree);
    return [...comments.values()].flatMap(comment=>[...comment.matchAll(patterns.slash)].map(match=>match[1]));
  }
  return style ? [...text.matchAll(patterns[style])].map(match => match[1]) : [];
}
