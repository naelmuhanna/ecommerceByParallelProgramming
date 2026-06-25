/**
 * Task 4 – Stress Testing (Autocannon)
 *
 * Simulates 100+ concurrent users doing a mixed workload:
 *   - browse products      GET  /api/v1/products
 *   - product details      GET  /api/v1/products/:id   (cache-aside path)
 *   - inventory update     POST /api/v1/inventory/:id/purchase-optimistic
 *
 * Reports RPS, avg/P95/P99 latency, and error rate, then validates that the
 * system stayed stable: server still responding, and inventory is NOT corrupted
 * (quantity == initial - sold, never negative).
 *
 * Run:  node test/task4-stress.js
 * Tunables: CONNECTIONS, DURATION env vars.
 */

const autocannon = require('autocannon');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'http://localhost:8000';
const PRODUCT_ID = process.env.PRODUCT_ID || '6a0b1f21ab42fc4c547c4443';
const CONNECTIONS = parseInt(process.env.CONNECTIONS, 10) || 100;
const DURATION = parseInt(process.env.DURATION, 10) || 15;
const INITIAL_STOCK = 1000000; // large so purchases keep succeeding under load

(async () => {
  console.log('\n==================================================');
  console.log('  TASK 4 – STRESS TEST (Autocannon)');
  console.log('==================================================\n');
  console.log(`Target        : ${BASE}`);
  console.log(`Connections   : ${CONNECTIONS}`);
  console.log(`Duration      : ${DURATION}s`);
  console.log('Workload      : browse + details + inventory purchase (mixed)\n');

  // Pre-seed a large stock so inventory writes succeed (isolate stability, not stock-out)
  await axios.put(`${BASE}/api/v1/inventory/${PRODUCT_ID}/reset-stock`, { quantity: INITIAL_STOCK });
  const before = (await axios.get(`${BASE}/api/v1/products/${PRODUCT_ID}`)).data.data;
  console.log(`Stock reset to ${before.quantity} (sold reset to ${before.sold}).\n`);
  console.log('Running load... (this takes ~' + DURATION + 's)\n');

  const result = await autocannon({
    url: BASE,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      { method: 'GET', path: '/api/v1/products' },
      { method: 'GET', path: `/api/v1/products/${PRODUCT_ID}` },
      {
        method: 'POST',
        path: `/api/v1/inventory/${PRODUCT_ID}/purchase-optimistic`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 1 }),
      },
    ],
  });

  // Post-run integrity check
  const after = (await axios.get(`${BASE}/api/v1/products/${PRODUCT_ID}`)).data.data;
  const serverAlive = !!after;

  const total = result.requests.total;
  const non2xx = result.non2xx || 0;
  const errors = result.errors || 0;
  const timeouts = result.timeouts || 0;
  const errorRate = (((non2xx + errors + timeouts) / total) * 100).toFixed(2);

  console.log('--------------------------------------------------');
  console.log('  PERFORMANCE METRICS');
  console.log('--------------------------------------------------');
  console.log(`Requests/sec (avg)     : ${result.requests.average}`);
  console.log(`Total requests         : ${total}`);
  console.log(`Latency avg            : ${result.latency.average} ms`);
  console.log(`Latency P50            : ${result.latency.p50} ms`);
  console.log(`Latency P90            : ${result.latency.p90} ms`);
  console.log(`Latency P95 (~p97.5)   : ${result.latency.p97_5} ms`);
  console.log(`Latency P99            : ${result.latency.p99} ms`);
  console.log(`Latency max            : ${result.latency.max} ms`);
  console.log(`Throughput             : ${(result.throughput.average / 1024 / 1024).toFixed(2)} MB/s`);
  console.log(`2xx responses          : ${result['2xx']}`);
  console.log(`Non-2xx                : ${non2xx}`);
  console.log(`Errors / timeouts      : ${errors} / ${timeouts}`);
  console.log(`Error rate             : ${errorRate}%`);
  console.log('--------------------------------------------------');
  console.log('  STABILITY & INTEGRITY CHECK');
  console.log('--------------------------------------------------');
  console.log(`Server still responding: ${serverAlive ? 'YES' : 'NO'}`);
  console.log(`Stock before / after   : ${before.quantity} → ${after.quantity}`);
  console.log(`Units sold during test : ${after.sold}`);
  const expectedStock = INITIAL_STOCK - after.sold;
  const consistent = after.quantity === expectedStock && after.quantity >= 0;
  console.log(`Inventory consistent   : ${consistent ? 'YES' : 'NO'} (quantity == initial - sold == ${expectedStock})`);
  console.log('--------------------------------------------------');

  if (serverAlive && consistent) {
    console.log('\n✅ STABLE — no crash, no inventory corruption under sustained load.');
  } else {
    console.log('\n❌ Instability detected — review server logs.');
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('Stress test error:', e.message);
  process.exit(1);
});
