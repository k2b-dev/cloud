// Frozen catalog DDL from cloud-v0.70.0, packages/cloud/src/ai/migrate.ts.
// Only the schema name changes; compare columns and CHECK constraints on the same server.
export const catalogV070Schema = `
CREATE SCHEMA catalog_v070;
CREATE TABLE IF NOT EXISTS catalog_v070.providers (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, base_url TEXT, data_boundary TEXT NOT NULL CHECK(data_boundary IN ('hosted','private','restricted')),
      enabled BOOLEAN NOT NULL DEFAULT true, logo TEXT, status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','ok','unreachable','key_rejected','error')),
      status_code TEXT, status_message TEXT, status_checked_at TIMESTAMPTZ,
      revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
    );
CREATE TABLE IF NOT EXISTS catalog_v070.models (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES catalog_v070.providers(id) ON DELETE CASCADE, provider_model TEXT NOT NULL,
      label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('chat','transcription','live-transcription','decision')),
      capabilities JSONB NOT NULL DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, temperature DOUBLE PRECISION, extra_body JSONB,
      max_loaded_tools INTEGER, max_tool_rounds INTEGER, pricing JSONB, icon JSONB NOT NULL DEFAULT '{"kind":"provider"}', enabled BOOLEAN NOT NULL DEFAULT true,
      revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
    );
CREATE TABLE IF NOT EXISTS catalog_v070.model_variants (
      id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES catalog_v070.models(id) ON DELETE CASCADE, slug TEXT NOT NULL, label TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '', reasoning_effort TEXT, max_output_tokens INTEGER, pricing JSONB, extra_body JSONB,
      show_in_picker BOOLEAN NOT NULL DEFAULT true, position INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, UNIQUE(model_id,slug),
      CHECK(id = CASE WHEN slug = 'standard' THEN model_id ELSE model_id || ':' || slug END)
    );
CREATE TABLE IF NOT EXISTS catalog_v070.model_assignments (
      slot TEXT PRIMARY KEY CHECK(slot IN ('fast','balanced','thorough','maximum','vision','audio','liveAudio','decision')),
      variant_id TEXT REFERENCES catalog_v070.model_variants(id), revision INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
    );
`;
