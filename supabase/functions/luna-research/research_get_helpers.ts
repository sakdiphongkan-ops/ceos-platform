export type ResearchPagination = {
  page: number;
  pageSize: number;
  from: number;
  to: number;
};

function boundedPositiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function parseResearchPagination(url: URL): ResearchPagination {
  const page = boundedPositiveInteger(url.searchParams.get("page"), 1, 1000);
  const pageSize = boundedPositiveInteger(url.searchParams.get("page_size"), 50, 50);
  const from = (page - 1) * pageSize;
  return { page, pageSize, from, to: from + pageSize - 1 };
}

export function researchCandidateStatus(runId: string | null, totalCandidates: number): string {
  if (!runId) return "NO_RESEARCH_RUNS";
  if (!Number.isFinite(totalCandidates) || totalCandidates <= 0) return "NO_CANDIDATES_FOR_RUN";
  return "OK";
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
