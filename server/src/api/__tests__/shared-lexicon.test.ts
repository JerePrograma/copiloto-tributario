import { beforeAll, describe, expect, it } from "vitest";
import { norm, LEX } from "../../nlp/lexicon";

const TARGET_TERMS = [
  "adhiero",
  "régimen simplificado",
  "PyME",
];

function flattenAndNorm(groups: string[][]): string[] {
  return groups.flat().map((term) => norm(term));
}

let SearchTesting: typeof import("../search").__TESTING;
let ChatTesting: typeof import("../chat").__TESTING;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/db";
  process.env.OLLAMA_BASE_URL ??= "http://localhost:11434";
  process.env.EMBEDDING_MODEL ??= "dummy-model";
  process.env.EMBEDDING_DIM ??= "384";
  process.env.OPENROUTER_API_KEY ??= "test-key-12345";
  process.env.OPENROUTER_MODEL ??= "openrouter/model";
  process.env.DOCS_ROOT ??= "/tmp";

  ({ __TESTING: SearchTesting } = await import("../search"));
  ({ __TESTING: ChatTesting } = await import("../chat"));
});

describe("shared lexicon", () => {
  it("contains key synonyms", () => {
    const lexValues = Object.values(LEX).flat().map((term) => norm(term));
    for (const term of TARGET_TERMS) {
      expect(lexValues).toContain(norm(term));
    }
  });

  it("keeps search anchor groups aligned", () => {
    const groups = SearchTesting.buildAnchorGroupsFromQuery(
      "Necesito adhiero al régimen simplificado PyME"
    );
    const normalized = flattenAndNorm(groups);
    for (const term of TARGET_TERMS) {
      expect(normalized).toContain(norm(term));
    }
  });

  it("keeps chat anchor groups aligned", () => {
    const { groups } = ChatTesting.buildAnchorGroupsByIntent(
      "Necesito adhiero al régimen simplificado PyME",
      undefined
    );
    const normalized = flattenAndNorm(groups);
    for (const term of TARGET_TERMS) {
      expect(normalized).toContain(norm(term));
    }
  });
});
