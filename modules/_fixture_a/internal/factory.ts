import type { ModuleStore } from "../../../platform/public";
import type { queries } from "../storage/queries";

/** Test-only repository: proves same-owner CAS + receipt atomicity. */
export function createFixture(store: ModuleStore<keyof typeof queries>) {
  return {
    seed: (workspace: string, id: string, value: string) =>
      store.run("insert", [workspace, id, value]),
    read: (workspace: string, id: string) => store.run("read", [workspace, id]),
    receipt: (workspace: string, operation: string) =>
      store.run("readReceipt", [workspace, operation]),
    edit: (workspace: string, id: string, version: number, value: string, operation: string) =>
      store.batch([
        { name: "update", values: [value, workspace, id, version] },
        { name: "guard", values: [workspace, operation] },
        { name: "receipt", values: [workspace, operation, value] },
        { name: "clearGuard", values: [workspace, operation] },
      ]),
  };
}
