# Purple Box (v1)

Ephemeral, E2E-encrypted 1:1 chat. See `ARCHITECTURE.md`, `DECISIONS.md`, and the three `*_spec.md` files for the design this implements.

## Local development

Requires Node 20+ and a local Redis.

```bash
redis-server --daemonize yes

cd server
npm install
npm run dev        # http://localhost:3000, GET /health

cd ../client
npm install
npm run dev         # http://localhost:5173
```

## Tests

```bash
cd server
npm test            # includes the required reconnect-race suite
npm run typecheck
npm run build
```

```bash
cd client
npm run typecheck
npm run build
```

## Docker

```bash
docker compose up --build
```

Serves the client on `:8080`, the server on `:3000`, backed by a Redis container. Set `VITE_SERVER_URL` and `CORS_ORIGIN` env vars for a non-local deployment.

## Scope

Everything unmarked in the specs is v1. `[v2]` (SAS key verification, abuse reporting), `[v3]` (multi-instance/pub-sub), and `[v4]` (screenshot detection, native wrapper) are out of scope for this implementation.
