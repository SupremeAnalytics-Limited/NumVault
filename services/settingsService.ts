import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error || !data) return fallback;
  return data.value as T;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const { error } = await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}
