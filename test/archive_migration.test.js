const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { ArchiveStore, MIGRATION_ADVISORY_LOCK_KEY } = require("../archive/archive_store");

function makeMigrationDirectory(sql = "CREATE TABLE archive_migration_contract (id INTEGER PRIMARY KEY);") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-archive-migration-"));
  fs.writeFileSync(path.join(directory, "001_contract.sql"), sql, "utf8");
  return directory;
}

function makeSerializedMigrationPool() {
  const applied = new Set();
  const calls = [];
  let tail = Promise.resolve();

  function connect() {
    let releaseLock = null;
    const client = {
      async query(sql, params = []) {
        calls.push(sql);
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          releaseLock?.();
          releaseLock = null;
          return { rows: [] };
        }
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS archive_schema_migrations")) return { rows: [] };
        if (sql === "SELECT migration_name FROM archive_schema_migrations") {
          return { rows: [...applied].map(migration_name => ({ migration_name })) };
        }
        if (sql.startsWith("INSERT INTO archive_schema_migrations")) {
          applied.add(params[0]);
          return { rows: [] };
        }
        if (sql.includes("BROKEN")) throw Object.assign(new Error("migration failed"), { code: "42601" });
        return { rows: [] };
      },
      release() {}
    };
    client.acquireMigrationLock = async key => {
      assert.equal(key, MIGRATION_ADVISORY_LOCK_KEY);
      const previous = tail;
      tail = new Promise(resolve => { releaseLock = resolve; });
      await previous;
    };
    return client;
  }

  return {
    calls,
    applied,
    connect: async () => connect(),
    end: async () => {}
  };
}

test("migration runner takes one transaction-scoped advisory-lock contract and is repeat-safe", async () => {
  const directory = makeMigrationDirectory();
  const pool = makeSerializedMigrationPool();
  try {
    const first = new ArchiveStore({ pool, migrationsDirectory: directory, migrationLock: client => client.acquireMigrationLock(MIGRATION_ADVISORY_LOCK_KEY) });
    const second = new ArchiveStore({ pool, migrationsDirectory: directory, migrationLock: client => client.acquireMigrationLock(MIGRATION_ADVISORY_LOCK_KEY) });
    await Promise.all([first.migrate(), second.migrate()]);
    assert.deepEqual([...pool.applied], ["001_contract.sql"]);
    assert.equal(pool.calls.filter(sql => sql === "CREATE TABLE archive_migration_contract (id INTEGER PRIMARY KEY);").length, 1);
    assert.equal(pool.calls.filter(sql => sql === "BEGIN").length, 2);
    assert.equal(pool.calls.filter(sql => sql === "COMMIT").length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration failure rolls back, releases the advisory-lock contract, and remains retryable", async () => {
  const directory = makeMigrationDirectory("BROKEN SQL;");
  const pool = makeSerializedMigrationPool();
  const store = new ArchiveStore({ pool, migrationsDirectory: directory, migrationLock: client => client.acquireMigrationLock(MIGRATION_ADVISORY_LOCK_KEY) });
  try {
    await assert.rejects(store.migrate(), { code: "42601" });
    assert.equal(store.migrated, false);
    assert.ok(pool.calls.includes("ROLLBACK"));
    fs.writeFileSync(path.join(directory, "001_contract.sql"), "CREATE TABLE archive_migration_contract (id INTEGER PRIMARY KEY);", "utf8");
    await store.migrate();
    assert.equal(store.migrated, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration connection failure is classified so the archive can disable fail-open", async () => {
  const unavailable = Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" });
  const store = new ArchiveStore({
    pool: {
      connect: async () => { throw unavailable; },
      end: async () => {}
    }
  });
  await assert.rejects(store.migrate(), error => error === unavailable && error.archive_migration === true);
  assert.equal(store.migrated, false);
});

test("real PostgreSQL migration runner contract is opt-in for a dedicated test database", {
  skip: !(process.env.TEST_ARCHIVE_DATABASE_URL && process.env.TEST_ARCHIVE_DATABASE_ALLOW_MIGRATIONS === "true")
}, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.TEST_ARCHIVE_DATABASE_URL });
  const store = new ArchiveStore({ pool });
  try {
    await store.migrate();
    await store.migrate();
    assert.equal(store.migrated, true);
  } finally {
    await store.close();
  }
});
