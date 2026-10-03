import { NextResponse } from "next/server";
import { getLunaAccountAccess } from "../../../../lib/luna2/auth";

export async function GET() {
  const account = await getLunaAccountAccess();

  if (!account) {
    return NextResponse.json({ ok: false, authenticated: false }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    authenticated: true,
    account,
    liveMoney: false,
    paperTrading: true,
  }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
