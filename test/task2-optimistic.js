/**
 * Task 2.2 – Optimistic Locking proves overselling is eliminated.
 *
 * Strategy: Compare-and-Swap on a `lockVersion` field. Each purchase reads the
 * product + its lockVersion, then issues an atomic findOneAndUpdate guarded by
 * that version. If another request won the race, the version no longer matches,
 * zero docs update, and we retry (bounded). Net effect: writes are serialized
 * at the document level — no lost updates, no oversell.
 *
 * Test: stock = K, fire M (> K) concurrent purchases. Exactly K must succeed,
 * the rest are rejected as out-of-stock, and final stock is never negative.
 *
 * Run:  node test/task2-optimistic.js
 */

const axios = require('axios');

const BASE = process.env.BASE_URL || 'http://localhost:8000';
const PRODUCT_ID = process.env.PRODUCT_ID || '6a0b1f21ab42fc4c547c4443';
const INITIAL_STOCK = 5;
const CONCURRENT_BUYERS = 20;

const purchase = () =>
  axios
    .post(`${BASE}/api/v1/inventory/${PRODUCT_ID}/purchase-optimistic`, { quantity: 1 })
    .then((r) => ({ ok: true, attempt: r.data.attempt, remaining: r.data.data.quantityRemaining }))
    .catch((e) => ({ ok: false, status: e.response?.status }));

(async () => {
  console.log('\n==================================================');
  console.log('  TASK 2.2 – OPTIMISTIC LOCKING (CAS + retry)');
  console.log('==================================================\n');

  await axios.put(`${BASE}/api/v1/inventory/${PRODUCT_ID}/reset-stock`, { quantity: INITIAL_STOCK });
  console.log(`Stock reset to ${INITIAL_STOCK}.`);
  console.log(`Firing ${CONCURRENT_BUYERS} simultaneous purchases (qty 1 each)...\n`);

  const start = Date.now();
  const results = await Promise.all(Array.from({ length: CONCURRENT_BUYERS }, purchase));
  const elapsed = Date.now() - start;

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const retried = results.filter((r) => r.ok && r.attempt > 1).length;

  const after = await axios.get(`${BASE}/api/v1/products/${PRODUCT_ID}`);
  const finalStock = after.data.data.quantity;

  console.log('--------------------------------------------------');
  console.log('  RESULT');
  console.log('--------------------------------------------------');
  console.log(`Initial stock          : ${INITIAL_STOCK}`);
  console.log(`Concurrent requests    : ${CONCURRENT_BUYERS}`);
  console.log(`Purchases SUCCEEDED    : ${succeeded}   (should be exactly ${INITIAL_STOCK})`);
  console.log(`Purchases REJECTED     : ${failed}   (out of stock)`);
  console.log(`Succeeded after retry  : ${retried}   (CAS conflicts resolved)`);
  console.log(`Final stock in DB      : ${finalStock}   (should be 0, never < 0)`);
  console.log(`Elapsed                : ${elapsed} ms`);
  console.log('--------------------------------------------------');

  const correct = succeeded === INITIAL_STOCK && finalStock === 0;
  console.log(correct
    ? '\n✅ NO OVERSELL — exactly the available stock was sold. Race condition fixed.'
    : '\n❌ Unexpected result — investigate.');
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('Test error:', e.message);
  process.exit(1);
});
