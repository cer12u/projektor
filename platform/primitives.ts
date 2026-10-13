import type { Clock, IdGenerator } from "./public";
export const systemClock: Clock = Object.freeze({ now: () => Math.floor(Date.now() / 1000) });
export const randomIds: IdGenerator = Object.freeze({ next: () => crypto.randomUUID() });
