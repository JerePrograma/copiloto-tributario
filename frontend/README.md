# Frontend (Next.js)

Interfaz del Copiloto Tributario con chat streaming, panel de métricas y timeline de herramientas.

## Scripts

```bash
pnpm dev     # http://localhost:3000
pnpm build
pnpm start
pnpm lint
```

Configura `NEXT_PUBLIC_BACKEND_URL` para apuntar al servidor SSE (por defecto `http://localhost:3001`).

## Estructura

- `src/app/page.tsx` → carga el `AppShell` (cliente) que coordina chat + métricas.
- `src/components/Chat.tsx` → formulario, historial de mensajes, citas y claim-check.
- `src/components/MetricsPanel.tsx` → renderiza métricas TTFB / LLM / SQL / embeddings / similitudes.
- `src/components/Timeline.tsx` → timeline de herramientas (start/ok/error + duración).
- `src/lib/sse.ts` → parser SSE con soporte de abort.

## Estilo

Los estilos globales viven en `src/app/globals.css` (gradiente oscuro + layout responsive). Puedes ajustar la UI sin cambiar la lógica del chat.
