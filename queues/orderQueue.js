const { Queue } = require('bullmq');
const IORedis = require('ioredis');

// Create a Redis connection instance
const redisConnection = new IORedis({
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
});

// Create a BullMQ queue named 'order-queue'
// This queue is responsible for storing background order jobs
const orderQueue = new Queue('order-queue', {
  connection: redisConnection,
});

// Export the queue to use it in controllers/services
module.exports = orderQueue;