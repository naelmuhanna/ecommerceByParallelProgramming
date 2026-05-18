// queues/orderWorker.js
const { Worker } = require('bullmq');
const IORedis = require('ioredis');

const startTimeRef = Date.now();

// Worker process logic - connects to Redis and processes jobs only
const redisConnection = new IORedis({
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null
});

// Simulates a CPU-intensive blocking task (blocks the Event Loop)
const blockEventLoop = (ms) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // Busy-wait loop to simulate heavy computation
  }
};

const orderWorker = new Worker(
  'order-queue',
  async (job) => {
    const startJobTime = Date.now();
    const queueWaitingTime = ((startJobTime - startTimeRef) / 1000).toFixed(2);

    console.log(
      `⚡ [Server Process: ${process.pid}] Picked up job: ${job.id} | (Waited in queue: ${queueWaitingTime} seconds)`
    );

    // Simulate heavy processing task
    blockEventLoop(10000);

    const endJobTime = Date.now();
    const totalDuration = ((endJobTime - startTimeRef) / 1000).toFixed(2);

    console.log(
      `✨ [Server Process: ${process.pid}] Finished job: ${job.id} | (Total elapsed time: ${totalDuration} seconds)`
    );
  },
  {
    connection: redisConnection,
    concurrency: 1
  }
);

module.exports = orderWorker;