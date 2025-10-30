# Copiloto Tributario – Plan Ajustado

## 1. Arquitectura actualizada

```
┌─────────────────────────────────────────────────────────────────────┐
│                              Frontend (Next.js)                     │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Chat UI (App Router)                                            │ │
│ │  • Componentes server/client desacoplados                      │ │
│ │  • Hook SSE -> /api/chat con abort + retries                    │ │
│ │  • Timeline herramientas + panel métricas en vivo               │ │
│ │  • Gestión passcode + caché sesión                              │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────┬──────────────────────────────────┘
                                      │ HTTPS (SSE + JSON)
┌─────────────────────────────────────▼──────────────────────────────────┐
│                       Backend (Next.js API Routes)                     │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ /api/chat (AI SDK streamText)                                      │ │
│ │  • Orquestador AI SDK (Vercel) + runtime Node                      │ │
│ │  • Tool router tipado (zod) con límite iteraciones                 │ │
│ │  • Búsqueda RAG + claim-checker                                    │ │
│ │  • Telemetría granular (TTFB, LLM, SQL, embeddings, similitud)     │ │
│ │  • Sanitización chunks + guardado audit trail                      │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ /api/metrics, /api/passcode, /api/docs                            │ │
│ │  • Autenticación + rate limiting                                  │ │
│ │  • Servicio de configuración (modelos, thresholds)                 │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ Prisma Client + PgBouncer opcional
┌───────────────────────────────▼────────────────────────────────────────┐
│                       PostgreSQL 15 + pgvector 0.5.1                   │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ Tablas negocio (InvitedUser, Session, Lead, Note, FollowUp, Doc)   │ │
│ │ DocChunk con embedding vector(768) + metadata JSONB                │ │
│ │ Índices: btree (claves), GIN (texto), ivfflat opcional             │ │
│ │ Funciones claim audit (jsonb_build_object)                         │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ REST (HTTP/JSON)
┌───────────────────────────────▼────────────────────────────────────────┐
│                               Ollama                                   │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ Modelo embeddings nomic-embed-text                                 │ │
│ │ Pool de conexiones limitado + timeout 8s                           │ │
│ │ Métrica latencia enviada al backend                                │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### Ajustes clave respecto al plan previo

1. **Runtime Node dedicado en `/api/chat`**: forzamos `export const runtime = "nodejs";` para garantizar compatibilidad con AI SDK, Prisma y AbortController. Evita throttling edge y simplifica gestión de pools.
2. **PgBouncer opcional**: en entornos productivos el compose incluye PgBouncer para estabilizar conexiones Prisma/Next.js durante streaming.
3. **Servicio de configuración dinámica**: centraliza thresholds (similitud mínima, máximos tokens herramientas) y permite toggles A/B sin redeploy.
4. **Audit trail**: cada interacción se persiste (prompt, chunks, claim-check resultado) para auditoría. Se añade tabla `AuditEvent` opcional (no requerida pero recomendada).
5. **Rate limiting**: capa ligera con `@upstash/ratelimit` compatible con Next API para evitar abuso.
6. **Timeboxing herramientas**: cada tool ejecuta en `Promise.race` con timeout configurable, registrando métricas de éxito/fallo.
7. **Sanitización reforzada**: se limpian instrucciones con whitelist HTML + strip de directivas `<<SYS>>` dentro de chunks; se loguea si se detecta inyección.
8. **Validación embeddings**: se controla `embedding.length === EMBEDDING_DIM` y se verifica que la norma L2 no sea cero (descarta texto vacío).
9. **Claim-checker reforzado**: mezcla fuzzy matching (Jaro-Winkler) con umbral de token overlap. Pone bandera `unsupported_sentences` y lo reporta en stream.
10. **Telemetría persistente**: se agrega almacenamiento circular en memoria + endpoint SSE `/api/metrics/stream` para panel en vivo.

## 2. Decisiones justificadas

| Decisión | Ajuste | Beneficio | Riesgo/Mitigación |
| --- | --- | --- | --- |
| AI SDK + streamText | Router de tools desacoplado y soporte reintentos | Menos acoplamiento, logging uniforme | Mantener versiones actualizadas del SDK y tests contractuales |
| OpenRouter + Anthropic Haiku por defecto | Configurable vía `.env`; fallback `gpt-4o-mini` | Flexibilidad coste vs calidad; pruebas A/B | Manejar errores 429 con backoff exponencial |
| Prisma + `$queryRaw` | Añadir vistas SQL para MMR (CTE) | Control total sobre ranking, manteniendo tipado | Revisar consultas en migraciones y testear con EXPLAIN |
| pgvector `ivfflat` opcional | Crear migración con `ANALYZE` post index | Escala sin penalizar datasets pequeños | Requiere `REINDEX` si cambian parámetros; documentar |
| Docker Compose con healthchecks | Servicios `postgres`, `pgbouncer`, `ollama`, `web` | Arranque reproducible y CI ready | Cuidar recursos en dev; permitir perfiles `docker compose --profile` |
| Claim-checker pre-stream final | Usa pipeline determinista, fallback a marcar `No evidenciado` | Aumenta confianza audit | Debe ser rápido (<30ms/chunk); optimizar con caches |

## 3. Estructura de repositorio revisada

```
copiloto-tributario/
├─ README.md
├─ docker-compose.yml
├─ env.example
├─ package.json
├─ prisma/
│  ├─ schema.prisma
│  └─ migrations/
│     ├─ 2024XXXX_init/
│     ├─ 2024XXXX_enable_pgvector.sql
│     └─ 2024XXXX_docchunk_vector.sql
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx
│  │  └─ api/
│  │     ├─ chat/route.ts
│  │     ├─ metrics/route.ts
│  │     ├─ metrics/stream/route.ts
│  │     └─ passcode/route.ts
│  ├─ server/
│  │  ├─ config/index.ts
│  │  ├─ lib/
│  │  │  ├─ prisma.ts
│  │  │  ├─ ai-sdk.ts
│  │  │  ├─ embeddings.ts
│  │  │  ├─ rag/
│  │  │  │  ├─ chunker.ts
│  │  │  │  ├─ ingest.ts
│  │  │  │  └─ search.ts
│  │  │  ├─ claim-checker.ts
│  │  │  ├─ metrics.ts
│  │  │  ├─ guardrails.ts
│  │  │  └─ auth.ts
│  │  ├─ tools/
│  │  │  ├─ index.ts
│  │  │  ├─ verifyPasscode.ts
│  │  │  ├─ createLead.ts
│  │  │  ├─ recordNote.ts
│  │  │  ├─ listNotes.ts
│  │  │  ├─ scheduleFollowup.ts
│  │  │  ├─ listFollowups.ts
│  │  │  ├─ completeFollowup.ts
│  │  │  └─ searchDocs.ts
│  │  └─ telemetry/
│  │     ├─ emitter.ts
│  │     ├─ metrics-store.ts
│  │     └─ types.ts
│  ├─ hooks/
│  │  └─ useChatStream.ts
│  ├─ components/
│  │  ├─ ChatWindow.tsx
│  │  ├─ MetricsPanel.tsx
│  │  ├─ ToolTimeline.tsx
│  │  ├─ PasscodeDialog.tsx
│  │  └─ EvidenceCitations.tsx
│  └─ tests/
│     ├─ unit/
│     ├─ integration/
│     └─ e2e/
├─ scripts/
│  ├─ ingest.ts
│  └─ demo-script.md
└─ tsconfig.json
```

Cambios vs plan previo: separamos `config/`, añadimos `telemetry/`, y reorganizamos APIs para reutilizar lógica server-only.

## 4. Plan de implementación iterativo optimizado

1. **Infraestructura y cimientos**
   - Inicializar Next.js (App Router) con TypeScript, ESLint, Prettier.
   - Configurar Docker Compose con servicios `postgres`, `pgvector` extension, `pgbouncer`, `ollama`, `web`.
   - Añadir script `pnpm prisma migrate deploy` en entrypoint.

2. **Modelo de datos + migraciones**
   - Escribir `schema.prisma` completo (Incl. `AuditEvent`).
   - Crear migración SQL: `CREATE EXTENSION IF NOT EXISTS vector;` y columnas `embedding vector(768)`.
   - Añadir migración opcional `CREATE INDEX ... USING ivfflat` documentada.

3. **Servicios core backend**
   - Config `AI SDK` wrapper (modelo, retries, logging).
   - Implementar tools Prisma con validaciones zod y auth.
   - Añadir guardrails: passcode, rate limit, sanitización.

4. **Pipeline RAG**
   - Implementar chunker configurable (700/120) + normalización.
   - Script `scripts/ingest.ts` con CLI (yargs) para cargar docs.
   - Búsqueda con `$queryRaw` + MMR (CTE) + threshold.

5. **Orquestación `/api/chat`**
   - Construir flujo `streamText` + timeline de tools + claim-checker.
   - Enviar métricas intermedias y finales vía `AIStreamResponse`.
   - Persistir audit trail.

6. **Frontend WOW**
   - Hook SSE confiable (`EventSource` + fallback fetch).
   - UI chat con citas clicables y resaltado.
   - Panel métricas y timeline (estado real time + badges).

7. **Telemetría + observabilidad**
   - Implementar `metrics-store` in-memory + SSE `/api/metrics/stream`.
   - Mostrar en panel y registrar en audit trail.
   - Enviar logs estructurados (pino) a STDOUT.

8. **Testing integral**
   - Unit tests (Vitest) para chunker, claim-checker, tools (mocks Prisma).
   - Integration (Node env) para RAG (Docker Compose en CI).
   - E2E (Playwright) con flujo completo.

9. **Demo y documentación**
   - Script de demo 90s (pasos CLI, prompts, expected).
   - README con setup, `.env`, seeds, troubleshooting.
   - Roadmap ANN, versionado corpus.

## 5. Configuraciones refinadas

- **Variables de entorno** (`env.example`):
  ```env
  DATABASE_URL=postgres://postgres:postgres@postgres:5432/copiloto
  SHADOW_DATABASE_URL=postgres://postgres:postgres@postgres-shadow:5432/copiloto_shadow
  OLLAMA_BASE_URL=http://ollama:11434
  EMBEDDING_MODEL=nomic-embed-text
  EMBEDDING_DIM=768
  OPENROUTER_API_KEY=sk-...
  OPENROUTER_MODEL=anthropic/claude-3.5-haiku
  OPENROUTER_FALLBACK_MODEL=openai/gpt-4o-mini
  DOCS_ROOT=./data
  MAX_TOOL_ITERATIONS=4
  CLAIM_SIMILARITY_THRESHOLD=0.78
  CLAIM_OVERLAP_THRESHOLD=0.65
  NEXT_PUBLIC_BACKEND_URL=http://localhost:3000
  PASSCODE_HASH=$2b$10$...
  RATE_LIMIT_REQUESTS=60
  RATE_LIMIT_WINDOW=60
  ```

- **Docker Compose (resumen)**:
  ```yaml
  services:
    postgres:
      image: ankane/pgvector:0.5.1
      environment:
        POSTGRES_PASSWORD: postgres
      healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 5 }
    pgbouncer:
      image: edoburu/pgbouncer
      depends_on: { postgres: { condition: service_healthy } }
    ollama:
      image: ollama/ollama:latest
      volumes: ["ollama-data:/root/.ollama"]
    web:
      build: .
      command: pnpm dev
      env_file: .env
      depends_on:
        postgres: { condition: service_healthy }
        ollama: { condition: service_started }
  ```

## 6. Próximos pasos

- Confirmar aceptación de estructura y plan.
- Pasar a definición detallada de `schema.prisma` y migraciones SQL.
- Implementar endpoint `/api/chat` conforme al flujo descrito.
- Continuar con ingesta RAG y claim-checker.

> Supuestos: Node.js 20, pnpm, entorno Linux, App Router habilitado, Anthropic Haiku disponible vía OpenRouter.
