/**
 * Pause the BullMQ "scrape" queue — workers will not pick new jobs until resumed.
 * Does NOT delete jobs or touch MongoDB.
 *
 *   node pause-queue.js
 *
 * Resume later:
 *   node resume-queue.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Queue } = require('bullmq');

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

(async () => {
  const q = new Queue('scrape', { connection: redisConnection });
  await q.pause();
  console.log('Queue "scrape" is PAUSED — no jobs will run until: node resume-queue.js');
  await q.close();
})();
