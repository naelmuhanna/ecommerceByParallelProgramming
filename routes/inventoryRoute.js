const express = require('express');
const {
  purchaseOptimistic,
  purchasePessimistic,
  purchaseAtomic,
  purchaseUnsafe,
  resetStock,
} = require('../services/inventoryService');
const {
  checkoutNoTransaction,
  checkoutTransaction,
} = require('../services/checkoutService');

const router = express.Router();

// Task 2 – concurrency control demo routes (no auth for academic testing)

// Option A: Optimistic Locking (Compare-and-Swap with lockVersion)
router.post('/:id/purchase-optimistic', purchaseOptimistic);

// Option B: Pessimistic Locking (Redis distributed mutex)
router.post('/:id/purchase-pessimistic', purchasePessimistic);

// Option C: Atomic conditional update (Task 5 optimized write path)
router.post('/:id/purchase-atomic', purchaseAtomic);

// Before: no locking — demonstrates race condition / overselling
router.post('/:id/purchase-unsafe', purchaseUnsafe);

// Reset stock for repeated demos
router.put('/:id/reset-stock', resetStock);

// Task 3 – Transaction integrity (payment + inventory + order).
// add ?fail=true (or body.forceFail) to simulate an order-creation crash.
router.post('/:id/checkout-no-transaction', checkoutNoTransaction); // partial-state on failure
router.post('/:id/checkout-transaction', checkoutTransaction);      // atomic; needs replica set

module.exports = router;
