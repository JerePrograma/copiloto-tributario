# Copiloto Tributario

Asistente tributario con recuperación aumentada, evidencia auditable y herramientas comerciales livianas. El objetivo es responder preguntas sobre normativa, explicar documentos fiscales y ejecutar acciones básicas (leads, notas, follow-ups) con métricas técnicas en vivo.

## Arquitectura

```
copiloto-tributario/
├─ docker-compose.yml
├─ .env.example
├─ data/                       # Corpus de normativa (DOCS_ROOT)
├─ frontend/                   # Next.js + UI de chat/metrics
│  ├─ next.config.mjs
│  ├─ package.json
│  └─ src/
│     ├─ app/
│     │  ├─ page.tsx          # Shell principal (chat + métricas)
│     │  └─ api/health/route.ts
│     ├─ components/
│     │  ├─ AppShell.tsx
│     │  ├─ Chat.tsx
│     │  ├─ MetricsPanel.tsx
│     │  └─ Timeline.tsx
│     └─ lib/sse.ts            # Cliente SSE con abort y parsing
├─ server/                     # Node.js + AI SDK + Prisma
│  ├─ package.json
│  ├─ prisma/
│  │  ├─ schema.prisma
│  │  └─ migrations/
│  │     └─ 000_init/migration.sql  # Enable pgvector + tablas + índice ivfflat
│  ├─ src/
│  │  ├─ api/
│  │  │  ├─ chat.ts           # Orquestación streamText + herramientas + SSE
│  │  │  └─ dev-server.ts     # Servidor HTTP local (SSE + health)
│  │  ├─ claimcheck/
│  │  │  └─ claim_checker.ts  # Verificación oración-a-evidencia
│  │  ├─ lib/
│  │  │  ├─ env.ts            # Variables de entorno tipadas con zod
│  │  │  ├─ ollama.ts         # Embeddings via Ollama
│  │  │  ├─ openrouter.ts     # Cliente OpenRouter (AI SDK)
│  │  │  └─ prisma.ts
│  │  ├─ metrics/telemetry.ts # Métricas TTFB, LLM, SQL, embeddings, timeline
│  │  ├─ rag/
│  │  │  ├─ chunk.ts          # Chunking configurable (700/120)
│  │  │  ├─ ingest.ts         # Ingesta + embeddings + persistencia
│  │  │  └─ search.ts         # Búsqueda pgvector + sanitización
│  │  ├─ security/sanitize.ts # Guard rails anti prompt-injection
│  │  └─ tools/index.ts       # Registro de tools (zod + Prisma + auth)
│  └─ scripts/
│     ├─ ingest_path.ts       # Ingesta puntual por archivo/carpeta
│     └─ seed.ts              # Usuario demo con passcode
└─ README.md
```

## Stack

- **Frontend**: Next.js (App Router) con streaming SSE, UI de chat, panel de métricas y timeline de herramientas.
- **Backend**: Node.js + [AI SDK](https://sdk.vercel.ai/) usando OpenRouter como provider de LLM.
- **Embeddings**: [Ollama](https://ollama.com/) (`nomic-embed-text`).
- **Base de datos**: PostgreSQL + `pgvector` (`ivfflat` listo para ANN).
- **ORM**: Prisma.
- **Claim checking**: coincidencia léxica oración-chunk con estatus `supported` / `no_evidence`.

## Puesta en marcha

1. **Infra básica**
   ```bash
   docker compose up -d
   ```
   Levanta PostgreSQL (pgvector) y Ollama.

2. **Variables de entorno**
   ```bash
   cp .env.example .env
   ```
   Ajusta `OPENROUTER_API_KEY` y, si es necesario, los puertos/URLs.

3. **Dependencias**
   ```bash
   pnpm install
   ```
   (Requiere acceso al registry npm para descargar `tsx`, Prisma, etc.).

4. **Base de datos**
   ```bash
   pnpm --filter server prisma migrate dev
   pnpm --filter server prisma:generate
   pnpm --filter server run seed
   ```

5. **Ingesta de normativa**
   - Coloca archivos `.md|.txt|.html` en `data/`.
   - Ejecuta:
     ```bash
     pnpm --filter server run ingest
     # o para una ruta específica
     pnpm --filter server run ingest:path data/ordenanzas
     ```

6. **Servicios en desarrollo**
   ```bash
   pnpm --filter server dev        # backend SSE en http://localhost:3001
   pnpm --filter frontend dev      # UI en http://localhost:3000
   ```

   Configura `NEXT_PUBLIC_BACKEND_URL` (frontend) y `FRONTEND_ORIGIN` (backend) para permitir CORS.

## Flujo de conversación

1. El frontend envía el historial + passcode (opcional) vía SSE.
2. El backend recupera chunks pgvector (k=6) con métricas (`embeddingMs`, `sqlMs`, `k`, `similarityAvg`, `similarityMin`).
3. `streamText` orquesta el plan del LLM y las herramientas (máx. `MAX_TOOL_ITERATIONS`).
4. Eventos SSE emitidos:
   - `ready`: ID de request.
   - `context`: citas con `href`, snippet y similitud.
   - `token`: delta de respuesta.
   - `tool`: inicio/éxito/error + duración.
   - `claimcheck`: resultado oración-evidencia.
   - `metrics`: snapshot final (TTFB, latencias, k, similitudes).
   - `done`/`error`.
5. Claim checking final marca oraciones sin evidencia (`no_evidence`).

## Seguridad y guardrails

- Sanitización del contexto RAG (`security/sanitize.ts`) eliminando instrucciones hostiles.
- Herramientas bloqueadas hasta validar passcode (vía `verify_passcode`).
- Validaciones Zod en tools y request inicial.
- Aborto de streaming si el cliente cierra la conexión.

## Scripts útiles

| Comando | Descripción |
| --- | --- |
| `pnpm --filter server run seed` | Crea usuario demo (`demo@laburen.local` / `123456`). |
| `pnpm --filter server run ingest` | Ingesta completa de `DOCS_ROOT` con embeddings Ollama. |
| `pnpm --filter server run ingest:path <ruta>` | Ingesta puntual de carpeta/archivo. |

## Métricas en vivo

El panel del frontend muestra:

- **TTFB**: tiempo hasta el primer token.
- **Latencia LLM**: duración total del stream.
- **SQL / Embeddings**: tiempos de búsqueda vs. Ollama.
- **k / similitudes**: cantidad de chunks + calidad promedio/mínima.
- **Timeline**: ejecución de herramientas (OK / error / duración).

## Futuras extensiones

- Ajustar parámetros `ivfflat` (lists/probes) cuando crezca el corpus.
- Versionado de corpus (`Doc.version`) para AB testing sin `TRUNCATE`.
- Comparativas de modelos vía OpenRouter (`defaultModel()` configurable).
