// Run the complete exercise on a Linux machine where Docker is available.
// The workflow starts the containers before invoking this script.
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

const output = path.resolve('evidence/ci');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let application;
let consoleApplication;
let browser;

function start(preload, name) {
  const fd = fs.openSync(path.join(output, name), 'w');
  const child = spawn(process.execPath, ['--require', preload, 'index.js'], {
    stdio: ['ignore', fd, fd],
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
  });
  fs.closeSync(fd);
  return child;
}

async function waitForServer(child) {
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, 'Application exited during startup');
    const ready = await new Promise(resolve => {
      const socket = net.connect(3000, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    await pause(200);
  }
  throw new Error('Application did not start within 30 seconds');
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Application shutdown timed out')), 15000);
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Application exited with ${code}`));
    });
  });
  child.kill('SIGINT');
  await closed;
}

function rootSpan(t) {
  return t.spans.find(s => s.operationName.startsWith('GET /todo') &&
    s.tags.some(tag => tag.key === 'span.kind' && tag.value === 'server'));
}

async function run() {
  fs.writeFileSync(path.join(output, 'docker-containers.txt'), execFileSync(
    'docker', ['compose', '--project-name', 'a9-observability', 'ps', '--format', 'json'],
    { encoding: 'utf8' },
  ));
  consoleApplication = start('./tracing-console.js', 'console-stage.log');
  await waitForServer(consoleApplication);
  const curl = spawnSync('curl', ['--fail', '--silent', '--show-error', 'http://127.0.0.1:3000/todo'], {
    encoding: 'utf8',
  });
  assert.equal(curl.status, 0, curl.stderr);
  const initialTodos = JSON.parse(curl.stdout);
  assert.ok(initialTodos.some(todo => todo.id === '1' && todo.title === 'Buy groceries'));
  fs.writeFileSync(path.join(output, 'curl-response.json'), JSON.stringify(initialTodos, null, 2));
  await stop(consoleApplication);
  const consoleSpans = fs.readFileSync(path.join(output, 'console-stage.log'), 'utf8');
  assert.ok(consoleSpans.includes("name: 'mongodb.find'"));
  assert.ok(consoleSpans.includes("name: 'GET /todo'"));

  application = start('./tracing.js', 'application.log');
  await waitForServer(application);
  const exercise = spawnSync(process.execPath, ['scripts/exercise.js'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(output, 'requests.log'), exercise.stdout + exercise.stderr);
  assert.equal(exercise.status, 0, exercise.stdout + exercise.stderr);

  let telemetry;
  let traces = [];
  for (let i = 0; i < 40; i++) {
    telemetry = await (await fetch('http://127.0.0.1:16686/api/traces?service=todo-service&limit=100')).json();
    traces = telemetry.data.filter(rootSpan);
    if (traces.length === 8) break;
    await pause(500);
  }
  assert.equal(traces.length, 8, 'Jaeger must contain all eight HTTP request traces');
  const counts = {};
  for (const t of traces) {
    const root = rootSpan(t);
    const attrs = Object.fromEntries(root.tags.map(tag => [tag.key, tag.value]));
    const status = attrs['http.status_code'];
    counts[status] = (counts[status] || 0) + 1;
    assert.ok(t.spans.some(s => s.operationName.startsWith('todo.')));
    if (status !== 400) assert.ok(t.spans.some(s => s.operationName === 'mongodb.find'));
    const ids = new Set(t.spans.map(s => s.spanID));
    for (const span of t.spans) {
      for (const ref of span.references) {
        if (ref.refType === 'CHILD_OF') assert.ok(ids.has(ref.spanID), 'Span parent must exist');
      }
    }
  }
  assert.deepEqual(counts, { 200: 6, 400: 1, 404: 1 });
  fs.writeFileSync(path.join(output, 'traces.json'), JSON.stringify(telemetry, null, 2));
  const selected = traces.filter(t => rootSpan(t).operationName === 'GET /todo')
    .sort((a, b) => rootSpan(a).startTime - rootSpan(b).startTime)[0];
  const httpSpan = rootSpan(selected);
  const databaseSpan = selected.spans.find(s => s.operationName === 'mongodb.find');

  const { chromium } = require('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  // Jaeger's search state is encoded in its URL. Use the same search route
  // produced by the UI so the service selection and result count are visible.
  const end = Date.now() * 1000;
  const search = new URLSearchParams({
    service: 'todo-service', limit: '20', lookback: '1h',
    end: String(end), start: String(end - 3600000000),
    maxDuration: '', minDuration: '',
  });
  await page.goto(`http://127.0.0.1:16686/search?${search}`);
  await page.getByRole('heading', { name: /8 Traces/ }).waitFor();
  await page.screenshot({ path: path.join(output, 'jaeger-search.jpg'), type: 'jpeg', quality: 94 });

  await page.goto(`http://127.0.0.1:16686/trace/${selected.traceID}`);
  await page.getByRole('switch', { name: 'todo-service GET /todo', exact: true }).click();
  await page.getByRole('switch', { name: /^Tags/ }).click();
  await page.screenshot({ path: path.join(output, 'jaeger-http-span.jpg'), type: 'jpeg', quality: 94 });
  await page.getByRole('switch', { name: 'todo-service GET /todo', exact: true }).click();
  await page.getByRole('switch', { name: 'todo-service mongodb.find', exact: true }).click();
  await page.getByRole('switch', { name: /^Tags/ }).click();
  await page.screenshot({ path: path.join(output, 'jaeger-mongodb-span.jpg'), type: 'jpeg', quality: 94 });
  await browser.close();
  browser = undefined;
  await stop(application); // Flush the final cumulative metrics.

  const applicationLog = fs.readFileSync(path.join(output, 'application.log'), 'utf8');
  assert.ok(applicationLog.includes("name: 'todo.http.requests'"));
  assert.ok(applicationLog.includes("name: 'todo.http.duration'"));
  const requestLogs = applicationLog.split('\n').flatMap(line => {
    try { const j = JSON.parse(line); return j.event === 'http_request_completed' ? [j] : []; }
    catch { return []; }
  });
  assert.equal(requestLogs.length, 8);
  for (const entry of requestLogs) assert.ok(traces.some(t => t.traceID === entry.trace_id));

  const report = {
    execution: 'Docker containers on a GitHub-hosted Ubuntu runner',
    repository: process.env.GITHUB_REPOSITORY || null,
    commit: process.env.GITHUB_SHA || null,
    workflow_run_id: process.env.GITHUB_RUN_ID || null,
    captured_at: new Date().toISOString(),
    mongodb_image: 'mongo:7.0.14',
    jaeger_image: 'jaegertracing/jaeger:2.5.0',
    request_count: 8,
    response_counts: counts,
    selected_trace_id: selected.traceID,
    http_duration_ms: Number((httpSpan.duration / 1000).toFixed(3)),
    database_duration_ms: Number((databaseSpan.duration / 1000).toFixed(3)),
    database: 'todo',
    collection: 'todos',
    console_stage_verified: true,
    spans_and_parent_references_verified: true,
    request_logs_correlated_with_traces: true,
    metrics_export_verified: true,
  };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  for (const app of [application, consoleApplication]) {
    if (app && app.exitCode === null) app.kill('SIGINT');
  }
});
