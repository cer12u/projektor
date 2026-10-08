// Pure view-only CRLF-preserving input projection, copied from reviewed I2.
export function preserveMarkdownInput(raw:string, displayed:string) {
  const normalized=raw.replace(/\r\n?/g,'\n');
  if(normalized===displayed)return raw;
  let prefix=0,suffix=0;
  while(prefix<normalized.length&&prefix<displayed.length&&normalized[prefix]===displayed[prefix])prefix++;
  while(suffix<normalized.length-prefix&&suffix<displayed.length-prefix&&normalized[normalized.length-1-suffix]===displayed[displayed.length-1-suffix])suffix++;
  const offset=(target:number)=>{let input=0,output=0;while(output<target){if(raw[input]==='\r'&&raw[input+1]==='\n')input++;input++;output++;}return input;};
  const ending=raw.match(/\r\n|\r|\n/)?.[0]??'\n';
  const inserted=displayed.slice(prefix,displayed.length-suffix).replace(/\n/g,ending);
  return raw.slice(0,offset(prefix))+inserted+raw.slice(offset(normalized.length-suffix));
}
