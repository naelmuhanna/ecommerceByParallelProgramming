/**
 * Task 2.1 – Demonstrate the Race Condition (Overselling)
 *
 * Scenario: stock = 1, but several purchase requests arrive simultaneously.
 * The /purchase-unsafe route does a read-modify-write with NO locking, so the
 * classic lost-update race lets multiple buyers each read "quantity = 1" before
 * anyone writes back — producing oversell (final quantity goes negative).
 *
 * Run:  node test/task2-race-condition.js
 * Requires the server running on http://localhost:8000 and a valid PRODUCT_ID.
 */

const axios = require('axios');

const BASE = process.env.BASE_URL || 'http://localhost:8000';
const PRODUCT_ID = process.env.PRODUCT_ID || '6a0b1f21ab42fc4c547c4443';
const INITIAL_STOCK = 1;
const CONCURRENT_BUYERS = 10;

const purchase = () =>
  axios
    .post(`${BASE}/api/v1/inventory/${PRODUCT_ID}/purchase-unsafe`, { quantity: 1 })
    .then((r) => ({ ok: true, remaining: r.data.data.quantityRemaining }))
    .catch((e) => ({ ok: false, status: e.response?.status, msg: e.response?.data?.message }));

(async () => {
  console.log('\n==================================================');
  console.log('  TASK 2.1 – RACE CONDITION DEMO (NO LOCKING)');
  console.log('==================================================\n');

  // 1. Reset stock to exactly 1
  await axios.put(`${BASE}/api/v1/inventory/${PRODUCT_ID}/reset-stock`, { quantity: INITIAL_STOCK });
  console.log(`Stock reset to ${INITIAL_STOCK}.`);
  console.log(`Firing ${CONCURRENT_BUYERS} simultaneous purchase requests (qty 1 each)...\n`);

  const start = Date.now();
  const results = await Promise.all(Array.from({ length: CONCURRENT_BUYERS }, purchase));
  const elapsed = Date.now() - start;

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  // 2. Read the real final stock from the DB
  const after = await axios.get(`${BASE}/api/v1/products/${PRODUCT_ID}`);
  const finalStock = after.data.data.quantity;

  console.log('--------------------------------------------------');
  console.log('  RESULT');
  console.log('--------------------------------------------------');
  console.log(`Initial stock          : ${INITIAL_STOCK}`);
  console.log(`Concurrent requests    : ${CONCURRENT_BUYERS}`);
  console.log(`Purchases SUCCEEDED    : ${succeeded}   (should be 1)`);
  console.log(`Purchases REJECTED     : ${failed}`);
  console.log(`Final stock in DB      : ${finalStock}   (should be 0)`);
  console.log(`Oversold units         : ${Math.max(0, succeeded - INITIAL_STOCK)}`);
  console.log(`Elapsed                : ${elapsed} ms`);
  console.log('--------------------------------------------------');

  if (succeeded > INITIAL_STOCK || finalStock < 0) {
    console.log('\n❌ OVERSELLING OCCURRED — the race condition is proven.');
    console.log(`   ${succeeded} customers were sold a product that had only ${INITIAL_STOCK} unit(s).`);
  } else {
    console.log('\n⚠️  No oversell this run (races are timing-dependent). Re-run a few times.');
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('Test error:', e.message);
  process.exit(1);
});
