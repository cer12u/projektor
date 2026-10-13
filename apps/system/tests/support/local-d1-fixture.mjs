// @module verification
// @role fixture-d1
// Disposable test setup only. Wrangler owns SQL parsing and the migration ledger.
// This never accepts a remote target or an existing database.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL("../../", import.meta.url));
const databaseId = '00000000-0000-0000-0000-000000000001';

export async function prepareLocalD1(temp) {
  const directory = join(temp, 'canonical-d1');
  // Fails if reused: migration application is limited to a fresh test directory.
  await mkdir(directory);
  const config = join(directory, 'wrangler.json');
  await writeFile(config, JSON.stringify({
    name: 'projektor-canonical-test',
    compatibility_date: '2026-10-09',
    d1_databases: [{ binding: 'DB', database_name: 'projektor-canonical-test',
      database_id: databaseId, migrations_dir: join(project, 'migrations'), remote: false }],
  }));
  const packagePath = require.resolve('wrangler/package.json');
  const wrangler = JSON.parse(await readFile(packagePath, 'utf8'));
  const cli = join(dirname(packagePath), wrangler.bin.wrangler);
  const persistence = join(directory, 'state');
  const { stdout, stderr } = await run(process.execPath, ['--require',fileURLToPath(new URL('./local-network-guard.cjs',import.meta.url)),cli, 'd1', 'migrations', 'apply',
    'projektor-canonical-test', '--local', '--config', config, '--persist-to', persistence], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory,
      CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED:'false', WRANGLER_HIDE_BANNER:'true', WRANGLER_SEND_ERROR_REPORTS:'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(directory, 'migrations.log'), stdout + stderr);
  return { d1Databases: { DB: databaseId }, resourcePersistencePath: join(persistence, 'v3'), outboundService:()=>{process.exitCode=86;throw new Error('Local fixture forbids external requests');} };
}

export async function verifyCanonicalLedger(db) {
  const expected = (await readdir(join(project, 'migrations'))).filter(n => n.endsWith('.sql')).sort();
  const rows = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
  assert.deepEqual(rows.map(row => row.name), expected, 'Wrangler applied the complete canonical chain');
}
