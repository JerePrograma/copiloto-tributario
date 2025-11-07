#!/usr/bin/env node
import * as fs from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { chunkText } from "./chunk";
import { embed } from "../lib/ollama";
import { extractFrontMatter, normalizeLegalMetadata } from "./metadata";

/* ================================
   Resolución de raíz de documentos
   Prioridad: --root > DOCS_ROOT > heurísticas locales
==================================*/
function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const rootArg = getArg("--root");

const candidates = [
  rootArg ? resolve(process.cwd(), rootArg) : null,
  env.DOCS_ROOT ? resolve(process.cwd(), env.DOCS_ROOT) : null,
  resolve(process.cwd(), "../data"),
  resolve(process.cwd(), "data"),
  resolve(process.cwd(), "../../data"),
].filter(Boolean) as string[];

const effectiveRoot = candidates.find((p) => fs.existsSync(p));
if (!effectiveRoot) {
  console.error("No se encontró carpeta de datos. Probé:", candidates.join(" | "));
  process.exit(2);
}
console.log("INGEST_ROOT =", effectiveRoot, " argv=", process.argv.slice(2));

/* ================================
   Utils
==================================*/
export function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = fs.statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (/\.(md|txt|html)$/i.test(entry)) yield full;
  }
}

function ensureUniqueSequentialIdx<T extends { idx: number }>(arr: T[]): T[] {
  // Reindexa 0..N-1 y asegura unicidad determinística
  return arr.map((c, i) => ({ ...c, idx: i }));
}

/* ================================
   Ingesta de un archivo (idempotente y segura)
==================================*/
export async function ingestFile(filePath: string) {
  const relativePath = relative(effectiveRoot, filePath).replace(/\\/g, "/");
  const title = relativePath.split("/").pop() || relativePath;
  const raw = fs.readFileSync(filePath, "utf8");

  const { body, metadata } = extractFrontMatter(raw);
  const normalized = normalizeLegalMetadata(metadata);

  // Upsert del Doc
  const doc = await prisma.doc.upsert({
    where: { path_version: { path: relativePath, version: 1 } },
    update: {
      title,
      jurisdiccion: normalized.jurisdiccion ?? null,
      tipo: normalized.tipo ?? null,
      anio: normalized.anio ?? null,
      metadata: normalized.raw ?? {},
      updatedAt: new Date(),
    },
    create: {
      path: relativePath,
      title,
      version: 1,
      jurisdiccion: normalized.jurisdiccion ?? null,
      tipo: normalized.tipo ?? null,
      anio: normalized.anio ?? null,
      metadata: normalized.raw ?? {},
    },
  });

  // Chunking + reindexación determinística
  const rawChunks = chunkText(body, 700, 120);
  const chunks = ensureUniqueSequentialIdx(rawChunks);

  // Guardias de diagnóstico
  const seen = new Set<number>();
  for (const c of chunks) {
    if (seen.has(c.idx)) {
      throw new Error(`chunker duplicó idx=${c.idx} en ${relativePath}`);
    }
    seen.add(c.idx);
  }

  console.log(`Indexando ${relativePath}: ${chunks.length} chunks -> idx [0..${chunks.length - 1}]`);

  // Sincronización exacta de filas:
  // 1) borrar "sobrantes" (idx que ya no existen)
  const keepIdx = chunks.map((c) => c.idx);
  await prisma.docChunk.deleteMany({
    where: { docId: doc.id, NOT: { idx: { in: keepIdx } } },
  });

  // 2) upsert de cada chunk (evita P2002 ante concurrencia o rerun)
  for (const c of chunks) {
    const row = await prisma.docChunk.upsert({
      where: { docId_idx: { docId: doc.id, idx: c.idx } },
      update: {
        content: c.content,
        tokenCount: c.content.length,
        startChar: c.start,
        endChar: c.end,
        href: `${relativePath}#chunk=${c.idx}`,
      },
      create: {
        docId: doc.id,
        idx: c.idx,
        content: c.content,
        tokenCount: c.content.length,
        startChar: c.start,
        endChar: c.end,
        href: `${relativePath}#chunk=${c.idx}`,
      },
    });

    // Embedding y actualización (pgvector) — Prisma no soporta vector en create/update
    const { vector, tMs } = await embed(c.content);
    if (!Array.isArray(vector) || vector.length === 0) {
      console.warn(`  chunk ${c.idx}: embedding vacío, se omite seteo`);
      continue;
    }
    const lit = `[${vector.map((v) => Number(v).toFixed(6)).join(",")}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE "DocChunk" SET "embedding" = '${lit}'::vector WHERE "id" = '${row.id}'`
    );
    console.log(`  chunk ${c.idx} -> embedding (${tMs} ms)`);
  }
}

/* ================================
   Main: recorre todo el árbol
==================================*/
async function main() {
  const start = performance.now();
  let count = 0;
  for (const file of walk(effectiveRoot)) {
    await ingestFile(file);
    count++;
  }
  const totalMs = Math.round(performance.now() - start);
  console.log(`Ingesta completada: ${count} archivos en ${totalMs} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
