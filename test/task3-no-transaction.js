/**
 * Task 3.1 – Demonstrate the Failure (NO transaction)
 *
 * Forces order creation to fail AFTER payment + inventory update. Because the
 * three steps are not atomic, the database is left inconsistent:
 *   - payment charged
 *   - stock decremented
 *   - NO order record
 *
 * Self-contained: opens its own MongoDB connection, seeds a product, runs the
 * scenario, prints the database state as proof.
 *
 * Run:  node test/task3-no-transaction.js
 *   Default DB: the temporary replica set on :27018 (also works on standalone,
 *   since this path uses no transactions). Override with TASK3_DB_URI.
 */

const mongoose = require('mongoose');

const URI = process.env.TASK3_DB_URI
  || 'mongodb://127.0.0.1:27018/ecommerce_task3?replicaSet=rs0';

const PRODUCT_ID = new mongoose.Types.ObjectId('700000000000000000000001');
const INITIAL_STOCK = 5;

(async () => {
  await mongoose.connect(URI);
  // require models AFTER connecting so they bind to this connection
  require('../models/categoryModel'); // referenced by Product's populate hook
  const Product = require('../models/productModel');
  const Order = require('../models/orderModel');
  const { runCheckout } = require('../services/checkoutService');

  console.log('\n==================================================');
  console.log('  TASK 3.1 – NO TRANSACTION (partial-state failure)');
  console.log('==================================================\n');

  // Seed / reset the demo product
  await Product.findByIdAndUpdate(
    PRODUCT_ID,
    {
      $set: {
        title: 'TX Demo Product', slug: 'tx-demo-product',
        description: 'Product used to demonstrate transaction integrity.',
        quantity: INITIAL_STOCK, sold: 0, price: 100,
        imageCover: 'demo.png', category: new mongoose.Types.ObjectId(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await Order.deleteMany({ user: '6645afbc0000000000000005' });

  const before = await Product.findById(PRODUCT_ID).lean();
  const ordersBefore = await Order.countDocuments({ user: '6645afbc0000000000000005' });
  console.log(`BEFORE  → stock: ${before.quantity}, sold: ${before.sold}, orders: ${ordersBefore}\n`);

  console.log('Running checkout WITHOUT a transaction, forcing the order step to crash...');
  let paymentTaken = false;
  try {
    await runCheckout({ productId: PRODUCT_ID, qty: 1, useTransaction: false, forceOrderFailure: true });
  } catch (err) {
    // Payment + inventory already happened before the crash
    paymentTaken = true;
    console.log(`✖ Checkout threw: ${err.message}\n`);
  }

  const after = await Product.findById(PRODUCT_ID).lean();
  const ordersAfter = await Order.countDocuments({ user: '6645afbc0000000000000005' });

  console.log('--------------------------------------------------');
  console.log('  DATABASE STATE AFTER THE FAILURE');
  console.log('--------------------------------------------------');
  console.log(`Payment charged        : ${paymentTaken ? 'YES (customer billed)' : 'no'}`);
  console.log(`Stock before / after   : ${before.quantity} → ${after.quantity}  (decremented)`);
  console.log(`Sold before / after    : ${before.sold} → ${after.sold}`);
  console.log(`Orders before / after  : ${ordersBefore} → ${ordersAfter}  (NO order created)`);
  console.log('--------------------------------------------------');

  const inconsistent = after.quantity < before.quantity && ordersAfter === ordersBefore;
  console.log(inconsistent
    ? '\n❌ INCONSISTENT STATE — payment taken & stock reduced, but NO order exists.\n   This is exactly what transactions must prevent.'
    : '\n(Unexpected — state looks consistent.)');
  console.log('');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('Test error:', e.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
