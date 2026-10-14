import { ja } from "./strings";
/** Browser transport. The route/method catalog comes from Gateway's public OpenAPI. */
export class WireError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
type Operation = { method: "GET" | "POST"; path: string };
type ApiSpec = {
  paths: Record<string, { get?: { operationId: string }; post?: { operationId: string } }>;
};
export class WireClient {
  private operations?: Map<string, Operation>;
  constructor(private readonly send: typeof fetch = (input, init) => fetch(input, init)) {}
  private async catalog() {
    if (this.operations) return this.operations;
    const response = await this.send("/api/openapi.json", { credentials: "same-origin" });
    if (!response.ok) throw new WireError("network", ja.ui.apiUnavailable);
    const spec = (await response.json()) as ApiSpec;
    const operations = new Map<string, Operation>();
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of ["get", "post"] as const) {
        const entry = methods[method];
        if (entry)
          operations.set(entry.operationId, {
            method: method.toUpperCase() as "GET" | "POST",
            path,
          });
      }
    }
    this.operations = operations;
    return operations;
  }
  async call<T>(
    workspaceId: string | undefined,
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const entry = (await this.catalog()).get(name);
    if (!entry) throw new WireError("unsupported", `${name} ${ja.ui.notPublished}`);
    const url = new URL(
      entry.path.replace("{workspaceId}", encodeURIComponent(workspaceId ?? "")),
      location.origin,
    );
    if (entry.method === "GET")
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== null && value !== "")
          url.searchParams.set(key, String(value));
      }
    let response: Response;
    try {
      response = await this.send(url.pathname + url.search, {
        method: entry.method,
        credentials: "same-origin",
        signal,
        ...(entry.method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(args) }
          : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new WireError("network", ja.ui.networkUnknown);
    }
    const data = (await response.json()) as T & { code?: string; message?: string };
    if (!response.ok)
      throw new WireError(data.code ?? "network", data.message ?? `HTTP ${response.status}`);
    return data;
  }
  async uploadBinary(workspaceId: string, assetId: string, body: ArrayBuffer): Promise<void> {
    const url = `/api/w/${encodeURIComponent(workspaceId)}/assets/upload/${encodeURIComponent(assetId)}`;
    let response: Response;
    try {
      response = await this.send(url, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
    } catch {
      throw new WireError("network", ja.ui.networkUnknown);
    }
    if (!response.ok) {
      const data = (await response.json()) as { code?: string; message?: string };
      throw new WireError(data.code ?? "network", data.message ?? `HTTP ${response.status}`);
    }
  }
  downloadUrl(workspaceId: string, assetId: string): string {
    return `/api/w/${encodeURIComponent(workspaceId)}/assets/download/${encodeURIComponent(assetId)}`;
  }
}
