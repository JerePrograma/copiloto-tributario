#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { chunkText } from "./chunk";
import { embed } from "../lib/ollama";
import { extractFrontMatter, normalizeLegalMetadata } from "./metadata";

// -------- CLI root: --root > env.DOCS_ROOT > default ../../data
function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const rootArg = getArg("--root");
export const effectiveRoot = rootArg
  ? resolve(process.cwd(), rootArg)
  : env.DOCS_ROOT
  ? resolve(process.cwd(), env.DOCS_ROOT)
  : resolve(__dirname, "../../data");

console.log("INGEST_ROOT =", effectiveRoot, " argv=", process.argv.slice(2));

// -------- Walk
export function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (/\.(md|txt|html)$/i.test(entry)) {
      yield full;
    }
  }
}

// -------- Ingest one file
export async function ingestFile(filePath: string) {
  const relativePath = relative(effectiveRoot, filePath).replace(/\\/g, "/");
  const title = relativePath.split("/").pop() || relativePath;
  const raw = readFileSync(filePath, "utf8");
  const { body, metadata } = extractFrontMatter(raw);
  const normalized = normalizeLegalMetadata(metadata);

  // upsert por (path, version) usando unique compuesto path_version
  const doc = await prisma.doc.upsert({
    where: { path_version: { path: relativePath, version: 1 } },
    update: {
      title,
      jurisdiccion: normalized.jurisdiccion ?? null,
      tipo: normalized.tipo ?? null,
      anio: normalized.anio ?? null,
      metadata: normalized.raw ?? {},
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

  // reindex completo del doc
  await prisma.docChunk.deleteMany({ where: { docId: doc.id } });

  const chunks = chunkText(body, 700, 120);
  console.log(`Indexando ${relativePath}: ${chunks.length} chunks`);

  for (const chunk of chunks) {
    const created = await prisma.docChunk.create({
      data: {
        docId: doc.id,
        idx: chunk.idx,
        content: chunk.content,
        tokenCount: chunk.content.length,
        startChar: chunk.start,
        endChar: chunk.end,
        href: `${relativePath}#chunk=${chunk.idx}`,
      },
    });

    const { vector, tMs } = await embed(chunk.content);
    // Persistencia vía SQL crudo (pgvector)
    const vectorLiteral =
      "[" + vector.map((v) => Number(v).toFixed(6)).join(",") + "]";
    await prisma.$executeRawUnsafe(
      `UPDATE "DocChunk" SET "embedding" = '${vectorLiteral}'::vector WHERE "id" = '${created.id}'`
    );
    console.log(`  chunk ${chunk.idx} -> embedding (${tMs} ms)`);
  }
}

// -------- Main
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
