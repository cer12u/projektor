/** Monotonic request generation; returning to an old binding never revives it. */
export function advanceWikiGeneration(state,identity){
 if(!state||state.identity!==identity)return {identity,generation:(state?.generation??0)+1};
 return state;
}
