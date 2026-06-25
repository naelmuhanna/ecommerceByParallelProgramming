/**
 * Task 3 – Transaction Integrity (ACID)
 *
 * A checkout is three steps that must be ATOMIC:
 *   1. Payment        (charge the customer)
 *   2. Inventory      (decrement stock)
 *   3. Order creation (persist the order record)
 *
 * If step 3 fails after steps 1–2 already committed, the system is left in an
 * inconsistent state: the customer paid and stock was reduced, but no order
 * exists. MongoDB multi-document transactions (via Mongoose sessions) make all
 * three succeed together or roll back together.
 *
 * NOTE: MongoDB transactions require a replica set (or mongos). A standalone
 * mongod throws "Transaction numbers are only allowed on a replica set member".
 */

const mongoose = require('mongoose');
const asyncHandler = require('express-async-handler');
const Product = require('../models/productModel');
const Order = require('../models/orderModel');
const ApiError = require('../utils/apiError');

const DEFAULT_USER = '6645afbc0000000000000005';

// Simulated external payment gateway. Always "succeeds" so we can isolate the
// failure to the order-persistence step.
async function chargePayment(amount) {
  return { id: `pay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, amount, status: 'succeeded' };
}

function isTransient(err) {
  return Array.isArray(err?.errorLabels) && err.errorLabels.includes('TransientTransactionError');
}

/**
 * Run one checkout.
 * @param {string}  productId
 * @param {number}  qty
 * @param {boolean} useTransaction  wrap steps 2–3 in a MongoDB transaction
 * @param {boolean} forceOrderFailure simulate a crash AFTER payment + inventory
 * @param {number}  maxRetries retries for transient (write-conflict) errors
 * @returns {{ok, payment, orderId, stockBefore, stockAfter}}
 */
async function runCheckout({
  productId,
  qty = 1,
  useTransaction = false,
  forceOrderFailure = false,
  userId = DEFAULT_USER,
  maxRetries = 3,
}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let session = null;
    if (useTransaction) {
      session = await mongoose.startSession();
      session.startTransaction();
    }
    try {
      // 1. Read product (within the session when transactional)
      const query = Product.findById(productId);
      if (session) query.session(session);
      const product = await query;
      if (!product) throw new ApiError('Product not found', 404);
      if (product.quantity < qty) throw new ApiError(`Insufficient stock (${product.quantity})`, 400);
      const stockBefore = product.quantity;

      // 2. Payment (external)
      const payment = await chargePayment(product.price * qty);

      // 3. Inventory decrement
      await Product.updateOne(
        { _id: productId },
        { $inc: { quantity: -qty, sold: qty } },
        session ? { session } : {}
      );

      // 4. Order creation — may "crash"
      if (forceOrderFailure) {
        throw new Error('SIMULATED CRASH: order persistence failed after payment + inventory update');
      }
      const created = await Order.create(
        [{
          user: userId,
          cartItems: [{ product: productId, quantity: qty, price: product.price }],
          totalOrderPrice: product.price * qty,
          paymentMethodType: 'cash',
          isPaid: true,
          paidAt: Date.now(),
        }],
        session ? { session } : {}
      );

      if (session) await session.commitTransaction();
      return { ok: true, payment, orderId: created[0]._id, stockBefore, stockAfter: stockBefore - qty };
    } catch (err) {
      if (session) await session.abortTransaction();
      if (useTransaction && isTransient(err) && attempt <= maxRetries) {
        continue; // retry the whole transaction on a write conflict
      }
      throw err;
    } finally {
      if (session) session.endSession();
    }
  }
}

// ─── Express handlers (in-app API surface) ───────────────────────────────────
// Mounted under /api/v1/inventory. The transaction route only works when the
// app's MongoDB is a replica set.

exports.checkoutNoTransaction = asyncHandler(async (req, res) => {
  const result = await runCheckout({
    productId: req.params.id,
    qty: parseInt(req.body.quantity, 10) || 1,
    useTransaction: false,
    forceOrderFailure: req.body.forceFail === true || req.query.fail === 'true',
  });
  res.status(201).json({ status: 'success', mode: 'no-transaction', ...result });
});

exports.checkoutTransaction = asyncHandler(async (req, res) => {
  const result = await runCheckout({
    productId: req.params.id,
    qty: parseInt(req.body.quantity, 10) || 1,
    useTransaction: true,
    forceOrderFailure: req.body.forceFail === true || req.query.fail === 'true',
  });
  res.status(201).json({ status: 'success', mode: 'transaction', ...result });
});

exports.runCheckout = runCheckout;
