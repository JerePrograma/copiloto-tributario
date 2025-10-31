#!/usr/bin/env tsx
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ingestFile, walk } from "../src/rag/ingest";
import { env } from "../src/lib/env";

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Uso: pnpm --filter server ingest <ruta|archivo>");
    process.exit(1);
  }

  const target = resolve(input);
  if (!target.startsWith(resolve(env.DOCS_ROOT))) {
    console.warn("La ruta debe residir dentro de DOCS_ROOT", env.DOCS_ROOT);
  }

  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(target);
  } catch {
    console.error("La ruta especificada no existe:", target);
    process.exit(1);
  }
  if (!stats) {
    process.exit(1);
  }
  if (stats.isDirectory()) {
    for (const file of walk(target)) {
      await ingestFile(file);
    }
  } else {
    await ingestFile(target);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
