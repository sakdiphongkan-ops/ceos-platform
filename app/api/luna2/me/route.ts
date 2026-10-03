import { NextResponse } from "next/server";
import { getLunaAccountAccess } from "../../../../lib/luna2/auth";

export async function GET() {
  try {
    const account = await getLunaAccountAccess();

    if (!account) {
      return NextResponse.json(
        { ok: false, authenticated: false },
        {
          status: 401,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        authenticated: true,
        account,
        liveMoney: false,
        paperTrading: true,
      },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        authenticated: false,
        error: "AUTH_BACKEND_NOT_CONFIGURED",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
