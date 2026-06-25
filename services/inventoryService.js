/**
 * Task 2 – Concurrency Control for Inventory Updates
 *
 * Two locking strategies are implemented and exposed as separate routes
 * so they can be compared academically:
 *
 *   Option A – Optimistic Locking  POST /api/v1/inventory/:id/purchase-optimistic
 *   Option B – Pessimistic Locking POST /api/v1/inventory/:id/purchase-pessimistic
 *
 * Both protect against the classic race condition:
 *   stock = 1, two simultaneous purchases → overselling (stock = -1).
 */

const asyncHandler = require('express-async-handler');
const Product = require('../models/productModel');
const ApiError = require('../utils/apiError');
const redis = require('../config/redis');
const { deleteCache, deleteCacheByPattern } = require('../utils/cache');

// ─────────────────────────────────────────────────────────────────────────────
// OPTION A — Optimistic Locking
//
// Theory:
//   Read the current document (with its lockVersion).
//   Attempt an atomic update that also checks the lockVersion hasn't changed.
//   If another concurrent request already updated lockVersion, our update
//   matches zero documents (version mismatch) → retry.
//
//   This is the "Compare-and-Swap" (CAS) pattern.
//   MongoDB's atomic findOneAndUpdate guarantees that the filter + update is
//   a single indivisible operation — no other write can interleave between
//   the version check and the stock decrement.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

exports.purchaseOptimistic = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const qty = parseInt(req.body.quantity, 10) || 1;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt+=1) {
  // eslint-disable-next-line no-await-in-loop
  const product = await Product.findById(id).select(
    'quantity lockVersion title'
  );

  if (!product) {
    return next(new ApiError(`Product ${id} not found`, 404));
  }

  if (product.quantity < qty) {
    return next(
      new ApiError(
        `Insufficient stock. Available: ${product.quantity}, requested: ${qty}`,
        400
      )
    );
  }

  const updated = await Product.findOneAndUpdate(
    {
      _id: id,
      lockVersion: product.lockVersion,
    },
    {
      $inc: {
        quantity: -qty,
        sold: qty,
        lockVersion: 1,
      },
    },
    {
      new: true,
    }
  );

  if (updated) {
    await deleteCache(`product:${id}`);
    await deleteCacheByPattern('products:list:*');

    return res.status(200).json({
      status: 'success',
      strategy: 'optimistic-locking',
      attempt,
      data: {
        productId: id,
        title: updated.title,
        quantityRemaining: updated.quantity,
        lockVersion: updated.lockVersion,
      },
    });
  }

  console.log(
    `[OptimisticLock] Conflict on attempt ${attempt} for product ${id}. Retrying…`
  );

  // eslint-disable-next-line no-await-in-loop
  await new Promise((resolve) =>
    setTimeout(resolve, 10 * attempt)
  );
}

  return next(new ApiError(
    `Purchase failed after ${MAX_RETRIES} retries due to high concurrency. Try again.`, 409
  ));
});

// ─────────────────────────────────────────────────────────────────────────────
// OPTION B — Pessimistic Locking (Redis Distributed Lock / Mutex)
//
// Theory:
//   Because MongoDB has no traditional row-level locks (unlike SQL databases),
//   we emulate them using a Redis key as a mutex.
//
//   The lock uses the SET NX PX command (atomic: set-if-not-exists with expiry)
//   which is the standard building block for distributed locks in Redis.
//
//   Only the process that successfully set the key "holds the lock".
//   All other processes spin-wait (poll) until the lock is released.
//   This turns concurrent access into sequential access for that product.
//
//   Why this is the Node.js/distributed-system approach:
//   SQL databases manage locks internally at the storage engine level (row-level
//   MVCC). MongoDB's document-level atomicity covers single-document writes but
//   not the read-modify-write pattern across time. A Redis distributed lock
//   provides an equivalent guarantee for multi-step operations involving any
//   data store.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_TTL_MS   = 5000;  // Lock expires after 5 s to prevent deadlocks
const LOCK_POLL_MS  = 20;    // Poll every 20 ms while waiting
const LOCK_TIMEOUT  = 4000;  // Give up waiting after 4 s

async function acquireLock(key, ttl) {
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const result = await redis.set(key, token, 'PX', ttl, 'NX');
  return result === 'OK' ? token : null;
}

async function releaseLock(key, token) {
  // Lua script: delete key only if we still own it (prevents releasing another owner's lock)
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, 1, key, token);
}

async function waitForLock(key, ttl, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const token = await acquireLock(key, ttl);
    if (token) return token;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  return null;
}

exports.purchasePessimistic = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const qty = parseInt(req.body.quantity, 10) || 1;
  const lockKey = `lock:inventory:${id}`;

  // 1. Acquire the distributed lock
  const token = await waitForLock(lockKey, LOCK_TTL_MS, LOCK_TIMEOUT);
  if (!token) {
    return next(new ApiError(
      'Could not acquire inventory lock — system under high concurrency, retry shortly.', 503
    ));
  }

  try {
    // 2. Critical section (only one process executes this at a time)
    const product = await Product.findById(id).select('quantity sold title');
    if (!product) return next(new ApiError(`Product ${id} not found`, 404));

    if (product.quantity < qty) {
      return next(new ApiError(
        `Insufficient stock. Available: ${product.quantity}, requested: ${qty}`, 400
      ));
    }

    product.quantity -= qty;
    product.sold     += qty;
    await product.save();

    // Invalidate cache
    await deleteCache(`product:${id}`);
    await deleteCacheByPattern('products:list:*');

    return res.status(200).json({
      status: 'success',
      strategy: 'pessimistic-locking (redis-mutex)',
      data: {
        productId: id,
        title: product.title,
        quantityRemaining: product.quantity,
      },
    });
  } finally {
    // 3. Always release the lock, even on error
    await releaseLock(lockKey, token);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// OPTION C — Atomic Conditional Update (Task 5 optimization)
//
// The optimistic strategy above does read → compare-and-swap → retry with
// exponential back-off. Under heavy single-product contention that becomes a
// "retry storm": most requests collide on lockVersion, burn their 5 retries
// (plus 10·attempt ms sleeps), and are rejected with 409 — throttling
// throughput badly (see Task 4).
//
// This version collapses the whole read-modify-write into ONE atomic operation:
// MongoDB applies the stock guard (quantity >= qty) and the decrement in a
// single indivisible document update. No prior read, no version field, no
// retry loop, no back-off sleeps. It is impossible to oversell because the
// guard and the write are evaluated atomically by the storage engine.
// ─────────────────────────────────────────────────────────────────────────────

exports.purchaseAtomic = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const qty = parseInt(req.body.quantity, 10) || 1;

  // Single atomic conditional decrement — only succeeds if enough stock exists.
  const updated = await Product.findOneAndUpdate(
    { _id: id, quantity: { $gte: qty } },
    { $inc: { quantity: -qty, sold: qty } },
    { new: true }
  );

  if (!updated) {
    // Either the product doesn't exist or there isn't enough stock.
    const exists = await Product.exists({ _id: id });
    return next(new ApiError(
      exists ? `Insufficient stock for the requested quantity (${qty})` : `Product ${id} not found`,
      exists ? 400 : 404
    ));
  }

  await deleteCache(`product:${id}`);
  await deleteCacheByPattern('products:list:*');

  return res.status(200).json({
    status: 'success',
    strategy: 'atomic-conditional-update',
    data: {
      productId: id,
      title: updated.title,
      quantityRemaining: updated.quantity,
    },
  });
});

// ─── Oversell demo (NO locking) ──────────────────────────────────────────────
// Intentionally broken: demonstrates the race condition for the "before" proof.

exports.purchaseUnsafe = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const qty = parseInt(req.body.quantity, 10) || 1;

  // Artificial delay amplifies the race window (simulates DB latency)
  const product = await Product.findById(id).select('quantity sold title');
  if (!product) return next(new ApiError(`Product ${id} not found`, 404));

  // RACE WINDOW STARTS HERE — another request may read the same quantity
  await new Promise((r) => setTimeout(r, 50)); // simulate processing

  if (product.quantity < qty) {
    return next(new ApiError(`Insufficient stock: ${product.quantity}`, 400));
  }

  product.quantity -= qty;
  product.sold     += qty;
  await product.save(); // RACE WINDOW ENDS — last writer wins (oversell possible)

  return res.status(200).json({
    status: 'success',
    strategy: 'unsafe (no locking)',
    data: { productId: id, title: product.title, quantityRemaining: product.quantity },
  });
});

// ─── Reset product stock (for demo purposes) ──────────────────────────────────

exports.resetStock = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const { quantity } = req.body;

  const product = await Product.findByIdAndUpdate(
    id,
    { $set: { quantity: parseInt(quantity, 10), sold: 0, lockVersion: 0 } },
    { new: true }
  );

  if (!product) return next(new ApiError(`Product ${id} not found`, 404));

  await deleteCache(`product:${id}`);
  await deleteCacheByPattern('products:list:*');

  res.status(200).json({ status: 'success', message: 'Stock reset', data: product });
});
