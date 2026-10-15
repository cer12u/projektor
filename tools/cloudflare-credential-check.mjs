// Manual diagnostic only. GET requests; never deploys or stores credentials.
import fs from "node:fs";

const report = { checks: {}, mutationPerformed: false, deploymentWriteTested: false };
const env = process.env;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_DEPLOY_CONFIG",
    "CF_PRESERVED_D1_IDS",
    "CF_APPROVED_SCHEMA_SHA256",
  ])
    if (!env[name]) throw new Error(`Missing ${name}`);
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("Invalid account configuration");
  const installation = JSON.parse(env.CF_DEPLOY_CONFIG);
  const base = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
  if (installation.worker !== base.name || !/^[a-z0-9-]{1,63}$/.test(installation.worker))
    throw new Error("Target Worker does not match source configuration");
  if (
    env.CF_PRESERVED_D1_IDS.split(",")
      .map((x) => x.trim())
      .includes(installation.d1Id)
  )
    throw new Error("Configuration points at a preserved database");
  if (!/^[0-9a-f]{64}$/.test(env.CF_APPROVED_SCHEMA_SHA256))
    throw new Error("Missing approved schema fingerprint");
  report.configurationPresent = true;

  async function read(label, suffix) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response;
      try {
        response = await fetch(`https://api.cloudflare.com/client/v4${suffix}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        if (attempt === 3) throw new Error(`Network connection failed: ${label}, 3 attempts`);
        await pause(attempt * 1000);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await pause(attempt * 1000);
        continue;
      }
      const body = await response.json().catch(() => null);
      report.checks[label] = {
        httpStatus: response.status,
        success: response.ok && body?.success === true,
        attempts: attempt,
        errorCodes: (body?.errors ?? []).map((x) => x.code).filter(Number.isInteger),
      };
      return { ok: report.checks[label].success, body };
    }
  }

  const root = `/accounts/${account}`;
  const worker = `${root}/workers/scripts/${installation.worker}`;
  const verified = await read("accountTokenVerification", `${root}/tokens/verify`);
  if (verified.ok) {
    const status = verified.body.result?.status;
    report.tokenStatus = ["active", "disabled", "expired"].includes(status) ? status : "unknown";
    if (report.tokenStatus !== "active") throw new Error("Token is not active");
  }

  for (const [label, endpoint] of [
    ["targetWorkerSettings", `${worker}/script-settings`],
    ["targetDeployments", `${worker}/deployments`],
    ["targetSecretNames", `${worker}/secrets`],
  ]) {
    const result = await read(label, endpoint);
    if (!result.ok) throw new Error(`Target Worker authentication/permission failed: ${label}`);
    if (label === "targetSecretNames") {
      const names = result.body.result?.map((x) => x.name) ?? [];
      report.selectedFeatureSecretsPresent =
        (!installation.oauthEnabled || names.includes("OAUTH_FORM_SECRET")) &&
        (!installation.integrationsEnabled || names.includes("INTEGRATIONS_KEY"));
      if (!report.selectedFeatureSecretsPresent)
        throw new Error("Selected feature secret names are missing");
    }
  }
  report.targetReadAuthenticationPassed = true;

  // This endpoint returns policy metadata, not token values. Least-privilege
  // Worker tokens may not have permission to inspect their own token policy.
  const tokenId = verified.body?.result?.id;
  if (verified.ok && /^[0-9a-f]{32}$/.test(tokenId ?? "")) {
    const details = await read("ownPolicyMetadata", `${root}/tokens/${tokenId}`);
    if (details.ok) {
      const policies = details.body.result?.policies ?? [];
      const allows = policies.filter((p) => p.effect === "allow");
      report.editorRoleDeclared = allows.some((p) =>
        p.permission_groups?.some((g) => /workers editor/i.test(g.name ?? "")),
      );
      report.legacyWorkersEditDeclared = allows.some((p) =>
        p.permission_groups?.some((g) => /workers scripts edit/i.test(g.name ?? "")),
      );
      const leaves = (value, parents = []) =>
        Object.entries(value ?? {}).flatMap(([key, child]) =>
          typeof child === "string" ? [[...parents, key]] : leaves(child, [...parents, key]),
        );
      const resources = allows.flatMap((p) => leaves(p.resources));
      const workerScoped = resources.filter((keys) =>
        keys.some((key) => /\.worker(?:\.|$)/.test(key)),
      );
      report.singleWorkerEditorPolicyDeclared =
        allows.length === 1 &&
        allows[0].permission_groups?.length === 1 &&
        report.editorRoleDeclared &&
        resources.length === 1 &&
        workerScoped.length === 1;
      report.policyMetadataAvailable = true;
      if (report.legacyWorkersEditDeclared && workerScoped.length === 0)
        throw new Error(
          "Credential scope requires review: account-wide legacy Workers Scripts Edit",
        );
    } else report.policyMetadataAvailable = false;
  } else report.policyMetadataAvailable = false;
  report.limitation =
    "GET authentication is verified; deployment write capability and exact Worker-only scope are not proven by these reads. No permission expansion is requested.";
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  // Only our fixed diagnostic messages are emitted, never raw API bodies,
  // credential strings, request headers, fetch errors or child-process output.
  report.error =
    error instanceof SyntaxError
      ? "Invalid non-secret JSON configuration"
      : error instanceof Error &&
          /^(Missing |Invalid account|Target Worker|Configuration points|Network connection|Token is not|Selected feature|Credential scope)/.test(
            error.message,
          )
        ? error.message
        : "Credential check failed; inspect sanitized HTTP status/error codes";
}
const summary = JSON.stringify(report, null, 2);
console.log(summary);
if (env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `### Cloudflare credential check\n\n\`\`\`json\n${summary}\n\`\`\`\n`,
  );
if (failed) process.exitCode = 1;
