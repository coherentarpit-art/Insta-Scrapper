/**
 * Resume the BullMQ "scrape" queue after pause-queue.js
 *
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
  await q.resume();
  console.log('Queue "scrape" is RESUMED — workers can process jobs again.');
  await q.close();
})();
