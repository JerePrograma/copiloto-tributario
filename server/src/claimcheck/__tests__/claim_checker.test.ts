import { describe, expect, it } from "vitest";
import { claimCheck } from "../claim_checker";
import type { RetrievedChunk } from "../../rag/search";

const chunks: RetrievedChunk[] = [
  {
    id: "c1",
    docId: "d1",
    idx: 0,
    title: "Normativa",
    href: "doc#1",
    content: "La exención para pymes aplica hasta 2026 con comprobante de AFIP.",
    similarity: 0.8,
  },
  {
    id: "c2",
    docId: "d2",
    idx: 0,
    title: "Otra norma",
    href: "doc#2",
    content: "El impuesto automotor tiene descuentos para vehículos eléctricos.",
    similarity: 0.6,
  },
];

describe("claimCheck", () => {
  it("marca oraciones sin respaldo", () => {
    const claims = claimCheck(
      "Las pymes tienen exención hasta 2026. Los autónomos tienen un beneficio especial.",
      chunks
    );
    expect(claims).toHaveLength(2);
    expect(claims[0].status).toBe("supported");
    expect(claims[1].status).toBe("no_evidence");
  });
});
