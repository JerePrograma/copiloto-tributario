import { describe, expect, it } from "vitest";

import { buildAnchorGroups, detectIntent, LEX } from "../intent";

describe("detectIntent - adhesion", () => {
  const utterances = [
    "Necesito adhiero al régimen simplificado de ingresos brutos",
    "Queremos adherimos al RS de ingresos brutos",
    "Quiero anotarme en el régimen simplificado de ingresos brutos",
    "Necesito registrarme en el régimen simplificado de ingresos brutos",
  ];

  utterances.forEach((utterance) => {
    it(`detects adhesion_rs for "${utterance}"`, () => {
      expect(detectIntent(utterance)).toBe("adhesion_rs");
    });
  });

  it("builds adhesion anchor groups including IIBB lexicon", () => {
    const utterance =
      "Necesito adhiero al régimen simplificado de ingresos brutos";
    const intent = detectIntent(utterance);
    const groups = buildAnchorGroups(intent, utterance);

    expect(groups).toContainEqual(LEX.adhesion);
    expect(groups).toContainEqual(LEX.iibb);
  });
});
