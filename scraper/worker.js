/**
 * Worker Manager — starts one dedicated worker process per Instagram account.
 *
 * Each worker process:
 *   - Uses a single account (no sharing between processes)
 *   - Reads from the shared Redis scrape queue
 *   - Writes to the shared MongoDB collection
 *   - Auto-restarts if it crashes
 *
 * Usage:
 *   node worker.js                    # Auto-start all accounts in .env
 *   node worker.js --accounts 1,2,3   # Start only accounts 1, 2 and 3
 *   node worker.js --status           # Show which workers are running
 *
 * Each account gets concurrency 1 by default (safe).
 * Total throughput = number_of_accounts × ~200 profiles/hour
 *
 * Examples:
 *   3 accounts → ~600/hour → ~14,400/day → 100,800/week  ✅ (hits 1 lakh)
 *   5 accounts → ~1,000/hour → ~24,000/day → 168,000/week ✅
 *  10 accounts → ~2,000/hour → ~48,000/day → 336,000/week ✅
 */

const { spawn } = require('child_process');
const path     = require('path');
const fs       = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--status')) {
  showStatus();
  process.exit(0);
}

// Which accounts to start
let accountNums = [];
const accArg = args.indexOf('--accounts');
if (accArg >= 0) {
  accountNums = args[accArg + 1].split(',').map(n => parseInt(n.trim())).filter(Boolean);
} else {
  // Auto-detect all accounts configured in .env
  for (let i = 1; i <= 10; i++) {
    const cookies = process.env[`IG_ACC${i}_COOKIES`];
    const csrf    = process.env[`IG_ACC${i}_CSRF`];
    if (cookies && csrf && !cookies.includes('REPLACE_ME')) {
      accountNums.push(i);
    }
  }
}

if (accountNums.length === 0) {
  console.error(`
ERROR: No accounts found in scraper/.env

Add at least one account:
  IG_ACC1_COOKIES=csrftoken=XXX; sessionid=XXX; ds_user_id=XXX; datr=XXX
  IG_ACC1_CSRF=XXX

See .env.example for instructions on getting credentials.
`);
  process.exit(1);
}

// ── Worker process tracking ───────────────────────────────────────────────────
const workers = new Map(); // accountNum → { process, restarts, startedAt }

function spawnWorker(accNum) {
  const crawlerPath = path.join(__dirname, 'queue-crawler.js');
  const workerArgs  = ['queue-crawler.js', 'start', '--concurrency', '1', '--account', String(accNum)];
  const label       = `[Worker #${accNum}]`;

  const child = spawn(process.execPath, workerArgs, {
    cwd: __dirname,
    stdio: 'pipe',
    env: process.env,
  });

  const info = workers.get(accNum) || { restarts: 0, startedAt: new Date() };
  info.process  = child;
  info.pid      = child.pid;
  info.account  = accNum;
  info.lastStart = new Date();
  workers.set(accNum, info);

  const prefix = `${label} `;

  child.stdout.on('data', (data) => {
    process.stdout.write(data.toString().replace(/^/gm, prefix));
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(data.toString().replace(/^/gm, prefix));
  });

  child.on('exit', (code, signal) => {
    const entry = workers.get(accNum);
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.log(`${label} Stopped (${signal})`);
      return;
    }
    entry.restarts = (entry.restarts || 0) + 1;
    const delay = Math.min(5000 * entry.restarts, 60000); // Back-off: 5s, 10s, … 60s max
    console.log(`${label} Exited (code ${code}). Restarting in ${delay / 1000}s... (restart #${entry.restarts})`);
    setTimeout(() => spawnWorker(accNum), delay);
  });

  console.log(`${label} Started (PID ${child.pid}) — Account #${accNum}`);
  return child;
}

function showStatus() {
  if (workers.size === 0) {
    console.log('No workers running (call node worker.js to start)');
    return;
  }
  console.log('\n══ Worker Status ══════════════════════════════');
  for (const [acc, info] of workers) {
    const uptime = info.lastStart
      ? Math.round((Date.now() - info.lastStart) / 60000) + ' min'
      : '?';
    console.log(`  Account #${acc}  PID ${info.pid}  up ${uptime}  restarts: ${info.restarts || 0}`);
  }
  console.log('═══════════════════════════════════════════════\n');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\nReceived ${signal} — stopping all workers...`);
  for (const [acc, info] of workers) {
    if (info.process && !info.process.killed) {
      info.process.kill('SIGTERM');
      console.log(`  Account #${acc} (PID ${info.pid}) sent SIGTERM`);
    }
  }
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Status ticker ─────────────────────────────────────────────────────────────
setInterval(() => showStatus(), 5 * 60 * 1000); // Print status every 5 min

// ── Start all workers ─────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════╗
║           INSTASCRAPER WORKER MANAGER            ║
╠══════════════════════════════════════════════════╣
║  Starting ${String(accountNums.length).padEnd(2)} account(s): ${accountNums.join(', ').padEnd(20)} ║
║  Est. throughput: ~${String(accountNums.length * 200).padEnd(6)}/hour                  ║
║  Est. per week:   ~${String(accountNums.length * 200 * 24 * 7).padEnd(8)} profiles           ║
╚══════════════════════════════════════════════════╝
`);

for (const accNum of accountNums) {
  spawnWorker(accNum);
  // Small stagger to avoid all workers hammering at exactly the same time
  // (synchronous sleep — only runs at startup)
  const start = Date.now();
  while (Date.now() - start < 2000) { /* stagger 2s */ }
}

console.log(`\nAll ${accountNums.length} worker(s) started. Press Ctrl+C to stop all.\n`);
