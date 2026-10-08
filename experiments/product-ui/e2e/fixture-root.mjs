// TEST ONLY. The unchanged I2 harness omits Miniflare.modulesRoot, so its module
// names are relative to process.cwd(). Match the proven core test invocation.
// Call once after the UI fixture build, keep it through all fixture lifetimes,
// then restore after suite cleanup. This creates no new execution environment.
export function enterFixtureRoot(coreRoot){
  const previous=process.cwd();process.chdir(coreRoot);let restored=false;
  return ()=>{if(!restored){process.chdir(previous);restored=true;}};
}
