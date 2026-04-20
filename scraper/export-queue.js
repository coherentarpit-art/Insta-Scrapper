/**
 * Export all usernames currently in the BullMQ "scrape" queue
 * (waiting + paused + delayed + prioritized) to a local file.
 *
 * Usage:
 *   node export-queue.js
 *
 * Output:
 *   backend/queued_usernames.json   — array of { username, jobId, depth, source }
 *   backend/queued_usernames.txt    — one @username per line
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

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

async function main() {
  const redis = new Redis(redisConnection);
  const jobIds = await collectJobIds(redis);
  console.log(`Found ${jobIds.length} job(s) in queue\n`);

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
          jobId,
          username: data.username || '',
          depth: data.depth ?? null,
          source: data.source || null,
          our_category: data.our_category || null,
        });
      } catch {
        /* skip */
      }
    }
    if ((i + BATCH) % 4000 === 0 || i + BATCH >= jobIds.length) {
      console.log(`  Parsed ${Math.min(i + BATCH, jobIds.length)}/${jobIds.length}…`);
    }
  }

  await redis.quit();

  const outJson = path.join(__dirname, '..', 'backend', 'queued_usernames.json');
  const outTxt = path.join(__dirname, '..', 'backend', 'queued_usernames.txt');

  fs.writeFileSync(outJson, JSON.stringify({ exported_at: new Date().toISOString(), count: rows.length, jobs: rows }, null, 2));
  fs.writeFileSync(
    outTxt,
    rows.map((r) => (r.username ? `@${r.username}` : `#${r.jobId}`)).join('\n') + '\n'
  );

  console.log(`\nWritten:`);
  console.log(`  ${outJson}`);
  console.log(`  ${outTxt}`);
  console.log(`\nTotal usernames: ${rows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
