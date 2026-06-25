const IORedis = require('ioredis');

const redisClient = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redisClient.on('connect', () =>
  console.log('✅ Redis Cache Client Connected')
);
redisClient.on('error', (err) =>
  console.error(`❌ Redis Cache Error: ${err.message}`)
);

module.exports = redisClient;
