# A9 Observability

An Express to-do API using MongoDB and OpenTelemetry, with Jaeger 2.5.0 for backend tracing.

The original instructor-supplied `index.js` is preserved without changes in `starter/index.js`. The application keeps its `todo` database, `todos` collection, string IDs, routes and three sample titles. The instrumented version adds handler spans, metrics, structured request logs, input validation, graceful shutdown and sample-data upserts to avoid duplicates after restarts.

## Run entirely on GitHub

The **Verify observability with Docker** workflow runs on GitHub's Ubuntu runner. It starts MongoDB and Jaeger in Docker, exercises the console exporter, switches to OTLP/HTTP, makes eight verified HTTP requests, checks span relationships and log correlation, and captures screenshots of the actual Jaeger UI. No Docker installation is needed on the reader's computer.

Open the repository's **Actions** tab to inspect the run. The workflow saves its output as `observability-docker-evidence` and commits the successful run's files into `evidence/ci/`. Changes to evidence do not trigger another run.

## Run locally if desired

Prerequisites: Node.js 20 or newer, npm, and Docker Desktop running. Open a terminal in this project folder.

```sh
npm ci
docker compose up -d --wait
npm run start:console
```

In another terminal, run the required first request:

```sh
curl http://localhost:3000/todo
```

The first terminal shows spans, request logs and periodic metrics. Stop the Node server with **Ctrl+C**. Start the final OTLP configuration:

```sh
node --require ./tracing.js index.js
```

In the second terminal:

```sh
npm run exercise
```

This sends exactly eight requests: six return 200, one missing item returns 404, and one invalid ID returns 400. The assertions verify the actual responses. Wait at least two seconds for trace export and open http://localhost:16686/ . Choose **todo-service**, leave Operation set to **all**, and click **Find Traces**. Open a **GET /todo** result and expand its HTTP and MongoDB span tags.

The sample data uses the instructor's IDs and titles:

| ID | Title |
| --- | --- |
| 1 | Buy groceries |
| 2 | Install Aspecto |
| 3 | buy my own name domain |

## Signals

| Signal | Collection | Destination |
| --- | --- | --- |
| Traces | Automatic HTTP and MongoDB spans with manual application spans | Console in the first stage; Jaeger through OTLP/HTTP in the final stage |
| Metrics | `todo.http.requests` counter and `todo.http.duration` histogram, grouped by route and response status; automatic HTTP and driver metrics | Console every ten seconds and on graceful shutdown |
| Logs | JSON request records with timestamps, route, status, duration, trace ID and span ID | Console |

`tracing.js` is preloaded before HTTP, Express and MongoDB are imported. It sends traces to `http://127.0.0.1:4318/v1/traces`. Every request is sampled for this small exercise. The histogram starts inside Express, so it has a narrower timing boundary than the HTTP span. Nested span durations overlap and must not be added together. Jaeger displays traces; this project does not export metrics or application logs to Jaeger.

## Files

- `starter/index.js`: the exact supplied starter file.
- `index.js`: instrumented application based on that starter.
- `tracing-console.js`: initial console-export stage.
- `tracing.js`: final OTLP exporter and HTTP/MongoDB instrumentation.
- `docker-compose.yml`: the MongoDB and Jaeger containers.
- `scripts/exercise.js`: eight actual HTTP checks.
- `scripts/verify-docker.js`: cloud verification and screenshot capture.
- `.github/workflows/observability.yml`: Docker execution on GitHub's runner.
- `evidence/ci/`: logs, trace JSON, container status, measurements and Jaeger screenshots from a successful Docker run.

Dependency versions are pinned in `package-lock.json`. The final setup uses the official OTLP exporter rather than the legacy Jaeger exporter. Explicit handler spans cover application work without relying on the handout's third-party Express instrumentation package.

## Shutdown

Stop the Node process with Ctrl+C, then:

```sh
docker compose down
```

MongoDB's named volume is retained. Jaeger uses in-memory storage; save trace data and screenshots before stopping it.

## Documentation

- https://opentelemetry.io/docs/
- https://opentelemetry.io/docs/concepts/signals/
- https://opentelemetry.io/docs/languages/js/instrumentation/
- https://opentelemetry.io/docs/languages/js/exporters/
- https://www.jaegertracing.io/docs/2.5/getting-started/
