#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PRESENTATION RUNNER — one command per task (BEFORE → AFTER → RESULTS)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node presentation/run-task.js <1|2|3|4|5|all>
 *
 * Normally you invoke it through the PowerShell helpers in presentation/tasks.ps1:
 *   . .\presentation\tasks.ps1     # load once per session
 *   task_1   task_2   task_3   task_4   task_5   task_all
 *
 * What it does for each task:
 *   1. Checks infrastructure (MongoDB :27017, Redis :6379).
 *   2. Auto-starts the API server if it is not already running, in development
 *      mode (required for the Task 1 cache-flush route), and stops it afterwards.
 *      If a server is already up, it is reused and left running.
 *   3. Discovers a real product id from the seeded DB (Tasks 2, 4, 5).
 *   4. Ensures a MongoDB replica set for Task 3 (auto-starts a throwaway one on
 *      :27018 if none is reachable, then shuts it down afterwards).
 *   5. Runs the task's BEFORE / AFTER / RESULTS scripts in order, streaming their
 *      output straight to the terminal.
 *
 * No new dependencies — only Node core plus mongoose (already a project dep).
 * On-screen text is English (committee-facing), matching the test scripts.
 */

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT, 10) || 8000;
const BASE_URL = `http://localhost:${PORT}`;
const IS_WIN = process.platform === 'win32';
const SERVER_LOG = path.join(__dirname, 'server.log');
const RS_LOG = path.join(__dirname, 'mongo-rs.log');
const RS_PORT = 27018;
const RS_DBPATH = path.join(os.tmpdir(), 'mongo-rs-task3');
const RS_DEFAULT_URI = `mongodb://127.0.0.1:${RS_PORT}/ecommerce_task3?replicaSet=rs0`;

// ─── Tiny ANSI helpers ─────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', blue: '\x1b[34m',
};
const out = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const bar = '═'.repeat(width + 2);
  out('\n' + c.cyan + '╔' + bar + '╗' + c.reset);
  for (const l of lines) {
    out(c.cyan + '║ ' + c.reset + c.bold + l + c.reset + ' '.repeat(width - l.length) + c.cyan + ' ║' + c.reset);
  }
  out(c.cyan + '╚' + bar + '╝' + c.reset);
}
function section(title) {
  const dashes = '─'.repeat(Math.max(3, 64 - title.length));
  out('\n' + c.blue + '── ' + c.bold + title + c.reset + c.blue + ' ' + dashes + c.reset);
}
function divider() { out(c.dim + '─'.repeat(68) + c.reset); }
function ok(msg) { out('   ' + c.green + '✓ ' + c.reset + msg); }
function info(msg) { out('   ' + c.cyan + 'ℹ ' + c.reset + msg); }
function warn(msg) { out('   ' + c.yellow + '⚠ ' + c.reset + msg); }
function err(msg) { out('   ' + c.red + '✗ ' + c.reset + msg); }
function statusLine(label, up) {
  out('   ' + (up ? c.green + '●' : c.red + '○') + c.reset + ' ' + label + ' : ' + (up ? c.green + 'UP' : c.red + 'DOWN') + c.reset);
}

// ─── Task definitions ──────────────────────────────────────────────────────────
const TASKS = {
  1: {
    title: 'TASK 1 — Distributed Caching with Redis (Cache-Aside)',
    doc: 'docs/task-1-distributed-caching.md',
    code: 'utils/cache.js + services/productService.js (getProduct / getProducts)',
    needsServer: true,
    steps: [
      { label: 'BEFORE — Baseline: cache flushed each request → 100% MongoDB traffic', script: 'test/task1-before.js' },
      { label: 'AFTER — Cache-Aside: MISS → HIT → INVALIDATION → FALLBACK (+ RESULTS)', script: 'test/task1-after.js' },
      { label: 'ENHANCEMENT — Popularity ranking via Redis Sorted Set (+ 60s cache)', script: 'test/task1-popular.js' },
    ],
  },
  2: {
    title: 'TASK 2 — Concurrency Control for Inventory (no overselling)',
    doc: 'docs/task-2-concurrency-control.md',
    code: 'services/inventoryService.js (purchaseUnsafe / purchaseOptimistic / purchasePessimistic)',
    needsServer: true,
    needsProduct: true,
    steps: [
      { label: 'BEFORE — No locking: race condition oversells the stock', script: 'test/task2-race-condition.js' },
      { label: 'AFTER A — Optimistic locking (CAS on lockVersion + bounded retry)', script: 'test/task2-optimistic.js' },
      { label: 'AFTER B — Pessimistic locking (Redis distributed mutex)', script: 'test/task2-pessimistic.js' },
    ],
  },
  3: {
    title: 'TASK 3 — Transaction Integrity (ACID, all-or-nothing checkout)',
    doc: 'docs/task-3-transaction-integrity.md',
    code: 'services/checkoutService.js (runCheckout: startSession / startTransaction / commit / abort)',
    needsReplicaSet: true,
    steps: [
      { label: 'BEFORE — No transaction: payment + stock change but NO order (partial state)', script: 'test/task3-no-transaction.js' },
      { label: 'AFTER — Transaction: rollback on failure + concurrent consistency', script: 'test/task3-transaction.js' },
    ],
  },
  4: {
    title: 'TASK 4 — Stress Testing (stability under heavy load)',
    doc: 'docs/task-4-stress-testing.md',
    code: 'test/task4-stress.js (Autocannon mixed workload + post-run inventory integrity check)',
    needsServer: true,
    needsProduct: true,
    steps: [
      { label: 'LOAD + RESULTS — 100 connections × 15s mixed workload + integrity assertion', script: 'test/task4-stress.js' },
    ],
  },
  5: {
    title: 'TASK 5 — Benchmarking & Bottleneck Fix (atomic write path)',
    doc: 'docs/task-5-benchmarking.md',
    code: 'services/inventoryService.js (purchaseAtomic: single conditional findOneAndUpdate)',
    needsServer: true,
    needsProduct: true,
    steps: [
      { label: 'BEFORE vs AFTER + RESULTS — optimistic vs atomic benchmark + oversell check', script: 'test/task5-benchmark.js' },
    ],
  },
};

// ─── Network / process helpers ─────────────────────────────────────────────────
function checkPort(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function httpGetJson(pathname, timeout = 8000) {
  return new Promise((resolve) => {
    const req = http.get(BASE_URL + pathname, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function pingServerOnce() {
  return new Promise((resolve) => {
    const req = http.get(BASE_URL + '/', (res) => { res.resume(); resolve(res.statusCode > 0); });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingServerOnce()) return true;
    await sleep(700);
  }
  return false;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort(port)) return true;
    await sleep(600);
  }
  return false;
}

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch (_) { try { process.kill(pid, 'SIGTERM'); } catch (__) { /* ignore */ } }
  }
}

// ─── Infrastructure checks ─────────────────────────────────────────────────────
async function checkInfra() {
  section('Infrastructure check');
  const mongoUp = await checkPort(27017);
  const redisUp = await checkPort(6379);
  statusLine('MongoDB (:27017)', mongoUp);
  statusLine('Redis    (:6379) ', redisUp);
  if (!mongoUp) warn('MongoDB looks down — start it (e.g. "mongod") or the API/tests will fail.');
  if (!redisUp) warn('Redis looks down — start it ("redis-server") or caching/locking tests will fail.');
  return { mongoUp, redisUp };
}

// ─── API server lifecycle ──────────────────────────────────────────────────────
async function ensureServer(state) {
  section('API server');
  if (await waitForServer(1500)) {
    if (!state.serverStartedByUs) ok(`Reusing the API server already running on ${BASE_URL}`);
    else ok(`API server is up on ${BASE_URL}`);
    return;
  }
  info('No server detected — starting a temporary one in development mode...');
  const fd = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT) },
    stdio: ['ignore', fd, fd],
    detached: !IS_WIN,
    windowsHide: true,
  });
  state.serverProc = child;
  state.serverStartedByUs = true;
  const ready = await waitForServer(45000);
  if (!ready) {
    throw new Error(`Server did not become ready on ${BASE_URL} — see ${path.relative(ROOT, SERVER_LOG)}`);
  }
  ok(`API server started on ${BASE_URL}  (logs → ${path.relative(ROOT, SERVER_LOG)})`);
}

function stopServer(state) {
  if (state.serverStartedByUs && state.serverProc) {
    info('Stopping the temporary API server...');
    killTree(state.serverProc.pid);
    state.serverProc = null;
    state.serverStartedByUs = false;
  }
}

// ─── Product discovery (Tasks 2, 4, 5) ─────────────────────────────────────────
async function discoverProductId() {
  const data = await httpGetJson('/api/v1/products?limit=3&page=1');
  const list = data && data.data;
  if (!list || !list.length) return null;
  return list[0]._id;
}

// ─── MongoDB replica set (Task 3) ──────────────────────────────────────────────
function findMongod() {
  const works = (cmd) => {
    try { const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' }); return !r.error; } catch (_) { return false; }
  };
  if (process.env.MONGOD_PATH && works(process.env.MONGOD_PATH)) return process.env.MONGOD_PATH;
  if (works('mongod')) return 'mongod';
  if (IS_WIN) {
    const base = 'C:\\Program Files\\MongoDB\\Server';
    try {
      const versions = fs.readdirSync(base).sort().reverse();
      for (const v of versions) {
        const p = path.join(base, v, 'bin', 'mongod.exe');
        if (fs.existsSync(p)) return p;
      }
    } catch (_) { /* not installed there */ }
  }
  return null;
}

async function isPrimary(admin) {
  try { const h = await admin.command({ hello: 1 }); return !!h.isWritablePrimary; } catch (_) {
    try { const m = await admin.command({ isMaster: 1 }); return !!m.ismaster; } catch (__) { return false; }
  }
}

async function initiateAndWaitPrimary() {
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(`mongodb://127.0.0.1:${RS_PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    const admin = client.db('admin');
    try {
      await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${RS_PORT}` }] } });
      info('replSetInitiate sent — waiting for PRIMARY election...');
    } catch (e) {
      const tag = `${e.codeName || ''} ${e.message || ''}`;
      if (/already initialized|AlreadyInitialized/i.test(tag)) info('Replica set already initialized — waiting for PRIMARY...');
      else info(`replSetInitiate: ${e.message} — waiting for PRIMARY...`);
    }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (await isPrimary(admin)) return true;
      await sleep(700);
    }
    return false;
  } catch (e) {
    warn(`Replica-set init error: ${e.message}`);
    return false;
  } finally {
    try { await client.close(); } catch (_) { /* ignore */ }
  }
}

function printRsManual() {
  out('');
  warn('Could not auto-start a MongoDB replica set (mongod was not found on PATH).');
  out('   Task 3 needs transactions, which require a replica set. Start one manually:');
  out(c.dim + '     mkdir %TEMP%\\mongo-rs-task3' + c.reset);
  out(c.dim + `     mongod --port ${RS_PORT} --replSet rs0 --dbpath "%TEMP%\\mongo-rs-task3" --bind_ip 127.0.0.1` + c.reset);
  out(c.dim + `     mongosh --port ${RS_PORT} --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:${RS_PORT}'}]})"` + c.reset);
  out('   Or point the tests at any replica set:  set TASK3_DB_URI=mongodb://.../?replicaSet=rs0');
  out('');
}

async function ensureReplicaSet(state) {
  section('MongoDB replica set (required for Task 3 transactions)');
  if (process.env.TASK3_DB_URI) {
    ok(`TASK3_DB_URI is set — assuming it points to a ready replica set:\n     ${process.env.TASK3_DB_URI}`);
    return;
  }
  if (await checkPort(RS_PORT)) {
    info(`A mongod is already listening on :${RS_PORT} — ensuring it is an initiated rs0...`);
    if (await initiateAndWaitPrimary()) { ok(`Replica set rs0 on :${RS_PORT} is ready (reused).`); return; }
    warn(`Something is on :${RS_PORT} but it is not a usable rs0 primary.`);
  }
  const mongod = findMongod();
  if (!mongod) { printRsManual(); throw new Error('mongod not found — cannot auto-start a replica set.'); }
  if (!fs.existsSync(RS_DBPATH)) fs.mkdirSync(RS_DBPATH, { recursive: true });
  info(`Starting a throwaway single-node replica set (rs0) on :${RS_PORT}...`);
  const fd = fs.openSync(RS_LOG, 'a');
  const proc = spawn(mongod, ['--port', String(RS_PORT), '--replSet', 'rs0', '--dbpath', RS_DBPATH, '--bind_ip', '127.0.0.1'], {
    stdio: ['ignore', fd, fd], detached: !IS_WIN, windowsHide: true,
  });
  state.rsProc = proc;
  state.rsStartedByUs = true;
  if (!(await waitForPort(RS_PORT, 30000))) {
    throw new Error(`mongod did not open :${RS_PORT} — see ${path.relative(ROOT, RS_LOG)}`);
  }
  if (!(await initiateAndWaitPrimary())) {
    throw new Error('Replica set did not reach PRIMARY in time.');
  }
  ok(`Replica set rs0 on :${RS_PORT} is ready  (logs → ${path.relative(ROOT, RS_LOG)})`);
}

function stopReplicaSet(state) {
  if (state.rsStartedByUs && state.rsProc) {
    info('Stopping the throwaway replica set...');
    killTree(state.rsProc.pid);
    state.rsProc = null;
    state.rsStartedByUs = false;
  }
}

// ─── Step runner ───────────────────────────────────────────────────────────────
function runStep(step, env) {
  return new Promise((resolve) => {
    section(step.label);
    const child = spawn(process.execPath, [step.script], { cwd: ROOT, env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === null ? 1 : code));
    child.on('error', (e) => { err(`Failed to run ${step.script}: ${e.message}`); resolve(1); });
  });
}

function codeFooter(task, failures) {
  out('');
  divider();
  out('  ' + c.bold + '📄 For the committee — what to open & explain' + c.reset);
  out('     Documentation : ' + c.cyan + task.doc + c.reset);
  out('     Key code      : ' + c.cyan + task.code + c.reset);
  if (failures) out('     ' + c.yellow + `Note: ${failures} step(s) returned a non-zero exit code — review the output above.` + c.reset);
  divider();
}

// ─── Per-task orchestration ────────────────────────────────────────────────────
async function runTask(num, state) {
  const task = TASKS[num];
  if (!task) { err(`Unknown task "${num}". Valid: 1, 2, 3, 4, 5, all.`); return 1; }

  box([task.title, `doc: ${task.doc}`]);

  try {
    if (task.needsServer) {
      await checkInfra();
      await ensureServer(state);
    }
    let productId = process.env.PRODUCT_ID;
    if (task.needsProduct) {
      section('Product discovery');
      productId = await discoverProductId();
      if (!productId) { err('No products found. Seed the database first:  npm run seed:import'); return 1; }
      ok(`Using product id: ${productId}`);
    }
    if (task.needsReplicaSet) {
      await ensureReplicaSet(state);
    }

    const env = { ...process.env, BASE_URL, PORT: String(PORT) };
    if (productId) env.PRODUCT_ID = productId;

    let failures = 0;
    for (let i = 0; i < task.steps.length; i++) {
      out('\n' + c.dim + `   step ${i + 1} / ${task.steps.length}` + c.reset);
      const code = await runStep(task.steps[i], env);
      if (code !== 0) { failures++; warn(`Step exited with code ${code}.`); }
    }

    codeFooter(task, failures);
    return failures ? 1 : 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}

// ─── stop mode (best-effort cleanup of anything we may have left running) ───────
function stopMode() {
  out('Stopping anything listening on :' + PORT + ' and :' + RS_PORT + ' ...');
  if (IS_WIN) {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    const pids = new Set();
    (r.stdout || '').split('\n').forEach((line) => {
      if (line.includes(`:${PORT}`) || line.includes(`:${RS_PORT}`)) {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
    });
    if (!pids.size) { out('Nothing found to stop.'); return; }
    pids.forEach((pid) => { out('  killing pid ' + pid); killTree(pid); });
  } else {
    out('Use:  lsof -ti :' + PORT + ' | xargs kill  (non-Windows)');
  }
}

function printUsage() {
  box(['Presentation runner — usage']);
  out('  node presentation/run-task.js <1|2|3|4|5|all>');
  out('');
  out('  Or load the PowerShell helpers once, then type a task directly:');
  out(c.dim + '    . .\\presentation\\tasks.ps1' + c.reset);
  out(c.dim + '    task_1   task_2   task_3   task_4   task_5   task_all' + c.reset);
  out('');
  for (const n of [1, 2, 3, 4, 5]) out(`    task_${n}  →  ${TASKS[n].title}`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const arg = (process.argv[2] || '').toLowerCase().trim();

  if (arg === 'stop') { stopMode(); return; }
  if (!arg || arg === 'help' || arg === '-h' || arg === '--help') { printUsage(); process.exitCode = arg ? 0 : 1; return; }

  const state = { serverProc: null, serverStartedByUs: false, rsProc: null, rsStartedByUs: false };
  const cleanup = () => { stopServer(state); stopReplicaSet(state); };

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    out('\n' + c.yellow + 'Interrupted — cleaning up background processes...' + c.reset);
    cleanup();
    process.exit(130);
  });

  let exitCode = 0;
  try {
    if (arg === 'all') {
      for (const n of [1, 2, 3, 4, 5]) {
        const code = await runTask(n, state);
        if (code !== 0) exitCode = 1;
      }
    } else if (TASKS[arg]) {
      exitCode = await runTask(Number(arg), state);
    } else {
      err(`Unknown argument "${arg}".`);
      printUsage();
      exitCode = 1;
    }
  } finally {
    cleanup();
  }
  process.exitCode = exitCode;
}

main();
