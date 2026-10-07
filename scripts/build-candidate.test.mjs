import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  FIXED, assertSeparatePaths, assertSource, buildEnvironment, formatAnnotation, knownErrorCategory, migrationFiles,
  packageArtifact, readArchive, safePath, sha256, verifyArtifact,
} from './build-candidate.mjs';

// These deliberately tiny fixtures test rejection logic, not the application
// build. They never stand in for the separately checked-out candidate artifact.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'build-candidate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  mkdirSync(stage);
  const write = (path, text = 'fixture\n') => {
    mkdirSync(join(stage, path, '..'), { recursive: true });
    writeFileSync(join(stage, path), text);
  };
  for (const path of ['worker.js', 'VERSION', 'web/index.html', 'web/sw.js',
    'web/_headers', 'web/manifest.json', 'web/_astro/chunk.js']) write(path);
  const migrations = Array.from({ length: 72 }, (_, index) => {
    const path = `migrations/${String(index).padStart(4, '0')}_fixture.sql`;
    const text = `-- fixture ${index}\n`;
    write(path, text);
    return { path, sha256: sha256(text) };
  });
  const metadata = {
    source: { repository: FIXED.repository, commit: FIXED.commit,
      tree: 'a'.repeat(40), lock_sha256: FIXED.lock_sha256 },
    tools: { node: FIXED.node, pnpm: FIXED.pnpm, wrangler: '4.0.0', tar: 'fixture' },
    workflow: { event: 'pull_request', github_sha: 'b'.repeat(40),
      pr_head_sha: 'c'.repeat(40), tooling_commit: 'b'.repeat(40), run_id: '1', run_attempt: '1',
      tooling_files: Object.fromEntries(['.github/workflows/build-candidate.yml',
        'scripts/build-candidate.mjs', 'scripts/build-candidate.test.mjs'].map((p) => [p, 'd'.repeat(64)])) },
  };
  const output = join(root, 'output');
  const pack = () => packageArtifact(stage, output, metadata, migrations);
  const changeManifest = (fn) => {
    const path = join(output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path));
    fn(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };
  return { root, stage, write, migrations, metadata, output, pack, changeManifest };
}

test('one coherent tar and manifest verify with distinct candidate and workflow SHAs', (t) => {
  const f = fixture(t);
  const manifest = f.pack();
  assert.equal(manifest.files.length, 79);
  assert.equal(manifest.source.commit, FIXED.commit);
  assert.notEqual(manifest.source.commit, manifest.workflow.github_sha);
  assert.deepEqual(verifyArtifact(f.output), manifest);
  assert.equal(readArchive(readFileSync(join(f.output, manifest.archive.path))).size, 79);
  const listed = execFileSync('tar', ['-tzf', join(f.output, manifest.archive.path)], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(listed, manifest.files.map((f) => f.path));
});

for (const path of ['worker.js', 'web/index.html', 'web/sw.js', 'web/_headers',
  'web/manifest.json', 'web/_astro/chunk.js', 'migrations/0071_fixture.sql']) {
  test(`reject incomplete output: ${path}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.stage, path));
    assert.throws(f.pack, /Incomplete/);
  });
}
for (const path of ['wrangler.toml', 'web/.env', 'web/.dev.vars', 'web/private.json',
  'web/deploy-settings.json', 'web/settings.json', 'web/config.json', 'web/credentials.json', 'web/private.key', 'web/_astro/chunk.js.map']) {
  test(`reject private/config/environment payload: ${path}`, (t) => {
    const f = fixture(t);
    f.write(path);
    assert.throws(f.pack, /Private/);
  });
}

test('reject embedded private keys', (t) => {
  const f = fixture(t);
  f.write('web/innocent.txt', '-----BEGIN PRIVATE KEY-----\nfixture');
  assert.throws(f.pack, /Private key/);
});
test('reject unlisted root payload and extra migration', (t) => {
  const f = fixture(t);
  f.write('notes.txt');
  assert.throws(f.pack, /Unexpected/);
  rmSync(join(f.stage, 'notes.txt'));
  f.write('migrations/9999_extra.sql');
  assert.throws(f.pack, /Incomplete migration/);
});
test('reject altered migration bytes even when filenames/count match', (t) => {
  const f = fixture(t);
  f.write('migrations/0000_fixture.sql', '-- altered\n');
  assert.throws(f.pack, /Migration content mismatch/);
});
test('reject file and directory symlinks and hard links', (t) => {
  const f = fixture(t);
  symlinkSync(join(f.stage, 'worker.js'), join(f.stage, 'web/alias.js'));
  assert.throws(f.pack, /Symlink/);
  rmSync(join(f.stage, 'web/alias.js'));
  symlinkSync(join(f.stage, 'migrations'), join(f.stage, 'web/alias'));
  assert.throws(f.pack, /Symlink/);
  rmSync(join(f.stage, 'web/alias'));
  linkSync(join(f.stage, 'worker.js'), join(f.stage, 'web/alias.js'));
  assert.throws(f.pack, /hard-linked/);
});
test('reject unsafe paths', () => {
  for (const path of ['/root', '../secret', 'web/../secret', 'web//file', 'web\\file', 'web/./file', 'web/file\n']) {
    assert.throws(() => safePath(path), /Unsafe/);
  }
});
test('reject preexisting output without changing it', (t) => {
  const f = fixture(t);
  mkdirSync(f.output);
  writeFileSync(join(f.output, 'keep'), 'unchanged');
  assert.throws(f.pack, /already exists/);
  assert.equal(readFileSync(join(f.output, 'keep'), 'utf8'), 'unchanged');
});

for (const [label, mutate] of [
  ['wrong candidate SHA', (m) => { m.source.commit = 'f'.repeat(40); }],
  ['missing tree', (m) => { delete m.source.tree; }],
  ['wrong lock hash', (m) => { m.source.lock_sha256 = '0'.repeat(64); }],
  ['wrong repository', (m) => { m.source.repository = 'someone/else'; }],
  ['missing actual workflow SHA', (m) => { delete m.workflow.github_sha; }],
  ['wrong tools SHA', (m) => { m.workflow.tooling_commit = m.source.commit; }],
  ['missing helper hash', (m) => { delete m.workflow.tooling_files['scripts/build-candidate.mjs']; }],
  ['wrong Node', (m) => { m.tools.node = '24.0.0'; }],
  ['wrong pnpm', (m) => { m.tools.pnpm = '10.19.0'; }],
  ['wrong event', (m) => { m.workflow.event = 'workflow_dispatch'; }],
  ['missing file record', (m) => { m.files.pop(); }],
  ['duplicate file record', (m) => { m.files[1] = m.files[0]; }],
  ['wrong file hash', (m) => { m.files[0].sha256 = 'e'.repeat(64); }],
  ['wrong file size', (m) => { m.files[0].bytes += 1; }],
]) {
  test(`reject manifest corruption: ${label}`, (t) => {
    const f = fixture(t);
    f.pack();
    f.changeManifest(mutate);
    assert.throws(() => verifyArtifact(f.output));
  });
}
test('reject tar corruption and mismatched externally supplied tree', (t) => {
  const f = fixture(t);
  const manifest = f.pack();
  assert.throws(() => verifyArtifact(f.output, { ...FIXED, tree: '0'.repeat(40) }), /provenance/);
  const path = join(f.output, manifest.archive.path);
  const bytes = readFileSync(path);
  bytes[20] ^= 1;
  writeFileSync(path, bytes);
  assert.throws(() => verifyArtifact(f.output), /Archive checksum/);
});

function rewriteHeader(bytes, mutate) {
  mutate(bytes.subarray(0, 512));
  bytes.fill(32, 148, 156);
  const sum = [...bytes.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0);
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return gzipSync(bytes);
}
for (const [label, mutate] of [
  ['symlink', (h) => { h[156] = 50; }],
  ['hard link', (h) => { h[156] = 49; }],
  ['PAX extension', (h) => { h[156] = 120; }],
  ['private name', (h) => { h.fill(0, 0, 100); h.write('web/.env'); }],
  ['path traversal', (h) => { h.fill(0, 0, 100); h.write('../outside'); }],
]) {
  test(`reject hostile tar entry: ${label}`, (t) => {
    const f = fixture(t);
    const manifest = f.pack();
    const tar = gunzipSync(readFileSync(join(f.output, manifest.archive.path)));
    assert.throws(() => readArchive(rewriteHeader(tar, mutate)));
  });
}
test('reject malformed/truncated tar independently of outer checksum', (t) => {
  const f = fixture(t);
  const manifest = f.pack();
  const tar = gunzipSync(readFileSync(join(f.output, manifest.archive.path)));
  assert.throws(() => readArchive(gzipSync(tar.subarray(0, 600))));
  tar[0] ^= 1;
  assert.throws(() => readArchive(gzipSync(tar)), /header checksum/);
});

function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-source-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'fixture lock\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.astro/\n.env\n');
  mkdirSync(join(root, 'apps/web'), { recursive: true });
  writeFileSync(join(root, 'apps/web/.env.example'), 'PUBLIC_EXAMPLE=example\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'test fixture');
  const expected = { ...FIXED, commit: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'), lock_sha256: sha256('fixture lock\n') };
  return { root, git, expected };
}
test('source fixtures are accepted only for their actual commit/tree/lock', (t) => {
  const f = sourceFixture(t);
  assert.equal(assertSource(f.root, f.expected).tree, f.expected.tree);
  assert.throws(() => assertSource(f.root), /commit mismatch/);
  assert.throws(() => assertSource(f.root, { ...f.expected, tree: '0'.repeat(40) }), /tree mismatch/);
  assert.throws(() => assertSource(f.root, { ...f.expected, lock_sha256: '0'.repeat(64) }), /Lock hash/);
});
test('reject dirty tracked files and staged changes', (t) => {
  const f = sourceFixture(t);
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'changed');
  assert.throws(() => assertSource(f.root, f.expected), /Tracked source/);
  f.git('add', 'pnpm-lock.yaml');
  assert.throws(() => assertSource(f.root, f.expected), /Tracked source/);
});
for (const path of ['untracked.txt', '.env', 'apps/web/.env.local', 'apps/web/dist/.env']) {
  test(`reject unknown/ignored/private source file: ${path}`, (t) => {
    const f = sourceFixture(t);
    mkdirSync(join(f.root, path, '..'), { recursive: true });
    writeFileSync(join(f.root, path), 'must not be compiled');
    assert.throws(() => assertSource(f.root, f.expected, true), /Untracked|Private/);
  });
}
test('allow only expected build products after preflight', (t) => {
  const f = sourceFixture(t);
  mkdirSync(join(f.root, 'apps/web/dist'), { recursive: true });
  writeFileSync(join(f.root, 'apps/web/dist/index.html'), 'generated');
  assert.throws(() => assertSource(f.root, f.expected), /Untracked/);
  assert.doesNotThrow(() => assertSource(f.root, f.expected, true));
  symlinkSync('/outside', join(f.root, 'apps/web/dist/alias'));
  assert.throws(() => assertSource(f.root, f.expected, true), /Non-regular/);
});
test('migration inventory requires exactly the pinned source count', (t) => {
  const f = sourceFixture(t);
  assert.throws(() => migrationFiles(f.root), /Incomplete/);
});
test('build subprocess environment drops credentials and PUBLIC overrides', () => {
  const result = buildEnvironment('/fixture/home', { PATH: '/bin',
    CLOUDFLARE_API_TOKEN: 'private', GITHUB_TOKEN: 'private', PUBLIC_WORKSPACE_SLUG: 'private',
    NODE_OPTIONS: '--require=/private', NPM_CONFIG_USERCONFIG: '/private/.npmrc',
    HOME: '/private' });
  assert.equal(result.PATH, '/bin');
  assert.equal(result.HOME, '/fixture/home');
  assert.equal(result.PUBLIC_WORKSPACE_SLUG, undefined);
  assert.equal(result.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(result.NODE_OPTIONS, '--max-old-space-size=8192');
});

test('workflow remains PR-only, read-only, separate-source, pinned, and bounded', () => {
  const workflow = readFileSync(new URL('../.github/workflows/build-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_dispatch|workflow_run|secrets\.|contents: write|id-token: write/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/g);
  assert.match(workflow, new RegExp(`ref: ${FIXED.commit}`));
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /path: tooling/);
  assert.match(workflow, /path: candidate/);
  assert.match(workflow, /node-version: '22.12.0'/);
  assert.match(workflow, /version: '10.18.0'/);
  assert.match(workflow, /node --test tooling\/scripts\/build-candidate.test.mjs/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /retention-days: 7/);
  assert.match(workflow, /timeout-minutes: 25/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /include-hidden-files: false/);
});


test('public settings routes are not confused with private deployment settings', (t) => {
  const f = fixture(t);
  f.write('web/settings/groups/index.html', 'public application route');
  f.write('web/settings/tokens/index.html', 'public application route');
  assert.doesNotThrow(f.pack);
});
test('build paths must be disjoint, new, and free of symlink ancestors', (t) => {
  const f = fixture(t);
  const source = join(f.root, 'source');
  const tooling = join(f.root, 'tooling');
  mkdirSync(source);
  mkdirSync(tooling);
  assert.doesNotThrow(() => assertSeparatePaths(source, tooling, f.output));
  for (const output of [source, f.root, join(source, 'output'), join(tooling, 'output')]) {
    assert.throws(() => assertSeparatePaths(source, tooling, output), /separate/);
  }
  assert.throws(() => assertSeparatePaths(source, source, f.output), /separate/);
  symlinkSync(source, join(f.root, 'alias'));
  assert.throws(() => assertSeparatePaths(source, tooling, join(f.root, 'alias/output')), /Symlink/);
  mkdirSync(f.output);
  assert.throws(() => assertSeparatePaths(source, tooling, f.output), /already exists/);
});


test('annotation escapes percent, CR, and LF without allowing a second command', () => {
  const result = formatAnnotation('notice', 'hash%\r\n::error::injected');
  assert.equal(result, '::notice::hash%25%0D%0A::error::injected');
  assert.doesNotMatch(result, /[\r\n]/);
  assert.throws(() => formatAnnotation('warning', 'value'), /category/);
});
test('annotation bound counts UTF-8 bytes, prefix, and escaping expansion', () => {
  assert.equal(Buffer.byteLength(formatAnnotation('notice', 'x'.repeat(1990))), 2000);
  for (const message of ['x'.repeat(1991), 'é'.repeat(996), '%'.repeat(664), '\n'.repeat(664)]) {
    assert.throws(() => formatAnnotation('notice', message), /size limit/);
  }
});
test('unknown errors never export arbitrary exception text', () => {
  for (const error of [new Error('secret path /private/token%\r\n::notice::leak'),
    new Error('Candidate commit mismatch\nprivate'), { message: 'secret' }, 'secret', null]) {
    assert.equal(knownErrorCategory(error), 'Unexpected build or verification failure');
  }
  assert.equal(knownErrorCategory(new Error('Candidate commit mismatch')), 'Candidate provenance mismatch');
  assert.equal(knownErrorCategory(new Error('frontend build stage failed (status 1); raw output withheld')), 'Frontend build failed');
});
test('report emits one bounded native notice with only public verified metadata', (t) => {
  const f = fixture(t);
  f.pack();
  const result = spawnSync(process.execPath, [new URL('./build-candidate.mjs', import.meta.url).pathname, 'report', f.output], {
    encoding: 'utf8', env: { ...process.env,
      ARTIFACT_URL: 'https://github.com/cer12u/projektor/actions/runs/1/artifacts/2',
      ARTIFACT_ID: '2', ARTIFACT_DIGEST: 'e'.repeat(64) },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], formatAnnotation('notice', lines[0]));
  assert.ok(Buffer.byteLength(lines[1], 'utf8') <= 2000);
  const metadata = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(metadata), ['candidate_sha', 'candidate_tree', 'lock_sha256',
    'github_sha', 'pr_head_sha', 'tar_sha256', 'manifest_sha256', 'run_url',
    'artifact_url', 'artifact_id', 'github_artifact_zip_sha256']);
});
test('CLI failure preserves nonzero status and publishes only a known error category', (t) => {
  const f = fixture(t);
  const privatePath = join(f.root, 'private-token-must-not-appear');
  const result = spawnSync(process.execPath, [new URL('./build-candidate.mjs', import.meta.url).pathname, 'verify', privatePath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), '::error::Candidate build rejected: Unexpected build or verification failure');
  assert.doesNotMatch(result.stdout + result.stderr, /private-token-must-not-appear|ENOENT/);
});
