const fs = require('fs');
require('colors');
const dotenv = require('dotenv');
const path = require('path');
const dbConnection = require('../../config/database'); // عدل المسار حسب مشروعك

// استدعاء الموديلز
const Order = require('../../models/orderModel'); // عدل المسار حسب مشروعك
const User = require('../../models/userModel');
const Product = require('../../models/productModel');

dotenv.config({
  path: path.join(__dirname, '../../config.env'),
});

// الاتصال بقاعدة البيانات
dbConnection();

// دالة لتوليد أرقام عشوائية ضمن نطاق معين
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const generateMockOrders = async () => {
  try {
    console.log('⏳ جاري جلب المستخدمين والمنتجات من قاعدة البيانات...'.cyan);
    
    // جلب الـ IDs الخاصة بالمستخدمين والمنتجات المتوفرة
    const users = await User.find({}, '_id');
    const products = await Product.find({}, '_id price');

    if (users.length === 0 || products.length === 0) {
      console.log('❌ خطأ: يجب أن تحتوي قاعدة البيانات على مستخدمين ومنتجات أولاً قبل توليد الطلبات!'.red);
      process.exit(1);
    }

    console.log(`✨ تم العثور على ${users.length} مستخدم و ${products.length} منتج.`.green);
    console.log('🚀 البدء في بناء 10,000 طلب وهمي...'.yellow);

    const ordersBatch = [];
    const totalOrdersToCreate = 10000;

    for (let i = 0; i < totalOrdersToCreate; i+=1) {
      // اختيار مستخدم عشوائي ليكون صاحب الطلب
      const randomUser = users[getRandomInt(0, users.length - 1)]._id;
      
      // تحديد عدد عشوائي من المنتجات داخل الطلب الواحد (من 1 إلى 4 منتجات مختلفة)
      const itemsCount = getRandomInt(1, 4);
      const cartItems = [];
      let totalOrderPrice = 0;

      for (let j = 0; j < itemsCount; j+=1) {
        const randomProduct = products[getRandomInt(0, products.length - 1)];
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

      // بناء جسم الطلب (مكتمل الدفع ومسجل كـ cash أو card)
      ordersBatch.push({
        user: randomUser,
        cartItems: cartItems,
        taxPrice: 0,
        shippingPrice: 15, // تكلفة شحن افتراضية ثابتة
        totalOrderPrice: totalOrderPrice + 15,
        paymentMethodType: getRandomInt(0, 1) === 0 ? 'cash' : 'card',
        isPaid: true,
        paidAt: new Date(Date.now() - getRandomInt(0, 24) * 60 * 60 * 1000), // أوقات عشوائية خلال الـ 24 ساعة الماضية
        isDelivered: getRandomInt(0, 1) === 0,
        deliveredAt: new Date()
      });
    }

    console.log('💾 جاري إدخال البيانات إلى MongoDB عبر Bulk Insert...'.cyan);
    
    // إدخال الـ 10,000 طلب دفعة واحدة
    await Order.insertMany(ordersBatch);

    console.log(`🎉 تم إدخال ${totalOrdersToCreate} طلب بنجاح إلى قاعدة البيانات!`.green.inverse);
    process.exit(0);
  } catch (error) {
    console.error('❌ حدث خطأ أثناء توليد البيانات:'.red, error);
    process.exit(1);
  }
};

// دالة لتفريغ جدول الطلبات فقط إذا احتجت تنظيفها لاحقاً
const destroyOrders = async () => {
  try {
    await Order.deleteMany();
    console.log('🗑️ تم مسح جميع الطلبات بنجاح من قاعدة البيانات!'.red.inverse);
    process.exit(0);
  } catch (error) {
    console.error('❌ حدث خطأ أثناء مسح البيانات:'.red, error);
    process.exit(1);
  }
};

// قراءة الأوامر من الـ CLI
const command = process.argv[2];

if (command === '-i') {
  generateMockOrders();
} else if (command === '-d') {
  destroyOrders();
} else {
  console.log(`
  الرجاء تحديد خيار للتشغيل:
  node orderSeeder.js -i   ← لتوليد الـ 10,000 طلب
  node orderSeeder.js -d   ← لمسح كافة الطلبات
  `.yellow);
  process.exit();
}