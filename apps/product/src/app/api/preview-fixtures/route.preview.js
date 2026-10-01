import { createClient } from '@supabase/supabase-js';
import { handlePreviewFixtureRequest } from '../../../../../../scripts/lib/preview-fixture-http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 150;

export async function POST(request) {
  return handlePreviewFixtureRequest(request, { createClient });
}
