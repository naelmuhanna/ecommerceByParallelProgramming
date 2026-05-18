const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const Product = require('../models/productModel');

// 1. Redis Connection Configuration
// Ensure your local Redis server is running on port 6379
const connection = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

// 2. Initialize the BullMQ Queue
// Your API routes will use this instance to push image jobs into Redis
const imageQueue = new Queue('productImages', { connection });

// 3. Initialize the Background Worker
// This listener runs completely out-of-band to pull jobs from Redis and run Sharp
const worker = new Worker('productImages', async (job) => {
  const { productId, files = {} } = job.data || {};
  const uploadDir = path.join(__dirname, '../uploads/products');

  // Verify the target uploads directory exists dynamically
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const updatePayload = {};

  // --- Task A: Process Cover Image ---
  if (files.imageCover) {
    const imageCoverFileName =
      files.imageCover.filename || `product-${productId}-${Date.now()}-cover.jpeg`;
    const outputPath = path.join(uploadDir, imageCoverFileName);

    // Sharp processes the image completely isolated from the main API Event Loop
    await sharp(files.imageCover.tmpPath)
      .resize(2000, 1333)
      .toFormat('jpeg')
      .jpeg({ quality: 95 })
      .toFile(outputPath);

    updatePayload.imageCover = imageCoverFileName;

    if (files.imageCover.tmpPath) {
      try {
        await fs.promises.unlink(files.imageCover.tmpPath);
      } catch (err) {
        console.error(`[Queue Worker] Failed to delete tmp file: ${err.message}`);
      }
    }
  }

  // --- Task B: Process Gallery Images ---
  if (files.images && files.images.length > 0) {
    const imageNames = [];
    
    for (let i = 0; i < files.images.length; i+=1) {
      const imageName =
        files.images[i].filename || `product-${productId}-${Date.now()}-${i + 1}.jpeg`;
      const outputPath = path.join(uploadDir, imageName);
      // eslint-disable-next-line no-await-in-loop
      await sharp(files.images[i].tmpPath)
        .resize(2000, 1333)
        .toFormat('jpeg')
        .jpeg({ quality: 95 })
        .toFile(outputPath);

      imageNames.push(imageName);

      if (files.images[i].tmpPath) {
        try {
            // eslint-disable-next-line no-await-in-loop
          await fs.promises.unlink(files.images[i].tmpPath);
        } catch (err) {
          console.error(`[Queue Worker] Failed to delete tmp file: ${err.message}`);
        }
      }
    }
    
    updatePayload.images = imageNames;
  }

  // --- Task C: Update MongoDB Document ---
  if (Object.keys(updatePayload).length > 0) {
    await Product.findByIdAndUpdate(productId, updatePayload);
  }
}, { connection });

// 4. Background Event Listeners for Easy Debugging
worker.on('completed', (job) => {
  console.log(`\x1b[32m[Queue Worker] Job ${job.id} completed: Images processed and MongoDB updated successfully!\x1b[0m`);
});

worker.on('failed', (job, err) => {
  console.error(`\x1b[31m[Queue Worker] Job ${job.id || 'unknown'} failed:\x1b[0m`, err);
});

// Export the queue instance so your productService can interact with it

module.exports = { imageQueue };