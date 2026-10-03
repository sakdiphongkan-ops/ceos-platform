"use client";

import { useEffect } from "react";
import { reportClientError } from "../lib/luna2/observability-client";

export default function GlobalError({
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
    <html lang="en">
      <body className="bg-[#f7f7f4] text-[#171817]">
        <main className="grid min-h-screen place-items-center px-6">
          <section className="w-full max-w-md rounded-3xl border border-[#deded6] bg-white p-7">
            <div className="text-xs font-semibold tracking-[.2em] text-[#777970]">LUNA SYSTEM ERROR</div>
            <h1 className="mt-3 text-2xl font-medium">The application hit an unexpected error.</h1>
            <p className="mt-3 text-sm leading-6 text-[#66685f]">
              Diagnostics were captured in sanitized form. No authentication secret is rendered here.
            </p>
            <button type="button" onClick={() => reset()} className="mt-6 h-11 rounded-2xl bg-[#171817] px-5 text-sm font-medium text-white">
              Reload
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
