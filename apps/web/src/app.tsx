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
type Lease = { issueId: string; sessionId: string | null; fencingToken: number; expiresAt: number };
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
    if (!workspace) return;
    const controller = new AbortController();
    wire
      .call<T>(workspace, name, args, controller.signal)
      .then(setData)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [workspace, name, key, reload]);
  return { data, error, refresh: () => setReload((x) => x + 1) };
}
function WorkspacePicker({ value, onSelect }: { value: string; onSelect: (id: string) => void }) {
  const [input, setInput] = useState(value);
  const [known, setKnown] = useState<string[]>(
    () => JSON.parse(localStorage.getItem("ui:workspaces") ?? "[]") as string[],
  );
  const select = (id: string) => {
    const next = [...new Set([id, ...known])];
    setKnown(next);
    localStorage.setItem("ui:workspaces", JSON.stringify(next));
    onSelect(id);
  };
  return (
    <section class="panel">
      <h2>{ja.ui.selectWorkspace}</h2>
      <p class="muted">{ja.ui.workspaceHint}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (/^[a-zA-Z0-9_-]{1,128}$/.test(input)) select(input);
        }}
      >
        <label>
          {ja.ui.workspaceId}
          <input
            required
            pattern="[a-zA-Z0-9_-]{1,128}"
            value={input}
            onInput={(event) => setInput(event.currentTarget.value)}
          />
        </label>
        <button type="submit" class="primary">
          {ja.ui.open}
        </button>
      </form>
      {known.length > 0 && (
        <>
          <h3>{ja.ui.recentWorkspaces}</h3>
          <ul class="list">
            {known.map((id) => (
              <li key={id}>
                <button type="button" class="secondary" onClick={() => select(id)}>
                  {id}
                </button>
              </li>
            ))}
          </ul>
        </>
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
            <button type="submit" class="secondary">
              {ja.ui.addComment}
            </button>
          </form>
          <Status op={op} onRetry={retry} />
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
  const sessions = useQuery<Session[]>(workspace, "coordination.listSessions", {}, workspace);
  const leases = useQuery<Lease[]>(
    workspace,
    "coordination.listLeases",
    { projectId: project?.id },
    project?.id ?? "",
  );
  const [repo, setRepo] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [issueId, setIssueId] = useState("");
  const claims = useQuery<Claim[]>(
    workspace,
    "coordination.listClaims",
    { repo, sessionId },
    `${repo}:${sessionId}`,
  );
  const progress = useQuery<{ items: Progress[] }>(
    workspace,
    "coordination.listProgress",
    { issueId },
    issueId,
  );
  return (
    <>
      <section class="panel">
        <h2>{ja.activity}</h2>
        <button
          type="button"
          class="secondary"
          onClick={() => {
            sessions.refresh();
            leases.refresh();
            claims.refresh();
            progress.refresh();
          }}
        >
          {ja.ui.refresh}
        </button>
        <h3>{ja.ui.sessions}</h3>
        <ul class="list">
          {sessions.data?.map((s) => (
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
      </section>
      <section class="panel">
        <h3>
          {ja.ui.leases} {project && `· ${project.name}`}
        </h3>
        {!project && <p>{ja.ui.chooseProject}</p>}
        <ul class="list">
          {leases.data?.map((l) => (
            <li key={l.issueId}>
              <strong>{l.issueId}</strong> · {ja.ui.holder} {l.sessionId ?? ja.ui.none} ·{" "}
              {ja.ui.fencingToken} {l.fencingToken} · {date(l.expiresAt)}
            </li>
          ))}
        </ul>
        <p class="muted">{ja.ui.wipNote}</p>
      </section>
      <section class="panel">
        <h3>{ja.ui.progress}</h3>
        <label>
          {ja.ui.issueId}
          <input value={issueId} onInput={(event) => setIssueId(event.currentTarget.value)} />
        </label>
        <ul class="list">
          {progress.data?.items.map((p, i) => (
            <li key={i}>
              {date(p.reportedAt)} · {p.sessionId} · {p.status}
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
      </section>
      <section class="panel">
        <h3>{ja.ui.claims}</h3>
        <div class="row">
          <label>
            {ja.ui.repo}
            <input value={repo} onInput={(event) => setRepo(event.currentTarget.value)} />
          </label>
          <label>
            {ja.ui.sessionId}
            <input value={sessionId} onInput={(event) => setSessionId(event.currentTarget.value)} />
          </label>
        </div>
        <ul class="list">
          {claims.data?.map((c) => (
            <li key={c.path}>
              {c.path} · {c.sessionId} · {date(c.expiresAt)}
            </li>
          ))}
        </ul>
        <p class="muted">{ja.ui.claimsNote}</p>
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
  const op = useAction(workspace);
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
        <p>{ja.ui.oauthUnavailable}</p>
      </section>
      <Status
        op={op}
        onRetry={() => {
          void op.retry().then((result) => {
            if (
              result &&
              typeof result === "object" &&
              "token" in result &&
              typeof result.token === "string"
            )
              setToken(result.token);
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
          <WorkspacePicker value="" onSelect={selectWorkspace} />
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
