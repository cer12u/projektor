import type { OAuthConsent, Workspace } from "../modules/access/public";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

export function consentPage(
  consent: OAuthConsent,
  workspaces: readonly Workspace[],
  selected: string,
  input: Record<string, string>,
  token: string,
): string {
  const name = escapeHtml(workspaces.find((w) => w.id === selected)?.name ?? selected);
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Authorize MCP client</title>
<style>
body{font:18px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#182230;background:#f8fafc}
main{background:white;padding:1.5rem;border:1px solid #cbd5e1;border-radius:.5rem}
h1{font-size:1.6rem;margin-top:0}h2{font-size:1.25rem}
button,select{font:inherit;padding:.5rem;margin:.3rem 0;max-width:100%}
button{cursor:pointer}button[value=approve]{background:#174ea6;color:white;border:2px solid #174ea6;border-radius:.25rem;margin-right:.5rem}
dt{font-weight:bold}dd{margin:0 0 1rem;overflow-wrap:anywhere}
label{display:block}p{font-size:1rem}
</style>
<main>
<h1>Authorize MCP client</h1>
<dl>
<dt>Client</dt><dd>${escapeHtml(consent.clientName)}</dd>
<dt>Redirect host</dt><dd>${escapeHtml(new URL(consent.redirectUri).host)}</dd>
<dt>Requested scope</dt><dd>${escapeHtml(consent.requestedScope)}</dd>
<dt>Granted scope in ${name}</dt><dd>${escapeHtml(consent.scope)}</dd>
</dl>
<form method="get" action="/oauth/authorize">
${Object.entries(input)
  .map(([k, v]) => hidden(k, v))
  .join("\n")}
<label for="workspace">Workspace</label>
<select id="workspace" name="workspace">${workspaces.map((w) => `<option value="${escapeHtml(w.id)}"${w.id === selected ? " selected" : ""}>${escapeHtml(w.name)}</option>`).join("")}</select>
<button>Review workspace</button>
<p>After changing the workspace, select Review workspace to update the grant below.</p>
</form>
<h2>Access to ${name}</h2>
<p>Approve only if you trust this client. It will receive the granted scope shown above.</p>
<form method="post" action="/oauth/authorize">
${hidden("form_token", token)}
<button name="decision" value="approve">Approve ${name}</button>
<button name="decision" value="deny">Deny</button>
</form>
</main>
</html>`;
}
