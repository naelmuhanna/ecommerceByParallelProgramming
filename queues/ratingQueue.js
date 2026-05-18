const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const mongoose = require('mongoose');

const connection = new Redis({
  maxRetriesPerRequest: null
});
const ratingQueue = new Queue('ratingAggregation', { connection });

const ratingWorker = new Worker('ratingAggregation', async (job) => {
  const { productId } = job.data;
  
  const Review = mongoose.model('Review');
  const Product = mongoose.model('Product');

  const result = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId) } },
    {
      $group: {
        _id: '$product',
        avgRatings: { $avg: '$ratings' },
        ratingsQuantity: { $sum: 1 },
      },
    },
  ]);

  if (result.length > 0) {
    await Product.findByIdAndUpdate(productId, {
      ratingsAverage: result[0].avgRatings,
      ratingsQuantity: result[0].ratingsQuantity,
    });
  } else {
    await Product.findByIdAndUpdate(productId, {
      ratingsAverage: 0,
      ratingsQuantity: 0,
    });
  }
  
  console.log(`Successfully recalculated ratings for product: ${productId}`);
}, { connection });


module.exports = { ratingQueue };