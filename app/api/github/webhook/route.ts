// POST /api/github/webhook: GitHub App webhook. Verify, dedupe, route; slow work runs in after().
// Logic lives in lib/github/webhook.ts.
import { after, NextResponse, type NextRequest } from "next/server";
import { getServiceClient } from "@/lib/db/supabase";
import { createWebhookDeps, handleWebhook } from "@/lib/github/webhook";

// Background work (log download + parsing, Tasks 5–6) runs inside this function's lifetime.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // Raw body: the signature is computed over these exact bytes.
  const body = await request.text();

  try {
    const result = await handleWebhook(createWebhookDeps(getServiceClient(), after), {
      body,
      deliveryId: request.headers.get("x-github-delivery"),
      event: request.headers.get("x-github-event"),
      signature: request.headers.get("x-hub-signature-256"),
    });
    return NextResponse.json({ message: result.message }, { status: result.status });
  } catch (err) {
    console.error(
      "webhook: handler failed",
      request.headers.get("x-github-delivery"),
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ message: "internal error" }, { status: 500 });
  }
}
