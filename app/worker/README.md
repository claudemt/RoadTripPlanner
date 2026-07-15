# Route render worker

The public website queues export jobs in Supabase. This worker claims one job at a time, runs the existing Remotion/Chromium renderer, and uploads the generated files to the private `route-exports` bucket.

## Required environment variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
AMAP_KEY=your-amap-js-key
AMAP_SECURITY_JS_CODE=your-amap-security-code
```

Optional settings:

```env
RENDER_WORKER_ID=roadtrip-render-01
RENDER_POLL_INTERVAL_MS=5000
ROUTE_RENDER_CONCURRENCY=2
ROUTE_RENDER_CRF=20
```

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. It must only exist on the render server and must never be exposed through EdgeOne environment variables prefixed with `VITE_` or shipped to the browser.

## Run with Docker

From the `app` directory:

```bash
docker build -f worker/Dockerfile -t roadtrip-render-worker .
docker run -d --restart unless-stopped \
  --name roadtrip-render-worker \
  --env-file worker.env \
  roadtrip-render-worker
```

The container needs outbound HTTPS access to Supabase and AMap. No inbound port is required.
