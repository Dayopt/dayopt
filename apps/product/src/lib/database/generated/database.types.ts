export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      activities: {
        Row: {
          archived_at: string | null;
          category_id: string | null;
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          archived_at?: string | null;
          category_id?: string | null;
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          archived_at?: string | null;
          category_id?: string | null;
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'activities_category_owner_fkey';
            columns: ['category_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      calendar_connection_calendars: {
        Row: {
          calendar_name: string | null;
          connection_id: string;
          created_at: string;
          id: string;
          last_synced_at: string | null;
          provider_calendar_id: string;
          sync_token: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          calendar_name?: string | null;
          connection_id: string;
          created_at?: string;
          id?: string;
          last_synced_at?: string | null;
          provider_calendar_id: string;
          sync_token?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          calendar_name?: string | null;
          connection_id?: string;
          created_at?: string;
          id?: string;
          last_synced_at?: string | null;
          provider_calendar_id?: string;
          sync_token?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'calendar_connection_calendars_connection_owner_fkey';
            columns: ['connection_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'calendar_connections';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      calendar_connections: {
        Row: {
          authority_epoch: number | null;
          authority_fence_id: string | null;
          created_at: string;
          data_generation: number;
          granted_scopes: string[];
          id: string;
          last_sync_error: string | null;
          last_synced_at: string | null;
          provider: string;
          provider_account_email: string | null;
          provider_account_id: string;
          refresh_token_enc: string;
          refresh_token_rotation_operation_id: string | null;
          status: string;
          sync_sequence: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          authority_epoch?: number | null;
          authority_fence_id?: string | null;
          created_at?: string;
          data_generation?: number;
          granted_scopes: string[];
          id?: string;
          last_sync_error?: string | null;
          last_synced_at?: string | null;
          provider: string;
          provider_account_email?: string | null;
          provider_account_id: string;
          refresh_token_enc: string;
          refresh_token_rotation_operation_id?: string | null;
          status: string;
          sync_sequence?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          authority_epoch?: number | null;
          authority_fence_id?: string | null;
          created_at?: string;
          data_generation?: number;
          granted_scopes?: string[];
          id?: string;
          last_sync_error?: string | null;
          last_synced_at?: string | null;
          provider?: string;
          provider_account_email?: string | null;
          provider_account_id?: string;
          refresh_token_enc?: string;
          refresh_token_rotation_operation_id?: string | null;
          status?: string;
          sync_sequence?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      categories: {
        Row: {
          archived_at: string | null;
          color: string | null;
          created_at: string;
          icon: string | null;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          archived_at?: string | null;
          color?: string | null;
          created_at?: string;
          icon?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          archived_at?: string | null;
          color?: string | null;
          created_at?: string;
          icon?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      email_suppressions: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          reason: string;
          source_event_id: string | null;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          reason: string;
          source_event_id?: string | null;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          reason?: string;
          source_event_id?: string | null;
        };
        Relationships: [];
      };
      external_calendar_events: {
        Row: {
          calendar_name: string | null;
          connection_id: string | null;
          created_at: string;
          description: string | null;
          dismissed_at: string | null;
          end_at: string | null;
          id: string;
          last_synced_at: string;
          provider: string;
          provider_calendar_id: string;
          provider_event_id: string;
          start_at: string | null;
          status: string;
          title: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          calendar_name?: string | null;
          connection_id?: string | null;
          created_at?: string;
          description?: string | null;
          dismissed_at?: string | null;
          end_at?: string | null;
          id?: string;
          last_synced_at: string;
          provider: string;
          provider_calendar_id: string;
          provider_event_id: string;
          start_at?: string | null;
          status: string;
          title?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          calendar_name?: string | null;
          connection_id?: string | null;
          created_at?: string;
          description?: string | null;
          dismissed_at?: string | null;
          end_at?: string | null;
          id?: string;
          last_synced_at?: string;
          provider?: string;
          provider_calendar_id?: string;
          provider_event_id?: string;
          start_at?: string | null;
          status?: string;
          title?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'external_calendar_events_connection_owner_fkey';
            columns: ['connection_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'calendar_connections';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      mcp_environment_identity: {
        Row: {
          authorization_server_uri: string;
          environment: string;
          provisioned_at: string;
          resource_uri: string;
          singleton_key: boolean;
          supabase_project_ref: string | null;
        };
        Insert: {
          authorization_server_uri: string;
          environment: string;
          provisioned_at?: string;
          resource_uri: string;
          singleton_key?: boolean;
          supabase_project_ref?: string | null;
        };
        Update: {
          authorization_server_uri?: string;
          environment?: string;
          provisioned_at?: string;
          resource_uri?: string;
          singleton_key?: boolean;
          supabase_project_ref?: string | null;
        };
        Relationships: [];
      };
      mcp_mutation_control: {
        Row: {
          changed_at: string;
          enabled_client_ids: string[];
          revision: number;
          singleton_key: boolean;
          writes_enabled: boolean;
        };
        Insert: {
          changed_at?: string;
          enabled_client_ids?: string[];
          revision?: number;
          singleton_key?: boolean;
          writes_enabled?: boolean;
        };
        Update: {
          changed_at?: string;
          enabled_client_ids?: string[];
          revision?: number;
          singleton_key?: boolean;
          writes_enabled?: boolean;
        };
        Relationships: [];
      };
      mcp_mutation_receipts: {
        Row: {
          applied_at: string;
          client_id: string;
          data_generation: number;
          envelope_version: number;
          operation_id: string;
          origin_connection_id: string | null;
          purged_at: string | null;
          purged_generation: number | null;
          request_digest: string;
          resource_deleted_at: string | null;
          resource_id: string;
          resource_type: string;
          resource_version: string;
          tool_name: string;
          user_id: string;
        };
        Insert: {
          applied_at?: string;
          client_id: string;
          data_generation?: number;
          envelope_version: number;
          operation_id: string;
          origin_connection_id?: string | null;
          purged_at?: string | null;
          purged_generation?: number | null;
          request_digest: string;
          resource_deleted_at?: string | null;
          resource_id: string;
          resource_type: string;
          resource_version: string;
          tool_name: string;
          user_id: string;
        };
        Update: {
          applied_at?: string;
          client_id?: string;
          data_generation?: number;
          envelope_version?: number;
          operation_id?: string;
          origin_connection_id?: string | null;
          purged_at?: string | null;
          purged_generation?: number | null;
          request_digest?: string;
          resource_deleted_at?: string | null;
          resource_id?: string;
          resource_type?: string;
          resource_version?: string;
          tool_name?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'mcp_mutation_receipts_origin_connection_id_fkey';
            columns: ['origin_connection_id'];
            isOneToOne: false;
            referencedRelation: 'oauth_connections';
            referencedColumns: ['id'];
          },
        ];
      };
      mfa_recovery_codes: {
        Row: {
          code_hash: string;
          created_at: string;
          id: string;
          used_at: string | null;
          user_id: string;
        };
        Insert: {
          code_hash: string;
          created_at?: string;
          id?: string;
          used_at?: string | null;
          user_id: string;
        };
        Update: {
          code_hash?: string;
          created_at?: string;
          id?: string;
          used_at?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      oauth_audit_log: {
        Row: {
          called_at: string;
          client_id: string;
          id: string;
          token_id: string | null;
          tool_name: string;
          user_id: string;
        };
        Insert: {
          called_at?: string;
          client_id: string;
          id?: string;
          token_id?: string | null;
          tool_name: string;
          user_id: string;
        };
        Update: {
          called_at?: string;
          client_id?: string;
          id?: string;
          token_id?: string | null;
          tool_name?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'oauth_audit_log_token_id_fkey';
            columns: ['token_id'];
            isOneToOne: false;
            referencedRelation: 'oauth_tokens';
            referencedColumns: ['id'];
          },
        ];
      };
      oauth_authorization_codes: {
        Row: {
          client_id: string;
          code_challenge: string;
          code_challenge_method: string;
          code_hash: string;
          connection_id: string | null;
          consumed_at: string | null;
          created_at: string;
          expires_at: string;
          redirect_uri: string;
          resource_uri: string | null;
          scopes: string[];
          user_id: string;
        };
        Insert: {
          client_id: string;
          code_challenge: string;
          code_challenge_method: string;
          code_hash: string;
          connection_id?: string | null;
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          redirect_uri: string;
          resource_uri?: string | null;
          scopes: string[];
          user_id: string;
        };
        Update: {
          client_id?: string;
          code_challenge?: string;
          code_challenge_method?: string;
          code_hash?: string;
          connection_id?: string | null;
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          redirect_uri?: string;
          resource_uri?: string | null;
          scopes?: string[];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'oauth_authorization_codes_connection_binding_fkey';
            columns: ['connection_id', 'user_id', 'client_id', 'resource_uri'];
            isOneToOne: false;
            referencedRelation: 'oauth_connections';
            referencedColumns: ['id', 'user_id', 'client_id', 'resource_uri'];
          },
          {
            foreignKeyName: 'oauth_authorization_codes_environment_resource_fkey';
            columns: ['resource_uri'];
            isOneToOne: false;
            referencedRelation: 'mcp_environment_identity';
            referencedColumns: ['resource_uri'];
          },
        ];
      };
      oauth_connections: {
        Row: {
          authorized_at: string;
          client_id: string;
          consent_version: number;
          created_at: string;
          id: string;
          last_refreshed_at: string | null;
          last_used_at: string | null;
          legacy_read_only: boolean;
          reauth_required_at: string;
          resource_uri: string;
          revoked_at: string | null;
          revoked_reason: string | null;
          scopes: string[];
          updated_at: string;
          user_id: string;
          write_enabled_at: string | null;
        };
        Insert: {
          authorized_at?: string;
          client_id: string;
          consent_version?: number;
          created_at?: string;
          id?: string;
          last_refreshed_at?: string | null;
          last_used_at?: string | null;
          legacy_read_only?: boolean;
          reauth_required_at?: string;
          resource_uri: string;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          scopes: string[];
          updated_at?: string;
          user_id: string;
          write_enabled_at?: string | null;
        };
        Update: {
          authorized_at?: string;
          client_id?: string;
          consent_version?: number;
          created_at?: string;
          id?: string;
          last_refreshed_at?: string | null;
          last_used_at?: string | null;
          legacy_read_only?: boolean;
          reauth_required_at?: string;
          resource_uri?: string;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          scopes?: string[];
          updated_at?: string;
          user_id?: string;
          write_enabled_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'oauth_connections_environment_resource_fkey';
            columns: ['resource_uri'];
            isOneToOne: false;
            referencedRelation: 'mcp_environment_identity';
            referencedColumns: ['resource_uri'];
          },
        ];
      };
      oauth_tokens: {
        Row: {
          client_id: string;
          connection_id: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          last_used_at: string | null;
          parent_token_id: string | null;
          resource_uri: string | null;
          revoked_at: string | null;
          rotated_at: string | null;
          scopes: string[];
          token_hash: string;
          token_type: string;
          user_id: string;
        };
        Insert: {
          client_id: string;
          connection_id?: string | null;
          created_at?: string;
          expires_at: string;
          id?: string;
          last_used_at?: string | null;
          parent_token_id?: string | null;
          resource_uri?: string | null;
          revoked_at?: string | null;
          rotated_at?: string | null;
          scopes?: string[];
          token_hash: string;
          token_type: string;
          user_id: string;
        };
        Update: {
          client_id?: string;
          connection_id?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          last_used_at?: string | null;
          parent_token_id?: string | null;
          resource_uri?: string | null;
          revoked_at?: string | null;
          rotated_at?: string | null;
          scopes?: string[];
          token_hash?: string;
          token_type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'oauth_tokens_connection_binding_fkey';
            columns: ['connection_id', 'user_id', 'client_id', 'resource_uri'];
            isOneToOne: false;
            referencedRelation: 'oauth_connections';
            referencedColumns: ['id', 'user_id', 'client_id', 'resource_uri'];
          },
          {
            foreignKeyName: 'oauth_tokens_environment_resource_fkey';
            columns: ['resource_uri'];
            isOneToOne: false;
            referencedRelation: 'mcp_environment_identity';
            referencedColumns: ['resource_uri'];
          },
          {
            foreignKeyName: 'oauth_tokens_parent_token_id_fkey';
            columns: ['parent_token_id'];
            isOneToOne: false;
            referencedRelation: 'oauth_tokens';
            referencedColumns: ['id'];
          },
        ];
      };
      plan_template_blocks: {
        Row: {
          activity_id: string | null;
          anchor_minute: number;
          created_at: string;
          id: string;
          template_id: string;
          title: string;
          user_id: string;
        };
        Insert: {
          activity_id?: string | null;
          anchor_minute: number;
          created_at?: string;
          id?: string;
          template_id: string;
          title: string;
          user_id: string;
        };
        Update: {
          activity_id?: string | null;
          anchor_minute?: number;
          created_at?: string;
          id?: string;
          template_id?: string;
          title?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'plan_template_blocks_activity_owner_fkey';
            columns: ['activity_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'plan_template_blocks_template_owner_fkey';
            columns: ['template_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'plan_templates';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      plan_templates: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      plans: {
        Row: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          activity_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          end_at: string;
          external_calendar_event_id?: string | null;
          id?: string;
          note?: string | null;
          source?: string;
          start_at: string;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          activity_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          end_at?: string;
          external_calendar_event_id?: string | null;
          id?: string;
          note?: string | null;
          source?: string;
          start_at?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'plans_activity_owner_fkey';
            columns: ['activity_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'plans_external_calendar_event_id_fkey';
            columns: ['external_calendar_event_id'];
            isOneToOne: false;
            referencedRelation: 'external_calendar_events';
            referencedColumns: ['id'];
          },
        ];
      };
      product_events: {
        Row: {
          created_at: string;
          event_name: string;
          id: string;
          properties: Json;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          event_name: string;
          id?: string;
          properties?: Json;
          user_id: string;
        };
        Update: {
          created_at?: string;
          event_name?: string;
          id?: string;
          properties?: Json;
          user_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          app_trial_consumed_at: string | null;
          app_trial_ends_at: string | null;
          app_trial_started_at: string | null;
          avatar_url: string | null;
          created_at: string;
          email: string;
          full_name: string | null;
          id: string;
          stripe_customer_id: string | null;
          subscription_id: string | null;
          subscription_status: string;
          updated_at: string;
        };
        Insert: {
          app_trial_consumed_at?: string | null;
          app_trial_ends_at?: string | null;
          app_trial_started_at?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          email: string;
          full_name?: string | null;
          id: string;
          stripe_customer_id?: string | null;
          subscription_id?: string | null;
          subscription_status?: string;
          updated_at?: string;
        };
        Update: {
          app_trial_consumed_at?: string | null;
          app_trial_ends_at?: string | null;
          app_trial_started_at?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          email?: string;
          full_name?: string | null;
          id?: string;
          stripe_customer_id?: string | null;
          subscription_id?: string | null;
          subscription_status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      records: {
        Row: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          activity_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          end_at: string;
          external_calendar_event_id?: string | null;
          fulfillment?: string | null;
          id?: string;
          note?: string | null;
          source?: string;
          start_at: string;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          activity_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          end_at?: string;
          external_calendar_event_id?: string | null;
          fulfillment?: string | null;
          id?: string;
          note?: string | null;
          source?: string;
          start_at?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'records_activity_owner_fkey';
            columns: ['activity_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'records_external_calendar_event_id_fkey';
            columns: ['external_calendar_event_id'];
            isOneToOne: false;
            referencedRelation: 'external_calendar_events';
            referencedColumns: ['id'];
          },
        ];
      };
      reports: {
        Row: {
          content: Json;
          created_at: string;
          id: string;
          period_end: string;
          period_start: string;
          period_type: string;
          summary: string;
          user_id: string;
        };
        Insert: {
          content: Json;
          created_at?: string;
          id?: string;
          period_end: string;
          period_start: string;
          period_type: string;
          summary: string;
          user_id: string;
        };
        Update: {
          content?: Json;
          created_at?: string;
          id?: string;
          period_end?: string;
          period_start?: string;
          period_type?: string;
          summary?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      segment_activities: {
        Row: {
          activity_id: string;
          segment_id: string;
          user_id: string;
        };
        Insert: {
          activity_id: string;
          segment_id: string;
          user_id: string;
        };
        Update: {
          activity_id?: string;
          segment_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'segment_activities_activity_owner_fkey';
            columns: ['activity_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'segment_activities_segment_owner_fkey';
            columns: ['segment_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'segments';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      segments: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      stripe_webhook_events: {
        Row: {
          claimed_at: string;
          event_id: string;
          event_type: string;
          id: string;
          processed_at: string | null;
          status: string;
        };
        Insert: {
          claimed_at?: string;
          event_id: string;
          event_type: string;
          id?: string;
          processed_at?: string | null;
          status?: string;
        };
        Update: {
          claimed_at?: string;
          event_id?: string;
          event_type?: string;
          id?: string;
          processed_at?: string | null;
          status?: string;
        };
        Relationships: [];
      };
      undo_receipt_effects: {
        Row: {
          effect_kind: string;
          id: string;
          plan_id: string | null;
          receipt_id: string;
          record_id: string | null;
          resource_type: string | null;
          user_id: string;
        };
        Insert: {
          effect_kind: string;
          id?: string;
          plan_id?: string | null;
          receipt_id: string;
          record_id?: string | null;
          resource_type?: string | null;
          user_id: string;
        };
        Update: {
          effect_kind?: string;
          id?: string;
          plan_id?: string | null;
          receipt_id?: string;
          record_id?: string | null;
          resource_type?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'undo_receipt_effects_plan_owner_fkey';
            columns: ['plan_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'plans';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'undo_receipt_effects_receipt_owner_fkey';
            columns: ['receipt_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'undo_receipts';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'undo_receipt_effects_record_owner_fkey';
            columns: ['record_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'records';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      undo_receipt_field_changes: {
        Row: {
          after_value: Json;
          before_value: Json;
          effect_id: string;
          field_name: string;
          user_id: string;
        };
        Insert: {
          after_value: Json;
          before_value: Json;
          effect_id: string;
          field_name: string;
          user_id: string;
        };
        Update: {
          after_value?: Json;
          before_value?: Json;
          effect_id?: string;
          field_name?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'undo_receipt_field_changes_effect_owner_fkey';
            columns: ['effect_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'undo_receipt_effects';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      undo_receipts: {
        Row: {
          command_name: string;
          created_at: string;
          had_origin_connection: boolean;
          id: string;
          operation_id: string;
          origin_connection_id: string | null;
          origin_scopes_snapshot: string[] | null;
          recorded_effect_count: number;
          undo_expires_at: string;
          undone_at: string | null;
          undone_operation_id: string | null;
          user_id: string;
        };
        Insert: {
          command_name: string;
          created_at?: string;
          had_origin_connection?: boolean;
          id?: string;
          operation_id: string;
          origin_connection_id?: string | null;
          origin_scopes_snapshot?: string[] | null;
          recorded_effect_count?: number;
          undo_expires_at: string;
          undone_at?: string | null;
          undone_operation_id?: string | null;
          user_id: string;
        };
        Update: {
          command_name?: string;
          created_at?: string;
          had_origin_connection?: boolean;
          id?: string;
          operation_id?: string;
          origin_connection_id?: string | null;
          origin_scopes_snapshot?: string[] | null;
          recorded_effect_count?: number;
          undo_expires_at?: string;
          undone_at?: string | null;
          undone_operation_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'undo_receipts_origin_connection_owner_fkey';
            columns: ['origin_connection_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'oauth_connections';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      user_settings: {
        Row: {
          created_at: string;
          default_duration: number;
          default_view: string;
          hour_height_density: string;
          ical_feed_token: string | null;
          id: string;
          personalization: Json | null;
          preferred_locale: string;
          show_week_numbers: boolean;
          show_weekends: boolean;
          theme: string;
          time_format: string;
          timezone: string;
          updated_at: string;
          user_id: string;
          week_starts_on: number;
        };
        Insert: {
          created_at?: string;
          default_duration?: number;
          default_view?: string;
          hour_height_density?: string;
          ical_feed_token?: string | null;
          id?: string;
          personalization?: Json | null;
          preferred_locale?: string;
          show_week_numbers?: boolean;
          show_weekends?: boolean;
          theme?: string;
          time_format?: string;
          timezone?: string;
          updated_at?: string;
          user_id: string;
          week_starts_on?: number;
        };
        Update: {
          created_at?: string;
          default_duration?: number;
          default_view?: string;
          hour_height_density?: string;
          ical_feed_token?: string | null;
          id?: string;
          personalization?: Json | null;
          preferred_locale?: string;
          show_week_numbers?: boolean;
          show_weekends?: boolean;
          theme?: string;
          time_format?: string;
          timezone?: string;
          updated_at?: string;
          user_id?: string;
          week_starts_on?: number;
        };
        Relationships: [];
      };
      write_fence_control: {
        Row: {
          fence_enabled: boolean;
          singleton_key: boolean;
          updated_at: string;
        };
        Insert: {
          fence_enabled?: boolean;
          singleton_key?: boolean;
          updated_at?: string;
        };
        Update: {
          fence_enabled?: boolean;
          singleton_key?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      abandon_billing_customer_provisioning_v1: {
        Args: { p_operation_id: string; p_user_id: string };
        Returns: boolean;
      };
      abandon_billing_customer_provisioning_v2: {
        Args: { p_operation_id: string; p_user_id: string };
        Returns: boolean;
      };
      abandon_calendar_account_delete_revoke_v1: {
        Args: {
          p_deletion_id: string;
          p_lease_id: string;
          p_operation_id: string;
          p_project_key: string;
          p_reason: string;
          p_user_id: string;
        };
        Returns: string;
      };
      apply_mcp_plan_create_v1: {
        Args: {
          p_access_token_id: string;
          p_activity_id?: string;
          p_connection_id: string;
          p_end_at: string;
          p_note: string;
          p_operation_id: string;
          p_start_at: string;
          p_title: string;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_plan_delete_v1: {
        Args: {
          p_access_token_id: string;
          p_connection_id: string;
          p_expected_updated_at: string;
          p_operation_id: string;
          p_plan_id: string;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_plan_restore_v1: {
        Args: {
          p_access_token_id: string;
          p_connection_id: string;
          p_expected_updated_at: string;
          p_operation_id: string;
          p_plan_id: string;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_plan_update_v1: {
        Args: {
          p_access_token_id: string;
          p_activity_id?: string;
          p_activity_id_present?: boolean;
          p_connection_id: string;
          p_end_at: string;
          p_end_at_present: boolean;
          p_expected_updated_at: string;
          p_note: string;
          p_note_present: boolean;
          p_operation_id: string;
          p_plan_id: string;
          p_start_at: string;
          p_start_at_present: boolean;
          p_title: string;
          p_title_present: boolean;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_record_create_v1: {
        Args: {
          p_access_token_id: string;
          p_activity_id?: string;
          p_connection_id: string;
          p_end_at: string;
          p_fulfillment?: string;
          p_note: string;
          p_operation_id: string;
          p_plan_id: string;
          p_start_at: string;
          p_title: string;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_record_delete_v1: {
        Args: {
          p_access_token_id: string;
          p_connection_id: string;
          p_expected_updated_at: string;
          p_operation_id: string;
          p_record_id: string;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_record_restore_v1: {
        Args: {
          p_access_token_id: string;
          p_connection_id: string;
          p_expected_updated_at: string;
          p_operation_id: string;
          p_record_id: string;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_mcp_record_update_v1: {
        Args: {
          p_access_token_id: string;
          p_activity_id?: string;
          p_activity_id_present?: boolean;
          p_connection_id: string;
          p_end_at: string;
          p_end_at_present: boolean;
          p_expected_updated_at: string;
          p_fulfillment?: string;
          p_fulfillment_present?: boolean;
          p_note: string;
          p_note_present: boolean;
          p_operation_id: string;
          p_record_id: string;
          p_start_at: string;
          p_start_at_present: boolean;
          p_title: string;
          p_title_present: boolean;
        };
        Returns: {
          deleted_at: string;
          operation_id: string;
          replayed: boolean;
          resource_id: string;
          resource_type: string;
          schema_version: number;
          version: string;
        }[];
      };
      apply_undo_receipt_v1: {
        Args: {
          p_apply_operation_id: string;
          p_receipt_id: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      assert_active_timeblock_activity_v1: {
        Args: { p_activity_id: string; p_user_id: string };
        Returns: undefined;
      };
      assert_timeblock_content_v1: {
        Args: { p_note: string; p_title: string };
        Returns: undefined;
      };
      assert_timeblock_external_event_v1: {
        Args: { p_external_calendar_event_id: string; p_user_id: string };
        Returns: undefined;
      };
      authorize_owned_storage_read_v1: { Args: never; Returns: boolean };
      authorize_owned_storage_write_v1: { Args: never; Returns: boolean };
      begin_account_deletion_v1: {
        Args: { p_user_id: string };
        Returns: {
          billing_state: string;
          calendar_state: string;
          deletion_id: string;
          storage_state: string;
        }[];
      };
      begin_calendar_account_deletion_v1: {
        Args: {
          p_deletion_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: {
          deletion_id: string;
          item_id: string;
          item_kind: string;
        }[];
      };
      begin_calendar_oauth_attempt_v1: {
        Args: {
          p_project_key: string;
          p_state_digest: string;
          p_user_id: string;
          p_verifier_digest: string;
        };
        Returns: {
          attempt_id: string;
          connection_id: string;
          expires_at: string;
          operation_id: string;
        }[];
      };
      begin_calendar_sync_run_v1: {
        Args: {
          p_connection_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: {
          authority_epoch: number;
          authority_fence_id: string;
          data_generation: number;
          refresh_token_enc: string;
          result: string;
          run_started_at: string;
          sync_sequence: number;
        }[];
      };
      bind_billing_account_deletion_v1: {
        Args: { p_generic_deletion_id: string; p_user_id: string };
        Returns: {
          binding_state: string;
          stripe_customer_id: string;
        }[];
      };
      bind_calendar_account_deletion_v1: {
        Args: { p_generic_deletion_id: string; p_user_id: string };
        Returns: {
          calendar_deletion_id: string;
          calendar_required: boolean;
        }[];
      };
      cancel_calendar_account_deletion_v1: {
        Args: { p_deletion_id: string; p_user_id: string };
        Returns: boolean;
      };
      claim_account_deletion_step_v1: {
        Args: { p_deletion_id: string; p_step: string; p_user_id: string };
        Returns: {
          lease_expires_at: string;
          lease_id: string;
          result: string;
        }[];
      };
      claim_billing_customer_provisioning_v1: {
        Args: {
          p_email_digest: string;
          p_operation_id: string;
          p_user_id: string;
        };
        Returns: {
          lease_expires_at: string;
          lease_id: string;
          provider_customer_id: string;
          provider_retry_deadline_at: string;
          result: string;
        }[];
      };
      claim_billing_customer_provisioning_v2: {
        Args: {
          p_email_digest: string;
          p_operation_id: string;
          p_user_id: string;
        };
        Returns: {
          lease_expires_at: string;
          lease_id: string;
          provider_customer_id: string;
          provider_retry_deadline_at: string;
          result: string;
        }[];
      };
      claim_billing_mutation_v2: {
        Args: {
          p_mutation_kind: string;
          p_operation_id: string;
          p_request_digest: string;
          p_user_id: string;
        };
        Returns: {
          canonical_operation_id: string;
          lease_expires_at: string;
          lease_id: string;
          provider_object_id: string;
          result: string;
        }[];
      };
      claim_billing_mutation_v3: {
        Args: {
          p_mutation_kind: string;
          p_operation_id: string;
          p_request_digest: string;
          p_user_id: string;
        };
        Returns: {
          canonical_operation_id: string;
          lease_expires_at: string;
          lease_id: string;
          provider_object_id: string;
          provider_response_expires_at: string;
          provider_response_url: string;
          provider_retry_deadline_at: string;
          result: string;
        }[];
      };
      claim_calendar_oauth_attempt_v1: {
        Args: {
          p_project_key: string;
          p_state_digest: string;
          p_user_id: string;
          p_verifier_digest: string;
        };
        Returns: {
          attempt_id: string;
          claim_expires_at: string;
          connection_id: string;
          data_generation: number;
          operation_id: string;
          project_epoch: number;
        }[];
      };
      claim_calendar_revoke_direct_attempt_v1: {
        Args: {
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: {
          attempt_deadline_at: string;
          lease_expires_at: string;
          lease_id: string;
        }[];
      };
      claim_calendar_revoke_outbox_v1: {
        Args: { p_limit?: number };
        Returns: {
          attempt_count: number;
          expires_at: string;
          lease_id: string;
          outbox_id: string;
          provider: string;
          refresh_token_enc: string;
        }[];
      };
      claim_calendar_revoke_outbox_v2: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: {
          attempt_count: number;
          attempt_deadline_at: string;
          expires_at: string;
          lease_expires_at: string;
          lease_id: string;
          outbox_id: string;
          provider: string;
          refresh_token_enc: string;
        }[];
      };
      claim_stripe_webhook_event: {
        Args: {
          p_event_id: string;
          p_event_type: string;
          p_stale_before: string;
        };
        Returns: string;
      };
      classify_billing_customer_event_v1: {
        Args: { p_stripe_customer_id: string };
        Returns: string;
      };
      cleanup_billing_account_deletion_terminal_receipts_v2: {
        Args: { p_limit?: number };
        Returns: {
          deleted_count: number;
          has_more: boolean;
        }[];
      };
      cleanup_billing_mutation_claims_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      cleanup_billing_mutation_claims_v2: {
        Args: { p_limit?: number };
        Returns: {
          claims_deleted: number;
          has_more: boolean;
          provider_responses_redacted: number;
        }[];
      };
      cleanup_calendar_authority_retention_v1: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: {
          command_receipts_deleted: number;
          oauth_attempts_deleted: number;
          subject_fences_deleted: number;
        }[];
      };
      cleanup_calendar_revoke_operations_v1: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: number;
      };
      cleanup_integration_security_events_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      cleanup_mcp_mutation_receipts_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      cleanup_oauth_access_tokens_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      cleanup_oauth_authorization_codes_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      cleanup_oauth_connections_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      cleanup_oauth_refresh_tokens_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      clear_calendar_sync_cursor_command_v1: {
        Args: {
          p_calendar_selection_id: string;
          p_connection_id: string;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_expected_sync_sequence: number;
          p_expected_sync_token: string;
          p_project_key: string;
          p_provider_calendar_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      complete_account_deletion_step_v1: {
        Args: {
          p_deletion_id: string;
          p_lease_id: string;
          p_step: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      complete_billing_customer_provisioning_v1: {
        Args: {
          p_operation_id: string;
          p_provider_customer_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      complete_billing_customer_provisioning_v2: {
        Args: {
          p_operation_id: string;
          p_provider_customer_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      complete_calendar_revoke_outbox_v1: {
        Args: { p_lease_id: string; p_outbox_id: string };
        Returns: boolean;
      };
      confirm_day_plans_command_v1: {
        Args: {
          p_confirmed_at?: string;
          p_end_at: string;
          p_start_at: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      confirm_day_plans_to_records: {
        Args: {
          p_confirmed_at?: string;
          p_end_at: string;
          p_start_at: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      count_unused_recovery_codes: {
        Args: { p_user_id: string };
        Returns: number;
      };
      create_oauth_authorization_grant_v2: {
        Args: {
          p_client_id: string;
          p_code_challenge: string;
          p_code_hash: string;
          p_redirect_uri: string;
          p_resource_uri: string;
          p_scopes: string[];
          p_user_id: string;
          p_write_enabled?: boolean;
        };
        Returns: string;
      };
      create_plan_command_v1: {
        Args: {
          p_activity_id?: string;
          p_end_at: string;
          p_external_calendar_event_id: string;
          p_note: string;
          p_source: string;
          p_start_at: string;
          p_title: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      create_plans_bulk_command_v1: {
        Args: { p_plans: Json; p_user_id: string };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      create_record_command_v1: {
        Args: {
          p_activity_id?: string;
          p_end_at: string;
          p_external_calendar_event_id: string;
          p_fulfillment?: string;
          p_note: string;
          p_plan_id: string;
          p_source: string;
          p_start_at: string;
          p_title: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      custom_access_token_hook: { Args: { event: Json }; Returns: Json };
      delete_all_user_data_command_v3: {
        Args: { p_user_id: string };
        Returns: boolean;
      };
      delete_all_user_data_command_v4: {
        Args: { p_project_key: string; p_user_id: string };
        Returns: boolean;
      };
      delete_all_user_data_command_v5: {
        Args: {
          p_expected_generation: number;
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      delete_plan_command_v1: {
        Args: {
          p_expected_updated_at: string;
          p_plan_id: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      delete_record_command_v1: {
        Args: {
          p_expected_updated_at: string;
          p_record_id: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      disconnect_calendar_connection_command_v1: {
        Args: {
          p_connection_id: string;
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      exchange_oauth_authorization_code_v2: {
        Args: {
          p_access_hash: string;
          p_client_id: string;
          p_code_challenge: string;
          p_code_hash: string;
          p_redirect_uri: string;
          p_refresh_hash: string;
          p_resource_uri: string;
        };
        Returns: {
          access_expires_at: string;
          access_id: string;
          client_id: string;
          connection_id: string;
          refresh_id: string;
          resource_uri: string;
          scopes: string[];
          user_id: string;
        }[];
      };
      expire_calendar_revoke_authority_v2: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: {
          ciphertexts_deleted: number;
          guards_finalized: number;
        }[];
      };
      expire_calendar_revoke_authority_v3: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: {
          ciphertexts_deferred: number;
          ciphertexts_deleted: number;
        }[];
      };
      expire_calendar_revoke_outbox_v1: {
        Args: { p_limit?: number };
        Returns: number;
      };
      finalize_calendar_account_delete_revoke_v1: {
        Args: {
          p_deletion_id: string;
          p_lease_id: string;
          p_operation_id: string;
          p_outcome: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      finalize_calendar_revoke_attempt_v2: {
        Args: {
          p_lease_id: string;
          p_outbox_id: string;
          p_outcome: string;
          p_project_key: string;
        };
        Returns: string;
      };
      finalize_calendar_revoke_guards_v1: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: number;
      };
      finish_calendar_sync_run_v1: {
        Args: {
          p_connection_id: string;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_expected_sync_sequence: number;
          p_last_sync_error: string;
          p_not_after: string;
          p_not_before: string;
          p_project_key: string;
          p_prune_window: boolean;
          p_run_started_at: string;
          p_user_id: string;
        };
        Returns: string;
      };
      get_account_deletion_customer_recovery_v1: {
        Args: { p_user_id: string };
        Returns: {
          operation_id: string;
          provider_retry_deadline_at: string;
          result: string;
        }[];
      };
      get_account_deletion_readiness_v1: {
        Args: never;
        Returns: {
          activated: boolean;
          active_operations: number;
        }[];
      };
      get_calendar_authority_readiness_v1: {
        Args: { p_oauth_client_id: string; p_project_key: string };
        Returns: {
          activated: boolean;
          oauth_client_id: string;
          pending_operations: number;
          project_epoch: number;
          project_state: string;
          unbound_connections: number;
          unbound_outbox: number;
        }[];
      };
      get_external_authority_maintenance_status_v1: {
        Args: never;
        Returns: {
          access_tokens_due: boolean;
          authorization_codes_due: boolean;
          calendar_finalize_stuck_count: number;
          calendar_revoke_due: number;
          calendar_revoke_total: number;
          connections_due: boolean;
          oldest_due_age_seconds: number;
          receipts_due: boolean;
          refresh_tokens_due: boolean;
          security_events_due: boolean;
        }[];
      };
      get_external_lifecycle_app_version_v1: { Args: never; Returns: number };
      get_external_lifecycle_app_version_v2: { Args: never; Returns: number };
      get_external_lifecycle_app_version_v3: { Args: never; Returns: number };
      get_mcp_environment_identity_v1: {
        Args: never;
        Returns: {
          authorization_server_uri: string;
          environment: string;
          provisioned_at: string;
          resource_uri: string;
          supabase_project_ref: string;
        }[];
      };
      get_timeblock_context_marker_v1: {
        Args: { p_user_id: string };
        Returns: {
          database_now: string;
          revision: string;
          timezone: string;
        }[];
      };
      get_user_data_generation_v1: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_user_timezone: { Args: { p_user_id: string }; Returns: string };
      get_vault_secret: { Args: { p_name: string }; Returns: string };
      invoke_edge_function: {
        Args: { p_body?: Json; p_function_name: string };
        Returns: number;
      };
      issue_oauth_token_pair: {
        Args: {
          p_access_expires_at: string;
          p_access_hash: string;
          p_client_id: string;
          p_parent_refresh_id?: string;
          p_refresh_expires_at: string;
          p_refresh_hash: string;
          p_scopes: string[];
          p_user_id: string;
        };
        Returns: {
          access_id: string;
          refresh_id: string;
        }[];
      };
      list_expired_calendar_account_deletion_intents_v1: {
        Args: { p_limit?: number; p_project_key: string };
        Returns: {
          deletion_id: string;
          user_id: string;
        }[];
      };
      list_undoable_receipts_v1: {
        Args: { p_user_id: string };
        Returns: {
          command_name: string;
          created_at: string;
          id: string;
          operation_id: string;
          undo_expires_at: string;
        }[];
      };
      lock_recordable_plan_v1: {
        Args: { p_plan_id: string; p_user_id: string };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      mark_calendar_connection_reauth_command_v2: {
        Args: {
          p_connection_id: string;
          p_expected_generation: number;
          p_expected_refresh_token_enc: string;
          p_last_synced_at?: string;
          p_new_refresh_token_enc?: string;
          p_operation_id?: string;
          p_user_id: string;
        };
        Returns: string;
      };
      mark_calendar_connection_reauth_command_v3: {
        Args: {
          p_connection_id: string;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_expected_refresh_token_enc: string;
          p_last_synced_at?: string;
          p_new_refresh_token_enc?: string;
          p_operation_id?: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      normalize_calendar_account_deletion_intent_v1: {
        Args: {
          p_deletion_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      persist_calendar_sync_result_command_v1: {
        Args: {
          p_calendar_selection_id: string;
          p_connection_id: string;
          p_events: Json;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_expected_sync_sequence: number;
          p_next_cursor: string;
          p_project_key: string;
          p_provider_calendar_id: string;
          p_run_started_at: string;
          p_tombstone_event_ids: string[];
          p_used_full_sync: boolean;
          p_user_id: string;
        };
        Returns: string;
      };
      prepare_calendar_account_delete_revoke_v1: {
        Args: {
          p_deletion_id: string;
          p_item_id: string;
          p_item_kind: string;
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: {
          attempt_deadline_at: string;
          lease_expires_at: string;
          lease_id: string;
          operation_id: string;
          refresh_token_enc: string;
          result: string;
        }[];
      };
      prepare_calendar_token_rotation_recovery_command_v1: {
        Args: {
          p_connection_id: string;
          p_expected_generation: number;
          p_expected_refresh_token_enc: string;
          p_last_synced_at?: string;
          p_new_refresh_token_enc?: string;
          p_operation_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      prepare_calendar_token_rotation_recovery_command_v2: {
        Args: {
          p_connection_id: string;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_expected_refresh_token_enc: string;
          p_last_synced_at?: string;
          p_new_refresh_token_enc?: string;
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      prepare_user_data_purge_v1: {
        Args: { p_user_id: string };
        Returns: {
          expected_generation: number;
          operation_id: string;
        }[];
      };
      provision_calendar_authority_project_v1: {
        Args: { p_oauth_client_id: string; p_project_key: string };
        Returns: string;
      };
      provision_mcp_preview_environment_identity_v1: {
        Args: {
          p_authorization_server_uri: string;
          p_resource_uri: string;
          p_supabase_project_ref: string;
        };
        Returns: {
          authorization_server_uri: string;
          environment: string;
          provisioned_at: string;
          resource_uri: string;
          supabase_project_ref: string;
        }[];
      };
      reconcile_billing_mutation_v2: {
        Args: {
          p_operation_id: string;
          p_outcome: string;
          p_provider_customer_id: string;
          p_provider_object_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      reconcile_billing_mutation_v3: {
        Args: {
          p_operation_id: string;
          p_outcome: string;
          p_provider_customer_id: string;
          p_provider_object_id: string;
          p_provider_response_url: string;
          p_user_id: string;
        };
        Returns: string;
      };
      reconcile_billing_mutation_v4: {
        Args: {
          p_operation_id: string;
          p_outcome: string;
          p_provider_customer_id: string;
          p_provider_object_id: string;
          p_provider_response_url: string;
          p_user_id: string;
        };
        Returns: string;
      };
      record_plan_command_v1: {
        Args: {
          p_expected_updated_at: string;
          p_plan_id: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      record_undo_receipt_v1: {
        Args: {
          p_command_name: string;
          p_effects: Json;
          p_is_mcp_command: boolean;
          p_operation_id: string;
          p_origin_connection_id: string;
          p_undo_ttl_seconds: number;
          p_user_id: string;
        };
        Returns: string;
      };
      replace_selected_calendars_command_v1: {
        Args: {
          p_connection_id: string;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_project_key: string;
          p_selected_calendars: Json;
          p_user_id: string;
        };
        Returns: string;
      };
      restore_plan: {
        Args: { p_plan_id: string; p_user_id: string };
        Returns: undefined;
      };
      restore_plan_command_v1: {
        Args: {
          p_expected_updated_at: string;
          p_plan_id: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      restore_record: {
        Args: { p_record_id: string; p_user_id: string };
        Returns: undefined;
      };
      restore_record_command_v1: {
        Args: {
          p_expected_updated_at: string;
          p_record_id: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      retry_calendar_revoke_outbox_v1: {
        Args: { p_lease_id: string; p_outbox_id: string };
        Returns: string;
      };
      revoke_oauth_connection: {
        Args: { p_connection_id: string };
        Returns: boolean;
      };
      rotate_oauth_refresh_token_v2: {
        Args: {
          p_client_id: string;
          p_new_access_hash: string;
          p_new_refresh_hash: string;
          p_refresh_hash: string;
          p_resource_uri: string;
        };
        Returns: {
          access_expires_at: string;
          access_id: string;
          client_id: string;
          connection_id: string;
          refresh_id: string;
          resource_uri: string;
          scopes: string[];
          status: string;
          user_id: string;
        }[];
      };
      rotate_or_enqueue_calendar_refresh_token_command_v2: {
        Args: {
          p_connection_id: string;
          p_expected_generation: number;
          p_expected_refresh_token_enc: string;
          p_new_refresh_token_enc: string;
          p_operation_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      rotate_or_enqueue_calendar_refresh_token_command_v3: {
        Args: {
          p_connection_id: string;
          p_expected_authority_epoch: number;
          p_expected_authority_fence_id: string;
          p_expected_generation: number;
          p_expected_refresh_token_enc: string;
          p_new_refresh_token_enc: string;
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      save_calendar_connection_command_v1: {
        Args: {
          p_expected_generation: number;
          p_granted_scopes: string[];
          p_provider: string;
          p_provider_account_email: string;
          p_provider_account_id: string;
          p_refresh_token_enc: string;
          p_user_id: string;
        };
        Returns: string;
      };
      save_calendar_connection_command_v2: {
        Args: {
          p_attempt_id: string;
          p_granted_scopes: string[];
          p_project_key: string;
          p_provider: string;
          p_provider_account_email: string;
          p_provider_account_id: string;
          p_refresh_token_enc: string;
          p_user_id: string;
        };
        Returns: string;
      };
      seal_account_deletion_v1: {
        Args: { p_deletion_id: string; p_user_id: string };
        Returns: boolean;
      };
      seal_billing_account_deletion_v1: {
        Args: {
          p_generic_deletion_id: string;
          p_provider_outcome: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      seal_calendar_account_deletion_v1: {
        Args: {
          p_deletion_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      set_mcp_client_write_control_v1: {
        Args: {
          p_client_id: string;
          p_enabled: boolean;
          p_expected_revision: number;
        };
        Returns: {
          changed_at: string;
          enabled_client_ids: string[];
          revision: number;
        }[];
      };
      set_mcp_mutation_control_v1: {
        Args: { p_expected_revision: number; p_writes_enabled: boolean };
        Returns: {
          changed_at: string;
          revision: number;
          writes_enabled: boolean;
        }[];
      };
      set_plan_skipped_command_v1: {
        Args: {
          p_expected_updated_at: string;
          p_plan_id: string;
          p_skipped: boolean;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      soft_delete_plan: {
        Args: { p_plan_id: string; p_user_id: string };
        Returns: undefined;
      };
      soft_delete_record: {
        Args: { p_record_id: string; p_user_id: string };
        Returns: undefined;
      };
      start_billing_customer_provisioning_v1: {
        Args: { p_lease_id: string; p_operation_id: string; p_user_id: string };
        Returns: string;
      };
      start_billing_customer_provisioning_v2: {
        Args: { p_lease_id: string; p_operation_id: string; p_user_id: string };
        Returns: string;
      };
      start_billing_mutation_v2: {
        Args: {
          p_lease_id: string;
          p_operation_id: string;
          p_provider_customer_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      start_calendar_account_delete_provider_attempt_v1: {
        Args: {
          p_deletion_id: string;
          p_lease_id: string;
          p_operation_id: string;
          p_project_key: string;
          p_user_id: string;
        };
        Returns: string;
      };
      sync_billing_subscription_deleted_v1: {
        Args: { p_stripe_customer_id: string; p_subscription_id: string };
        Returns: string;
      };
      trunc_week_tz: {
        Args: { ts: string; tz: string; week_start?: number };
        Returns: string;
      };
      update_personalization: {
        Args: { p_path: string; p_user_id: string; p_value: Json };
        Returns: undefined;
      };
      update_plan_command_v1: {
        Args: {
          p_activity_id?: string;
          p_activity_id_present?: boolean;
          p_end_at: string;
          p_expected_updated_at: string;
          p_external_calendar_event_id: string;
          p_note: string;
          p_plan_id: string;
          p_start_at: string;
          p_title: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'plans';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      update_record_command_v1: {
        Args: {
          p_activity_id?: string;
          p_activity_id_present?: boolean;
          p_end_at: string;
          p_expected_updated_at: string;
          p_external_calendar_event_id: string;
          p_fulfillment?: string;
          p_fulfillment_present?: boolean;
          p_note: string;
          p_plan_id: string;
          p_record_id: string;
          p_start_at: string;
          p_title: string;
          p_user_id: string;
        };
        Returns: {
          activity_id: string | null;
          created_at: string;
          deleted_at: string | null;
          end_at: string;
          external_calendar_event_id: string | null;
          fulfillment: string | null;
          id: string;
          note: string | null;
          source: string;
          start_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'records';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      use_recovery_code: {
        Args: { p_code_hash: string; p_user_id: string };
        Returns: boolean;
      };
      vault_secret_exists: { Args: { p_name: string }; Returns: boolean };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
