/**
 * Task 3.2/3.3 – MongoDB Transactions: rollback on failure + concurrent safety.
 *
 * Part A (Rollback): same forced-crash scenario as task3-no-transaction.js, but
 *   wrapped in a transaction. The abort rolls EVERYTHING back — stock unchanged,
 *   no order. No partial state.
 *
 * Part B (Concurrency): many simultaneous transactional checkouts against a
 *   small stock. Transaction isolation + write-conflict aborts guarantee:
 *     - no oversell (stock never negative)
 *     - orders created == units of stock consumed (no partial updates)
 *
 * REQUIRES a replica set. Default URI is the temporary rs0 on :27018.
 * Override with TASK3_DB_URI.
 *
 * Run:  node test/task3-transaction.js
 */

const mongoose = require('mongoose');

const URI = process.env.TASK3_DB_URI
  || 'mongodb://127.0.0.1:27018/ecommerce_task3?replicaSet=rs0';

const PRODUCT_ID = new mongoose.Types.ObjectId('700000000000000000000001');
const USER = '6645afbc0000000000000005';

async function seed(Product, Order, stock) {
  await Product.findByIdAndUpdate(
    PRODUCT_ID,
    {
      $set: {
        title: 'TX Demo Product', slug: 'tx-demo-product',
        description: 'Product used to demonstrate transaction integrity.',
        quantity: stock, sold: 0, price: 100,
        imageCover: 'demo.png', category: new mongoose.Types.ObjectId(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await Order.deleteMany({ user: USER });
}

(async () => {
  await mongoose.connect(URI);
  require('../models/categoryModel'); // referenced by Product's populate hook
  const Product = require('../models/productModel');
  const Order = require('../models/orderModel');
  const { runCheckout } = require('../services/checkoutService');

  console.log('\n==================================================');
  console.log('  TASK 3.2/3.3 – MONGODB TRANSACTIONS');
  console.log('==================================================');

  // ---- Part A: rollback on failure -------------------------------------------
  console.log('\n--- Part A: Atomic rollback on a forced failure ---\n');
  await seed(Product, Order, 5);
  const a0 = await Product.findById(PRODUCT_ID).lean();
  console.log(`BEFORE → stock: ${a0.quantity}, orders: 0`);

  try {
    await runCheckout({ productId: PRODUCT_ID, qty: 1, useTransaction: true, forceOrderFailure: true });
  } catch (err) {
    console.log(`✖ Checkout threw (expected): ${err.message}`);
  }

  const a1 = await Product.findById(PRODUCT_ID).lean();
  const aOrders = await Order.countDocuments({ user: USER });
  console.log(`AFTER  → stock: ${a1.quantity}, orders: ${aOrders}`);
  const rolledBack = a1.quantity === a0.quantity && aOrders === 0;
  console.log(rolledBack
    ? '✅ ROLLED BACK — stock unchanged, no order. No partial state.'
    : '❌ Partial state leaked — rollback failed.');

  // ---- Part B: concurrent transactional checkouts ----------------------------
  console.log('\n--- Part B: Concurrent transactional checkouts ---\n');
  const STOCK = 5;
  const BUYERS = 15;
  await seed(Product, Order, STOCK);
  console.log(`Stock = ${STOCK}; firing ${BUYERS} concurrent transactional checkouts (qty 1)...`);

  const results = await Promise.allSettled(
    Array.from({ length: BUYERS }, () =>
      runCheckout({ productId: PRODUCT_ID, qty: 1, useTransaction: true, forceOrderFailure: false }))
  );

  const committed = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = BUYERS - committed;

  const final = await Product.findById(PRODUCT_ID).lean();
  const finalOrders = await Order.countDocuments({ user: USER });

  console.log('\n--------------------------------------------------');
  console.log('  CONCURRENT RESULT');
  console.log('--------------------------------------------------');
  console.log(`Initial stock          : ${STOCK}`);
  console.log(`Concurrent checkouts   : ${BUYERS}`);
  console.log(`Committed (orders)     : ${committed}`);
  console.log(`Rejected (stock/conflict): ${rejected}`);
  console.log(`Final stock            : ${final.quantity}   (never < 0)`);
  console.log(`Orders created         : ${finalOrders}`);
  console.log(`Units sold (sold field): ${final.sold}`);
  console.log('--------------------------------------------------');

  const consistent =
    final.quantity >= 0 &&
    final.quantity === STOCK - committed &&
    finalOrders === committed &&
    final.sold === committed;

  console.log(consistent
    ? '\n✅ CONSISTENT — orders created == stock consumed == sold; no oversell, no partial updates.'
    : '\n❌ Inconsistency detected — investigate.');
  console.log('');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('Test error:', e.message);
  if (/replica set|Transaction numbers/.test(e.message)) {
    console.error('\n➡  MongoDB transactions require a replica set. Point TASK3_DB_URI at one,');
    console.error('   or convert your local mongod (see docs/task-3-transaction-integrity.md).');
  }
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
