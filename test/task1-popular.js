/**
 * Task 1 – Popularity-Based Caching Test
 *
 * Tests:
 *   1. Flush all product cache keys + view counters + sorted set
 *   2. Load 3 product IDs (A, B, C) from the API
 *   3. Send 50 requests to A, 5 to B, 30 to C
 *   4. GET /products/popular  → verify order A(50) > C(30) > B(5), cacheSource=mongodb
 *   5. GET /products/popular  → verify served from Redis cache (cacheSource=redis)
 *
 * Prerequisites:
 *   - Server running in dev mode:  npm run dev
 *   - Seed data loaded:           npm run seed:import
 *   - Redis running on 127.0.0.1:6379
 *
 * Usage:
 *   node test/task1-popular.js
 */

const http = require('http');

const BASE_URL = 'http://localhost:8000';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendRequests(label, path, count) {
  process.stdout.write(`    ${label.padEnd(12)} (${String(count).padStart(2)} reqs) `);
  for (let i = 0; i < count; i++) {
    await httpGet(path);
    if ((i + 1) % 10 === 0) process.stdout.write('.');
    else if (count <= 10) process.stdout.write('.');
  }
  console.log(' done');
}

function pass(ok, msg) {
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'} – ${msg}`);
  return ok;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Task 1 – Popularity-Based Caching Test                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── Step 1: Flush ──────────────────────────────────────────────────────────
  console.log('── Step 1: Flush cache, view counters, and sorted set');
  const flushStatus = await httpDelete('/api/v1/products/cache');
  if (flushStatus !== 200) {
    console.error(`  ERROR: /cache flush returned HTTP ${flushStatus} — is NODE_ENV=development?`);
    process.exit(1);
  }
  console.log('  All product cache keys cleared.\n');

  // ── Step 2: Discover 3 product IDs ────────────────────────────────────────
  console.log('── Step 2: Load 3 product IDs');
  const listResp = await httpGet('/api/v1/products?limit=3&page=1');
  const products = listResp.body.data;
  if (!products || products.length < 3) {
    console.error('  ERROR: Need at least 3 products. Run:  npm run seed:import');
    process.exit(1);
  }
  const [prodA, prodB, prodC] = products;
  const idA = prodA._id;
  const idB = prodB._id;
  const idC = prodC._id;
  console.log(`  Product A: ${idA}  "${String(prodA.title).slice(0, 28)}"`);
  console.log(`  Product B: ${idB}  "${String(prodB.title).slice(0, 28)}"`);
  console.log(`  Product C: ${idC}  "${String(prodC.title).slice(0, 28)}"\n`);

  // ── Step 3: Simulate views ────────────────────────────────────────────────
  console.log('── Step 3: Simulate views (A=50, B=5, C=30)');
  await sendRequests('Product A', `/api/v1/products/${idA}`, 50);
  await sendRequests('Product B', `/api/v1/products/${idB}`, 5);
  await sendRequests('Product C', `/api/v1/products/${idC}`, 30);
  console.log('  Note: threshold=10 → A cached from req #10, C from req #10, B never cached.\n');

  // ── Step 4: First call to /popular ────────────────────────────────────────
  console.log('── Step 4: GET /api/v1/products/popular (first call)');
  const pop1 = await httpGet('/api/v1/products/popular');
  const pop1Data  = pop1.body.data  || [];
  const pop1Src   = pop1.body.cacheSource;
  console.log(`  cacheSource : ${pop1Src}`);
  console.log(`  products returned: ${pop1Data.length}`);
  console.log('');

  // Show top 3
  console.log('  Top 3 in response:');
  pop1Data.slice(0, 3).forEach((p, i) => {
    const lbl = p._id === idA ? 'A'
              : p._id === idB ? 'B'
              : p._id === idC ? 'C' : '?';
    console.log(`    #${i + 1}: Product ${lbl}  views=${p.views}  id=${p._id}`);
  });
  console.log('');

  // Validate order: A must appear before C, C before B
  const ids = pop1Data.map((p) => p._id);
  const posA = ids.indexOf(idA);
  const posB = ids.indexOf(idB);
  const posC = ids.indexOf(idC);

  const r1 = pass(pop1Src === 'mongodb',                        'first call served from MongoDB (cache miss on /popular)');
  const r2 = pass(posA !== -1 && posC !== -1 && posB !== -1,   'all three products appear in the popular list');
  const r3 = pass(posA < posC,                                  'Product A(50) ranked above Product C(30)');
  const r4 = pass(posC < posB,                                  'Product C(30) ranked above Product B(5)');

  // ── Step 5: Second call (should be Redis hit) ─────────────────────────────
  console.log('\n── Step 5: GET /api/v1/products/popular (second call within 60-s TTL)');
  const pop2    = await httpGet('/api/v1/products/popular');
  const pop2Src = pop2.body.cacheSource;
  console.log(`  cacheSource : ${pop2Src}  (${pop2.ms} ms)`);
  const r5 = pass(pop2Src === 'redis', 'second call served from Redis (60-s cache hit)');

  // ── Summary ───────────────────────────────────────────────────────────────
  const allPass = r1 && r2 && r3 && r4 && r5;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║               POPULARITY TEST RESULTS                    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Views sent   : A=50   B=5    C=30                       ║`);
  console.log(`║  Expected rank: #1 A(50)  #2 C(30)  #3 B(5)             ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  [1] First call – cacheSource=mongodb   : ${r1 ? 'PASS ✓' : 'FAIL ✗'}             ║`);
  console.log(`║  [2] All 3 products in list             : ${r2 ? 'PASS ✓' : 'FAIL ✗'}             ║`);
  console.log(`║  [3] A(50) ranked above C(30)           : ${r3 ? 'PASS ✓' : 'FAIL ✗'}             ║`);
  console.log(`║  [4] C(30) ranked above B(5)            : ${r4 ? 'PASS ✓' : 'FAIL ✗'}             ║`);
  console.log(`║  [5] Second call – cacheSource=redis    : ${r5 ? 'PASS ✓' : 'FAIL ✗'}             ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Overall : ${allPass ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}                          ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
