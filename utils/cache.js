const redis = require('../config/redis');

const PRODUCT_TTL    = 3600; // 1 hour for individual product documents
const LIST_TTL       = 600;  // 10 minutes for product list queries
const VIEW_THRESHOLD = 10;   // individual product cached only after this many views
const POPULAR_TTL    = 60;   // seconds to cache the aggregated /popular response

// Shared counters so tests can read them without a separate endpoint
const stats = { hits: 0, misses: 0 };

const getCache = async (key) => {
  try {
    const data = await redis.get(key);
    if (data) {
      stats.hits += 1;
      return JSON.parse(data);
    }
    stats.misses += 1;
    return null;
  } catch (err) {
    // Redis unavailable → treat as cache miss, fall through to MongoDB
    console.error(`[Cache] Redis GET error for "${key}": ${err.message}`);
    stats.misses += 1;
    return null;
  }
};

const setCache = async (key, value, ttl = PRODUCT_TTL) => {
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
  } catch (err) {
    console.error(`[Cache] Redis SETEX error for "${key}": ${err.message}`);
  }
};

const deleteCache = async (key) => {
  try {
    await redis.del(key);
  } catch (err) {
    console.error(`[Cache] Redis DEL error for "${key}": ${err.message}`);
  }
};

// Remove all keys matching a glob pattern (e.g. 'products:list:*')
const deleteCacheByPattern = async (pattern) => {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(keys);
  } catch (err) {
    console.error(`[Cache] Redis pattern DEL error for "${pattern}": ${err.message}`);
  }
};

const resetStats = () => {
  stats.hits   = 0;
  stats.misses = 0;
};

// ─── Popularity tracking ──────────────────────────────────────────────────────

// Atomically increment product:{id}:views counter and the popular-products
// sorted set in a single pipeline round-trip.  Returns the new view count.
const trackProductView = async (productId) => {
  try {
    const pipeline = redis.pipeline();
    pipeline.incr(`product:${productId}:views`);
    pipeline.zincrby('popular-products', 1, productId);
    const results = await pipeline.exec();
    // results = [[err, incrValue], [err, zincrbyValue]]
    return (results[0] && results[0][1]) ? Number(results[0][1]) : 0;
  } catch (err) {
    console.error(`[Cache] View tracking error for "${productId}": ${err.message}`);
    return 0;
  }
};

// Return the top `limit` entries from the popular-products sorted set,
// ordered by descending view count.
// Returns [{ productId: string, views: number }, ...]
const getPopularIds = async (limit = 10) => {
  try {
    // ZREVRANGE returns a flat array [id1, score1, id2, score2, ...]
    const entries = await redis.zrevrange('popular-products', 0, limit - 1, 'WITHSCORES');
    const result = [];
    for (let i = 0; i < entries.length; i += 2) {
      result.push({ productId: entries[i], views: parseInt(entries[i + 1], 10) });
    }
    return result;
  } catch (err) {
    console.error(`[Cache] ZREVRANGE error: ${err.message}`);
    return [];
  }
};

module.exports = {
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPattern,
  trackProductView,
  getPopularIds,
  stats,
  resetStats,
  PRODUCT_TTL,
  LIST_TTL,
  VIEW_THRESHOLD,
  POPULAR_TTL,
};
