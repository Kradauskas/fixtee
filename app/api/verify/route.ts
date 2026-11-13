import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { syncFixVerification } from "@/lib/verify/state-machine";

export const maxDuration = 60;

const requestSchema = z.object({ fixId: z.string().trim().min(1) });

export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ message: "body is not JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: "fixId is required" }, { status: 400 });
  }

  const { fixId } = parsed.data;
  try {
    const result = await syncFixVerification(fixId);
    return NextResponse.json({
      status: result.status,
      testRunUrl: result.testRunUrl,
      fixRunUrl: result.fixRunUrl,
    });
  } catch (err) {
    console.error("verify: sync failed", fixId, err instanceof Error ? err.message : err);
    return NextResponse.json({ message: "verification failed" }, { status: 500 });
  }
}
