/**
 * Heartbeat monitor — prints one status line per minute.
 * Tracks liveness via BullMQ queue state + MongoDB scraped count.
 * Detects "DEAD" when scraped count has not grown and Active==0.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Queue } = require('bullmq');
const Redis = require('ioredis');
const mongoose = require('mongoose');

const INTERVAL_MS = 60 * 1000;

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

const redis = new Redis(connection);
const queue = new Queue('scrape', { connection });

let lastScraped = -1;
let stuckTicks = 0;

async function tick() {
  const time = new Date().toLocaleTimeString();
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'completed', 'delayed');
    const col = mongoose.connection.collection(process.env.MONGO_COLLECTION);
    const scraped = await col.countDocuments({});

    const grew = scraped > lastScraped;
    if (lastScraped === -1) stuckTicks = 0;
    else if (!grew && counts.active === 0) stuckTicks++;
    else stuckTicks = 0;

    const status = stuckTicks >= 2 ? 'DEAD ' : (counts.active > 0 || grew ? 'ALIVE' : 'IDLE ');
    const delta = lastScraped === -1 ? 0 : scraped - lastScraped;

    console.log(
      `[${time}] ${status} | Scraped: ${scraped} (+${delta}) | Active: ${counts.active} | Waiting: ${counts.waiting} | Failed: ${counts.failed}`
    );

    if (stuckTicks >= 2) {
      console.log(`  ^^ No new profiles for ${stuckTicks} minutes and no active jobs. Worker is likely stopped.`);
    }
    lastScraped = scraped;
  } catch (err) {
    console.log(`[${time}] ERROR  | ${err.message}`);
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB });
  console.log(`Heartbeat started — checking every ${INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);
  await tick();
  setInterval(tick, INTERVAL_MS);
})();
