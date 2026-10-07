// Build-only companion to build-release.sh: identical frontend and dry-run Worker
// commands, but no deployment config, releases, tags, source, or dependencies in
// the payload. Tooling belongs to the PR; candidate source stays at FIXED.commit.
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const FIXED = Object.freeze({
  repository: 'cer12u/projektor',
  commit: 'd39852cef35217bc1dbf4c42d646bda1f09994d3',
  lock_sha256: '7c0fa112ec4def6cc25fe2eb222862cc81e0c39a0397072854715cbea9a05b6c',
  node: '22.12.0',
  pnpm: '10.18.0',
  migration_count: 72,
});
const ARCHIVE = 'projektor-d39852cef352.tar.gz';
const MAX_BYTES = 256 * 1024 * 1024;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const TOOL_FILES = [
  '.github/workflows/build-candidate.yml',
  'scripts/build-candidate.mjs',
  'scripts/build-candidate.test.mjs',
];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const nulList = (text) => text.split('\0').filter(Boolean);

// Never forward subprocess logs (which may contain config or environment values).
// The label and exit status are sufficient to identify the failed build stage.
function run(command, args, cwd, env = process.env, input, label = command) {
  const result = spawnSync(command, args, {
    cwd, env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  assert(!result.error && result.status === 0,
    `${label} stage failed (status ${result.status ?? 'unavailable'}); raw output withheld`);
  return result.stdout.trim();
}
const git = (root, ...args) => run('git', ['-C', root, ...args], root);

export function safePath(path) {
  assert(typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
    !path.startsWith('/') && /^[\x20-\x7e]+$/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..'), 'Unsafe artifact path');
}
function privatePath(path) {
  return path.split('/').some((part) =>
    /^(?:\.|node_modules$|(?:private|secrets?|credentials?|deploy(?:ment)?)(?:[._-]|$)|wrangler(?:[._-]|$))/i.test(part) ||
    /^(?:settings|config)(?:[._-].*)?\.json$/i.test(part) ||
    /\.(?:pem|key|p12|pfx|env|toml|ya?ml|map)$/i.test(part));
}
function filesIn(root) {
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Expected regular directory');
  const files = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      safePath(path);
      assert(!privatePath(path), 'Private/config/environment file in payload');
      const stat = lstatSync(join(dir, name));
      assert(!stat.isSymbolicLink(), 'Symlink in payload');
      if (stat.isDirectory()) walk(join(dir, name), path);
      else {
        assert(stat.isFile() && stat.nlink === 1, 'Non-regular or hard-linked payload file');
        files.push(path);
      }
    }
  }
  walk(root);
  assert(files.length <= 10000, 'Too many payload files');
  return files.sort();
}

// All tracked files, including the public *.example templates, are anchored by
// the exact Git commit. No ignored/local env file may enter the build. After the
// build, only dependencies and these known generated directories are permitted.
export function assertSource(root, expected = FIXED, generated = false) {
  assert(git(root, 'rev-parse', 'HEAD') === expected.commit, 'Candidate commit mismatch');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  assert(HEX40.test(tree) && (!expected.tree || tree === expected.tree), 'Candidate tree mismatch');
  assert(git(root, 'status', '--porcelain=v1', '--untracked-files=no') === '', 'Tracked source changed');
  assert(sha256(readFileSync(join(root, 'pnpm-lock.yaml'))) === expected.lock_sha256, 'Lock hash mismatch');
  const tracked = new Set(nulList(git(root, 'ls-files', '-z')));
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === '.git') continue;
      const dependency = /^(?:node_modules|(?:apps|packages|plugins)\/[^/]+\/node_modules)$/.test(path);
      if (generated && dependency) continue;
      const stat = lstatSync(join(dir, name));
      if (stat.isDirectory()) walk(join(dir, name), path);
      else if (!tracked.has(path)) {
        assert(!/(^|\/)(?:\.env(?:\.|$)|\.dev\.vars(?:\.|$)|secrets?(?:[._-]|$)|credentials?(?:[._-]|$)|private(?:[._-]|$))/i.test(path),
          'Private/environment file in candidate source');
        assert(generated && /^(?:apps\/web\/(?:dist|\.astro)\/|apps\/api\/(?:dist|\.wrangler)\/)/.test(path),
          'Untracked file in candidate source');
        assert(stat.isFile() && !stat.isSymbolicLink(), 'Non-regular generated source file');
      }
    }
  }
  walk(root);
  return { repository: expected.repository, commit: expected.commit, tree, lock_sha256: expected.lock_sha256 };
}

export function migrationFiles(root, expected = FIXED) {
  const paths = nulList(git(root, 'ls-files', '-z', '--', 'packages/db/migrations'));
  assert(paths.length === expected.migration_count && paths.every((p) => /^packages\/db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(p)),
    'Incomplete or unexpected migration set');
  return paths.sort().map((path) => ({
    path: path.replace('packages/db/', ''),
    sha256: sha256(readFileSync(join(root, path))),
  }));
}

export function inventory(root, migrations) {
  const paths = filesIn(root);
  const required = ['worker.js', 'VERSION', 'web/index.html', 'web/sw.js', 'web/_headers', 'web/manifest.json'];
  assert(required.every((p) => paths.includes(p)) && paths.some((p) => /^web\/_astro\/.+\.js$/.test(p)),
    'Incomplete Worker or web output');
  const expectedMigrations = new Map(migrations.map((entry) => [entry.path, entry.sha256]));
  assert(paths.filter((p) => p.startsWith('migrations/')).length === migrations.length, 'Incomplete migration payload');
  let total = 0;
  return paths.map((path) => {
    assert(path === 'worker.js' || path === 'VERSION' || path.startsWith('web/') || expectedMigrations.has(path),
      'Unexpected payload file');
    const bytes = readFileSync(join(root, path));
    total += bytes.length;
    assert(bytes.length > 0 && total <= MAX_BYTES, 'Empty or oversized payload file');
    assert(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString('utf8')), 'Private key in payload');
    const digest = sha256(bytes);
    if (expectedMigrations.has(path)) assert(digest === expectedMigrations.get(path), 'Migration content mismatch');
    return { path, bytes: bytes.length, sha256: digest };
  });
}

// Only classic ustar regular-file entries are accepted. Verify in memory without
// extracting anything: no symlinks, hard links, traversal, PAX extensions, or
// duplicate names can exploit a later consumer's extraction step.
export function readArchive(compressed) {
  assert(compressed.length <= MAX_BYTES, 'Oversized archive');
  const bytes = gunzipSync(compressed, { maxOutputLength: MAX_BYTES });
  const files = new Map();
  let offset = 0;
  const stringAt = (header, start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(bytes.length - offset >= 1024 && bytes.length % 512 === 0 &&
        bytes.subarray(offset).every((byte) => byte === 0), 'Invalid archive terminator');
      assert(files.size > 0, 'Empty archive');
      return files;
    }
    const octal = (start, length) => {
      const value = stringAt(header, start, length).trim();
      assert(/^[0-7]+$/.test(value), 'Invalid tar number');
      return Number.parseInt(value, 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert(octal(148, 8) === checksum, 'Tar header checksum mismatch');
    assert(stringAt(header, 257, 6) === 'ustar' && header[156] === 48 &&
      !stringAt(header, 157, 100), 'Unsupported tar entry (regular files only)');
    const prefix = stringAt(header, 345, 155);
    const path = `${prefix ? `${prefix}/` : ''}${stringAt(header, 0, 100)}`;
    safePath(path);
    assert(!privatePath(path) && !files.has(path), 'Private or duplicate tar entry');
    const size = octal(124, 12);
    offset += 512;
    assert(size > 0 && offset + size <= bytes.length, 'Truncated or empty tar entry');
    const content = bytes.subarray(offset, offset + size);
    files.set(path, { path, bytes: size, sha256: sha256(content) });
    assert(files.size <= 10000, 'Too many tar entries');
    const end = offset + Math.ceil(size / 512) * 512;
    assert(bytes.subarray(offset + size, end).every((byte) => byte === 0), 'Nonzero tar padding');
    offset = end;
  }
  throw new Error('Missing archive terminator');
}

export function verifyArtifact(output, expected = FIXED) {
  const manifest = json(join(output, 'manifest.json'));
  assert(manifest.schema === 1 && manifest.source?.repository === expected.repository &&
    manifest.source.commit === expected.commit && HEX40.test(manifest.source.tree) &&
    (!expected.tree || manifest.source.tree === expected.tree) &&
    manifest.source.lock_sha256 === expected.lock_sha256, 'Manifest source provenance mismatch');
  assert(manifest.tools?.node === expected.node && manifest.tools.pnpm === expected.pnpm &&
    /^\d+\.\d+\.\d+/.test(manifest.tools.wrangler ?? ''), 'Manifest tool versions mismatch');
  assert(manifest.workflow?.event === 'pull_request' &&
    HEX40.test(manifest.workflow.github_sha) && HEX40.test(manifest.workflow.pr_head_sha) &&
    manifest.workflow.github_sha === manifest.workflow.tooling_commit &&
    /^\d+$/.test(manifest.workflow.run_id) && /^\d+$/.test(manifest.workflow.run_attempt) &&
    TOOL_FILES.every((path) => HEX64.test(manifest.workflow.tooling_files?.[path])),
  'Manifest workflow provenance mismatch');
  assert(manifest.archive?.path === ARCHIVE, 'Unexpected archive filename');
  const archive = readFileSync(join(output, ARCHIVE));
  assert(archive.length === manifest.archive.bytes && sha256(archive) === manifest.archive.sha256, 'Archive checksum mismatch');
  const actual = readArchive(archive);
  assert(Array.isArray(manifest.files) && manifest.files.length === actual.size, 'Incomplete file manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    assert(!seen.has(file.path) && actual.get(file.path)?.bytes === file.bytes && actual.get(file.path)?.sha256 === file.sha256, 'File hash/size mismatch');
    seen.add(file.path);
  }
  assert(['worker.js', 'VERSION', 'web/index.html', 'web/sw.js', 'web/_headers', 'web/manifest.json'].every((p) => seen.has(p)) &&
    [...seen].some((p) => /^web\/_astro\/.+\.js$/.test(p)) &&
    [...seen].filter((p) => /^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(p)).length === expected.migration_count &&
    [...seen].every((p) => p === 'worker.js' || p === 'VERSION' || p.startsWith('web/') || /^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(p)),
  'Incomplete or unexpected archive payload');
  return manifest;
}

export function packageArtifact(stage, output, metadata, migrations) {
  assert(!existsSync(output), 'Output directory already exists');
  const files = inventory(stage, migrations);
  mkdirSync(output, { recursive: true });
  try {
    run('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '--no-recursion', '-czf', join(output, ARCHIVE), '--null', '--verbatim-files-from', '-T', '-'], stage,
    process.env, files.map((file) => file.path).join('\0') + '\0');
    const archive = readFileSync(join(output, ARCHIVE));
    const manifest = { schema: 1, ...metadata,
      archive: { path: ARCHIVE, bytes: archive.length, sha256: sha256(archive) }, files };
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    verifyArtifact(output);
    return manifest;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

export function buildEnvironment(home, inherited = process.env) {
  // A fresh HOME + allowlisted environment prevents local wrangler credentials,
  // PUBLIC_* injection, tokens, .npmrc authentication, and deployment vars from
  // reaching installation or compilation. The read-only GitHub token is unused.
  return {
    PATH: inherited.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CI: 'true', LANG: 'C.UTF-8', TZ: 'UTC',
    NODE_OPTIONS: '--max-old-space-size=8192',
    ASTRO_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
    npm_config_update_notifier: 'false',
  };
}
// Workflow commands need escaping even though the normal metadata is hashes and
// validated GitHub URLs. Bound the entire UTF-8 annotation, including its prefix.
export function formatAnnotation(kind, message) {
  assert(kind === 'notice' || kind === 'error', 'Invalid annotation category');
  assert(typeof message === 'string', 'Invalid annotation message');
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const annotation = `::${kind}::${escaped}`;
  assert(Buffer.byteLength(annotation, 'utf8') <= 2000, 'Public annotation size limit exceeded');
  return annotation;
}

// Exception text is never public: filesystem, parser, and subprocess errors may
// contain local paths or data. Only these fixed diagnostic categories are exposed.
export function knownErrorCategory(error) {
  const message = error instanceof Error ? error.message : '';
  const exact = new Map([
    ['Node version must be 22.12.0', 'Runtime version mismatch'],
    ['pnpm version must be 10.18.0', 'Runtime version mismatch'],
    ['Candidate commit mismatch', 'Candidate provenance mismatch'],
    ['Candidate tree mismatch', 'Candidate provenance mismatch'],
    ['Lock hash mismatch', 'Candidate provenance mismatch'],
    ['Tracked source changed', 'Candidate source changed'],
    ['Build tooling changed', 'Build tooling changed'],
    ['Build tooling provenance mismatch', 'Build tooling provenance mismatch'],
    ['Missing workflow provenance', 'Workflow provenance unavailable'],
    ['Build requires the repository pull_request job', 'Workflow context rejected'],
    ['Private/environment file in candidate source', 'Private source file rejected'],
    ['Untracked file in candidate source', 'Untracked source file rejected'],
    ['Private/config/environment file in payload', 'Private payload file rejected'],
    ['Private key in payload', 'Private payload content rejected'],
    ['Incomplete Worker or web output', 'Incomplete application build'],
    ['Incomplete or unexpected migration set', 'Migration inventory mismatch'],
    ['Incomplete migration payload', 'Migration inventory mismatch'],
    ['Migration content mismatch', 'Migration content mismatch'],
    ['Manifest source provenance mismatch', 'Manifest provenance mismatch'],
    ['Manifest workflow provenance mismatch', 'Manifest provenance mismatch'],
    ['Manifest tool versions mismatch', 'Manifest tool versions mismatch'],
    ['Archive checksum mismatch', 'Archive integrity mismatch'],
    ['File hash/size mismatch', 'Artifact file integrity mismatch'],
    ['Missing upload metadata', 'Upload metadata unavailable'],
    ['Public annotation size limit exceeded', 'Public metadata exceeds annotation limit'],
  ]);
  if (exact.has(message)) return exact.get(message);
  const stage = /^(locked dependency install|frontend build|Worker dry-run build|tar|git|pnpm) stage failed \(status (?:-?\d+|unavailable)\); raw output withheld$/.exec(message)?.[1];
  const stages = { 'locked dependency install': 'Locked dependency installation failed',
    'frontend build': 'Frontend build failed', 'Worker dry-run build': 'Worker dry-run build failed',
    tar: 'Artifact packaging failed', git: 'Git verification failed', pnpm: 'pnpm verification failed' };
  return stages[stage] ?? 'Unexpected build or verification failure';
}

function publicMetadata(output, manifest) {
  return {
    candidate_sha: manifest.source.commit,
    candidate_tree: manifest.source.tree,
    lock_sha256: manifest.source.lock_sha256,
    github_sha: manifest.workflow.github_sha,
    pr_head_sha: manifest.workflow.pr_head_sha,
    tar_sha256: manifest.archive.sha256,
    manifest_sha256: sha256(readFileSync(join(output, 'manifest.json'))),
    run_url: `https://github.com/${FIXED.repository}/actions/runs/${manifest.workflow.run_id}/attempts/${manifest.workflow.run_attempt}`,
  };
}

export function assertSeparatePaths(source, tooling, output) {
  const roots = [source, tooling, output].map((path) => resolve(path));
  for (let i = 0; i < roots.length; i++) {
    for (let j = 0; j < roots.length; j++) {
      if (i === j) continue;
      const path = relative(roots[i], roots[j]);
      assert(path !== '' && (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)),
        'Source/tool/output paths must be separate');
    }
  }
  // Existing ancestors must resolve to themselves; output must not traverse a
  // symlink into a source checkout or another preexisting directory.
  for (const path of roots) {
    let ancestor = path;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    assert(realpathSync(ancestor) === ancestor, 'Symlink in build path');
  }
  assert(!existsSync(output), 'Output directory already exists');
}

function build(source, output) {
  const tooling = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert(process.versions.node === FIXED.node, 'Node version must be 22.12.0');
  assert(process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_REPOSITORY === FIXED.repository,
    'Build requires the repository pull_request job');
  assert(HEX40.test(process.env.GITHUB_SHA ?? '') && HEX40.test(process.env.CANDIDATE_PR_HEAD_SHA ?? '') &&
    /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''), 'Missing workflow provenance');
  assert(git(tooling, 'rev-parse', 'HEAD') === process.env.GITHUB_SHA &&
    git(tooling, 'status', '--porcelain=v1', '--untracked-files=all') === '', 'Build tooling provenance mismatch');
  assertSeparatePaths(source, tooling, output);
  const provenance = assertSource(source);
  const expected = { ...FIXED, tree: provenance.tree };
  const migrations = migrationFiles(source);
  const scratch = mkdtempSync(join(tmpdir(), 'projektor-build-'));
  try {
    const home = join(scratch, 'home');
    mkdirSync(home);
    const env = buildEnvironment(home);
    const pnpm = run('pnpm', ['--version'], source, env);
    assert(pnpm === FIXED.pnpm, 'pnpm version must be 10.18.0');
    run('pnpm', ['install', '--frozen-lockfile', '--reporter=silent'], source, env, undefined, 'locked dependency install');
    assertSource(source, expected, true);
    const version = json(join(source, 'apps/web/package.json')).version;
    assert(/^\d+\.\d+\.\d+$/.test(version), 'Unexpected source version');
    const candidateVersion = `${version}+candidate.${FIXED.commit.slice(0, 12)}`;
    run('pnpm', ['--filter', '@projektor/web', 'build'], source, env, undefined, 'frontend build');
    run('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', 'dist',
      '--define', `__PROJEKTOR_VERSION__:"${candidateVersion}"`], join(source, 'apps/api'), env, undefined, 'Worker dry-run build');
    assertSource(source, expected, true);
    const stage = join(scratch, 'stage');
    mkdirSync(stage);
    // Validate the complete generated web tree before copying only public output.
    const webFiles = filesIn(join(source, 'apps/web/dist'));
    const worker = join(source, 'apps/api/dist/index.js');
    assert(lstatSync(worker).isFile() && !lstatSync(worker).isSymbolicLink(), 'Worker output is not a regular file');
    copyFileSync(worker, join(stage, 'worker.js'));
    for (const path of webFiles) {
      mkdirSync(dirname(join(stage, 'web', path)), { recursive: true });
      copyFileSync(join(source, 'apps/web/dist', path), join(stage, 'web', path));
    }
    for (const file of migrations) {
      mkdirSync(dirname(join(stage, file.path)), { recursive: true });
      copyFileSync(join(source, 'packages/db', file.path), join(stage, file.path));
    }
    writeFileSync(join(stage, 'VERSION'), candidateVersion + '\n');
    const manifest = packageArtifact(stage, output, {
      source: provenance,
      tools: { node: process.versions.node, pnpm,
        wrangler: json(join(source, 'apps/api/node_modules/wrangler/package.json')).version,
        tar: run('tar', ['--version'], source, env).split('\n')[0] },
      workflow: { event: process.env.GITHUB_EVENT_NAME, github_sha: process.env.GITHUB_SHA,
        pr_head_sha: process.env.CANDIDATE_PR_HEAD_SHA, tooling_commit: git(tooling, 'rev-parse', 'HEAD'),
        run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
        tooling_files: Object.fromEntries(TOOL_FILES.map((path) => [path, sha256(readFileSync(join(tooling, path)))])) },
    }, migrations);
    assertSource(source, expected, true);
    assert(git(tooling, 'status', '--porcelain=v1', '--untracked-files=all') === '', 'Build tooling changed');
    console.log(JSON.stringify(publicMetadata(output, manifest)));
  } catch (error) {
    // Failure after packaging must not leave something a later step could upload.
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second] = process.argv.slice(2);
    assert(first, 'Usage: build-candidate.mjs build <source> <output> | verify/report <output>');
    if (command === 'build') {
      assert(second, 'Missing output directory');
      build(resolve(first), resolve(second));
    } else {
      assert(command === 'verify' || command === 'report', 'Unknown command');
      const manifest = verifyArtifact(resolve(first));
      const metadata = publicMetadata(resolve(first), manifest);
      if (command === 'report') {
        assert(/^https:\/\/github\.com\/cer12u\/projektor\/actions\/runs\/\d+\/artifacts\/\d+$/.test(process.env.ARTIFACT_URL ?? '') &&
          /^\d+$/.test(process.env.ARTIFACT_ID ?? '') && HEX64.test(process.env.ARTIFACT_DIGEST ?? ''), 'Missing upload metadata');
        Object.assign(metadata, { artifact_url: process.env.ARTIFACT_URL,
          artifact_id: process.env.ARTIFACT_ID, github_artifact_zip_sha256: process.env.ARTIFACT_DIGEST });
      }
      const encoded = JSON.stringify(metadata);
      const notice = command === 'report' ? formatAnnotation('notice', encoded) : null;
      console.log(encoded);
      if (notice) console.log(notice);
    }
  } catch (error) {
    const category = `Candidate build rejected: ${knownErrorCategory(error)}`;
    console.error(category);
    console.log(formatAnnotation('error', category));
    process.exitCode = 1;
  }
}
