import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { syncFixVerification, verifyFixByBranch } from "@/lib/verify/state-machine";

export const maxDuration = 60;

const requestSchema = z.union([
  z.object({ fixId: z.string().trim().min(1) }),
  z.object({
    projectId: z.string().trim().min(1),
    branchName: z.string().trim().min(1),
  }),
]);

export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ message: "body is not JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "send either fixId, or projectId and branchName" },
      { status: 400 },
    );
  }

  const target = parsed.data;
  const label = "fixId" in target ? target.fixId : `${target.projectId} ${target.branchName}`;
  try {
    const result =
      "fixId" in target
        ? await syncFixVerification(target.fixId)
        : await verifyFixByBranch(target);

    if (!result) {
      return NextResponse.json(
        { message: "no fix awaiting verification for this branch" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      status: result.status,
      testRunUrl: result.testRunUrl,
      fixRunUrl: result.fixRunUrl,
    });
  } catch (err) {
    console.error("verify: sync failed", label, err instanceof Error ? err.message : err);
    return NextResponse.json({ message: "verification failed" }, { status: 500 });
  }
}
