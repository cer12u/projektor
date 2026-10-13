// @module delivery
// @role http-adapter
import type {RequestServices} from "../contracts";
import { ApiError } from "../../adapters/protocol-errors";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function projectAccessApi(request:Request,requests:RequestServices):Promise<Response|null>{
 const path=new URL(request.url).pathname;
      const projectMatch=path.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,128})\/access$/);
      if(projectMatch&&request.method==='GET') {
        const current=await (await requests.authenticate(request)).identity.current(), project=current.projects.find(p=>p.id===projectMatch[1]);
        if(!project?.permissions.includes('view')) throw new ApiError(403,'forbidden');
        return json({principal:current.principal,project});
      }
 return null;
}
