/** Fully synthetic component/page snapshots. No fixture authorizes a write. */
const item=(id:string,status:string,priority:number|null)=>({id,title:'日本語 source <script>never execute</script>',priority,status_category:status,assignee_kind:'human'});
export const pageFixtures={
  loading:{phase:'loading',busy:true,locked:false,items:[],total:null},
  empty:{phase:'empty',busy:false,locked:false,items:[],total:0},
  partial:{phase:'partial',busy:false,locked:false,items:[item('one','ready',0)],total:3,nextCursor:'opaque'},
  partialError:{phase:'partial',busy:false,locked:false,code:'SERVER_UNAVAILABLE',items:[item('one','ready',0)],total:3},
  error:{phase:'error',busy:false,locked:false,code:'NETWORK_ERROR',items:[],total:null},
  forbidden:{phase:'locked',busy:false,locked:true,code:'FORBIDDEN',items:[],total:null},
  expired:{phase:'locked',busy:false,locked:true,code:'AUTH_REQUIRED',items:[],total:null},
  stale:{phase:'stale',busy:false,locked:false,code:'REFRESH_REQUIRED',items:[],total:null},
  ready:{phase:'ready',busy:false,locked:false,items:[item('one','ready',0),item('two','blocked',null),item('three','done',4)],total:3},
};
