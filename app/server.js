
// server.js
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import clientProm from 'prom-client';

const app = express();
app.use(express.json());

// ---- Environment ----
const port = parseInt(process.env.PORT || '3000', 10);
const appName = process.env.APP_NAME || 'node-mongo-demo';
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/appdb';
const mongoDbName = process.env.MONGO_DB || 'appdb';

// ---- Metrics (Prometheus) ----
const collectDefaultMetrics = clientProm.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'node_mongo_demo_' });

const httpRequestCounter = new clientProm.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status']
});

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    httpRequestCounter.inc({ method: req.method, path: req.path, status: res.statusCode });
  });
  next();
});

// ---- Mongo Setup ----
let mongoClient;
let db;

async function connectToMongo() {
  if (!mongoUri) {
    throw new Error('MONGO_URI is not set');
  }
  mongoClient = new MongoClient(mongoUri, { maxPoolSize: 10 });
  await mongoClient.connect();
  db = mongoClient.db(mongoDbName);
  console.log(`[startup] Connected to MongoDB, db=${mongoDbName}`);
}

// ---- Routes ----
app.get('/healthz', async (req, res) => {
  // readiness: check DB can respond to ping
  try {
    if (!db) throw new Error('DB not initialized');
    await db.command({ ping: 1 });
    return res.status(200).send('ok');
  } catch (err) {
    return res.status(500).send('db-not-ready');
  }
});

app.get('/livez', (req, res) => {
  // liveness: process is up
  res.status(200).send('live');
});

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', clientProm.register.contentType);
    res.end(await clientProm.register.metrics());
  } catch (e) {
    res.status(500).end(e.message);
  }
});

app.get('/', (req, res) => {
  res.status(200).send(`${appName} is running`);
});

app.get('/pingdb', async (req, res) => {
  try {
    const out = await db.command({ ping: 1 });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Simple Todos API for persistence validation ----
app.post('/api/todos', async (req, res) => {
  try {
    const { title = '', done = false } = req.body || {};
    const result = await db.collection('todos').insertOne({
      title,
      done,
      createdAt: new Date()
    });
    res.status(201).json({ id: result.insertedId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/todos', async (req, res) => {
  try {
    const docs = await db.collection('todos').find({}).sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/todos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const update = { $set: {} };
    if (typeof req.body?.title === 'string') update.$set.title = req.body.title;
    if (typeof req.body?.done === 'boolean') update.$set.done = req.body.done;
    const result = await db.collection('todos').findOneAndUpdate(
      { _id: new ObjectId(id) },
      update,
      { returnDocument: 'after' }
    );
    res.json(result?.value || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/todos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const result = await db.collection('todos').deleteOne({ _id: new ObjectId(id) });
    res.json({ deletedCount: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Startup ----
(async () => {
  try {
    await connectToMongo();
    app.listen(port, () => {
      console.log(`[startup] ${appName} listening on port ${port}`);
    });
  } catch (e) {
    console.error('[startup] Failed to start:', e);
    process.exit(1);
  }
})();

// ---- Graceful Shutdown ----
async function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}`);
  try {
    if (mongoClient) {
      await mongoClient.close();
      console.log('[shutdown] Mongo connection closed');
    }
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
