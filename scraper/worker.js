const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { scrapeFullProfile, discoverSuggestions } = require('./crawler'); // Assuming scrapeFullProfile is exported

// Initialize Redis connection
const redisConnection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null, // Required by BullMQ
});

// Create a worker to process jobs from the queue
const profileWorker = new Worker(
  'profileQueue',
  async (job) => {
    const { username, pk, depth, source, rootSeed } = job.data;
    console.log(`Processing profile: @${username}`);

    try {
      // Scrape the profile
      const result = await scrapeFullProfile(username, depth, source);

      if (result) {
        console.log(`Successfully scraped @${username}`);
        // Add suggestions to the queue (if any)
        await discoverSuggestions(username, result.pk, depth);
      }
    } catch (error) {
      console.error(`Failed to process @${username}: ${error.message}`);
      throw error; // Let BullMQ handle retries
    }
  },
  { connection: redisConnection }
);

// Add logging to track job processing
profileWorker.on('active', (job) => {
  console.log(`Processing job: ${job.id}, Data:`, job.data);
});

profileWorker.on('failed', (job, err) => {
  console.error(`Job failed: ${job.id}, Error: ${err.message}`);
});

profileWorker.on('completed', (job) => {
  console.log(`Job completed: ${job.id}`);
});

console.log('Worker is running and listening for jobs...');