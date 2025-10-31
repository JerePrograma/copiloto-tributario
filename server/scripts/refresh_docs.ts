#!/usr/bin/env node
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { prisma } from "../src/lib/prisma";
import { effectiveRoot, ingestFile } from "../src/rag/ingest";

async function main() {
  const root = effectiveRoot;
  const docs = await prisma.doc.findMany();
  let refreshed = 0;
  const started = performance.now();
  for (const doc of docs) {
    const filePath = join(root, doc.path);
    if (!existsSync(filePath)) {
      console.warn(`[refresh] archivo ausente: ${filePath}`);
      continue;
    }
    const stats = statSync(filePath);
    if (!doc.updatedAt || stats.mtimeMs > doc.updatedAt.getTime()) {
      console.log(`[refresh] reindexando ${doc.path}`);
      await ingestFile(filePath);
      refreshed++;
    }
  }
  const elapsed = Math.round(performance.now() - started);
  console.log(`Refresh completo (${refreshed} documentos) en ${elapsed} ms`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
