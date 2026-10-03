"use client";

import { useEffect } from "react";
import { reportClientError } from "../lib/luna2/observability-client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void reportClientError("boundary", error);
  }, [error]);

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f7f7f4] px-6 text-[#171817]">
      <section className="w-full max-w-md rounded-3xl border border-[#deded6] bg-white p-7 shadow-[0_18px_60px_rgba(30,30,20,.06)]">
        <div className="text-xs font-semibold tracking-[.2em] text-[#777970]">LUNA ERROR</div>
        <h1 className="mt-3 text-2xl font-medium">Something went wrong.</h1>
        <p className="mt-3 text-sm leading-6 text-[#66685f]">
          The error has been captured without exposing credentials or private session details.
        </p>
        <button type="button" onClick={() => reset()} className="mt-6 h-11 rounded-2xl bg-[#171817] px-5 text-sm font-medium text-white">
          Try again
        </button>
      </section>
    </main>
  );
}
