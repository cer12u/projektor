// @module platform.outcomes
// @role public-contract
export class ApiError extends Error {
  constructor(public status: number, public code: string, public fields?: Record<string, string>) { super(code); }
}
