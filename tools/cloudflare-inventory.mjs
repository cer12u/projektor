// Read-only inventory of the Cloudflare account used by CI. It prints names, IDs, bindings and
// hostnames only (never secret values), to plan the production cut-over. Run by the manual
// `cloudflare-inventory` job on protected main.
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  process.exit(78);
}
// Optional zone to inspect for Worker routes, from the CF_ZONE_NAME CI/CD variable.
const zoneName = process.env.CF_ZONE_NAME;
const api = async (path) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false)
    return { error: `${response.status} ${(body.errors ?? []).map((e) => e.code).join(",")}` };
  return { result: body.result };
};
const section = async (title, path, pick) => {
  const { result, error } = await api(path);
  console.log(`\n## ${title}`);
  if (error) {
    console.log(`  (unavailable: ${error})`);
    return [];
  }
  const rows = Array.isArray(result) ? result : (result?.objects ?? result?.buckets ?? [result]);
  for (const row of rows) console.log(`  ${pick(row)}`);
  return rows;
};
const a = `/accounts/${account}`;
const scripts = await section(
  "Workers",
  `${a}/workers/scripts`,
  (s) => `${s.id} modified=${s.modified_on}`,
);
for (const s of scripts.filter((x) => /projektor/i.test(x.id ?? ""))) {
  await section(`Bindings of ${s.id}`, `${a}/workers/scripts/${s.id}/settings`, (r) =>
    (r.bindings ?? [])
      .map(
        (b) =>
          `${b.type}:${b.name}${(b.id ?? b.namespace_id ?? b.bucket_name ?? b.class_name) ? `=${b.id ?? b.namespace_id ?? b.bucket_name ?? b.class_name}` : ""}`,
      )
      .join("\n  "),
  );
}
await section(
  "Workers custom domains",
  `${a}/workers/domains`,
  (d) => `${d.hostname} -> ${d.service} (${d.environment})`,
);
await section("workers.dev subdomain", `${a}/workers/subdomain`, (r) => r.subdomain);
await section(
  "D1",
  `${a}/d1/database?per_page=100`,
  (d) => `${d.name} ${d.uuid} created=${d.created_at}`,
);
await section("KV", `${a}/storage/kv/namespaces?per_page=100`, (k) => `${k.title} ${k.id}`);
await section("R2", `${a}/r2/buckets`, (b) => `${b.name} created=${b.creation_date}`);
await section(
  "Access organization",
  `${a}/access/organizations`,
  (o) => `auth_domain=${o.auth_domain}`,
);
await section(
  "Access apps",
  `${a}/access/apps`,
  (x) => `${x.name} domain=${x.domain} aud=${x.aud}`,
);
const zones = zoneName
  ? await section(`Zone ${zoneName}`, `/zones?name=${zoneName}`, (z) => `${z.name} ${z.id}`)
  : [];
if (zones[0]?.id)
  await section(
    `Worker routes in ${zoneName}`,
    `/zones/${zones[0].id}/workers/routes`,
    (r) => `${r.pattern} -> ${r.script}`,
  );
