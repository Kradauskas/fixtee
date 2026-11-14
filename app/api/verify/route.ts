import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createUserClient, type Db } from "../../../lib/db/supabase";
import {
  syncFixVerification,
  verifyFixByBranch,
  type FixBranchRef,
  type RunHint,
  type VerificationResult,
} from "../../../lib/verify/state-machine";

export const maxDuration = 60;

const requestSchema = z.union([
  z.object({
    fixId: z.string().trim().min(1),
    headSha: z.string().trim().min(1).optional(),
    conclusion: z.string().trim().min(1).optional(),
    runUrl: z.string().trim().min(1).optional(),
  }),
  z.object({
    projectId: z.string().trim().min(1),
    branchName: z.string().trim().min(1),
    headSha: z.string().trim().min(1).optional(),
    conclusion: z.string().trim().min(1).optional(),
    runUrl: z.string().trim().min(1).optional(),
  }),
]);

const uuidSchema = z.uuid();

export type VerifyRouteDeps = {
  getUserClient: () => Promise<Db>;
  syncFix: (fixId: string, hint?: RunHint) => Promise<VerificationResult>;
  verifyBranch: (ref: FixBranchRef) => Promise<VerificationResult | null>;
};

export type JsonBody = { json: () => Promise<unknown> };

const notFound = () => NextResponse.json({ message: "fix not found" }, { status: 404 });

async function ownsRow(supabase: Db, table: "fixes" | "projects", id: string): Promise<boolean> {
  const { data, error } = await supabase.from(table).select("id").eq("id", id).maybeSingle();
  if (error) throw new Error(`verify: ${table} lookup failed: ${error.message}`);
  return data !== null;
}

export async function handleVerifyRequest(
  deps: VerifyRouteDeps,
  request: JsonBody,
): Promise<NextResponse> {
  const supabase = await deps.getUserClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ message: "not signed in" }, { status: 401 });
  }

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
  const byFixId = "fixId" in target;
  const ownerId = byFixId ? target.fixId : target.projectId;
  if (!uuidSchema.safeParse(ownerId).success) return notFound();

  const hint: RunHint | undefined =
    target.headSha !== undefined || target.conclusion !== undefined || target.runUrl !== undefined
      ? {
          ...(target.headSha !== undefined ? { headSha: target.headSha } : {}),
          ...(target.conclusion !== undefined ? { conclusion: target.conclusion } : {}),
          ...(target.runUrl !== undefined ? { runUrl: target.runUrl } : {}),
        }
      : undefined;

  try {
    const visible = await ownsRow(supabase, byFixId ? "fixes" : "projects", ownerId);
    if (!visible) return notFound();

    const result = byFixId
      ? hint
        ? await deps.syncFix(target.fixId, hint)
        : await deps.syncFix(target.fixId)
      : await deps.verifyBranch(target);
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
    console.error("verify: sync failed", ownerId, err instanceof Error ? err.message : err);
    return NextResponse.json({ message: "verification failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handleVerifyRequest(
    {
      getUserClient: createUserClient,
      syncFix: (fixId, hint) => syncFixVerification(fixId, undefined, hint),
      verifyBranch: (ref) => verifyFixByBranch(ref),
    },
    request,
  );
}
