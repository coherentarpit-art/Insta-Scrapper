/**
 * Remove BullMQ "scrape" jobs whose usernames are already done:
 *   - in MongoDB (data.username)
 *   - OR in Redis SET ig:scraped
 *
 * Stops workers first (recommended): Ctrl+C scraper, then run this.
 *
 * Usage:
 *   node prune-queue.js --dry-run     # count only, fast
 *   node prune-queue.js               # actually remove jobs
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const Redis = require('ioredis');
const mongoose = require('mongoose');
const { Queue, Job } = require('bullmq');
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

const BULL_PREFIX = process.env.BULLMQ_PREFIX || 'bull';
const QUEUE_NAME = 'scrape';
const SCRAPED_SET = 'ig:scraped';

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || 'coherent2026_db';
const MONGO_COLL = process.env.MONGO_COLLECTION || 'insta_Profiles';

function jobHashKey(jobId) {
  return `${BULL_PREFIX}:${QUEUE_NAME}:${jobId}`;
}

async function loadKnownUsernames() {
  const known = new Set();

  const redis = new Redis(redisConnection);
  try {
    const scraped = await redis.smembers(SCRAPED_SET);
    for (const u of scraped) {
      if (u) known.add(String(u).toLowerCase());
    }
    console.log(`Redis ${SCRAPED_SET}: ${scraped.length} usernames`);
  } finally {
    await redis.quit();
  }

  if (!MONGO_URI) {
    console.warn('MONGO_URI not set — skipping MongoDB check');
    return known;
  }

  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
  const coll = mongoose.connection.collection(MONGO_COLL);
  const cursor = coll.find({}, { projection: { 'data.username': 1 } }).batchSize(2000);
  let n = 0;
  for await (const doc of cursor) {
    const u = doc?.data?.username;
    if (u) known.add(String(u).toLowerCase());
    n++;
    if (n % 5000 === 0) console.log(`  Mongo scan… ${n} docs`);
  }
  await mongoose.disconnect();
  console.log(`MongoDB ${MONGO_COLL}: ${n} docs → merged set size ${known.size}`);
  return known;
}

async function collectJobIds(redis) {
  const ids = new Set();
  const wait = await redis.lrange(`${BULL_PREFIX}:${QUEUE_NAME}:wait`, 0, -1);
  wait.forEach((id) => ids.add(id));
  const paused = await redis.lrange(`${BULL_PREFIX}:${QUEUE_NAME}:paused`, 0, -1);
  paused.forEach((id) => ids.add(id));
  const delayed = await redis.zrange(`${BULL_PREFIX}:${QUEUE_NAME}:delayed`, 0, -1);
  delayed.forEach((id) => ids.add(id));
  const prioritized = await redis.zrange(`${BULL_PREFIX}:${QUEUE_NAME}:prioritized`, 0, -1);
  prioritized.forEach((id) => ids.add(id));
  return [...ids];
}

async function mapWithConcurrency(items, limit, fn) {
  const ret = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return ret;
}

async function main() {
  console.log('Building username set (Mongo + Redis scraped)…');
  const known = await loadKnownUsernames();

  const redis = new Redis(redisConnection);
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });

  const jobIds = await collectJobIds(redis);
  console.log(`Queue job IDs: ${jobIds.length}\n`);

  const BATCH = 800;
  const toRemove = [];
  let badData = 0;

  for (let i = 0; i < jobIds.length; i += BATCH) {
    const slice = jobIds.slice(i, i + BATCH);
    const pipe = redis.pipeline();
    for (const id of slice) pipe.hget(jobHashKey(id), 'data');
    const res = await pipe.exec();

    for (let j = 0; j < slice.length; j++) {
      const id = slice[j];
      const err = res[j][0];
      const dataStr = res[j][1];
      if (err || !dataStr) {
        badData++;
        continue;
      }
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        badData++;
        continue;
      }
      const raw = data.username;
      if (!raw) continue;
      if (known.has(String(raw).toLowerCase())) {
        toRemove.push({ id, username: raw });
      }
    }
    if ((i + BATCH) % 4000 === 0 || i + BATCH >= jobIds.length) {
      console.log(`  Scanned ${Math.min(i + BATCH, jobIds.length)}/${jobIds.length} jobs, queued-for-removal: ${toRemove.length}`);
    }
  }

  console.log(`\nJobs to remove: ${toRemove.length} (already in Mongo or Redis scraped)`);
  console.log(`Unparseable / empty job data rows: ${badData}\n`);

  const removedList = [];
  let removed = 0;
  let failed = 0;

  if (!DRY && toRemove.length) {
    await mapWithConcurrency(
      toRemove,
      40,
      async ({ id, username }) => {
        try {
          const job = await Job.fromId(queue, id);
          if (!job) return;
          await job.remove();
          removed++;
          removedList.push({ username, jobId: id });
        } catch (e) {
          failed++;
        }
      }
    );
  } else {
    for (const row of toRemove) {
      removed++;
      removedList.push({ username: row.username, jobId: row.id });
    }
  }

  const reportPath = path.join(__dirname, '..', 'backend', 'queue_pruned_usernames.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        dryRun: DRY,
        totalQueuedJobs: jobIds.length,
        matchedAlreadyStored: toRemove.length,
        removed: DRY ? 0 : removed,
        removeFailed: failed,
        samples: removedList.slice(0, 500),
      },
      null,
      2
    )
  );

  await redis.quit();
  await queue.close();

  console.log('══ Result ═══════════════════════════════════');
  console.log(`  Matched (would remove / removed): ${toRemove.length}`);
  if (!DRY) console.log(`  Actually removed:              ${removed}`);
  if (!DRY) console.log(`  Remove errors:                ${failed}`);
  console.log(`  Report:                        ${reportPath}`);
  console.log('════════════════════════════════════════════\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
