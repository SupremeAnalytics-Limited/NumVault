import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

export type TourKey = 'home' | 'home_sheet' | 'wallet' | 'orders' | 'checkout';

export async function markTourSeen(tour: TourKey): Promise<void> {
  const { error } = await supabase.rpc('mark_tour_seen', { tour });
  if (error) throw new Error(error.message);
}
