// Compares a restored copy with the database it came from. Used by scripts/backup-drill.sh, and
// usable on its own after any restore:
//
//   node scripts/verify-restore.js "postgres://…/postgres" "postgres://…/booking_restore"
//   VERIFY_IGNORE="api_rate_limits,booking_reminders" node scripts/verify-restore.js …
//
// It answers one question: did every table, every row, every RLS flag and every function arrive?
// A restore that "worked" but silently lost a table is the failure this catches.
const { Client } = require("pg");
const { sslConfig } = require("../src/v2/db");

// Rows written by the running app keep changing while the dump is taken; their exact count is not
// a restore problem. Everything else must match exactly.
const DEFAULT_IGNORED = ["api_rate_limits"];

function connect(url) {
  const client = new Client({ connectionString: url, ssl: sslConfig(url) });
  return client.connect().then(() => client);
}

async function tables(client) {
  const { rows } = await client.query(
    `select c.relname as name, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by 1`,
  );
  return rows;
}

async function rowCount(client, table) {
  const { rows } = await client.query(`select count(*)::int as n from public."${table.replace(/"/g, '""')}"`);
  return rows[0].n;
}

async function policies(client) {
  const { rows } = await client.query(
    `select schemaname || '.' || tablename as table, count(*)::int as n
       from pg_policies where schemaname = 'public' group by 1 order by 1`,
  );
  return rows;
}

async function functions(client) {
  const { rows } = await client.query(
    `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' order by 1, 2`,
  );
  return rows;
}

function diffSets(a, b) {
  const key = (row) => Object.values(row).join(" ");
  const left = new Set(a.map(key));
  const right = new Set(b.map(key));
  return {
    missing: [...left].filter((k) => !right.has(k)),
    extra: [...right].filter((k) => !left.has(k)),
  };
}

async function main() {
  const [sourceUrl, targetUrl] = process.argv.slice(2);
  if (!sourceUrl || !targetUrl) {
    console.error("usage: node scripts/verify-restore.js <source-url> <restore-url>");
    process.exit(2);
  }
  const ignored = new Set(
    (process.env.VERIFY_IGNORE ?? DEFAULT_IGNORED.join(","))
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );

  const [source, target] = await Promise.all([connect(sourceUrl), connect(targetUrl)]);
  const problems = [];

  try {
    const [sourceTables, targetTables] = await Promise.all([tables(source), tables(target)]);
    const missingTables = diffSets(sourceTables, targetTables).missing;
    for (const row of missingTables) problems.push(`table missing after restore: ${row}`);
    for (const row of diffSets(sourceTables, targetTables).extra) problems.push(`unexpected table: ${row}`);

    console.log("table                     rows      restored  rls");
    for (const table of sourceTables) {
      const restored = targetTables.find((t) => t.name === table.name);
      if (!restored) continue;
      const [before, after] = await Promise.all([rowCount(source, table.name), rowCount(target, table.name)]);
      const skipped = ignored.has(table.name);
      const same = before === after;
      const mark = same || skipped ? "  ok" : "DIFF";
      if (!same && !skipped) problems.push(`row count differs for ${table.name}: ${before} -> ${after}`);
      if (!restored.rls && table.rls) problems.push(`RLS was on for ${table.name} and is off after restore`);
      console.log(`${table.name.padEnd(24)} ${String(before).padStart(8)}  ${String(after).padStart(8)}  ${table.rls ? "on " : "off"} ${skipped ? "(ignored)" : mark}`);
    }

    const [sourcePolicies, targetPolicies] = await Promise.all([policies(source), policies(target)]);
    for (const row of diffSets(sourcePolicies, targetPolicies).missing) problems.push(`policies lost on ${row}`);
    for (const row of diffSets(sourcePolicies, targetPolicies).extra) problems.push(`unexpected policies on ${row}`);

    const [sourceFunctions, targetFunctions] = await Promise.all([functions(source), functions(target)]);
    for (const row of diffSets(sourceFunctions, targetFunctions).missing) problems.push(`function missing after restore: ${row}`);

    if (problems.length) {
      console.error("\nrestore verification FAILED");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(`\nrestore verification passed: ${sourceTables.length} tables, ${sourceFunctions.length} functions match`);
    }
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

main().catch((error) => {
  console.error("verify-restore failed:", error.message);
  process.exit(1);
});
