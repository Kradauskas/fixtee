import { z } from "zod";

export const AgentOutput = z.object({
  /** Short one-line PR title (no code). Optional; github.ts falls back to a trimmed explanation. */
  title: z.string().optional(),
  explanation: z.string(),
  root_cause: z.string(),
  test: z.object({
    file_path: z.string(),
    content: z.string(),
  }),
  changes: z.array(
    z.object({
      file_path: z.string(),
      search: z.string(),
      replace: z.string(),
    }),
  ),
  confidence: z.enum(["low", "medium", "high"]),
});

export type AgentOutput = z.infer<typeof AgentOutput>;

export type ErrorInput = {
  error_id: string;
  error_message: string;
  log_excerpt: string;
  file_path: string;
  line: number;
  commit_sha: string;
};
