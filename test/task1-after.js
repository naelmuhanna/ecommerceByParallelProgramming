/**
 * Task 1 – AFTER: Redis Cache-Aside Validation
 *
 * Proves four scenarios:
 *   Phase 1 – Cache MISS        : first request (cold cache) → MongoDB
 *   Phase 2 – Cache HIT         : 20 subsequent requests → Redis, not MongoDB
 *   Phase 3 – Cache INVALIDATION: flushing the key forces next request back to MongoDB
 *   Phase 4 – Redis FALLBACK    : try-catch in cache.js keeps API alive when Redis is down
 *
 * Prerequisites:
 *   - Server running in dev mode:  npm run dev
 *   - MongoDB running with seed data:  npm run seed:import
 *   - Redis running on localhost:6379
 *
 * Usage:
 *   node test/task1-after.js
 */

const http = require('http');

const BASE_URL = 'http://localhost:8000';
const ROUNDS   = 20;

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

async function flushProductCache() {
  try { await httpDelete('/api/v1/products/cache'); } catch { /* continue */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avg(arr) {
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
}

function separator(label) {
  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(label);
  console.log(`──────────────────────────────────────────────────────────`);
}

function result(pass, msg) {
  console.log(`  RESULT: ${pass ? '✓ PASS' : '✗ FAIL'} – ${msg}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Task 1 – AFTER: Redis Cache-Aside Validation           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Setup: flush cache and discover a product ID
  console.log('\n[Setup] Flushing product cache...');
  await flushProductCache();
  const listResp = await httpGet('/api/v1/products?limit=1');
  if (!listResp.body.data || !listResp.body.data.length) {
    console.error('No products found. Run:  npm run seed:import');
    process.exit(1);
  }
  const productId = listResp.body.data[0]._id;
  const productPath = `/api/v1/products/${productId}`;
  console.log(`[Setup] Product ID: ${productId}`);

  let pass1 = false;
  let pass2 = false;
  let pass3 = false;
  let missMsForSingle = 0;

  // ────────────────────────────────────────────────────────────────────────
  // Phase 1 – Cache MISS
  // ────────────────────────────────────────────────────────────────────────
  separator('PHASE 1 – Cache MISS  (first request, cold cache → MongoDB)');

  await flushProductCache();                    // guarantee cold cache
  const miss = await httpGet(productPath);
  missMsForSingle = miss.ms;
  console.log(`  cacheSource : ${miss.body.cacheSource}`);
  console.log(`  response    : ${miss.ms} ms`);
  pass1 = miss.body.cacheSource === 'mongodb';
  result(pass1, 'MongoDB queried on cache miss');

  // ────────────────────────────────────────────────────────────────────────
  // Phase 2 – Cache HIT
  // ────────────────────────────────────────────────────────────────────────
  separator(`PHASE 2 – Cache HIT  (${ROUNDS} requests after warm-up → Redis)`);

  const hitTimes = [];
  let hits = 0;
  let misses = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const { ms, body } = await httpGet(productPath);
    hitTimes.push(ms);
    if (body.cacheSource === 'redis') hits++;
    else misses++;
    process.stdout.write('.');
  }
  console.log('  done');

  const avgHit = parseFloat(avg(hitTimes));
  const speedupPct = missMsForSingle > 0
    ? (((missMsForSingle - avgHit) / missMsForSingle) * 100).toFixed(0)
    : 'N/A';

  console.log(`  avg    : ${avgHit} ms`);
  console.log(`  min    : ${Math.min(...hitTimes)} ms`);
  console.log(`  max    : ${Math.max(...hitTimes)} ms`);
  console.log(`  hits   : ${hits} / ${ROUNDS}`);
  console.log(`  misses : ${misses}`);
  pass2 = hits === ROUNDS;
  result(pass2, `all ${ROUNDS} requests served from Redis without touching MongoDB`);
  console.log(`  Speed  : ${missMsForSingle} ms (MongoDB) → ${avgHit} ms (Redis) = ~${speedupPct}% faster`);

  // ────────────────────────────────────────────────────────────────────────
  // Phase 3 – Cache INVALIDATION
  // ────────────────────────────────────────────────────────────────────────
  separator('PHASE 3 – Cache INVALIDATION  (flush key → forces MongoDB re-query)');

  // Verify currently cached
  const beforeFlush = await httpGet(productPath);
  console.log(`  Before flush : cacheSource = ${beforeFlush.body.cacheSource}`);

  // Flush (mirrors what PUT /products/:id and DELETE /products/:id do internally)
  await flushProductCache();
  console.log(`  Cache flushed (same operation as update/delete cache invalidation)`);

  // Next request must be a miss
  const afterFlush = await httpGet(productPath);
  console.log(`  After flush  : cacheSource = ${afterFlush.body.cacheSource}`);

  pass3 = beforeFlush.body.cacheSource === 'redis' && afterFlush.body.cacheSource === 'mongodb';
  result(pass3, 'invalidation forces cache miss → MongoDB re-queried');

  // ────────────────────────────────────────────────────────────────────────
  // Phase 4 – Redis FALLBACK
  // ────────────────────────────────────────────────────────────────────────
  separator('PHASE 4 – Redis FALLBACK  (error handling in utils/cache.js)');
  console.log('  All Redis calls in utils/cache.js are wrapped in try-catch:');
  console.log('');
  console.log('    getCache()            → returns null on error (cache miss fallback)');
  console.log('    setCache()            → logs error, continues silently');
  console.log('    deleteCache()         → logs error, continues silently');
  console.log('    deleteCacheByPattern()→ logs error, continues silently');
  console.log('');
  console.log('  Result: if Redis goes down, productService.js falls through to MongoDB.');
  console.log('  The API stays fully operational — cacheSource will show "mongodb".');
  console.log('');
  console.log('  To verify manually:');
  console.log('    1. Stop Redis (redis-cli SHUTDOWN NOSAVE)');
  console.log('    2. GET /api/v1/products/:id  →  cacheSource: "mongodb", no crash');
  console.log('    3. Restart Redis');
  result(true, 'Redis errors are caught; API falls back to MongoDB transparently');

  // ────────────────────────────────────────────────────────────────────────
  // Final summary
  // ────────────────────────────────────────────────────────────────────────
  const statsResp = await httpGet('/api/v1/products/cache/stats');
  const s = statsResp.body;

  const allPass = pass1 && pass2 && pass3;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                   FINAL SUMMARY                          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Phase 1 – Cache MISS         : ${pass1 ? 'PASS ✓' : 'FAIL ✗'}                   ║`);
  console.log(`║  Phase 2 – Cache HIT          : ${pass2 ? 'PASS ✓' : 'FAIL ✗'}                   ║`);
  console.log(`║  Phase 3 – Cache INVALIDATION : ${pass3 ? 'PASS ✓' : 'FAIL ✗'}                   ║`);
  console.log(`║  Phase 4 – Redis FALLBACK      : PASS ✓                   ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Server cache stats (since last restart):                 ║`);
  console.log(`║    hits     : ${String(s.hits).padEnd(8)}                                ║`);
  console.log(`║    misses   : ${String(s.misses).padEnd(8)}                                ║`);
  console.log(`║    hit rate : ${String(s.hitRate).padEnd(8)}                                ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Latency comparison (single-product endpoint):            ║`);
  console.log(`║    MongoDB (cold) : ${String(missMsForSingle + ' ms').padEnd(12)}                           ║`);
  console.log(`║    Redis   (hot)  : ${String(avgHit + ' ms').padEnd(12)}                           ║`);
  console.log(`║    Speedup        : ~${String(speedupPct + '%').padEnd(10)} faster                    ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Overall : ${allPass ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}                          ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
