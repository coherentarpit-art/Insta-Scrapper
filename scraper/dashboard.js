/**
 * Bull-board dashboard — live web UI for the scrape queue.
 * Read-only observer. Does NOT interfere with the running worker.
 *
 * Usage: node dashboard.js
 * Open:  http://localhost:3030/admin/queues
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const { Queue } = require('bullmq');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

const scrapeQueue = new Queue('scrape', { connection });

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(scrapeQueue)],
  serverAdapter,
});

const app = express();
app.use('/admin/queues', serverAdapter.getRouter());

app.get('/', (req, res) => res.redirect('/admin/queues'));

const PORT = 3030;
app.listen(PORT, () => {
  console.log(`\n  Dashboard running at http://localhost:${PORT}/admin/queues\n`);
});
