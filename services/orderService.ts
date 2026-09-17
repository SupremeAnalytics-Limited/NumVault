import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

export interface Order {
  id: string;
  user_id: string;
  provider_code: string;
  country_id: number;
  country_name: string;
  project_id: number;
  project_name: string;
  phone_number: string | null;
  otp: string | null;
  amount_paid: number;
  status: 'pending' | 'completed' | 'expired';
  order_reference: string | null;
  socially_order_id: string | null;
  created_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  amount: number;
  type: 'credit' | 'debit';
  reference: string | null;
  description: string | null;
  created_at: string;
}

export async function fetchOrders(): Promise<Order[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function fetchOrder(id: string): Promise<Order | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

/**
 * Fetch only the mutable fields of a single pending order (status + otp).
 * Used by the order-polling loop to avoid re-fetching the entire list.
 */
export async function fetchOrderStatus(id: string): Promise<Pick<Order, 'id' | 'status' | 'otp' | 'phone_number'> | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, status, otp, phone_number')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

export async function fetchTransactions(): Promise<Transaction[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function fetchProfile() {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function updateOrderExpired(orderId: string) {
  await supabase
    .from('orders')
    .update({ status: 'expired' })
    .eq('id', orderId);
}
