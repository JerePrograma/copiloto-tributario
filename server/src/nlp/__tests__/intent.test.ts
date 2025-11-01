import { describe, expect, it } from "vitest";

import { buildAnchorGroups, detectIntent } from "../../nlp/intent";

describe("intent detection", () => {
  it("detects base_aliquota intent for base imponible queries", () => {
    expect(detectIntent("¿Cómo calculo la base imponible?"))
      .toBe("base_aliquota");
  });

  it("detects base_aliquota intent for alícuota queries", () => {
    expect(detectIntent("Necesito saber la alícuota aplicable"))
      .toBe("base_aliquota");
  });
});

describe("anchor groups", () => {
  it("combines base and alícuota keywords for base_aliquota intent", () => {
    const groups = buildAnchorGroups(
      "base_aliquota",
      "Detalle sobre base imponible y alícuota"
    );

    const combinedGroup = groups.find((group) =>
      group.includes("base imponible")
    );

    expect(combinedGroup).toBeDefined();
    expect(combinedGroup).toContain("alícuota");
  });
});
