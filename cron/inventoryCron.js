const cron = require('node-cron');
require('colors');

// Import the same Queue already used in your project
const orderQueue = require('../queues/orderQueue');

/**
 * @desc High-Performance Inventory Cron Job
 * Offloads the heavy reporting workload entirely to BullMQ
 */
const startOptimizedInventoryCron = () => {
  // Keep the same schedule pattern (every 5 minutes for development/testing)
  cron.schedule('*/5 * * * *', async () => {
    console.log('\n📡 [CRON] Midnight reached! Triggering daily inventory report...'.cyan);

    try {
      // 🔥 Push the job ticket into Redis. Takes less than 2ms!
      const job = await orderQueue.add(
        'generate-daily-inventory',
        {
          initiatedAt: new Date(),
          scope: 'all-orders'
        },
        {
          attempts: 2,

          // Retry after 10 seconds if the job fails
          backoff: 10000,
        }
      );

      console.log(`⚡ [CRON] Job ${job.id} dispatched to Redis. Express Server is FREE!`.green.bold);

    } catch (error) {
      console.error('❌ [CRON] Error dispatching inventory job to Queue:', error);
    }
  });
};

module.exports = startOptimizedInventoryCron;