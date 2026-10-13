// @module tooling.schema
// @role sql-tokens
// Remove only lexically insignificant spacing/comments. Quoted text is kept byte-for-byte.
// Conservative false mismatches are preferable to treating changed CHECK/trigger literals as equal.
export function sqlTokens(sql) {
 if (sql === null) return null;
 const tokens = []; let i = 0;
 while (i < sql.length) {
  if (/\s/.test(sql[i])) { i++; continue; }
  if (sql.startsWith('--', i)) { i = sql.indexOf('\n', i); if (i === -1) break; continue; }
  if (sql.startsWith('/*', i)) { const end=sql.indexOf('*/', i + 2); if(end === -1) throw new Error('Unterminated SQL comment'); i=end + 2; continue; }
  const start=i, q=sql[i];
  if (q === "'" || q === '"' || q === '`' || q === '[') {
   const end=q === '[' ? ']' : q; i++;
   let closed=false;
   while(i < sql.length) { if(sql[i++] === end) { if(sql[i] === end && q !== '[') { i++; continue; } closed=true; break; } }
   if(!closed) throw new Error('Unterminated quoted SQL');
  } else if (/[A-Za-z0-9_$]/.test(q)) { while(i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++; }
  else i++;
  tokens.push(sql.slice(start,i));
 }
 return tokens;
}

