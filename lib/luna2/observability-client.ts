"use client";

function safeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "Unknown client error");
  return raw
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]")
    .replace(/(access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key|authorization|cookie|session(?:[_-]?id)?)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email-redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone-redacted]")
    .slice(0, 500);
}

export async function reportClientError(
  source: "error" | "unhandledrejection" | "boundary",
  value: unknown,
): Promise<void> {
  const payload = JSON.stringify({
    source,
    name: value instanceof Error ? value.name : "ClientError",
    message: safeMessage(value),
  });

  try {
    await fetch("/api/luna2/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "same-origin",
    });
  } catch {
    // Error reporting must never create a second user-facing error.
  }
}

export function registerClientObservability(): () => void {
  const onError = (event: ErrorEvent) => {
    void reportClientError("error", event.error ?? event.message);
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    void reportClientError("unhandledrejection", event.reason);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  (window as Window & { __lunaObservabilityReady?: boolean }).__lunaObservabilityReady = true;

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    (window as Window & { __lunaObservabilityReady?: boolean }).__lunaObservabilityReady = false;
  };
}
