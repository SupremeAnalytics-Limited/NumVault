import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Reads an app_settings row (see migration 20260924092555_app_settings.sql).
// Falls back silently on any error/missing row — settings must never be able
// to break the payment path they gate.
export async function getSetting<T>(
  admin: ReturnType<typeof createClient>,
  key: string,
  fallback: T,
): Promise<T> {
  try {
    const { data } = await admin.from('app_settings').select('value').eq('key', key).maybeSingle();
    return data?.value ?? fallback;
  } catch {
    return fallback;
  }
}
