import { describe, expect, it } from "vitest";
import { rerankChunks } from "../rerank";
import type { RetrievedChunk } from "../search";

const chunks: RetrievedChunk[] = [
  {
    id: "1",
    docId: "d1",
    idx: 0,
    title: "Ley 123",
    href: "doc1#1",
    content: "La ordenanza 123 establece beneficios para pymes en la ciudad de Buenos Aires.",
    similarity: 0.82,
    hybridScore: 0.78,
  },
  {
    id: "2",
    docId: "d2",
    idx: 0,
    title: "Ordenanza 77",
    href: "doc2#1",
    content: "La provincia dicta normas generales sin mencionar pymes.",
    similarity: 0.86,
    hybridScore: 0.72,
  },
  {
    id: "3",
    docId: "d3",
    idx: 0,
    title: "Boleta",
    href: "doc3#1",
    content: "Detalle del impuesto automotor, referencia a exenciones para pymes.",
    similarity: 0.65,
    hybridScore: 0.69,
  },
];

describe("rerankChunks", () => {
  it("prioriza chunks con coincidencias léxicas", () => {
    const reranked = rerankChunks("exenciones para pymes", chunks, {
      mode: "lexical",
      limit: 2,
    });
    expect(reranked).toHaveLength(2);
    expect(reranked[0].id).toBe("1");
  });

  it("aplica diversidad con MMR", () => {
    const reranked = rerankChunks("beneficios pymes", chunks, {
      mode: "mmr",
      limit: 2,
      lambda: 0.5,
    });
    expect(reranked).toHaveLength(2);
    expect(reranked[0].id).toBe("2");
    expect(reranked[1].id).not.toBe(reranked[0].id);
  });
});
