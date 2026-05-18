// server.js (Parallel Cluster & Express Engine - Fully ESLint Compliant)
const cluster = require('cluster');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');

// Import configurations and custom layers
dotenv.config({ path: 'config.env' });
const ApiError = require('./utils/apiError');
const globalError = require('./middlewares/errorMiddleware');
const dbConnection = require('./config/database');
const mountRoutes = require('./routes');
const { webhookCheckout } = require('./services/orderService');
const startTraditionalInventoryCron = require('./cron/inventoryCron');

// 🚀 Load worker early to avoid global-require warnings
// Note: The actual worker will only run inside child processes below
const orderWorker = require('./queues/orderWorker');

const WORKER_COUNT = 10;

// 📦 1. Define the main function first to avoid no-use-before-define warning
function startExpressServer() {
  // Establish database connection
  dbConnection();

  // Start background processes inside Master only
  startTraditionalInventoryCron();

  const app = express();

  // Enable Cross-Origin Resource Sharing (CORS)
  app.use(cors());
  app.options('*', cors());

  // Compress HTTP responses for better performance
  app.use(compression());

  // Checkout webhook (must use raw body parser)
  app.post(
    '/webhook-checkout',
    express.raw({ type: 'application/json' }),
    webhookCheckout
  );

  // Middlewares
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, 'uploads')));

  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
    console.log(`mode: ${process.env.NODE_ENV}`);
  }

  // Rate Limiter configuration (currently disabled)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later',
  });
  // app.use('/api', limiter);

  // Protect against HTTP Parameter Pollution
  app.use(
    hpp({
      whitelist: [
        'price',
        'sold',
        'quantity',
        'ratingsAverage',
        'ratingsQuantity',
      ],
    })
  );

  // Mount application routes
  mountRoutes(app);

  // Base API route
  app.get('/', (req, res) => {
    res.status(200).json({
      status: 'success',
      message: 'Welcome to E-commerce API 🚀',
    });
  });

  // Handle undefined routes
  app.all('*', (req, res, next) => {
    next(new ApiError(`Can't find this route: ${req.originalUrl}`, 400));
  });

  // Global error handling middleware
  app.use(globalError);

  const PORT = process.env.PORT || 8000;
  const server = app.listen(PORT, () => {
    console.log(`🚀 [Express App] Running smoothly on port ${PORT}`);
  });

  // Graceful shutdown handling
  process.on('unhandledRejection', async (err) => {
    console.error(`UnhandledRejection Error: ${err.name} | ${err.message}`);

    if (orderWorker) {
      console.log('Stopping background worker safely...');
      await orderWorker.close();
    }

    server.close(() => {
      console.error('Shutting down server...');
      process.exit(1);
    });
  });
}

// 🌐 2. Cluster management for stateless horizontal scaling
if (cluster.isMaster) {
  console.log(
    `👑 [Master] Spawning ${WORKER_COUNT} independent parallel background workers...`
  );

  // Master process forks worker processes
  for (let i = 0; i < WORKER_COUNT; i += 1) {
    cluster.fork();
  }

  // Auto-recovery mechanism for crashed workers
  cluster.on('exit', (worker) => {
    console.log(
      `⚠️ [Master] Worker process ${worker.process.pid} died. Respawning...`
    );
    cluster.fork();
  });

  // Master process runs the Express server (binds port 8000)
  startExpressServer();

} else {
  // Worker processes handle Redis jobs only (no port binding)
  console.log(
    `👷‍♂️ [Worker Process: ${process.pid}] Initialized and listening to Redis...`
  );
}