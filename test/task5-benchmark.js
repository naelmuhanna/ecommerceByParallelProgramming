/**
 * Task 5 – Benchmarking & Bottleneck Analysis
 *
 * Bottleneck (found in Task 4): the inventory write path under hot-product
 * contention. `purchase-optimistic` does read → compare-and-swap on lockVersion
 * → retry (up to 5×) with exponential back-off. Under 100 concurrent buyers of
 * the SAME product this becomes a retry storm: throughput collapses and ~1/4 of
 * requests are rejected with HTTP 409 after exhausting their retries.
 *
 * Fix: `purchase-atomic` collapses the read-modify-write into ONE atomic
 * conditional update — `findOneAndUpdate({ _id, quantity: { $gte: qty } },
 * { $inc: { quantity: -qty, sold: qty } })`. No read, no version, no retry, no
 * sleeps. Oversell is still impossible (guard + write are atomic).
 *
 * This script benchmarks BOTH endpoints under identical load and prints the
 * before/after comparison, then proves the atomic path never oversells.
 *
 * Run:  node test/task5-benchmark.js
 */

const autocannon = require('autocannon');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'http://localhost:8000';
const PRODUCT_ID = process.env.PRODUCT_ID || '6a0b1f21ab42fc4c547c4443';
const CONNECTIONS = parseInt(process.env.CONNECTIONS, 10) || 100;
const DURATION = parseInt(process.env.DURATION, 10) || 10;
const BIG_STOCK = 1000000;

const reset = (qty) =>
  axios.put(`${BASE}/api/v1/inventory/${PRODUCT_ID}/reset-stock`, { quantity: qty });
const getProduct = async () =>
  (await axios.get(`${BASE}/api/v1/products/${PRODUCT_ID}`)).data.data;

async function bench(label, route) {
  await reset(BIG_STOCK);
  const before = await getProduct();
  const result = await autocannon({
    url: BASE,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [{
      method: 'POST',
      path: `/api/v1/inventory/${PRODUCT_ID}/${route}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 1 }),
    }],
  });
  const after = await getProduct();
  const total = result.requests.total;
  const non2xx = result.non2xx || 0;
  return {
    label,
    rps: result.requests.average,
    latencyAvg: result.latency.average,
    latencyP95: result.latency.p97_5,
    latencyP99: result.latency.p99,
    total,
    success2xx: result['2xx'],
    non2xx,
    errorRate: ((non2xx / total) * 100),
    sold: after.sold - before.sold,
    finalStock: after.quantity,
  };
}

function pct(beforeV, afterV) {
  if (!beforeV) return 'n/a';
  const change = ((afterV - beforeV) / beforeV) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

(async () => {
  console.log('\n==================================================');
  console.log('  TASK 5 – BENCHMARK: inventory write path');
  console.log('==================================================');
  console.log(`Load: ${CONNECTIONS} connections × ${DURATION}s, single hot product\n`);

  console.log('▶ BEFORE  — purchase-optimistic (read + CAS + retry)...');
  const before = await bench('optimistic', 'purchase-optimistic');
  console.log(`  done: ${before.rps} rps, ${before.errorRate.toFixed(1)}% 409s\n`);

  console.log('▶ AFTER   — purchase-atomic (single conditional update)...');
  const after = await bench('atomic', 'purchase-atomic');
  console.log(`  done: ${after.rps} rps, ${after.errorRate.toFixed(1)}% 409s\n`);

  const row = (name, b, a, imp) =>
    console.log(`${name.padEnd(24)}| ${String(b).padStart(12)} | ${String(a).padStart(12)} | ${imp}`);

  console.log('--------------------------------------------------------------------');
  console.log('Metric                  |   BEFORE(opt) |  AFTER(atomic)| Improvement');
  console.log('--------------------------------------------------------------------');
  row('Requests/sec', before.rps, after.rps, pct(before.rps, after.rps));
  row('Latency avg (ms)', before.latencyAvg, after.latencyAvg, pct(before.latencyAvg, after.latencyAvg));
  row('Latency P95 (ms)', before.latencyP95, after.latencyP95, pct(before.latencyP95, after.latencyP95));
  row('Latency P99 (ms)', before.latencyP99, after.latencyP99, pct(before.latencyP99, after.latencyP99));
  row('Successful purchases', before.success2xx, after.success2xx, pct(before.success2xx, after.success2xx));
  row('409 conflicts', before.non2xx, after.non2xx, pct(before.non2xx, after.non2xx));
  row('Error rate (%)', before.errorRate.toFixed(1), after.errorRate.toFixed(1), '');
  console.log('--------------------------------------------------------------------');

  // Correctness: the atomic path must still never oversell.
  console.log('\n▶ Correctness check — atomic path must not oversell:');
  await reset(5);
  const buyers = 50;
  const results = await Promise.allSettled(
    Array.from({ length: buyers }, () =>
      axios.post(`${BASE}/api/v1/inventory/${PRODUCT_ID}/purchase-atomic`, { quantity: 1 }))
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const finalStock = (await getProduct()).quantity;
  console.log(`  stock 5, ${buyers} concurrent atomic buys → ${ok} succeeded, final stock ${finalStock}`);
  console.log(ok === 5 && finalStock === 0
    ? '  ✅ exactly 5 sold, no oversell — optimization preserves correctness.'
    : '  ❌ oversell or under-sell detected.');
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('Benchmark error:', e.message);
  process.exit(1);
});
