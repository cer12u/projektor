import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { safeMarkdown } from "./markdown";
import { OperationState } from "./state";
import { ja } from "./strings";
import { WireClient } from "./wire";

type Project = { id: string; key: string; name: string; version: number; role: string };
type Issue = {
  id: string;
  projectId: string;
  reference: string;
  title: string;
  description: string;
  state: keyof typeof ja.state;
  priority: keyof typeof ja.priority;
  assigneeId: string | null;
  version: number;
};
type Page = {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  version: number;
};
type Session = {
  id: string;
  agentLabel: string;
  clientKind: string;
  repo: string | null;
  live: boolean;
  expiresAt: number;
};
type Lease = {
  issueId: string;
  sessionId: string | null;
  holderPrincipalId: string;
  agentLabel: string;
  clientKind: string;
  fencingToken: number;
  expiresAt: number;
};
type History = {
  version: number;
  action: string;
  actorId: string;
  actorKind: "human" | "machine";
  clientId: string | null;
  occurredAt: number;
  detail: string;
};
type Revision = {
  version: number;
  title: string;
  body: string;
  actorId: string;
  actorKind: "human" | "machine";
  clientId: string | null;
  occurredAt: number;
};
type Progress = {
  issueId: string;
  sessionId: string;
  text: string;
  status: string;
  reportedAt: number;
};
type Claim = { repo: string; path: string; sessionId: string; expiresAt: number };
type Workspace = { id: string; name: string; role: string; version: number };
type Principal = {
  id: string;
  kind: "human" | "machine" | "oauth";
  displayName: string;
  clientName?: string;
};
type Me = { principal: Principal; workspaces: Workspace[]; nextCursor: string | null };
type View = "projects" | "issues" | "wiki" | "activity" | "admin";
const wire = new WireClient();
const date = (value: number) => new Date(value * 1000).toLocaleString("ja-JP");
const identity = (actor: {
  actorKind: "human" | "machine";
  actorId: string;
  clientId: string | null;
}) =>
  `${ja.actor[actor.actorKind]} ${actor.actorId}${actor.clientId ? ` · ${actor.clientId} ${ja.ui.via}` : ""}`;
function useAction(workspace: string) {
  const [, refresh] = useState(0);
  const state = useMemo(() => new OperationState(wire, () => refresh((x) => x + 1)), []);
  useEffect(() => state.reset(), [workspace, state]);
  return state;
}
function Status({ op, onRetry }: { op: OperationState; onRetry?: () => void }) {
  if (op.status === "idle") return null;
  return (
    <div class={`notice ${op.status === "error" ? "error" : ""}`} role="status">
      {op.status === "pending" ? ja.pending : op.status === "unknown" ? ja.unknown : op.error}
      {op.status === "unknown" && (
        <button type="button" class="secondary" onClick={onRetry}>
          {ja.retry}
        </button>
      )}
    </div>
  );
}
function useQuery<T>(workspace: string, name: string, args: Record<string, unknown>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setData(null);
    setError("");
    if (
      (!workspace && name !== "access.me") ||
      ((name.startsWith("coordination.") || name === "access.wipCap") && !args.projectId)
    )
      return;
    const controller = new AbortController();
    wire
      .call<T>(workspace, name, args, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [workspace, name, key, reload]);
  return { data, error, refresh: () => setReload((x) => x + 1) };
}
function useMe(enabled: boolean) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setPrincipal(null);
    setWorkspaces([]);
    setNextCursor(null);
    setCursor(null);
    setError("");
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    wire
      .call<Me>(
        undefined,
        "access.me",
        { limit: 100, cursor: cursor ?? undefined },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        setPrincipal(result.principal);
        setWorkspaces((current) =>
          cursor ? [...current, ...result.workspaces] : result.workspaces,
        );
        setNextCursor(result.nextCursor);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, cursor]);
  return {
    principal,
    workspaces,
    nextCursor,
    error,
    loading,
    loadMore: () => setCursor(nextCursor),
  };
}
function usePaged<T>(workspace: string, name: string, scope: Record<string, unknown>) {
  const scopeKey = JSON.stringify(scope);
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | number | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setNextCursor(null);
    setError("");
  }, [workspace, name, scopeKey]);
  useEffect(() => {
    setError("");
    if (!workspace || ("projectId" in scope && !scope.projectId)) return;
    const controller = new AbortController();
    wire
      .call<{ items: T[]; nextCursor: string | number | null }>(
        workspace,
        name,
        { ...scope, cursor: cursor ?? undefined, limit: 50 },
        controller.signal,
      )
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems((current) => (cursor === null ? page.items : [...current, ...page.items]));
        setNextCursor(page.nextCursor);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [workspace, name, scopeKey, cursor, reload]);
  return {
    items,
    error,
    hasMore: nextCursor !== null,
    loadMore: () => setCursor(nextCursor),
    refresh: () => {
      setCursor(null);
      setReload((value) => value + 1);
    },
  };
}
function WorkspacePicker({
  me,
  error,
  loading,
  hasMore,
  onSelect,
  onMore,
}: {
  me: Omit<Me, "nextCursor"> | null;
  error: string;
  loading: boolean;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onMore: () => void;
}) {
  return (
    <section class="panel">
      <h2>{ja.ui.selectWorkspace}</h2>
      <p class="muted">
        {me ? `${me.principal.displayName} · ${ja.actor[me.principal.kind]}` : ja.ui.workspaceHint}
      </p>
      {error && <p role="alert">{error}</p>}
      {!me && !error && <p role="status">{ja.pending}</p>}
      {me && me.workspaces.length === 0 && <p>{ja.ui.noWorkspaces}</p>}
      <ul class="list">
        {me?.workspaces.map((workspace) => (
          <li key={workspace.id}>
            <div class="item">
              <button type="button" class="secondary" onClick={() => onSelect(workspace.id)}>
                <strong>{workspace.name}</strong>
              </button>
              <span class="badge">
                {ja.roles[workspace.role as keyof typeof ja.roles] ?? workspace.role}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" class="secondary" onClick={onMore} disabled={loading}>
          {loading ? ja.pending : ja.ui.loadMore}
        </button>
      )}
    </section>
  );
}
function Projects({
  workspace,
  project,
  onProject,
}: {
  workspace: string;
  project: Project | null;
  onProject: (p: Project) => void;
}) {
  const query = useQuery<{ projects: Project[] }>(workspace, "projects.list", {}, workspace);
  const op = useAction(workspace);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const submit = async () => {
    const id = crypto.randomUUID();
    const result = await op.run(workspace, "projects.create", { projectId: id, key, name });
    if (result) {
      setKey("");
      setName("");
      query.refresh();
    }
  };
  return (
    <>
      <section class="panel">
        <h2>{ja.project}</h2>
        {query.error && <p role="alert">{query.error}</p>}
        <ul class="list">
          {query.data?.projects.map((p) => (
            <li key={p.id}>
              <div class="item">
                <button
                  type="button"
                  class="secondary"
                  onClick={() => onProject(p)}
                  aria-current={project?.id === p.id ? "page" : undefined}
                >
                  <strong>
                    {p.key} · {p.name}
                  </strong>
                </button>
                <span class="badge">{ja.roles[p.role as keyof typeof ja.roles] ?? p.role}</span>
              </div>
            </li>
          ))}
        </ul>
        {query.data?.projects.length === 0 && <p class="muted">{ja.ui.noProjects}</p>}
      </section>
      <section class="panel">
        <h3>{ja.ui.createProject}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div class="row">
            <label>
              {ja.ui.key}
              <input required value={key} onInput={(event) => setKey(event.currentTarget.value)} />
            </label>
            <label>
              {ja.ui.name}
              <input
                required
                value={name}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <button
              type="submit"
              class="primary compact"
              disabled={op.status === "pending" || op.status === "unknown"}
            >
              {ja.create}
            </button>
          </div>
        </form>
        <Status
          op={op}
          onRetry={() => {
            void op.retry().then((result) => {
              if (result) {
                setKey("");
                setName("");
                query.refresh();
              }
            });
          }}
        />
      </section>
    </>
  );
}
function Issues({ workspace, project }: { workspace: string; project: Project }) {
  const [state, setState] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [text, setText] = useState("");
  const [selected, setSelected] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [newPriority, setNewPriority] = useState<keyof typeof ja.priority>("medium");
  const args = text.trim()
    ? { projectId: project.id, text: text.trim() }
    : {
        projectId: project.id,
        state: state || undefined,
        priority: priority || undefined,
        assigneeId: assignee || undefined,
      };
  const list = useQuery<{ issues: Issue[] } | Issue[]>(
    workspace,
    text.trim() ? "issues.search" : "issues.list",
    args,
    JSON.stringify(args),
  );
  const op = useAction(workspace);
  const create = async () => {
    const result = await op.run(workspace, "issues.create", {
      issueId: crypto.randomUUID(),
      projectId: project.id,
      title,
      description,
      priority: newPriority,
    });
    if (result) {
      setTitle("");
      setDescription("");
      list.refresh();
    }
  };
  const issues = Array.isArray(list.data) ? list.data : list.data?.issues;
  return (
    <>
      <section class="panel">
        <h2>
          {project.name} {ja.ui.issuesOf}
        </h2>
        <div class="row">
          <label>
            {ja.ui.search}
            <input
              type="search"
              value={text}
              onInput={(event) => setText(event.currentTarget.value)}
              placeholder={ja.ui.searchPlaceholder}
            />
          </label>
          <label>
            {ja.ui.state}
            <select value={state} onChange={(event) => setState(event.currentTarget.value)}>
              <option value="">{ja.ui.all}</option>
              {Object.entries(ja.state).map(([value, label]) => (
                <option value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            {ja.ui.priority}
            <select value={priority} onChange={(event) => setPriority(event.currentTarget.value)}>
              <option value="">{ja.ui.all}</option>
              {Object.entries(ja.priority).map(([value, label]) => (
                <option value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            {ja.ui.assigneeId}
            <input value={assignee} onInput={(event) => setAssignee(event.currentTarget.value)} />
          </label>
        </div>
        {text && (state || priority || assignee) && <p class="muted">{ja.ui.searchFilterNote}</p>}
        {list.error && <p role="alert">{list.error}</p>}
        <ul class="list">
          {issues?.map((issue) => (
            <li key={issue.id}>
              <button type="button" class="secondary" onClick={() => setSelected(issue.id)}>
                {issue.reference} · {issue.title}
              </button>{" "}
              <span class="badge">{ja.state[issue.state]}</span>
            </li>
          ))}
        </ul>
      </section>
      {selected && (
        <IssueDetail
          key={`${workspace}:${selected}`}
          workspace={workspace}
          id={selected}
          onChange={list.refresh}
        />
      )}
      <section class="panel">
        <h3>{ja.ui.createIssue}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            {ja.ui.title}
            <input
              required
              value={title}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            {ja.ui.description}
            <textarea
              value={description}
              onInput={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <label>
            {ja.ui.priority}
            <select
              value={newPriority}
              onChange={(event) =>
                setNewPriority(event.currentTarget.value as keyof typeof ja.priority)
              }
            >
              {Object.entries(ja.priority).map(([value, label]) => (
                <option value={value}>{label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            class="primary"
            disabled={op.status === "pending" || op.status === "unknown"}
          >
            {ja.create}
          </button>
        </form>
        <Status
          op={op}
          onRetry={() => {
            void op.retry().then((result) => {
              if (result) {
                setTitle("");
                setDescription("");
                list.refresh();
              }
            });
          }}
        />
      </section>
    </>
  );
}
type Attachment = {
  id: string;
  assetId: string;
  filename: string;
  target: { kind: "issue" | "wiki"; id: string };
};
type UploadJob = {
  file: File;
  assetId: string;
  beginId: string;
  completeId: string;
  linkId: string;
  linkOp: string;
  stage: "begin" | "put" | "complete" | "link";
};
function Attachments({
  workspace,
  targetKind,
  targetId,
  projectId,
}: {
  workspace: string;
  targetKind: "issue" | "wiki";
  targetId: string;
  projectId: string;
}) {
  const list = useQuery<{ items: Attachment[]; nextCursor: string | null }>(
    workspace,
    "assets.list",
    { targetKind, targetId },
    `${targetKind}:${targetId}`,
  );
  const [job, setJob] = useState<UploadJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unlink = useAction(workspace);
  async function runUpload(initial: UploadJob) {
    setBusy(true);
    setError("");
    const current = { ...initial };
    try {
      const data = await current.file.arrayBuffer();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (current.stage === "begin") {
        await wire.call(workspace, "assets.begin", {
          operationId: current.beginId,
          assetId: current.assetId,
          projectId,
          size: data.byteLength,
          contentType: current.file.type || "application/octet-stream",
          filename: current.file.name,
          sha256: digest,
        });
        current.stage = "put";
        setJob({ ...current });
      }
      if (current.stage === "put") {
        await wire.uploadBinary(workspace, current.assetId, data);
        current.stage = "complete";
        setJob({ ...current });
      }
      if (current.stage === "complete") {
        await wire.call(workspace, "assets.complete", {
          operationId: current.completeId,
          assetId: current.assetId,
          expectedVersion: 1,
        });
        current.stage = "link";
        setJob({ ...current });
      }
      if (current.stage === "link") {
        await wire.call(workspace, "assets.link", {
          operationId: current.linkOp,
          assetId: current.assetId,
          expectedVersion: 2,
          linkId: current.linkId,
          targetKind,
          targetId,
        });
      }
      setJob(null);
      list.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setJob({ ...current });
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: Attachment) {
    try {
      const meta = await wire.call<{ version: number }>(workspace, "assets.get", {
        assetId: item.assetId,
      });
      const done = await unlink.run(workspace, "assets.unlink", {
        assetId: item.assetId,
        expectedVersion: meta.version,
        linkId: item.id,
      });
      if (done) list.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <section class="attachments">
      <h3>{ja.ui.attachments}</h3>
      {list.error && <p role="alert">{list.error}</p>}
      {list.data?.items.length === 0 && <p>{ja.ui.noAttachments}</p>}
      <ul class="list">
        {list.data?.items.map((item) => (
          <li key={item.id}>
            <a href={wire.downloadUrl(workspace, item.assetId)}>
              {item.filename} · {ja.ui.download}
            </a>{" "}
            <button
              type="button"
              class="secondary compact"
              disabled={busy || unlink.status === "pending" || unlink.status === "unknown"}
              onClick={() => void remove(item)}
            >
              {ja.ui.removeAttachment}
            </button>
          </li>
        ))}
      </ul>
      <label>
        {ja.ui.upload}
        <input
          type="file"
          disabled={busy || !!job}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
              setError(ja.ui.attachmentTooLarge);
              return;
            }
            const next: UploadJob = {
              file,
              assetId: crypto.randomUUID(),
              beginId: crypto.randomUUID(),
              completeId: crypto.randomUUID(),
              linkId: crypto.randomUUID(),
              linkOp: crypto.randomUUID(),
              stage: "begin",
            };
            setJob(next);
            void runUpload(next);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {job && !busy && (
        <button type="button" class="secondary" onClick={() => void runUpload(job)}>
          {ja.retry}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <Status
        op={unlink}
        onRetry={() =>
          void unlink.retry().then((result) => {
            if (result) list.refresh();
          })
        }
      />
    </section>
  );
}
function IssueDetail({
  workspace,
  id,
  onChange,
}: {
  workspace: string;
  id: string;
  onChange: () => void;
}) {
  const issue = useQuery<Issue>(workspace, "issues.get", { issueId: id }, id);
  const history = useQuery<History[]>(workspace, "issues.history", { issueId: id }, id);
  const op = useAction(workspace);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<keyof typeof ja.priority>("medium");
  const [state, setState] = useState<keyof typeof ja.state>("todo");
  const [assignee, setAssignee] = useState("");
  const [comment, setComment] = useState("");
  useEffect(() => {
    if (issue.data) {
      setTitle(issue.data.title);
      setDescription(issue.data.description);
      setPriority(issue.data.priority);
      setState(issue.data.state);
      setAssignee(issue.data.assigneeId ?? "");
    }
  }, [issue.data?.id]);
  const save = async (name: string, extra: Record<string, unknown>) => {
    if (!issue.data) return;
    const result = await op.run(workspace, name, {
      issueId: id,
      expectedVersion: issue.data.version,
      ...extra,
    });
    if (result) {
      if (name === "issues.comment") setComment("");
      issue.refresh();
      history.refresh();
      onChange();
    }
  };
  const busy = op.status === "pending" || op.status === "unknown";
  const retry = () => {
    void op.retry().then((result) => {
      if (result) {
        issue.refresh();
        history.refresh();
        onChange();
      }
    });
  };
  return (
    <section class="panel">
      <h2>
        {issue.data?.reference ?? ja.issue} {ja.ui.details}
      </h2>
      {issue.error && <p role="alert">{issue.error}</p>}
      {issue.data && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save("issues.edit", { title, description, priority });
            }}
          >
            <label>
              {ja.ui.title}
              <input
                required
                value={title}
                onInput={(event) => setTitle(event.currentTarget.value)}
              />
            </label>
            <label>
              {ja.ui.description}
              <textarea
                value={description}
                onInput={(event) => setDescription(event.currentTarget.value)}
              />
            </label>
            <label>
              {ja.ui.priority}
              <select
                value={priority}
                onChange={(event) =>
                  setPriority(event.currentTarget.value as keyof typeof ja.priority)
                }
              >
                {Object.entries(ja.priority).map(([value, label]) => (
                  <option value={value}>{label}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              class="primary"
              disabled={op.status !== "idle" && op.status !== "error"}
            >
              {ja.save}
            </button>
          </form>
          <div class="row">
            <label>
              {ja.ui.state}
              <select
                value={state}
                onChange={(event) => setState(event.currentTarget.value as keyof typeof ja.state)}
              >
                {Object.entries(ja.state).map(([value, label]) => (
                  <option value={value}>{label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              class="secondary compact"
              disabled={busy}
              onClick={() => void save("issues.transition", { state })}
            >
              {ja.ui.changeState}
            </button>
            <label>
              {ja.ui.assigneeId}
              <input value={assignee} onInput={(event) => setAssignee(event.currentTarget.value)} />
            </label>
            <button
              type="button"
              class="secondary compact"
              disabled={busy}
              onClick={() => void save("issues.assign", { assigneeId: assignee || null })}
            >
              {ja.ui.changeAssignee}
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save("issues.comment", { commentId: crypto.randomUUID(), body: comment });
            }}
          >
            <label>
              {ja.ui.comment}
              <textarea
                required
                value={comment}
                onInput={(event) => setComment(event.currentTarget.value)}
              />
            </label>
            <button type="submit" class="secondary" disabled={busy}>
              {ja.ui.addComment}
            </button>
          </form>
          <Status op={op} onRetry={retry} />
          <Attachments
            workspace={workspace}
            targetKind="issue"
            targetId={id}
            projectId={issue.data.projectId}
          />
          <h3>{ja.ui.history}</h3>
          <ul class="list history">
            {history.data?.map((item, index) => (
              <li key={`${item.version}:${index}`}>
                <strong>{item.action}</strong> · {identity(item)}
                <br />
                <time>{date(item.occurredAt)}</time> · {item.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
function Wiki({ workspace, project }: { workspace: string; project: Project }) {
  const pages = useQuery<{ pages: Page[] }>(
    workspace,
    "wiki.list",
    { projectId: project.id },
    project.id,
  );
  const [selected, setSelected] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const op = useAction(workspace);
  const create = async () => {
    const result = await op.run(workspace, "wiki.create", {
      pageId: crypto.randomUUID(),
      projectId: project.id,
      slug,
      title,
      body,
    });
    if (result) {
      setSlug("");
      setTitle("");
      setBody("");
      pages.refresh();
    }
  };
  return (
    <>
      <section class="panel">
        <h2>
          {project.name} {ja.ui.wikiOf}
        </h2>
        {pages.error && <p role="alert">{pages.error}</p>}
        <ul class="list">
          {pages.data?.pages.map((page) => (
            <li key={page.id}>
              <button type="button" class="secondary" onClick={() => setSelected(page.id)}>
                {page.title}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected && (
        <WikiDetail
          key={`${workspace}:${selected}`}
          workspace={workspace}
          id={selected}
          onChange={pages.refresh}
        />
      )}
      <section class="panel">
        <h3>{ja.ui.createPage}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            {ja.ui.slug}
            <input required value={slug} onInput={(event) => setSlug(event.currentTarget.value)} />
          </label>
          <label>
            {ja.ui.title}
            <input
              required
              value={title}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            {ja.ui.markdownBody}
            <textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} />
          </label>
          <button
            type="submit"
            class="primary"
            disabled={op.status === "pending" || op.status === "unknown"}
          >
            {ja.create}
          </button>
        </form>
        <Status
          op={op}
          onRetry={() => {
            void op.retry().then((result) => {
              if (result) {
                setSlug("");
                setTitle("");
                setBody("");
                pages.refresh();
              }
            });
          }}
        />
      </section>
    </>
  );
}
function WikiDetail({
  workspace,
  id,
  onChange,
}: {
  workspace: string;
  id: string;
  onChange: () => void;
}) {
  const page = useQuery<Page>(workspace, "wiki.get", { pageId: id }, id);
  const revisions = useQuery<{ revisions: Revision[] }>(
    workspace,
    "wiki.revisions",
    { pageId: id },
    id,
  );
  const op = useAction(workspace);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [newer, setNewer] = useState<Page | null>(null);
  useEffect(() => {
    if (page.data) {
      setTitle(page.data.title);
      setBody(page.data.body);
    }
  }, [page.data?.id]);
  const save = async () => {
    if (!page.data) return;
    const result = await op.run(workspace, "wiki.edit", {
      pageId: id,
      expectedVersion: page.data.version,
      title,
      body,
    });
    if (result) {
      setNewer(null);
      page.refresh();
      revisions.refresh();
      onChange();
    } else if (op.status === "error") {
      try {
        setNewer(await wire.call<Page>(workspace, "wiki.get", { pageId: id }));
      } catch {
        /* keep the draft */
      }
    }
  };
  return (
    <section class="panel">
      <h2>{page.data?.title ?? ja.ui.wikiPage}</h2>
      {page.error && <p role="alert">{page.error}</p>}
      {page.data && (
        <>
          <div
            class="markdown"
            dangerouslySetInnerHTML={{ __html: safeMarkdown(page.data.body) }}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              {ja.ui.title}
              <input
                required
                value={title}
                onInput={(event) => setTitle(event.currentTarget.value)}
              />
            </label>
            <label>
              {ja.ui.markdownBody}
              <textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} />
            </label>
            <button
              type="submit"
              class="primary"
              disabled={op.status === "pending" || op.status === "unknown"}
            >
              {ja.save}
            </button>
          </form>
          <Status
            op={op}
            onRetry={() => {
              void op.retry().then((result) => {
                if (result) {
                  page.refresh();
                  revisions.refresh();
                  onChange();
                }
              });
            }}
          />
          {newer && (
            <div class="notice" role="alert">
              <strong>{ja.ui.conflict}</strong>
              <p>
                {ja.ui.currentVersion} v{newer.version}: {newer.title}
              </p>
              <div
                class="markdown"
                dangerouslySetInnerHTML={{ __html: safeMarkdown(newer.body) }}
              />
              <button
                type="button"
                class="secondary"
                onClick={() => {
                  page.refresh();
                  setNewer(null);
                }}
              >
                {ja.ui.useCurrentVersion}
              </button>
            </div>
          )}
          <Attachments
            workspace={workspace}
            targetKind="wiki"
            targetId={id}
            projectId={page.data.projectId}
          />
          <h3>{ja.ui.revisions}</h3>
          <ul class="list history">
            {revisions.data?.revisions.map((revision) => (
              <li key={revision.version}>
                v{revision.version} · {revision.title} · {identity(revision)} ·{" "}
                <time>{date(revision.occurredAt)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
function Activity({ workspace, project }: { workspace: string; project: Project | null }) {
  const projectId = project?.id ?? "";
  const sessions = usePaged<Session>(workspace, "coordination.projectSessions", { projectId });
  const leases = usePaged<Lease>(workspace, "coordination.projectLeases", { projectId });
  const progress = usePaged<Progress>(workspace, "coordination.projectProgress", { projectId });
  const claims = usePaged<Claim>(workspace, "coordination.projectClaims", { projectId });
  const cap = useQuery<{ projectId: string; cap: number; version: number }>(
    workspace,
    "coordination.wipCap",
    { projectId },
    projectId,
  );
  const capOp = useAction(workspace);
  const [capInput, setCapInput] = useState("");
  useEffect(() => setCapInput(cap.data ? String(cap.data.cap) : ""), [cap.data?.version]);
  return (
    <>
      <section class="panel">
        <h2>{ja.activity}</h2>
        {!project && <p>{ja.ui.chooseProject}</p>}
        <button
          type="button"
          class="secondary"
          disabled={!project}
          onClick={() => {
            sessions.refresh();
            leases.refresh();
            progress.refresh();
            claims.refresh();
            cap.refresh();
          }}
        >
          {ja.ui.refresh}
        </button>
        <h3>{ja.ui.sessions}</h3>
        {sessions.error && <p role="alert">{sessions.error}</p>}
        <ul class="list">
          {sessions.items.map((s) => (
            <li key={s.id}>
              <div class="item">
                <strong>{s.agentLabel}</strong>
                <span class="badge">{s.live ? ja.ui.live : ja.ui.stale}</span>
              </div>
              <span>
                {s.clientKind} · {s.repo ?? ja.ui.noRepo} · {date(s.expiresAt)} {ja.ui.until}
              </span>
            </li>
          ))}
        </ul>
        {sessions.hasMore && (
          <button type="button" class="secondary" onClick={sessions.loadMore}>
            {ja.ui.loadMore}
          </button>
        )}
      </section>
      <section class="panel">
        <h3>
          {ja.ui.leases} {project && `· ${project.name}`}
        </h3>
        {leases.error && <p role="alert">{leases.error}</p>}
        <ul class="list">
          {leases.items.map((l) => (
            <li key={l.issueId}>
              <strong>{l.issueId}</strong> · {ja.ui.holder} {l.agentLabel} ({l.clientKind}) ·{" "}
              {l.sessionId ?? ja.ui.none} · {ja.ui.fencingToken} {l.fencingToken} ·{" "}
              {date(l.expiresAt)}
            </li>
          ))}
        </ul>
        {leases.hasMore && (
          <button type="button" class="secondary" onClick={leases.loadMore}>
            {ja.ui.loadMore}
          </button>
        )}
        <h3>{ja.ui.wipCap}</h3>
        {cap.error && <p role="alert">{cap.error}</p>}
        {cap.data && (
          <p>
            {cap.data.cap} · v{cap.data.version}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!cap.data) return;
            void capOp
              .run(workspace, "coordination.wipCap.set", {
                projectId,
                cap: Number(capInput),
                expectedVersion: cap.data.version,
              })
              .then((result) => {
                if (result) cap.refresh();
              });
          }}
        >
          <div class="row">
            <label>
              {ja.ui.wipCap}
              <input
                type="number"
                min="1"
                max="100"
                required
                value={capInput}
                onInput={(event) => setCapInput(event.currentTarget.value)}
              />
            </label>
            <button
              type="submit"
              class="secondary"
              disabled={!cap.data || capOp.status === "pending" || capOp.status === "unknown"}
            >
              {ja.save}
            </button>
          </div>
        </form>
        <Status
          op={capOp}
          onRetry={() => {
            void capOp.retry().then((result) => {
              if (result) cap.refresh();
            });
          }}
        />
      </section>
      <section class="panel">
        <h3>{ja.ui.progress}</h3>
        {progress.error && <p role="alert">{progress.error}</p>}
        <ul class="list">
          {progress.items.map((p, i) => (
            <li key={i}>
              {date(p.reportedAt)} · {p.sessionId} · {p.status}
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
        {progress.hasMore && (
          <button type="button" class="secondary" onClick={progress.loadMore}>
            {ja.ui.loadMore}
          </button>
        )}
      </section>
      <section class="panel">
        <h3>{ja.ui.claims}</h3>
        {claims.error && <p role="alert">{claims.error}</p>}
        <ul class="list">
          {claims.items.map((c) => (
            <li key={c.path}>
              {c.path} · {c.sessionId} · {date(c.expiresAt)}
            </li>
          ))}
        </ul>
        {claims.hasMore && (
          <button type="button" class="secondary" onClick={claims.loadMore}>
            {ja.ui.loadMore}
          </button>
        )}
      </section>
    </>
  );
}
function Admin({ workspace }: { workspace: string }) {
  const [principalId, setPrincipalId] = useState("");
  const [issuer, setIssuer] = useState("");
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState("member");
  const [machineId, setMachineId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [token, setToken] = useState("");
  const member = useQuery<{ id: string; version: number; role: string; active: boolean }>(
    workspace,
    "access.membership",
    { principalId },
    principalId,
  );
  const members = usePaged<{
    principalId: string;
    kind: "human" | "machine" | "oauth";
    displayName: string;
    role: string;
    version: number;
  }>(workspace, "access.members.list", {});
  const oauthClients = usePaged<{
    clientId: string;
    name: string;
    version: number;
    revoked: boolean;
  }>(workspace, "access.oauthClients.list", {});
  const op = useAction(workspace);
  const busy = op.status === "pending" || op.status === "unknown";
  const submit = async (name: string, args: Record<string, unknown>) => {
    const result = await op.run<{ token?: string; id?: string }>(workspace, name, args);
    if (result) {
      if (result.token) setToken(result.token);
      member.refresh();
    }
    return result;
  };
  return (
    <>
      <section class="panel">
        <h2>{ja.ui.workspaceAdmin}</h2>
        <h3>{ja.ui.members}</h3>
        {members.error && <p role="alert">{members.error}</p>}
        <ul class="list">
          {members.items.map((entry) => (
            <li key={entry.principalId}>
              <div class="item">
                <strong>{entry.displayName}</strong>
                <span class="badge">
                  {ja.roles[entry.role as keyof typeof ja.roles] ?? entry.role}
                </span>
              </div>
              <small>
                {entry.kind} · {entry.principalId} · v{entry.version}
              </small>
              <button
                type="button"
                class="secondary"
                onClick={() => {
                  setPrincipalId(entry.principalId);
                  setRole(entry.role);
                }}
              >
                {ja.ui.select}
              </button>
            </li>
          ))}
        </ul>
        {members.hasMore && (
          <button type="button" class="secondary" onClick={members.loadMore}>
            {ja.ui.loadMore}
          </button>
        )}
        <p class="muted">{ja.ui.adminHint}</p>
        <label>
          {ja.ui.principalId}
          <input
            value={principalId}
            onInput={(event) => setPrincipalId(event.currentTarget.value)}
          />
        </label>
        {member.data && (
          <p>
            {ja.roles[member.data.role as keyof typeof ja.roles] ?? member.data.role} ·{" "}
            {member.data.active ? ja.ui.active : ja.ui.inactive} · v{member.data.version}
          </p>
        )}
        <div class="row">
          <label>
            {ja.ui.issuer}
            <input value={issuer} onInput={(event) => setIssuer(event.currentTarget.value)} />
          </label>
          <label>
            {ja.ui.subject}
            <input value={subject} onInput={(event) => setSubject(event.currentTarget.value)} />
          </label>
          <label>
            {ja.ui.role}
            <select value={role} onChange={(event) => setRole(event.currentTarget.value)}>
              {["owner", "admin", "member", "viewer"].map((r) => (
                <option value={r}>{ja.roles[r as keyof typeof ja.roles]}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onClick={() =>
            void submit("access.invite", { expectedVersion: 0, issuer, subject, role })
          }
        >
          {ja.ui.invite}
        </button>{" "}
        {member.data && (
          <button
            type="button"
            class="secondary"
            disabled={busy}
            onClick={() =>
              void submit("access.role", {
                principalId,
                expectedVersion: member.data?.version,
                role,
              })
            }
          >
            {ja.ui.changeRole}
          </button>
        )}
      </section>
      <section class="panel">
        <h3>{ja.ui.machinePrincipal}</h3>
        <label>
          {ja.ui.machineId}
          <input value={machineId} onInput={(event) => setMachineId(event.currentTarget.value)} />
        </label>
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onClick={() => {
            void submit("access.machine", { principalId: machineId, role: "member" }).then(
              (result) => {
                if (result?.id) setMachineId(result.id);
              },
            );
          }}
        >
          {ja.ui.register}
        </button>
        <h3>{ja.ui.issueCredential}</h3>
        <label>
          {ja.ui.credentialId}
          <input
            value={credentialId}
            onInput={(event) => setCredentialId(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onClick={() => {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            const value = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
            void submit("access.credential.issue", {
              credentialId,
              principalId: machineId,
              secret: value,
              scope: "write",
              expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
            });
          }}
        >
          {ja.ui.mintThirtyDayToken}
        </button>
        {token && (
          <div class="notice">
            <strong>{ja.ui.tokenOnce}</strong>
            <p class="secret">{token}</p>
            <button type="button" class="secondary" onClick={() => setToken("")}>
              {ja.ui.close}
            </button>
          </div>
        )}
      </section>
      <section class="panel">
        <h3>{ja.ui.oauthClients}</h3>
        {oauthClients.error && <p role="alert">{oauthClients.error}</p>}
        <ul class="list">
          {oauthClients.items.map((client) => (
            <li key={client.clientId}>
              <div class="item">
                <strong>{client.name}</strong>
                <span class="badge">{client.revoked ? ja.ui.inactive : ja.ui.active}</span>
              </div>
              <small>
                {client.clientId} · v{client.version}
              </small>
              {!client.revoked && (
                <button
                  type="button"
                  class="secondary"
                  disabled={busy}
                  onClick={() => {
                    void submit("access.oauthClients.revoke", {
                      clientId: client.clientId,
                      expectedVersion: client.version,
                    }).then((result) => {
                      if (result) oauthClients.refresh();
                    });
                  }}
                >
                  {ja.ui.revoke}
                </button>
              )}
            </li>
          ))}
        </ul>
        {oauthClients.hasMore && (
          <button type="button" class="secondary" onClick={oauthClients.loadMore}>
            {ja.ui.loadMore}
          </button>
        )}
      </section>
      <Status
        op={op}
        onRetry={() => {
          const retryName = op.pending?.name;
          void op.retry().then((result) => {
            if (
              result &&
              typeof result === "object" &&
              "token" in result &&
              typeof result.token === "string"
            )
              setToken(result.token);
            if (result && retryName === "access.oauthClients.revoke") oauthClients.refresh();
            member.refresh();
          });
        }}
      />
    </>
  );
}
function App() {
  const [workspace, setWorkspace] = useState(
    () => new URL(location.href).searchParams.get("w") ?? "",
  );
  const [project, setProject] = useState<Project | null>(null);
  const [view, setView] = useState<View>("projects");
  const workspaceInfo = useQuery<Workspace[]>(workspace, "access.workspaces", {}, workspace);
  const meQuery = useMe(!workspace);
  const selectWorkspace = (id: string) => {
    setWorkspace(id);
    setProject(null);
    setView("projects");
    const url = new URL(location.href);
    url.searchParams.set("w", id);
    history.replaceState(null, "", url);
  };
  return (
    <>
      <header>
        <div>
          <h1>{ja.app}</h1>
          <small>
            {workspace
              ? `${workspace}${project ? ` / ${project.name}` : ""}`
              : ja.ui.selectWorkspace}
          </small>
        </div>
        {workspace && (
          <button type="button" onClick={() => selectWorkspace("")}>
            {ja.ui.switch}
          </button>
        )}
      </header>
      <main>
        {!workspace ? (
          <WorkspacePicker
            me={
              meQuery.principal
                ? { principal: meQuery.principal, workspaces: meQuery.workspaces }
                : null
            }
            error={meQuery.error}
            loading={meQuery.loading}
            hasMore={meQuery.nextCursor !== null}
            onSelect={selectWorkspace}
            onMore={meQuery.loadMore}
          />
        ) : (
          <>
            {workspaceInfo.error && (
              <div class="notice error" role="alert">
                {ja.ui.connectionFailed} {workspaceInfo.error}
              </div>
            )}
            {workspaceInfo.data && (
              <p class="muted">
                {workspaceInfo.data.find((w) => w.id === workspace)?.name ?? workspace} ·{" "}
                {ja.roles[
                  workspaceInfo.data.find((w) => w.id === workspace)?.role as keyof typeof ja.roles
                ] ?? workspaceInfo.data.find((w) => w.id === workspace)?.role}
              </p>
            )}
            <nav aria-label={ja.ui.mainMenu}>
              {(["projects", "issues", "wiki", "activity", "admin"] as View[]).map((item, i) => (
                <button
                  type="button"
                  key={item}
                  aria-current={view === item ? "page" : undefined}
                  onClick={() => setView(item)}
                >
                  {[ja.project, ja.issue, ja.wiki, ja.activity, ja.admin][i]}
                </button>
              ))}
            </nav>
            {view === "projects" && (
              <Projects
                workspace={workspace}
                project={project}
                onProject={(p) => {
                  setProject(p);
                  setView("issues");
                }}
              />
            )}
            {view === "issues" &&
              (project ? (
                <Issues
                  key={`${workspace}:${project.id}`}
                  workspace={workspace}
                  project={project}
                />
              ) : (
                <div class="panel">{ja.ui.chooseProject}</div>
              ))}
            {view === "wiki" &&
              (project ? (
                <Wiki key={`${workspace}:${project.id}`} workspace={workspace} project={project} />
              ) : (
                <div class="panel">{ja.ui.chooseProject}</div>
              ))}
            {view === "activity" && (
              <Activity
                key={`${workspace}:${project?.id}`}
                workspace={workspace}
                project={project}
              />
            )}
            {view === "admin" && <Admin key={workspace} workspace={workspace} />}
          </>
        )}
      </main>
    </>
  );
}
render(<App />, document.getElementById("app") ?? document.body);
