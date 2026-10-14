import { ja } from "./strings";
import { type WireClient, WireError } from "./wire";
export type Pending = { name: string; args: Record<string, unknown>; workspace: string };
/** A pending request remains byte-for-byte stable until acknowledged. */
export class OperationState {
  pending: Pending | null = null;
  status: "idle" | "pending" | "unknown" | "error" = "idle";
  error = "";
  constructor(
    private readonly wire: WireClient,
    private readonly changed: () => void,
  ) {}
  async run<T>(workspace: string, name: string, args: Record<string, unknown>): Promise<T | null> {
    if (!this.pending)
      this.pending = { workspace, name, args: { ...args, operationId: crypto.randomUUID() } };
    if (this.pending.workspace !== workspace || this.pending.name !== name) return null;
    this.status = "pending";
    this.error = "";
    this.changed();
    try {
      const value = await this.wire.call<T>(workspace, name, this.pending.args);
      this.pending = null;
      this.status = "idle";
      this.changed();
      return value;
    } catch (cause) {
      const error =
        cause instanceof WireError ? cause : new WireError("network", ja.ui.networkUnknownShort);
      this.status = error.code === "network" || error.code === "unknown" ? "unknown" : "error";
      this.error = error.message;
      if (this.status === "error") this.pending = null;
      this.changed();
      return null;
    }
  }
  async retry<T>(): Promise<T | null> {
    const pending = this.pending;
    return pending ? this.run<T>(pending.workspace, pending.name, pending.args) : null;
  }
  reset() {
    this.pending = null;
    this.status = "idle";
    this.error = "";
    this.changed();
  }
}
