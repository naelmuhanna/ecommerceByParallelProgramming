const asyncHandler = require('express-async-handler');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const { uploadMixOfImages } = require('../middlewares/uploadImageMiddleware');
const factory = require('./handlersFactory');
const Product = require('../models/productModel');
const ApiError = require('../utils/apiError');
const ApiFeatures = require('../utils/apiFeatures');
const {
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPattern,
  trackProductView,
  getPopularIds,
  stats,
  PRODUCT_TTL,
  LIST_TTL,
  VIEW_THRESHOLD,
  POPULAR_TTL,
} = require('../utils/cache');

// ─── Image upload/resize helpers (unchanged) ──────────────────────────────────

exports.uploadProductImages = uploadMixOfImages([
  { name: 'imageCover', maxCount: 1 },
  { name: 'images',     maxCount: 5 },
]);

exports.resizeProductImages = asyncHandler(async (req, res, next) => {
  if (req.files.imageCover) {
    const imageCoverFileName = `product-${uuidv4()}-${Date.now()}-cover.jpeg`;
    await sharp(req.files.imageCover[0].buffer)
      .resize(2000, 1333)
      .toFormat('jpeg')
      .jpeg({ quality: 95 })
      .toFile(`uploads/products/${imageCoverFileName}`);
    req.body.imageCover = imageCoverFileName;
  }

  if (req.files.images) {
    req.body.images = [];
    await Promise.all(
      req.files.images.map(async (img, index) => {
        const imageName = `product-${uuidv4()}-${Date.now()}-${index + 1}.jpeg`;
        await sharp(img.buffer)
          .resize(2000, 1333)
          .toFormat('jpeg')
          .jpeg({ quality: 95 })
          .toFile(`uploads/products/${imageName}`);
        req.body.images.push(imageName);
      })
    );
  }

  next();
});

// ─── Cache-Aside: GET /api/v1/products ───────────────────────────────────────
// Cache key encodes the full query string so different filters/pages are cached
// independently (e.g. ?page=2&sort=price is a separate key from ?sort=-price).

exports.getProducts = asyncHandler(async (req, res) => {
  // Build a stable, sorted cache key from query params
  const sortedQuery = Object.keys(req.query)
    .sort()
    .reduce((acc, k) => { acc[k] = req.query[k]; return acc; }, {});
  const cacheKey = `products:list:${JSON.stringify(sortedQuery)}`;

  // 1. Check Redis
  const cached = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json({ ...cached, cacheSource: 'redis' });
  }

  // 2. Cache miss → query MongoDB
  let filter = {};
  if (req.filterObj) filter = req.filterObj;

  const documentsCounts = await Product.countDocuments();
  const apiFeatures = new ApiFeatures(Product.find(filter), req.query)
    .paginate(documentsCounts)
    .filter()
    .search('Products')
    .limitFields()
    .sort();

  const { mongooseQuery, paginationResult } = apiFeatures;
  const documents = await mongooseQuery;

  const responseBody = {
    results: documents.length,
    paginationResult,
    data: documents,
    cacheSource: 'mongodb',
  };

  // 3. Store in Redis
  await setCache(cacheKey, responseBody, LIST_TTL);

  res.status(200).json(responseBody);
});

// ─── Cache-Aside: GET /api/v1/products/:id ───────────────────────────────────

exports.getProduct = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const cacheKey = `product:${id}`;

  // 1. Check Redis
  const cached = await getCache(cacheKey);
  if (cached) {
    // Track view even on cache hits so the sorted set stays accurate
    await trackProductView(id);
    return res.status(200).json({ data: cached, cacheSource: 'redis' });
  }

  // 2. Cache miss → query MongoDB
  const document = await Product.findById(id).populate('reviews');
  if (!document) {
    return next(new ApiError(`No product found for id ${id}`, 404));
  }

  // 3. Track view; only cache once the product has reached VIEW_THRESHOLD views
  //    (threshold-based caching avoids polluting Redis with low-traffic products)
  const viewCount = await trackProductView(id);
  if (viewCount >= VIEW_THRESHOLD) {
    await setCache(cacheKey, document.toJSON(), PRODUCT_TTL);
  }

  res.status(200).json({ data: document, cacheSource: 'mongodb' });
});

// ─── Create (no cache effect, but bust the list cache) ───────────────────────

exports.createProduct = asyncHandler(async (req, res) => {
  const newDoc = await Product.create(req.body);
  // Any existing list cache is now stale
  await deleteCacheByPattern('products:list:*');
  res.status(201).json({ data: newDoc });
});

// ─── Update: invalidate the item cache + all list caches ─────────────────────

exports.updateProduct = asyncHandler(async (req, res, next) => {
  const document = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });

  if (!document) {
    return next(new ApiError(`No document for this id ${req.params.id}`, 404));
  }

  // Invalidate stale caches
  await deleteCache(`product:${req.params.id}`);
  await deleteCacheByPattern('products:list:*');

  res.status(200).json({ data: document });
});

// ─── Delete: invalidate the item cache + all list caches ─────────────────────

exports.deleteProduct = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const document = await Product.findByIdAndDelete(id);

  if (!document) {
    return next(new ApiError(`No document for this id ${id}`, 404));
  }

  // Invalidate stale caches
  await deleteCache(`product:${id}`);
  await deleteCacheByPattern('products:list:*');

  res.status(204).send();
});

// ─── Popular products: GET /api/v1/products/popular ──────────────────────────
// Reads the top-10 from the Redis Sorted Set, fetches documents from MongoDB,
// and caches the aggregated response for POPULAR_TTL seconds.

exports.getPopularProducts = asyncHandler(async (req, res) => {
  const TOP_N = 10;
  const cacheKey = 'popular-products:cache';

  // 1. Check if the aggregated list is cached
  const cached = await getCache(cacheKey);
  if (cached) {
    return res.status(200).json({ ...cached, cacheSource: 'redis' });
  }

  // 2. Pull top-N entries from the sorted set
  const rankedIds = await getPopularIds(TOP_N);
  if (rankedIds.length === 0) {
    return res.status(200).json({
      results: 0,
      data: [],
      note: 'No products tracked yet — view some products first.',
      cacheSource: 'none',
    });
  }

  // 3. Fetch the matching documents in one MongoDB query
  const productIds = rankedIds.map((e) => e.productId);
  const products = await Product.find({ _id: { $in: productIds } });

  // Re-order to match sorted set ranking (find() result order is not guaranteed)
  const productMap = {};
  products.forEach((p) => { productMap[p._id.toString()] = p; });

  const orderedProducts = productIds
    .map((pid, i) => {
      const doc = productMap[pid];
      if (!doc) return null;
      return { ...doc.toJSON(), views: rankedIds[i].views };
    })
    .filter(Boolean);

  const responseBody = {
    results: orderedProducts.length,
    data: orderedProducts,
    cacheSource: 'mongodb',
  };

  // 4. Cache the aggregated result
  await setCache(cacheKey, responseBody, POPULAR_TTL);

  res.status(200).json(responseBody);
});

// ─── Cache stats endpoint (used by the test script) ──────────────────────────

exports.getCacheStats = (req, res) => {
  const total = stats.hits + stats.misses;
  res.status(200).json({
    hits: stats.hits,
    misses: stats.misses,
    total,
    hitRate: total ? `${((stats.hits / total) * 100).toFixed(1)}%` : '0%',
  });
};

// ─── Dev-only: flush all product cache keys (used by task1 test scripts) ─────

exports.flushCache = asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ message: 'Only available in development mode' });
  }
  // product:{id} caches + product:{id}:views counters
  await deleteCacheByPattern('product:*');
  // products:list:{query} caches
  await deleteCacheByPattern('products:list:*');
  // popularity sorted set + aggregated popular-list cache
  await deleteCache('popular-products');
  await deleteCache('popular-products:cache');
  res.status(200).json({ message: 'Product cache flushed' });
});
