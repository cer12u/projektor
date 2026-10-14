import assert from "node:assert/strict";
import { assetsProviderContract } from "./assets-provider-contract.mjs";

// Integrations consumes the same authorization ports plus Issues idempotent creation.
export async function integrationsProviderContract(providers) {
  await assetsProviderContract(providers);
  const { issues, editor, viewer, projectId } = providers;
  const input = {
    operationId: "integrations-provider-created",
    issueId: "integrations-provider-created",
    projectId,
    title: "Feedback contract",
    description: "Body",
    priority: "medium",
  };
  const created = await issues.createIssue(editor, input);
  assert.deepEqual(await issues.createIssue(editor, input), created);
  await assert.rejects(
    issues.createIssue(editor, { ...input, title: "Changed" }),
    (e) => e.code === "conflict",
  );
  await assert.rejects(
    issues.createIssue(viewer, {
      ...input,
      operationId: "viewer-created",
      issueId: "viewer-created",
    }),
    (e) => e.code === "forbidden",
  );
}
