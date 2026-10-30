import Link from "next/link";

function getReleaseChecks() {
  const isVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_URL);
  const environment = process.env.VERCEL_ENV ?? "unknown";
  const branch = process.env.VERCEL_GIT_COMMIT_REF ?? "unknown";
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  const deploymentUrl = process.env.VERCEL_URL ?? "";
  const shortCommit = commit ? commit.slice(0, 7) : null;

  const sourceStatus = branch === "master" && shortCommit
    ? "PASS"
    : branch === "unknown" || !shortCommit
      ? "UNVERIFIED"
      : "NON-MASTER";

  const sourceValue = shortCommit
    ? `${branch} · ${shortCommit}`
    : "Git source revision not exposed by this build";

  const deploymentReady = isVercel && environment === "production" && Boolean(shortCommit);
  const deploymentPreview = isVercel && environment === "preview";

  const deploymentStatus = deploymentReady
    ? "READY"
    : deploymentPreview
      ? "PREVIEW"
      : "UNVERIFIED";

  const deploymentValue = deploymentReady
    ? `Production deployment is serving this page · ${shortCommit}${deploymentUrl ? ` · ${deploymentUrl}` : ""}`
    : deploymentPreview
      ? `Preview deployment context · ${shortCommit ?? "revision unavailable"}${deploymentUrl ? ` · ${deploymentUrl}` : ""}`
      : "Vercel production deployment context cannot be verified from this build";

  return [
    ["SOURCE", sourceValue, sourceStatus],
    ["LIVE MONEY", "LOCKED", "SAFE"],
    ["BILLING", "Provider-neutral / not activated", "SAFE"],
    ["AUTH", "Sign-in required; authenticated user session not verified", "GATED"],
    ["VERCEL", deploymentValue, deploymentStatus],
  ] as const;
}

export default function ReleasePage() {
  const checks = getReleaseChecks();

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <div className="text-xs font-semibold tracking-[.25em] text-[#777970]">RELEASE</div>
      <h1 className="mt-3 text-3xl font-medium">LUNA Webapp Readiness</h1>
      <p className="mt-3 text-sm leading-6 text-[#66685f]">
        A transparent release gate. Deployment and source status are derived from the build environment;
        user authentication is shown as gated until an authenticated session is independently verified.
      </p>
      <div className="mt-8 overflow-hidden rounded-3xl border border-[#deded6] bg-white">
        {checks.map(([name, value, status]) => (
          <div key={name} className="grid grid-cols-[110px_1fr_auto] gap-4 border-b border-[#ecece5] p-5 last:border-0">
            <span className="text-xs font-semibold tracking-[.12em] text-[#777970]">{name}</span>
            <span className="text-sm">{value}</span>
            <span className="text-xs font-semibold">{status}</span>
          </div>
        ))}
      </div>
      <Link href="/luna" className="mt-6 inline-block rounded-2xl bg-[#171817] px-5 py-3 text-sm text-white">
        Open Control Room
      </Link>
    </main>
  );
}
