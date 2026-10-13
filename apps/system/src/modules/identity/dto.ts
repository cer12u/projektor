// @module identity
// @role public-contract
export type Permission = 'view' | 'edit' | 'assign' | 'transition' | 'execute' | 'manage';
export interface Identity {
  principal: { id: string; kind: 'human' | 'agent'; displayName: string };
  authentication: 'session' | 'api' | 'federated';
  projects: { id: string; permissions: Permission[] }[];
  csrfToken?: string;
}
