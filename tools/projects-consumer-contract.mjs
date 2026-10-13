import assert from "node:assert/strict";

/** Same public expectations for the provider and Issues' Projects fake. */
export async function projectsConsumerContract({
  api,
  editor,
  viewer,
  projectId,
  assigneeId,
  missingPrincipalId,
}) {
  const denied = (name) => (error) => error.code === name;
  const project = await api.authorizeProject(editor, projectId, "write");
  assert.equal(project.id, projectId);
  assert.equal((await api.getProject(editor, projectId)).key, project.key);
  assert.equal((await api.authorizeProject(viewer, projectId, "read")).id, projectId);
  await assert.rejects(api.authorizeProject(viewer, projectId, "write"), denied("forbidden"));
  await assert.rejects(api.authorizeProject({ ...editor }, projectId), denied("forbidden"));
  await assert.rejects(api.authorizeProject(editor, "contract-absent"), denied("not_found"));
  await api.authorizeProjectPrincipal(editor, projectId, assigneeId);
  await assert.rejects(
    api.authorizeProjectPrincipal(editor, projectId, missingPrincipalId),
    denied("not_found"),
  );
}
