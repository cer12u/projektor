import assert from "node:assert/strict";

// The live target-read contract used by Insights. Run for its isolated fake and
// real Access/Projects/Issues providers; no storage or private provider imports.
export async function insightsProviderContract({
  access,
  projects,
  issues,
  scope,
  projectId,
  issueId,
  archiveIssue,
}) {
  await access.authorize(scope, "read");
  await assert.rejects(access.authorize({ ...scope }, "read"), (e) => e.code === "forbidden");
  assert.equal((await projects.getProject(scope, projectId)).id, projectId);
  assert.equal((await issues.authorizeIssue(scope, issueId)).projectId, projectId);
  assert(
    (await issues.listIssues(scope, { projectId, limit: 100 })).issues.some(
      (i) => i.id === issueId,
    ),
  );
  await issues.getHistory(scope, issueId);
  await assert.rejects(issues.authorizeIssue(scope, "repo/path"), (e) => e.code === "validation");
  await assert.rejects(
    issues.authorizeIssue(scope, "missing-issue"),
    (e) => e.code === "not_found",
  );
  await archiveIssue();
  await assert.rejects(issues.authorizeIssue(scope, issueId), (e) => e.code === "not_found");
  await assert.rejects(issues.getHistory(scope, issueId), (e) => e.code === "not_found");
  assert(
    !(await issues.listIssues(scope, { projectId, limit: 100 })).issues.some(
      (i) => i.id === issueId,
    ),
  );
}
