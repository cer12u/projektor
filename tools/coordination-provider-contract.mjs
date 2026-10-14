import assert from "node:assert/strict";

// Only public authorization results consumed by Coordination. Run against both
// the isolated fake and the real Access/Projects/Issues composition.
export async function coordinationProviderContract({
  access,
  projects,
  issues,
  editor,
  viewer,
  manager,
  issueId,
  projectId,
}) {
  const denied = (code) => (error) => error.code === code;
  await access.authorize(editor, "write");
  await assert.rejects(access.authorize({ ...editor }, "read"), denied("forbidden"));
  assert.equal((await projects.authorizeProject(manager, projectId, "manage")).id, projectId);
  await assert.rejects(projects.authorizeProject(editor, projectId, "manage"), denied("forbidden"));
  for (const [scope, permission] of [
    [editor, "write"],
    [viewer, "read"],
  ]) {
    const issue = await issues.authorizeIssue(scope, issueId, permission);
    assert.equal(issue.id, issueId);
    assert.equal(issue.projectId, projectId);
  }
  await assert.rejects(issues.authorizeIssue(viewer, issueId, "write"), denied("forbidden"));
  await assert.rejects(issues.authorizeIssue({ ...editor }, issueId), denied("forbidden"));
  await assert.rejects(issues.authorizeIssue(editor, "contract-absent"), denied("not_found"));
}
