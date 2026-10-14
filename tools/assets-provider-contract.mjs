import assert from "node:assert/strict";

// The exact authorization subset consumed by Assets, shared by fakes and providers.
export async function assetsProviderContract({
  access,
  projects,
  issues,
  wiki,
  editor,
  viewer,
  projectId,
  issueId,
  pageId,
}) {
  const denied = (code) => (e) => e.code === code;
  await access.authorize(editor, "write");
  await assert.rejects(access.authorize({ ...editor }), denied("forbidden"));
  for (const [provider, method, id] of [
    [projects, "authorizeProject", projectId],
    [issues, "authorizeIssue", issueId],
    [wiki, "authorizePage", pageId],
  ]) {
    assert.equal((await provider[method](editor, id, "write")).id, id);
    assert.equal((await provider[method](viewer, id, "read")).id, id);
    await assert.rejects(provider[method](viewer, id, "write"), denied("forbidden"));
    await assert.rejects(provider[method]({ ...editor }, id), denied("forbidden"));
    await assert.rejects(provider[method](editor, "contract-absent"), denied("not_found"));
  }
  assert.equal((await issues.authorizeIssue(editor, issueId)).projectId, projectId);
  assert.equal((await wiki.authorizePage(editor, pageId)).projectId, projectId);
}
