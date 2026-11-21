// This preload must run before Express, http, or mongodb are imported.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  AlwaysOnSampler,
} = require('@opentelemetry/sdk-trace-base');
const {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} = require('@opentelemetry/sdk-metrics');

const consoleMode = process.env.TRACING_EXPORTER === 'console';
const exporter = consoleMode
  ? new ConsoleSpanExporter()
  : new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
        'http://127.0.0.1:4318/v1/traces',
    });
const spanProcessor = consoleMode
  ? new SimpleSpanProcessor(exporter)
  : new BatchSpanProcessor(exporter, { scheduledDelayMillis: 1000 });

const metricReader = new PeriodicExportingMetricReader({
  exporter: new ConsoleMetricExporter(),
  exportIntervalMillis: 10000,
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'todo-service',
    'service.version': '1.0.0',
    'deployment.environment.name': 'local',
  }),
  spanProcessors: [spanProcessor],
  // Record every request in this small local exercise.
  sampler: new AlwaysOnSampler(),
  metricReader,
  instrumentations: [
    new HttpInstrumentation(),
    new MongoDBInstrumentation({ enhancedDatabaseReporting: false }),
  ],
});

sdk.start();
console.log(JSON.stringify({
  event: 'telemetry_started',
  traces: consoleMode ? 'console' : 'otlp-http',
  metrics: 'console',
  logs: 'structured JSON console',
}));

module.exports = { sdk, metricReader };
