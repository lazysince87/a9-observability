// Part 3, first stage: print spans to the terminal instead of Jaeger.
process.env.TRACING_EXPORTER = 'console';
module.exports = require('./tracing');
