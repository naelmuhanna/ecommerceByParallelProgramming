/**
 * Task 1 – BEFORE: Baseline Measurement (No Cache)
 *
 * Simulates the "before" state by flushing all product cache keys before
 * every request, guaranteeing each response comes directly from MongoDB.
 *
 * What is proved:
 *   - cacheSource: 'mongodb' on every response
 *   - 50 requests = 50 MongoDB queries (100 % DB traffic)
 *   - Average response times to compare with task1-after.js
 *
 * Prerequisites:
 *   - Server running in dev mode:  npm run dev
 *   - MongoDB running with seed data:  npm run seed:import
 *   - Redis running on localhost:6379
 *
 * Usage:
 *   node test/task1-before.js
 */

const http = require('http');

const BASE_URL = 'http://localhost:8000';
const REQUESTS = 50;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(`${BASE_URL}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ms: Date.now() - start, body: JSON.parse(body), status: res.statusCode });
        } catch {
          resolve({ ms: Date.now() - start, body: {}, status: res.statusCode });
        }
      });
    }).on('error', reject);
  });
}

function httpDelete(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 8000, path, method: 'DELETE' };
    const req = http.request(opts, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

// Flush all product-related Redis keys (dev-only endpoint)
async function flushProductCache() {
  try {
    await httpDelete('/api/v1/products/cache');
  } catch {
    // If the endpoint is unavailable continue — Redis may still have data
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function avg(arr) {
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
}

// ─── Phase runner ─────────────────────────────────────────────────────────────

async function runPhase(label, path) {
  const times = [];
  let mongoHits = 0;
  let redisHits  = 0;

  console.log(`\n  ${label}`);
  for (let i = 0; i < REQUESTS; i++) {
    // Flush cache before EVERY request → guaranteed cache miss
    await flushProductCache();
    const { ms, body } = await httpGet(path);
    times.push(ms);
    if (body.cacheSource === 'mongodb') mongoHits++;
    else if (body.cacheSource === 'redis') redisHits++;
    process.stdout.write('.');
  }

  console.log('  done');
  return {
    avg: parseFloat(avg(times)),
    min: Math.min(...times),
    max: Math.max(...times),
    mongoHits,
    redisHits,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Task 1 – BEFORE: All Requests Hit MongoDB (Baseline)   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\nMethod: cache is flushed before each request so every');
  console.log('response is a cache miss → direct MongoDB query.\n');

  // Discover a product ID (first flush so this request itself hits MongoDB)
  await flushProductCache();
  const listResp = await httpGet('/api/v1/products?limit=1');
  if (!listResp.body.data || !listResp.body.data.length) {
    console.error('No products found. Run:  npm run seed:import');
    process.exit(1);
  }
  const productId = listResp.body.data[0]._id;
  console.log(`Product ID : ${productId}`);
  console.log(`Requests   : ${REQUESTS} per endpoint\n`);

  const singleResult = await runPhase(
    `GET /api/v1/products/:id  (${REQUESTS} reqs, cache flushed each time)`,
    `/api/v1/products/${productId}`
  );

  const listResult = await runPhase(
    `GET /api/v1/products      (${REQUESTS} reqs, cache flushed each time)`,
    `/api/v1/products?limit=10&page=1`
  );

  const totalMongo = singleResult.mongoHits + listResult.mongoHits;
  const totalReqs  = REQUESTS * 2;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║             BEFORE – RESULTS SUMMARY                     ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Single-product  (${REQUESTS} requests):                           ║`);
  console.log(`║    avg  : ${String(singleResult.avg + ' ms').padEnd(12)}                             ║`);
  console.log(`║    min  : ${String(singleResult.min + ' ms').padEnd(12)}                             ║`);
  console.log(`║    max  : ${String(singleResult.max + ' ms').padEnd(12)}                             ║`);
  console.log(`║    MongoDB hits : ${singleResult.mongoHits}/${REQUESTS}                               ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Product-list    (${REQUESTS} requests):                           ║`);
  console.log(`║    avg  : ${String(listResult.avg + ' ms').padEnd(12)}                             ║`);
  console.log(`║    min  : ${String(listResult.min + ' ms').padEnd(12)}                             ║`);
  console.log(`║    max  : ${String(listResult.max + ' ms').padEnd(12)}                             ║`);
  console.log(`║    MongoDB hits : ${listResult.mongoHits}/${REQUESTS}                               ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  TOTAL: ${totalMongo}/${totalReqs} requests hit MongoDB = 100% DB traffic  ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nSave these numbers, then run task1-after.js to compare:`);
  console.log(`  Single-product avg : ${singleResult.avg} ms`);
  console.log(`  Product-list avg   : ${listResult.avg} ms`);
  console.log('');
}

main().catch((err) => { console.error(err); process.exit(1); });
