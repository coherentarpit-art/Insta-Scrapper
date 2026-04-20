/**
 * Store queue job payload in MongoDB (snapshot of who is queued to scrape).
 * This does NOT scrape Instagram — it only persists the same data export-queue.js writes to disk.
 *
 * Reads (in order):
 *   1. backend/queued_usernames.json  (from: node export-queue.js)
 *   2. If missing / --from-redis:     pulls live from Redis like export-queue.js
 *
 * Collection (default): insta_QueuedExports
 *   Env: MONGO_QUEUE_SNAPSHOT_COLL=insta_QueuedExports
 *
 * Usage:
 *   cd scraper
 *   node import-queue-to-mongo.js
 *   node import-queue-to-mongo.js --from-redis
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || 'coherent2026_db';
const COLL = process.env.MONGO_QUEUE_SNAPSHOT_COLL || 'insta_QueuedExports';

const FROM_REDIS = process.argv.includes('--from-redis');

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

const BULL_PREFIX = process.env.BULLMQ_PREFIX || 'bull';
const QUEUE_NAME = 'scrape';

function jobHashKey(jobId) {
  return `${BULL_PREFIX}:${QUEUE_NAME}:${jobId}`;
}

async function loadFromJson() {
  const p = path.join(__dirname, '..', 'backend', 'queued_usernames.json');
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j.jobs || [];
}

async function loadFromRedis() {
  const redis = new Redis(redisConnection);
  const ids = new Set();
  const wait = await redis.lrange(`${BULL_PREFIX}:${QUEUE_NAME}:wait`, 0, -1);
  wait.forEach((id) => ids.add(id));
  const paused = await redis.lrange(`${BULL_PREFIX}:${QUEUE_NAME}:paused`, 0, -1);
  paused.forEach((id) => ids.add(id));
  const delayed = await redis.zrange(`${BULL_PREFIX}:${QUEUE_NAME}:delayed`, 0, -1);
  delayed.forEach((id) => ids.add(id));
  const prioritized = await redis.zrange(`${BULL_PREFIX}:${QUEUE_NAME}:prioritized`, 0, -1);
  prioritized.forEach((id) => ids.add(id));
  const jobIds = [...ids];

  const rows = [];
  const BATCH = 800;
  for (let i = 0; i < jobIds.length; i += BATCH) {
    const slice = jobIds.slice(i, i + BATCH);
    const pipe = redis.pipeline();
    for (const id of slice) pipe.hget(jobHashKey(id), 'data');
    const res = await pipe.exec();
    for (let j = 0; j < slice.length; j++) {
      const jobId = slice[j];
      const dataStr = res[j][1];
      if (!dataStr) continue;
      try {
        const data = JSON.parse(dataStr);
        rows.push({
          jobId: String(jobId),
          username: data.username || '',
          depth: data.depth ?? null,
          source: data.source || null,
          our_category: data.our_category || null,
        });
      } catch {
        /* skip */
      }
    }
  }
  await redis.quit();
  return rows;
}

const snapshotSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, index: true, unique: true },
    username: { type: String, index: true },
    depth: Number,
    source: String,
    our_category: String,
    snapshot_at: { type: Date, default: Date.now, index: true },
    import_source: { type: String, default: 'queued_usernames.json' },
  },
  { strict: true }
);

async function run() {
  if (!MONGO_URI) {
    console.error('MONGO_URI not set in scraper/.env');
    process.exit(1);
  }

  let jobs = null;
  if (!FROM_REDIS) {
    jobs = await loadFromJson();
  }
  if (!jobs || jobs.length === 0 || FROM_REDIS) {
    console.log('Loading jobs from Redis (--from-redis or empty JSON)…');
    jobs = await loadFromRedis();
  } else {
    console.log(`Loading ${jobs.length} jobs from backend/queued_usernames.json`);
  }

  if (!jobs.length) {
    console.error('No jobs to import. Run: node export-queue.js   or   node import-queue-to-mongo.js --from-redis');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
  const Snapshot = mongoose.models.QueueSnapshot || mongoose.model('QueueSnapshot', snapshotSchema, COLL);

  const snapshotAt = new Date();
  let upserted = 0;
  const BATCH = 500;

  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    const ops = slice
      .filter((j) => j.username && j.jobId)
      .map((j) => ({
        updateOne: {
          filter: { jobId: String(j.jobId) },
          update: {
            $set: {
              jobId: String(j.jobId),
              username: j.username,
              depth: j.depth,
              source: j.source || null,
              our_category: j.our_category || null,
              snapshot_at: snapshotAt,
              import_source: FROM_REDIS ? 'redis_queue' : 'queued_usernames.json',
            },
          },
          upsert: true,
        },
      }));
    if (ops.length) {
      const r = await Snapshot.bulkWrite(ops, { ordered: false });
      upserted += (r.upsertedCount || 0) + (r.modifiedCount || 0) + (r.matchedCount || 0);
    }
    if ((i + BATCH) % 2000 === 0 || i + BATCH >= jobs.length) {
      console.log(`  Written ${Math.min(i + BATCH, jobs.length)}/${jobs.length}…`);
    }
  }

  const total = await Snapshot.countDocuments({ snapshot_at: snapshotAt });
  console.log(`\nDone. Collection: ${MONGO_DB}.${COLL}`);
  console.log(`  Jobs in this import: ${jobs.length}`);
  console.log(`  snapshot_at: ${snapshotAt.toISOString()}`);
  console.log('\nNote: These are queue rows only (username, depth, source). Full profile data still comes from the scraper worker into insta_Profiles.\n');

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
