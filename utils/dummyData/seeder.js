const fs = require('fs');
require('colors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const path = require('path');
const mongoose = require('mongoose');

// Models
const Product = require('../../models/productModel');
const User = require('../../models/userModel');
const Cart = require('../../models/cartModel');
const Order = require('../../models/orderModel');
const dbConnection = require('../../config/database');

dotenv.config({
  path: path.join(__dirname, '../../config.env'),
});

// Connect to Database
dbConnection();

const productsPath = path.join(__dirname, 'products.json');
const usersPath = path.join(__dirname, 'users.json');

// Read JSON files
const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));

const USE_HASH = false;

// Helper function to get a random integer within a range
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Prepare users (hash passwords if needed)
const prepareUsers = async () => {
  if (!USE_HASH) return users;

  return Promise.all(
    users.map(async (user) => ({
      ...user,
      password: await bcrypt.hash(user.password, 12),
    }))
  );
};

// 🔥 Optimized function to generate 100,000 orders using chunked processing
const generateMockOrders = async (insertedUsers, insertedProducts) => {
  try {
    console.log('🚀 Starting to build 100,000 mock orders based on inserted data...'.yellow);

    const totalOrdersToCreate = 100000; // Fixed: Now exactly 100,000 Orders
    const chunkSize = 10000; // Processing 10k records per iteration to keep memory light and fast
    let currentInsertedCount = 0;

    while (currentInsertedCount < totalOrdersToCreate) {
      const ordersBatch = [];
      
      // Build a single batch of 10,000 records
      for (let i = 0; i < chunkSize; i += 1) {
        const randomUser = insertedUsers[getRandomInt(0, insertedUsers.length - 1)]._id;
        const itemsCount = getRandomInt(1, 4);
        const cartItems = [];
        let totalOrderPrice = 0;

        for (let j = 0; j < itemsCount; j += 1) {
          const randomProduct = insertedProducts[getRandomInt(0, insertedProducts.length - 1)];
          const quantity = getRandomInt(1, 3);
          const price = randomProduct.price;

          cartItems.push({
            product: randomProduct._id,
            quantity: quantity,
            color: ['Red', 'Blue', 'Black', 'White'][getRandomInt(0, 3)],
            price: price
          });

          totalOrderPrice += price * quantity;
        }

        ordersBatch.push({
          user: randomUser,
          cartItems: cartItems,
          taxPrice: 0,
          shippingPrice: 15,
          totalOrderPrice: totalOrderPrice + 15,
          paymentMethodType: getRandomInt(0, 1) === 0 ? 'cash' : 'card',
          isPaid: true,
          paidAt: new Date(Date.now() - getRandomInt(0, 24) * 60 * 60 * 1000), // Random times within the last 24 hours
          isDelivered: getRandomInt(0, 1) === 0,
          deliveredAt: new Date()
        });
      }

      // Inject the current batch into MongoDB
      // eslint-disable-next-line no-await-in-loop
      await Order.insertMany(ordersBatch);
      currentInsertedCount += chunkSize;
      
      // Print progress metrics
      const percentage = ((currentInsertedCount / totalOrdersToCreate) * 100).toFixed(0);
      console.log(`💾 Progress: ${currentInsertedCount.toLocaleString()} / ${totalOrdersToCreate.toLocaleString()} orders inserted (${percentage}%)...`.cyan);
    }

    console.log('🎉 Successfully created and saved all 100,000 orders!'.green.bold);

  } catch (error) {
    console.error('❌ Error during mock orders generation:'.red, error);
    throw error;
  }
};

// Insert all data sequentially (Pipeline)
const insertData = async () => {
  try {
    // 1. Insert Products
    console.log('⏳ Inserting products...'.cyan);
    const createdProducts = await Product.create(products);
    console.log(`... Inserted ${createdProducts.length} products successfully.`.green);

    // 2. Insert Users
    console.log('⏳ Inserting users...'.cyan);
    const preparedUsers = await prepareUsers();
    const createdUsers = await User.create(preparedUsers);
    console.log(`... Inserted ${createdUsers.length} users successfully.`.green);

    console.log('⚡ Base data injected successfully (Products + Users)'.green.inverse);

    // 3. Trigger order generation pipeline
    await generateMockOrders(createdUsers, createdProducts);

    console.log('\n🌟 Seeding process completed successfully for all records! 🌟'.green.bold.inverse);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error in Insert pipeline:'.red, error);
    process.exit(1);
  }
};

// Destroy and clear all database collections
const destroyData = async () => {
  try {
    console.log('🗑️  Cleaning up and purging database...'.cyan);
    await Product.deleteMany();
    await User.deleteMany();
    await Cart.deleteMany();
    await Order.deleteMany();

    console.log('🗑️  Data Destroyed Successfully (Products + Users + Carts + Orders)'.red.inverse);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error in Destroy pipeline:'.red, error);
    process.exit(1);
  }
};

// CLI Commands Parsing
const command = process.argv[2];

if (command === '-i') {
  insertData();
} else if (command === '-d') {
  destroyData();
} else {
  console.log(`
Usage:
  node seeder.js -i   → Import All Data (Products + Users + 100,000 Orders)
  node seeder.js -d   → Destroy All Data (Products + Users + Carts + Orders)
  `.yellow);
  process.exit();
}