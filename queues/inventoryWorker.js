const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const mongoose = require('mongoose');
const { performance } = require('perf_hooks');
require('colors');

// Import the model (make sure the path matches your project structure)
const Order = require('../models/orderModel');

// 1. Connect to Redis using the same configuration as your existing setup
const redisConnection = new IORedis({
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
});

// Connect to MongoDB independently for the Worker service
mongoose.connect('mongodb://127.0.0.1:27017/ecommerce')
  .then(() => console.log('📦 Inventory Worker connected to MongoDB successfully.'.green))
  .catch((err) => console.error('❌ MongoDB Connection Error:', err));

// Simulation function adapted from your code to block the event loop
// (safe to use here inside the Worker process)
const blockEventLoop = (ms) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // Synchronous heavy task simulation
  }
};

// 2. Create the Worker to listen to the same 'order-queue'
const inventoryWorker = new Worker(
  'order-queue',
  async (job) => {
    // Check the incoming job name
    if (job.name === 'generate-daily-inventory') {
      console.log(`\n⚙️  [Worker] Started processing heavy inventory job: ${job.id}`.yellow);
      
      const startTime = performance.now();
      const memBefore = process.memoryUsage().heapUsed;

      const report = {
        totalRevenue: 0,
        totalItemsSold: 0,
        cashOrders: 0,
        cardOrders: 0
      };

      try {
        // 🔥 Combining Queue + Stream for maximum architectural efficiency
        // Open a MongoDB cursor stream - only one document is loaded into memory at a time
        const orderStream = Order.find({}).cursor();

        // eslint-disable-next-line no-await-in-loop
        for (let order = await orderStream.next(); order != null; order = await orderStream.next()) {
          report.totalRevenue += order.totalOrderPrice || 0;

          if (order.paymentMethodType === 'cash') {
            report.cashOrders += 1;
          }

          if (order.paymentMethodType === 'card') {
            report.cardOrders += 1;
          }

          if (order.cartItems && Array.isArray(order.cartItems)) {
            order.cartItems.forEach((item) => {
              report.totalItemsSold += item.quantity || 0;
            });
          }
        }

        // ⏳ Simulate heavy data processing and external service latency (3 seconds)
        console.log('⏳ [Worker] Simulating heavy external data processing & validation...'.yellow);

        blockEventLoop(3000);

        const memAfter = process.memoryUsage().heapUsed;
        const endTime = performance.now();

        const timeTaken = ((endTime - startTime) / 1000).toFixed(3);
        const memUsed = ((memAfter - memBefore) / 1024 / 1024).toFixed(2);

        console.log('✅ [Worker] Heavy Inventory Aggregation Completed Successfully!'.green.bold);
        console.log(`📊 [Worker] Report: Revenue=${report.totalRevenue} | Items Sold=${report.totalItemsSold}`.cyan);
        console.log(`⏱️  [Worker] Time spent on external processing: ${timeTaken} seconds`.yellow);
        console.log(`🧠 [Worker] Worker RAM Usage Spike: +${memUsed} MB`.yellow);

      } catch (error) {
        console.error(`❌ [Worker] Error during stream processing inside job ${job.id}:`, error);
        throw error;
      }
    }
  },
  {
    connection: redisConnection,

    // Process only one report at a time to protect the external service stability
    concurrency: 1
  }
);

// Error handling
inventoryWorker.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed with error: ${err.message}`.red);
});