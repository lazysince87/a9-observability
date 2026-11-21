const express = require('express');
const { MongoClient } = require('mongodb');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { sdk } = require('./tracing');

const app = express();
app.use(express.json());
app.disable('x-powered-by');
const tracer = trace.getTracer('todo-app', '1.0.0');
const meter = metrics.getMeter('todo-app', '1.0.0');
const requests = meter.createCounter('todo.http.requests', {
  description: 'Completed HTTP requests, grouped by route and status',
  unit: '{request}',
});
const latency = meter.createHistogram('todo.http.duration', {
  description: 'Time from entry into Express until the response finishes',
  unit: 'ms',
});

const client = new MongoClient(
  process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
  { serverSelectionTimeoutMS: 5000 },
);
let todos;
let server;

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const serverSpan = trace.getActiveSpan();
  const spanContext = serverSpan?.spanContext();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route?.path || 'unmatched';
    const attributes = {
      'http.request.method': req.method,
      'http.route': route,
      'http.response.status_code': res.statusCode,
    };
    requests.add(1, attributes);
    latency.record(durationMs, attributes);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : 'info',
      event: 'http_request_completed',
      method: req.method,
      path: req.path,
      route,
      status: res.statusCode,
      duration_ms: Number(durationMs.toFixed(3)),
      trace_id: spanContext?.traceId,
      span_id: spanContext?.spanId,
    }));
  });
  next();
});

// Add a manual application span inside the automatically created HTTP span.
// The instrumented MongoDB driver creates the database child spans.
function tracedHandler(name, handler) {
  return (req, res, next) => {
    const serverSpan = trace.getActiveSpan();
    serverSpan?.updateName(`${req.method} ${req.route.path}`);
    serverSpan?.setAttribute('http.route', req.route.path);
    tracer.startActiveSpan(name, async span => {
      try {
        await handler(req, res, span);
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        next(error);
      } finally {
        span.end();
      }
    });
  };
}

app.get('/todo', tracedHandler('todo.list', async (req, res, span) => {
  const result = await todos.find({}, { projection: { _id: 0 } }).toArray();
  span.setAttribute('todo.count', result.length);
  res.json(result);
}));

app.get('/todo/:id', tracedHandler('todo.get', async (req, res, span) => {
  if (!/^\d+$/.test(req.params.id)) {
    span.addEvent('invalid_todo_id');
    return res.status(400).json({ error: 'Todo id must be a positive integer' });
  }
  const id = req.params.id;
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) {
    return res.status(400).json({ error: 'Todo id must be a positive integer' });
  }
  const result = await todos.findOne({ id }, { projection: { _id: 0 } });
  if (!result) {
    span.addEvent('todo_not_found', { 'todo.id': id });
    return res.status(404).json({ error: 'Todo not found' });
  }
  span.setAttribute('todo.id', id);
  res.json(result);
}));

app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'request_failed',
    message: err.message,
    trace_id: trace.getActiveSpan()?.spanContext().traceId,
  }));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function startServer() {
  await client.connect();
  // Keep the database, collection, string IDs and sample titles from the
  // instructor's supplied index.js (preserved verbatim in starter/index.js).
  todos = client.db('todo').collection('todos');
  // Upsert only these demo records; never clear an existing collection.
  await todos.bulkWrite([
    { id: '1', title: 'Buy groceries' },
    { id: '2', title: 'Install Aspecto' },
    { id: '3', title: 'buy my own name domain' },
  ].map(todo => ({
    updateOne: { filter: { id: todo.id }, update: { $setOnInsert: todo }, upsert: true },
  })));
  const port = Number(process.env.PORT || 3000);
  server = app.listen(port, () => {
    console.log(JSON.stringify({ event: 'server_started', port, service: 'todo-service' }));
  });
}

async function shutdown() {
  if (server) await new Promise(resolve => server.close(resolve));
  await client.close();
  await sdk.shutdown(); // Flush pending spans and the final metric export.
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown().then(() => process.exit(0)).catch(err => {
      console.error(err);
      process.exit(1);
    });
  });
}

startServer().catch(async err => {
  console.error(err);
  await client.close();
  await sdk.shutdown();
  process.exit(1);
});
