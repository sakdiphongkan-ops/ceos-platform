import { assertEquals } from "jsr:@std/assert@1";
import {
  isUuid,
  parseResearchPagination,
  researchCandidateStatus,
} from "./research_get_helpers.ts";

Deno.test("research pagination defaults to bounded first page", () => {
  assertEquals(
    parseResearchPagination(new URL("https://example.test/research")),
    { page: 1, pageSize: 50, from: 0, to: 49 },
  );
});

Deno.test("research pagination respects requested page while capping size", () => {
  assertEquals(
    parseResearchPagination(new URL("https://example.test/research?page=3&page_size=25")),
    { page: 3, pageSize: 25, from: 50, to: 74 },
  );
  assertEquals(
    parseResearchPagination(new URL("https://example.test/research?page=9000&page_size=200")),
    { page: 1000, pageSize: 50, from: 49950, to: 49999 },
  );
});

Deno.test("invalid pagination parameters safely fall back to defaults", () => {
  assertEquals(
    parseResearchPagination(new URL("https://example.test/research?page=-1&page_size=NaN")),
    { page: 1, pageSize: 50, from: 0, to: 49 },
  );
});

Deno.test("candidate state does not imply candidates from another run", () => {
  assertEquals(researchCandidateStatus(null, 0), "NO_RESEARCH_RUNS");
  assertEquals(researchCandidateStatus("82f12d8e-5ef3-4f6a-9c15-17b93bc3f9fb", 0), "NO_CANDIDATES_FOR_RUN");
  assertEquals(researchCandidateStatus("82f12d8e-5ef3-4f6a-9c15-17b93bc3f9fb", 12), "OK");
});

Deno.test("run_id validation only accepts UUID-shaped identifiers", () => {
  assertEquals(isUuid("82f12d8e-5ef3-4f6a-9c15-17b93bc3f9fb"), true);
  assertEquals(isUuid("not-a-run"), false);
});
