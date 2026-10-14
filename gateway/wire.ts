import { catalog, restOnly, toolCatalog } from "./catalog";

/** Wire descriptions generated from the same dispatch table used by REST and MCP. */
export function tools() {
  return toolCatalog();
}
export function openApi() {
  const paths: Record<string, unknown> = {};
  const workspaceParameter = {
    name: "workspaceId",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
  for (const [name, entry] of Object.entries(catalog)) {
    if (name === "access.workspaces") continue;
    const [owner, action] = name.split(".");
    const fields = Object.entries(entry.fields);
    const properties = Object.fromEntries(
      fields.map(([field, kind]) => [
        field,
        {
          type:
            kind === "stringArray"
              ? "array"
              : kind === "optionalBoolean"
                ? "boolean"
                : kind.includes("Number") || kind === "number"
                  ? "integer"
                  : "string",
          ...(kind === "stringArray" ? { items: { type: "string" } } : {}),
        },
      ]),
    );
    const required = fields
      .filter(([, kind]) => !kind.startsWith("optional") && kind !== "nullableString")
      .map(([field]) => field);
    const parameters = entry.write
      ? [workspaceParameter]
      : [
          workspaceParameter,
          ...fields.map(([field]) => ({
            name: field,
            in: "query",
            required: required.includes(field),
            schema: properties[field],
          })),
        ];
    const requestBody = entry.write
      ? {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties, required, additionalProperties: false },
            },
          },
        }
      : undefined;
    paths[`/api/w/{workspaceId}/${owner}/${action}`] = {
      [entry.write ? "post" : "get"]: {
        operationId: name,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses: {
          "200": { description: "Success" },
          "400": { description: "Validation error" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
          "409": { description: "Conflict" },
        },
      },
    };
  }
  for (const name of ["access.create", ...restOnly]) {
    paths[`/api/w/{workspaceId}/${name.replaceAll(".", "/")}`] = {
      post: {
        operationId: name,
        parameters: [workspaceParameter],
        responses: { "200": { description: "Success" } },
      },
    };
  }
  paths["/api/w/{workspaceId}/access/workspaces"] = {
    get: {
      operationId: "access.workspaces",
      parameters: [workspaceParameter],
      responses: { "200": { description: "Success" } },
    },
  };
  return { openapi: "3.1.0", info: { title: "Projektor Gateway", version: "0.1.0" }, paths };
}
