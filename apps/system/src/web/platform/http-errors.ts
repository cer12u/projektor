// @module platform.browser
// @role contracts
export class HttpError extends Error {
  constructor(public status:number,public code:string,public fields?:Record<string,string>,public current?:unknown,public mutationOutcome?:unknown,outcome?:{operationId?:string;application?:'unknown'}){super(code);this.operationId=outcome?.operationId;this.application=outcome?.application;}
  readonly operationId?:string;
  readonly application?:'unknown';
}
