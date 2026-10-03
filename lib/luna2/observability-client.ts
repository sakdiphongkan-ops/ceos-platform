"use client";

function safeMessage(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 500);
  return String(value ?? "Unknown client error").slice(0, 500);
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

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
