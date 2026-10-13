// @module workbench
// @role contracts

export interface SourceView{record:Record<string,unknown>;history:{sourceTable:string;sourceId:string;actorName:string|null;record:Record<string,unknown>}[];page:number;historyTotal:number}

export interface Directory{projects:{id:string;workspaceId:string;key:string;slug:string;name:string;description:string}[];workspaces:{id:string;scopeId:string;name:string}[];definitions:{sourceTable:string;scopeId:string;record:Record<string,unknown>}[]}
