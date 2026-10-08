// A separate private service used only by test code via getWorker().fetch.
export default {async fetch(request,env){const {workspace,action,args}=await request.json();const stub=env.WORKSPACE.getByName(workspace);return Response.json(await stub[action](...args));}};
