#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { chunkText } from "./chunk";
import { embed } from "../lib/ollama";

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

export async function ingestFile(filePath: string) {
  const relativePath = relative(env.DOCS_ROOT, filePath).replace(/\\/g, "/");
  const title = relativePath.split("/").pop() || relativePath;
  const raw = readFileSync(filePath, "utf8");
  const doc = await prisma.doc.upsert({
    where: { path_version: { path: relativePath, version: 1 } },
    update: { title },
    create: { path: relativePath, title, version: 1 },
  });

  await prisma.docChunk.deleteMany({ where: { docId: doc.id } });
  const chunks = chunkText(raw, 700, 120);
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
      "[" +
      vector
        .map((value) => Number(value).toFixed(6))
        .join(",") +
      "]";
    await prisma.$executeRawUnsafe(
      `UPDATE "DocChunk" SET "embedding" = '${vectorLiteral}'::vector WHERE "id" = '${created.id}'`
    );
    console.log(`  chunk ${chunk.idx} -> embedding (${tMs} ms)`);
  }
}

async function main() {
  const start = performance.now();
  for (const file of walk(env.DOCS_ROOT)) {
    await ingestFile(file);
  }
  const totalMs = Math.round(performance.now() - start);
  console.log(`Ingesta completada en ${totalMs} ms`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
