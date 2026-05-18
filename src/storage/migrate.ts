/**
 * Tiny migration runner.
 *
 * Reads migrations/NNNN_<name>.up.sql files in order, applies each one
 * inside a transaction, and records the application in a `_migrations`
 * bookkeeping table.
 *
 * Idempotent: re-running skips migrations already recorded. Operators
 * who prefer their own tooling can ignore this and apply the .sql
 * files directly; the table lookup is the only durable state.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, PoolClient } from 'pg';

export interface MigrationRecord {
  name: string;
  appliedAt: Date;
  sha256: string;
}

const MIGRATIONS_TABLE = '_migrations';

const ensureTableSql = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  sha256      text NOT NULL
);`;

function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/storage/migrate.ts → repo root /migrations
  return join(here, '..', '..', 'migrations');
}

async function listUpMigrations(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.up.sql')).sort();
}

export async function applyMigrations(
  pool: Pool,
  dir = defaultMigrationsDir(),
): Promise<MigrationRecord[]> {
  await pool.query(ensureTableSql);
  const files = await listUpMigrations(dir);
  const applied: MigrationRecord[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    const existing = await pool.query<{ sha256: string }>(
      `SELECT sha256 FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
      [file],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const prevSha = existing.rows[0]?.sha256;
      if (prevSha !== sha) {
        throw new Error(
          `migration ${file} was previously applied with a different sha256 ` +
            `(stored=${prevSha} current=${sha}); migrations are immutable`,
        );
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await applyOne(client, file, sql, sha);
    } finally {
      client.release();
    }
    applied.push({ name: file, appliedAt: new Date(), sha256: sha });
  }
  return applied;
}

async function applyOne(client: PoolClient, file: string, sql: string, sha: string): Promise<void> {
  // The migration files themselves wrap in BEGIN/COMMIT, so we don't
  // start an outer transaction here — that would deadlock on the
  // CREATE TABLE inside a transaction with the bookkeeping insert.
  try {
    await client.query(sql);
    await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, sha256) VALUES ($1, $2)`, [
      file,
      sha,
    ]);
  } catch (err) {
    // Best effort: leave bookkeeping consistent. The migration's own
    // BEGIN/COMMIT either committed or rolled back atomically.
    throw new Error(
      `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function appliedMigrations(pool: Pool): Promise<MigrationRecord[]> {
  await pool.query(ensureTableSql);
  const result = await pool.query<{
    name: string;
    applied_at: Date;
    sha256: string;
  }>(`SELECT name, applied_at, sha256 FROM ${MIGRATIONS_TABLE} ORDER BY name`);
  return result.rows.map((r) => ({
    name: r.name,
    appliedAt: r.applied_at,
    sha256: r.sha256,
  }));
}

/**
 * Walk the down migrations in reverse order and apply them. Use for
 * test teardown only; production rollbacks are an operator-driven
 * exercise.
 */
export async function revertAll(pool: Pool, dir = defaultMigrationsDir()): Promise<void> {
  const upFiles = await listUpMigrations(dir);
  for (const upFile of upFiles.slice().reverse()) {
    const downFile = upFile.replace(/\.up\.sql$/, '.down.sql');
    const sql = await readFile(join(dir, downFile), 'utf8');
    await pool.query(sql);
    await pool.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`, [upFile]);
  }
}
