#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chunkText } from "./chunker";
import { embed } from "../llm/ollama";

const prisma = new PrismaClient();
const ROOT = process.env.DOCS_ROOT || "./data";

function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(md|txt)$/i.test(f)) yield p;
  }
}

async function main() {
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const title = rel.split("/").pop() || rel;
    const raw = readFileSync(file, "utf8");
    const doc = await prisma.doc.upsert({
      where: { path_version: { path: rel, version: 1 } },
      update: {},
      create: { path: rel, title, version: 1 },
    });

    const chunks = chunkText(raw, 700, 120);
    console.log(`Indexando ${rel} -> ${chunks.length} chunks`);
    for (const c of chunks) {
      const dc = await prisma.docChunk.create({
        data: {
          docId: doc.id,
          idx: c.idx,
          content: c.content,
          tokenCount: c.content.length,
          startChar: c.start,
          endChar: c.end,
          href: `${rel}#chunk=${c.idx}`,
        },
      });
      const { vector, t_ms } = await embed(c.content);
      const vec = "[" + vector.map((x) => Number(x).toFixed(6)).join(",") + "]";
      await prisma.$executeRawUnsafe(
        `UPDATE "DocChunk" SET "embedding" = '${vec}'::vector WHERE "id" = '${dc.id}'`
      );
      console.log(`  chunk ${c.idx} ok (${t_ms} ms)`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
