// exports.addProductToCart = asyncHandler(async (req, res, next) => {
//   const { productId, color } = req.body;
//   const product = await Product.findById(productId);

//   let cart = await Cart.findOne({ user: req.user._id });

//   if (!cart) {
//     cart = await Cart.create({
//       user: req.user._id,
//       cartItems: [{ product: productId, color, price: product.price, quantity: 1 }],
//     });
//   } else {
//     const item = cart.cartItems.find(
//       (i) => i.product.toString() === productId && i.color === color
//     );

//     if (item) {
//       // ❌ BUG HERE: read-modify-write race condition
//       item.quantity += 1;
//     } else {
//       cart.cartItems.push({
//         product: productId,
//         color,
//         price: product.price,
//         quantity: 1,
//       });
//     }
//   }

//   await new Promise((resolve) => {
//   setTimeout(resolve, 300);
// }); // ⛔ artificially slow DB write

//   calcTotalCartPrice(cart);
//   await cart.save();

//   res.json({ success: true, cart });
// });

const axios = require("axios");

const PRODUCT_ID = "6a0acfda68c1140cdc9de3d6";
const COLOR = "red";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2YTBhY2ZkYTY4YzExNDBjZGM5ZGUzZjciLCJpYXQiOjE3NzkxMTM0NjUsImV4cCI6MTc3OTcxODI2NX0.ZaMte_-q-zSFOdUNiBSPpD-zwQOEk-f9PbupzA4gcNM";

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const runTest = async () => {
  console.log("\n==============================");
  console.log("🔥 RACE CONDITION STRESS TEST");
  console.log("==============================\n");

  const start = Date.now();

  const requests = [];

  // 🔥 Burst concurrency
  for (let i = 0; i < 5; i += 1) {
    const batch = [];

    for (let j = 0; j < 10; j += 1) {
      batch.push(
        axios.post(
          "http://localhost:8000/api/v1/cart",
          {
            productId: PRODUCT_ID,
            color: COLOR,
          },
          {
            headers: {
              Authorization: `Bearer ${TOKEN}`,
            },
          }
        )
      );
    }

    requests.push(Promise.all(batch));

    // 🔥 non-blocking delay (no ESLint warning)
    setTimeout(() => {}, 5);
  }

  console.log("📡 Sending concurrent bursts...");

  await Promise.all(requests);

  console.log("✔ Requests completed");

  const res = await axios.get("http://localhost:8000/api/v1/cart", {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  });

  const cart = res.data.data;

  let totalQty = 0;

  cart.cartItems.forEach((item) => {
    totalQty += item.quantity;
  });

  const end = Date.now();

  console.log("\n==============================");
  console.log("📊 FINAL RESULT");
  console.log("==============================");

  console.log("Cart Items:");
  console.log(JSON.stringify(cart.cartItems, null, 2));

  console.log("------------------------------");
  console.log("Expected Quantity: 50");
  console.log("Actual Quantity:", totalQty);
  console.log("Lost Updates:", 50 - totalQty);
  console.log("Execution Time:", end - start, "ms");

  console.log("==============================\n");
};

runTest();


