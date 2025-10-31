import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { searchDocuments } from "../rag/search";
import { recordSearchAudit } from "../metrics/audit";

const requestSchema = z.object({
  passcode: z.string().min(4).optional(),
  query: z.string().min(3),
  k: z.number().int().min(1).max(12).optional(),
  perDoc: z.number().int().min(1).max(5).optional(),
  minSim: z.number().min(0).max(1).optional(),
  reranker: z.enum(["lexical", "mmr"]).optional(),
  filters: z
    .object({
      pathLike: z.string().optional(),
      jurisdiccion: z.array(z.string()).optional(),
      tipo: z.array(z.string()).optional(),
      anioMin: z.number().int().optional(),
      anioMax: z.number().int().optional(),
    })
    .optional(),
});

async function verifyPasscode(passcode?: string) {
  if (!passcode) return { authenticated: false, userId: undefined as string | undefined };
  const invited = await prisma.invitedUser.findFirst({ where: { passcode } });
  return {
    authenticated: Boolean(invited),
    userId: invited?.id,
  };
}

export async function search(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsed = requestSchema.parse(rawBody ? JSON.parse(rawBody) : {});

    const { authenticated, userId } = await verifyPasscode(parsed.passcode);

    const filters = parsed.filters ?? {};
    const cleanedFilters = Object.fromEntries(
      Object.entries(filters).filter(([, value]) =>
        Array.isArray(value)
          ? value.length > 0
          : value !== undefined && value !== null && value !== ""
      )
    );
    const result = await searchDocuments(parsed.query, parsed.k ?? 6, {
      perDoc: parsed.perDoc,
      minSim: parsed.minSim,
      pathLike: filters.pathLike,
      jurisdiccion: filters.jurisdiccion,
      tipo: filters.tipo,
      anioMin: filters.anioMin,
      anioMax: filters.anioMax,
      authenticated,
      rerankMode: parsed.reranker,
    });

    await recordSearchAudit({
      userId,
      passcodeValid: authenticated,
      query: parsed.query,
      filters: cleanedFilters,
      metrics: result.metrics,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        results: result.chunks,
        metrics: result.metrics,
        authenticated,
      })
    );
  } catch (error) {
    const isValidation = error instanceof z.ZodError || error instanceof SyntaxError;
    const message = isValidation
      ? (error as Error).message
      : (error as Error).message ?? "Unexpected error";
    res.writeHead(isValidation ? 400 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}
