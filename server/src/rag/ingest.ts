#!/usr/bin/env node
import * as fs from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { chunkText } from "./chunk";
import { embed } from "../lib/ollama";
import { extractFrontMatter, normalizeLegalMetadata } from "./metadata";

// --- CLI: --root > DOCS_ROOT > heurísticas locales
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
  console.error(
    "No se encontró carpeta de datos. Probé:",
    candidates.join(" | ")
  );
  process.exit(2);
}
console.log("INGEST_ROOT =", effectiveRoot, " argv=", process.argv.slice(2));

// --- Walk
export function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = fs.statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (/\.(md|txt|html)$/i.test(entry)) yield full;
  }
}

// --- Ingest one file
export async function ingestFile(filePath: string) {
  const relativePath = relative(effectiveRoot, filePath).replace(/\\/g, "/");
  const title = relativePath.split("/").pop() || relativePath;
  const raw = fs.readFileSync(filePath, "utf8");

  const { body, metadata } = extractFrontMatter(raw);
  const normalized = normalizeLegalMetadata(metadata);

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
    const vectorLiteral =
      "[" + vector.map((v) => Number(v).toFixed(6)).join(",") + "]";
    await prisma.$executeRawUnsafe(
      `UPDATE "DocChunk" SET "embedding" = '${vectorLiteral}'::vector WHERE "id" = '${created.id}'`
    );
    console.log(`  chunk ${chunk.idx} -> embedding (${tMs} ms)`);
  }
}

// --- Main
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
