// @module delivery
// @role protocol-input
import {ISSUE_STATES} from "../../modules/work/planning-contracts";
import {ApiError} from "../../adapters/protocol-errors";
import type {IssueListQuery} from "../../modules/work/public";
export function listQuery(params:URLSearchParams):IssueListQuery {
 const allowed=['q','state','mine','page','pageSize','order'];for(const[key]of params)if(!allowed.includes(key)||params.getAll(key).length!==1)throw new ApiError(400,'invalid_input');
 const q=params.get('q')??'',state=params.get('state')??'',mine=params.get('mine')??'1',page=params.get('page')??'1',size=params.get('pageSize')??'20',order=params.get('order')??'priority';
 if([...q].length>128||(state&&!ISSUE_STATES.some(s=>s===state))||!['0','1'].includes(mine)||!/^[1-9][0-9]{0,5}$/.test(page)||!/^[1-9][0-9]?$/.test(size)||Number(size)>50||order!=='priority')throw new ApiError(400,'invalid_input');
 return {q,state,mine:mine==='1',page:Number(page),pageSize:Number(size),order};
}
export function contentPage(query:URLSearchParams){for(const [k]of query)if(!['page','pageSize'].includes(k)||query.getAll(k).length!==1)throw new ApiError(400,'invalid_input',{query:'unknown or repeated query'});const page=Number(query.get('page')??1),pageSize=Number(query.get('pageSize')??20);if(!/^[1-9][0-9]{0,5}$/.test(query.get('page')??'1')||!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw new ApiError(400,'invalid_input',{query:'page >=1, pageSize 1–50'});return{page,pageSize};}
