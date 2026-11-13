import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createUserClient, getServiceClient, type Db } from "../../../../../lib/db/supabase";

const bodySchema = z.object({ llmApiKey: z.string().trim().min(1) });

const projectIdSchema = z.uuid();

export type KeysRouteDeps = {
  getUserClient: () => Promise<Db>;
  getAdminClient: () => Db;
};

export type JsonBody = { json: () => Promise<unknown> };

export async function handleSetProjectKey(
  deps: KeysRouteDeps,
  request: JsonBody,
  projectId: string,
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

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: "llmApiKey is required" }, { status: 400 });
  }

  if (!projectIdSchema.safeParse(projectId).success) {
    return NextResponse.json({ message: "project not found" }, { status: 404 });
  }

  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (error) {
    console.error("keys: project lookup failed", projectId, error.message);
    return NextResponse.json({ message: "could not save the key" }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ message: "project not found" }, { status: 404 });
  }

  const { error: rpcError } = await deps.getAdminClient().rpc("set_project_llm_key", {
    p_project_id: projectId,
    p_key: parsed.data.llmApiKey,
  });
  if (rpcError) {
    console.error("keys: storing the key failed", projectId, rpcError.message);
    return NextResponse.json({ message: "could not save the key" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleSetProjectKey(
    { getUserClient: createUserClient, getAdminClient: getServiceClient },
    request,
    id,
  );
}
