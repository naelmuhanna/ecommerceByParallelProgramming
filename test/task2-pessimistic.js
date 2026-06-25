/**
 * Task 2.3 – Pessimistic Locking proves only the available stock is sold.
 *
 * Strategy: a Redis distributed mutex (SET key token NX PX) serializes the
 * critical section. MongoDB has no SQL-style row locks, so in a distributed /
 * multi-worker Node.js deployment a Redis lock is the idiomatic way to force
 * read-modify-write to run one-at-a-time across every process. The lock is
 * released with a Lua compare-and-delete so a process can only free its own
 * lock, and a TTL prevents deadlock if a holder crashes.
 *
 * Test: stock = K, fire M (> K) concurrent purchases. Exactly K succeed, the
 * rest are rejected, final stock never negative.
 *
 * Run:  node test/task2-pessimistic.js
 */

const axios = require('axios');

const BASE = process.env.BASE_URL || 'http://localhost:8000';
const PRODUCT_ID = process.env.PRODUCT_ID || '6a0b1f21ab42fc4c547c4443';
const INITIAL_STOCK = 5;
const CONCURRENT_BUYERS = 20;

const purchase = () =>
  axios
    .post(`${BASE}/api/v1/inventory/${PRODUCT_ID}/purchase-pessimistic`, { quantity: 1 })
    .then((r) => ({ ok: true, remaining: r.data.data.quantityRemaining }))
    .catch((e) => ({ ok: false, status: e.response?.status }));

(async () => {
  console.log('\n==================================================');
  console.log('  TASK 2.3 – PESSIMISTIC LOCKING (Redis mutex)');
  console.log('==================================================\n');

  await axios.put(`${BASE}/api/v1/inventory/${PRODUCT_ID}/reset-stock`, { quantity: INITIAL_STOCK });
  console.log(`Stock reset to ${INITIAL_STOCK}.`);
  console.log(`Firing ${CONCURRENT_BUYERS} simultaneous purchases (qty 1 each)...\n`);

  const start = Date.now();
  const results = await Promise.all(Array.from({ length: CONCURRENT_BUYERS }, purchase));
  const elapsed = Date.now() - start;

  const succeeded = results.filter((r) => r.ok).length;
  const outOfStock = results.filter((r) => !r.ok && r.status === 400).length;
  const lockBusy = results.filter((r) => !r.ok && r.status === 503).length;

  const after = await axios.get(`${BASE}/api/v1/products/${PRODUCT_ID}`);
  const finalStock = after.data.data.quantity;

  console.log('--------------------------------------------------');
  console.log('  RESULT');
  console.log('--------------------------------------------------');
  console.log(`Initial stock          : ${INITIAL_STOCK}`);
  console.log(`Concurrent requests    : ${CONCURRENT_BUYERS}`);
  console.log(`Purchases SUCCEEDED    : ${succeeded}   (should be exactly ${INITIAL_STOCK})`);
  console.log(`Rejected (out of stock): ${outOfStock}`);
  console.log(`Rejected (lock busy)   : ${lockBusy}   (503 — could not acquire lock in time)`);
  console.log(`Final stock in DB      : ${finalStock}   (should be 0, never < 0)`);
  console.log(`Elapsed                : ${elapsed} ms`);
  console.log('--------------------------------------------------');

  const correct = succeeded === INITIAL_STOCK && finalStock === 0;
  console.log(correct
    ? '\n✅ NO OVERSELL — the Redis mutex serialized access. Only available stock was sold.'
    : '\n❌ Unexpected result — investigate (raise LOCK_TIMEOUT if many 503s).');
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('Test error:', e.message);
  process.exit(1);
});
