export type HistoricalCandle = Record<string, unknown> & {
  timestamp?: string;
  time?: string;
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
};

export interface SettradeHistoryRequest {
  symbol: string;
  interval?: string;
  limit?: number;
  start?: string;
  end?: string;
  normalized?: boolean;
}

export interface SettradeHistoryResponse {
  ok: boolean;
  source: string;
  symbol: string;
  interval: string;
  limit: number;
  start: string | null;
  end: string | null;
  normalized: boolean;
  fetched_at: string;
  data: unknown;
}

export async function fetchSettradeHistoricalCandles(
  gatewayUrl: string,
  gatewayKey: string,
  request: SettradeHistoryRequest,
): Promise<SettradeHistoryResponse> {
  const symbol = request.symbol.trim().toUpperCase();
  if (!symbol) throw new Error("SETTRADE_HISTORY_SYMBOL_REQUIRED");

  const params = new URLSearchParams({
    interval: request.interval ?? "15m",
    limit: String(request.limit ?? 500),
    normalized: String(request.normalized ?? true),
  });
  if (request.start) params.set("start", request.start);
  if (request.end) params.set("end", request.end);

  const response = await fetch(
    gatewayUrl.replace(/\/$/, "") +
      "/historical-candles/" +
      encodeURIComponent(symbol) +
      "?" +
      params.toString(),
    {
      headers: {
        "x-luna-gateway": gatewayKey,
        accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `SETTRADE_HISTORY_HTTP_${response.status}: ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as SettradeHistoryResponse;
  if (!payload.ok || payload.source !== "settrade-open-api-historical") {
    throw new Error("SETTRADE_HISTORY_INVALID_RESPONSE");
  }
  return payload;
}
