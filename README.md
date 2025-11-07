# Copiloto Tributario

Asistente tributario con RAG, evidencia auditable y herramientas comerciales livianas. Responde sobre normativa, explica documentos fiscales y ejecuta acciones básicas (leads, notas, follow-ups) con métricas en vivo.

## Requisitos

- Node.js ≥ 20.18
- pnpm ≥ 9
- Docker + Docker Compose
- Dominio público y DNS (p. ej. Cloudflare)
- Caddy (reverse proxy con TLS)
- Acceso a un proveedor LLM vía OpenRouter

## Arquitectura

```
copiloto-tributario/
├─ docker-compose.yml
├─ .env.example
├─ data/                         # Corpus de normativa (DOCS_ROOT)
├─ frontend/                     # Next.js + UI (SSE)
│  ├─ package.json
│  └─ src/
│     ├─ app/page.tsx            # Shell (chat + métricas)
│     ├─ app/api/health/route.ts
│     ├─ components/{Chat,MetricsPanel,Timeline}.tsx
│     └─ lib/sse.ts
├─ server/                       # Node + AI SDK + Prisma
│  ├─ package.json
│  ├─ prisma/
│  │  ├─ schema.prisma
│  │  └─ migrations/000_init/migration.sql  # pgvector + tablas + ivfflat
│  └─ src/
│     ├─ api/{chat.ts,dev-server.ts}
│     ├─ claimcheck/claim_checker.ts
│     ├─ lib/{env.ts,ollama.ts,openrouter.ts,prisma.ts}
│     ├─ metrics/telemetry.ts
│     ├─ rag/{chunk.ts,ingest.ts,search.ts}
│     ├─ security/sanitize.ts
│     └─ tools/index.ts
└─ README.md
```

## Variables de entorno

Crear **tres** archivos: uno global de ejemplo y dos específicos por app. Usa **placeholders**. No uses dominios reales en este archivo.

### `.env.example` (raíz, informativo)

```ini
# === Infra ===
DOMAIN=<DOMAIN>                # p. ej. your-domain.tld
API_DOMAIN=<API_DOMAIN>        # p. ej. api.your-domain.tld

# === Postgres local (docker compose) ===
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=app
PG_PASSWORD=app
PG_DB=copiloto
PG_DB_SHADOW=copiloto_shadow

# === Ollama ===
OLLAMA_BASE_URL=http://127.0.0.1:11434
EMBED_MODEL=nomic-embed-text
EMBED_DIM=768

# === OpenRouter ===
OPENROUTER_API_KEY=changeme
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=google/gemini-2.0-flash-exp:free

# === RAG / Server ===
DOCS_ROOT=../data
RAG_TOP_K=6
MAX_TOOL_ITERATIONS=3

# === Fronteras CORS ===
FRONTEND_ORIGIN=https://<DOMAIN>
NEXT_PUBLIC_BACKEND_URL=https://<API_DOMAIN>
```

### `server/.env`

```ini
# Puerto del backend
PORT=3001

# Base de datos
DATABASE_URL=postgresql://app:app@127.0.0.1:5432/copiloto
SHADOW_DATABASE_URL=postgresql://app:app@127.0.0.1:5432/copiloto_shadow

# RAG
DOCS_ROOT=../data
RAG_TOP_K=6
MAX_TOOL_ITERATIONS=3

# CORS (origen exacto, sin slash final)
FRONTEND_ORIGIN=https://<DOMAIN>

# Embeddings (Ollama)
OLLAMA_BASE_URL=http://127.0.0.1:11434
EMBED_MODEL=nomic-embed-text
EMBED_DIM=768

# LLM vía OpenRouter
OPENROUTER_API_KEY=changeme
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=google/gemini-2.0-flash-exp:free

NODE_ENV=production
```

### `frontend/.env.local`

```ini
# URL pública del backend para el navegador
NEXT_PUBLIC_BACKEND_URL=https://<API_DOMAIN>

NEXT_PUBLIC_APP_NAME=Copiloto Tributario
NODE_ENV=production
```

## Puesta en marcha local (dev)

1. **Infra (DB + Ollama)**

```bash
docker compose up -d
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

2. **Crear DBs (si Prisma aún no corrió)**

```bash
docker exec -i ct_db psql -U app -d postgres -c "CREATE DATABASE copiloto;"
docker exec -i ct_db psql -U app -d postgres -c "CREATE DATABASE copiloto_shadow;"
```

3. **Instalar dependencias**

```bash
pnpm install
```

4. **Migraciones + generate + seed**

```bash
pnpm --filter server prisma migrate dev
pnpm --filter server prisma:generate
pnpm --filter server run seed   # crea usuario demo y passcode
```

5. **Ingesta de normativa**

- Generar contenido **mock** desde `server/sources.json`:

```bash
pnpm --filter server run fetch:manifest -- --manifest server/sources.json --out ../data --mode mock
```

- Ingestar corpus:

```bash
pnpm --filter server run ingest
# o bien, ingesta puntual
pnpm --filter server run ingest:path data/algo
```

6. **Levantar apps en dev**

```bash
pnpm --filter server dev        # http://localhost:3001
pnpm --filter frontend dev      # http://localhost:3000
```

## Despliegue en VPS (prod)

### 1) Systemd units

`/etc/systemd/system/copiloto-server.service`:

```ini
[Unit]
Description=Copiloto Tributario - Backend
After=network.target docker.service
Wants=docker.service

[Service]
User=root
Group=root
WorkingDirectory=/opt/copiloto-tributario/server
EnvironmentFile=/opt/copiloto-tributario/server/.env
Environment=NODE_ENV=production
# Si tenés "start" usa start; si no, dev con tsx (temporal)
ExecStart=/usr/bin/env pnpm run dev
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/copiloto-frontend.service`:

```ini
[Unit]
Description=Copiloto Tributario - Frontend
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=/opt/copiloto-tributario/frontend
EnvironmentFile=/opt/copiloto-tributario/frontend/.env.local
Environment=NODE_ENV=production
# Importante: invocar Next sin el "--" defectuoso.
ExecStart=/usr/bin/env pnpm exec next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Aplicar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now copiloto-server copiloto-frontend
```

### 2) Caddyfile

`/etc/caddy/Caddyfile`:

```caddy
<DOMAIN> {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
  }
  reverse_proxy 127.0.0.1:3000
}

<API_DOMAIN> {
  # Preflight dedicado
  @preflight method OPTIONS
  header @preflight {
    Access-Control-Allow-Origin https://<DOMAIN>
    Access-Control-Allow-Credentials true
    Access-Control-Allow-Methods GET, POST, OPTIONS
    Access-Control-Allow-Headers Content-Type, Authorization, X-Session-Id, x-session-id
    Cache-Control "no-store"
  }
  respond @preflight 204

  # Limpieza por si el backend ya envía CORS (evitar duplicados)
  header {
    -Access-Control-Allow-Origin
    -Access-Control-Allow-Methods
    -Access-Control-Allow-Headers
  }
  # CORS final único
  header {
    Access-Control-Allow-Origin https://<DOMAIN>
    Access-Control-Allow-Credentials true
    Access-Control-Allow-Methods GET, POST, OPTIONS
    Access-Control-Allow-Headers Content-Type, Authorization, X-Session-Id, x-session-id
  }

  # SSE en /api/chat
  @sse path /api/chat
  header @sse {
    Content-Type "text/event-stream"
    Cache-Control "no-cache, no-transform"
    X-Accel-Buffering "no"
    -Content-Encoding
  }

  # No usar "encode" en este site para evitar problemas con SSE
  reverse_proxy 127.0.0.1:3001
}
```

Aplicar:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile
```

### 3) DNS / Proxy (ejemplo con Cloudflare)

- Registros A/AAAA o CNAME para `<DOMAIN>` y `<API_DOMAIN>` apuntando al VPS, **Proxied** activado.
- Opcional: regla de caché *Bypass* para `<API_DOMAIN>/*`.
- Evitar transformaciones que rompan SSE. Mantener `Cache-Control: no-transform` ya seteado por Caddy.

## Comandos útiles

### Backend

```bash
# Reiniciar backend
sudo systemctl restart copiloto-server
journalctl -u copiloto-server -n 120 --no-pager

# Puerto
ss -ltnp | grep ':3001' || echo "No está escuchando 3001"
```

### Frontend

```bash
# Build y start manual (si no usás systemd)
pnpm --filter frontend build
pnpm --filter frontend exec next start -p 3000 -H 127.0.0.1
```

### Salud y CORS

```bash
# Salud local backend
curl -si http://127.0.0.1:3001/api/health | sed -n '1,20p'

# Salud vía edge
curl -si https://<API_DOMAIN>/api/health | sed -n '1,40p'

# Preflight correcto (204)
curl -si -X OPTIONS https://<API_DOMAIN>/api/chat \
  -H "Origin: https://<DOMAIN>" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type, X-Session-Id"

# SSE mínimo (debería emitir 'ready' y 'session')
curl -N -s https://<API_DOMAIN>/api/chat \
  -H "Origin: https://<DOMAIN>" \
  -H "Content-Type: application/json" \
  --data '{"messages":[{"role":"user","content":"ping"}]}'
```

## Flujo de conversación (SSE)

Eventos emitidos:

- `ready`: id del request
- `session`: id de sesión
- `context`: citas RAG con `href`, snippet y similitud
- `token`: delta LLM
- `tool`: inicio/éxito/error + duración
- `claimcheck`: oración vs evidencia (`supported` | `no_evidence`)
- `metrics`: TTFB, latencias, k, similitudes
- `done` | `error`

## Seguridad

- `FRONTEND_ORIGIN` exacto. Sin slash final.
- Tools bloqueadas hasta validar passcode.
- Sanitización anti prompt-injection en `security/sanitize.ts`.
- Validaciones `zod` en request y tools.

## Troubleshooting

- **“Failed to fetch” en el browser**
  - Duplicación CORS: limpiar en Caddy y setear CORS final único (ver Caddyfile).
  - `FRONTEND_ORIGIN` y `NEXT_PUBLIC_BACKEND_URL` deben coincidir con los hosts reales.
  - Proxy en DNS habilitado. HTTPS en ambos orígenes.
  - Revisar Network tab: la primera request es `OPTIONS` 204; si es 4xx, CORS mal.

- **502 en Caddy a `/`**
  - No usar `next start -- -p 3000` (interpreta `-p` como carpeta).  
    Usar `pnpm exec next start -p 3000 -H 127.0.0.1`.

- **SSE se corta**
  - No usar `encode` en el site del API.
  - Confirmar `Cache-Control: no-transform` y `X-Accel-Buffering: no`.

- **DB no migra**
  - Ver `DATABASE_URL` y `SHADOW_DATABASE_URL`.
  - Crear DBs manualmente si hace falta.

- **Modelo OpenRouter**
  - Cambiar `LLM_MODEL` en `server/.env`. Requiere clave válida.

## Scripts (pnpm)

| Comando | Descripción |
|---|---|
| `pnpm --filter server run seed` | Crea usuario demo y passcode |
| `pnpm --filter server run ingest` | Ingesta completa de `DOCS_ROOT` |
| `pnpm --filter server run ingest:path <ruta>` | Ingesta puntual de carpeta/archivo |
| `pnpm --filter server run fetch:manifest -- --manifest server/sources.json --out ../data --mode mock` | Genera corpus de ejemplo |
| `pnpm --filter server prisma migrate dev` | Migraciones en dev |
| `pnpm --filter server prisma migrate deploy` | Migraciones en prod |
| `pnpm --filter server prisma:generate` | Genera cliente Prisma |

## Endpoints

- `GET /api/health` → `{ "ok": true }`
- `POST /api/chat` (SSE) → stream de eventos descritos arriba

## Roadmap breve

- Tunear `ivfflat` (lists/probes) con corpus grande.
- Versionado de corpus (`Doc.version`) para AB testing.
- Selector de modelo (`LLM_MODEL`) por request.
