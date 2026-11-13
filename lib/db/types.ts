export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      errors: {
        Row: {
          commit_sha: string
          error_message: string | null
          error_type: string | null
          file_path: string | null
          fingerprint: string
          first_seen: string
          id: string
          last_seen: string
          line: number | null
          log_excerpt: string | null
          occurrences: number
          parsed: boolean
          project_id: string
          run_url: string
          test_name: string | null
          workflow_run_id: number
        }
        Insert: {
          commit_sha: string
          error_message?: string | null
          error_type?: string | null
          file_path?: string | null
          fingerprint: string
          first_seen?: string
          id?: string
          last_seen?: string
          line?: number | null
          log_excerpt?: string | null
          occurrences?: number
          parsed?: boolean
          project_id: string
          run_url: string
          test_name?: string | null
          workflow_run_id: number
        }
        Update: {
          commit_sha?: string
          error_message?: string | null
          error_type?: string | null
          file_path?: string | null
          fingerprint?: string
          first_seen?: string
          id?: string
          last_seen?: string
          line?: number | null
          log_excerpt?: string | null
          occurrences?: number
          parsed?: boolean
          project_id?: string
          run_url?: string
          test_name?: string | null
          workflow_run_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "errors_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      fixes: {
        Row: {
          ai_reasoning: string | null
          branch_name: string | null
          confidence: number | null
          created_at: string
          error_id: string
          fix_commit_sha: string | null
          green_run_url: string | null
          id: string
          planned_changes: Json | null
          pr_number: number | null
          pr_url: string | null
          red_run_url: string | null
          status: Database["public"]["Enums"]["fix_status"]
          test_commit_sha: string | null
          tokens_used: number | null
          updated_at: string
        }
        Insert: {
          ai_reasoning?: string | null
          branch_name?: string | null
          confidence?: number | null
          created_at?: string
          error_id: string
          fix_commit_sha?: string | null
          green_run_url?: string | null
          id?: string
          planned_changes?: Json | null
          pr_number?: number | null
          pr_url?: string | null
          red_run_url?: string | null
          status?: Database["public"]["Enums"]["fix_status"]
          test_commit_sha?: string | null
          tokens_used?: number | null
          updated_at?: string
        }
        Update: {
          ai_reasoning?: string | null
          branch_name?: string | null
          confidence?: number | null
          created_at?: string
          error_id?: string
          fix_commit_sha?: string | null
          green_run_url?: string | null
          id?: string
          planned_changes?: Json | null
          pr_number?: number | null
          pr_url?: string | null
          red_run_url?: string | null
          status?: Database["public"]["Enums"]["fix_status"]
          test_commit_sha?: string | null
          tokens_used?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fixes_error_id_fkey"
            columns: ["error_id"]
            isOneToOne: false
            referencedRelation: "errors"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          db_schema_paths: string[]
          default_branch: string
          id: string
          installation_id: number
          llm_key_secret_id: string | null
          llm_provider: Database["public"]["Enums"]["llm_provider"] | null
          repo_name: string
          repo_owner: string
          user_id: string
        }
        Insert: {
          created_at?: string
          db_schema_paths?: string[]
          default_branch: string
          id?: string
          installation_id: number
          llm_key_secret_id?: string | null
          llm_provider?: Database["public"]["Enums"]["llm_provider"] | null
          repo_name: string
          repo_owner: string
          user_id: string
        }
        Update: {
          created_at?: string
          db_schema_paths?: string[]
          default_branch?: string
          id?: string
          installation_id?: number
          llm_key_secret_id?: string | null
          llm_provider?: Database["public"]["Enums"]["llm_provider"] | null
          repo_name?: string
          repo_owner?: string
          user_id?: string
        }
        Relationships: []
      }
      webhook_deliveries: {
        Row: {
          delivery_id: string
          event: string
          received_at: string
        }
        Insert: {
          delivery_id: string
          event: string
          received_at?: string
        }
        Update: {
          delivery_id?: string
          event?: string
          received_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_project_llm_key: { Args: { p_project_id: string }; Returns: string }
      set_project_llm_key: {
        Args: { p_key: string; p_project_id: string }
        Returns: string
      }
    }
    Enums: {
      fix_status:
        | "queued"
        | "analyzing"
        | "test_pushed"
        | "test_failed"
        | "fix_pushed"
        | "verified"
        | "failed"
      llm_provider: "anthropic" | "openai"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      fix_status: [
        "queued",
        "analyzing",
        "test_pushed",
        "test_failed",
        "fix_pushed",
        "verified",
        "failed",
      ],
      llm_provider: ["anthropic", "openai"],
    },
  },
} as const
