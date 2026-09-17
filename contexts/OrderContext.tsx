import React, { createContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { getSupabaseClient } from '@/template';
import { fetchOrders, fetchTransactions, fetchOrderStatus, Order, Transaction } from '@/services/orderService';
import { OTP_TIMEOUT } from '@/constants/config';

const supabase = getSupabaseClient();

// Tracks order IDs that the context has already dispatched an expire-order call for,
// so concurrent checks or re-renders never double-fire the same order.
const expiryInFlight = new Set<string>();

interface OrderContextType {
  orders: Order[];
  transactions: Transaction[];
  loading: boolean;
  refreshOrders: () => Promise<void>;
  refreshTransactions: () => Promise<void>;
  /** Fetch only status/otp/phone_number for one order and merge into state. */
  refreshOrderStatus: (orderId: string) => Promise<void>;
}

export const OrderContext = createContext<OrderContextType | undefined>(undefined);

export function OrderProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshOrders = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchOrders();
      setOrders(data);
    } catch (e) {
      console.error('Failed to fetch orders:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshTransactions = useCallback(async () => {
    try {
      const data = await fetchTransactions();
      setTransactions(data);
    } catch (e) {
      console.error('Failed to fetch transactions:', e);
    }
  }, []);

  // ── App-level expiry watcher ─────────────────────────────────────────────
  // Runs every 30 s (and on initial mount) to find any pending order whose
  // creation time has passed OTP_TIMEOUT. Calls expire-order server-side so a
  // refund is triggered regardless of which screen the user is on.
  // number-display.tsx timer becomes display-only; this is the authoritative trigger.
  const checkAndExpireStaleOrders = useCallback(async (currentOrders: Order[]) => {
    const pending = currentOrders.filter((o) => o.status === 'pending');
    if (pending.length === 0) return;

    const now = Date.now();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;

    for (const order of pending) {
      const age = now - new Date(order.created_at).getTime();
      if (age < OTP_TIMEOUT) continue;        // still within window
      if (expiryInFlight.has(order.id)) continue; // already being handled

      expiryInFlight.add(order.id);
      console.log(`OrderContext: expiring stale order ${order.id} (age ${Math.floor(age / 1000)}s)`);

      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/expire-order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ order_id: order.id }),
        });
        const result = await res.json();

        if (result.refunded || result.already_expired || result.already_handled) {
          // Merge the final status back into local state immediately
          const finalStatus = result.status ?? 'expired';
          setOrders((prev) =>
            prev.map((o) =>
              o.id === order.id ? { ...o, status: finalStatus } : o
            )
          );
        }
      } catch (e) {
        console.warn(`OrderContext: expire-order failed for ${order.id}`, e);
        // Remove from in-flight so it can be retried next cycle
        expiryInFlight.delete(order.id);
      }
    }
  }, []);

  // Keep a stable ref to the latest orders so the interval closure always
  // has access to current state without being recreated on every render.
  const ordersRef = useRef<Order[]>([]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  useEffect(() => {
    // Run immediately on mount, then every 30 s
    checkAndExpireStaleOrders(ordersRef.current);
    const interval = setInterval(() => {
      checkAndExpireStaleOrders(ordersRef.current);
    }, 30_000);
    return () => clearInterval(interval);
  }, [checkAndExpireStaleOrders]);
  // ─────────────────────────────────────────────────────────────────────────

  const refreshOrderStatus = useCallback(async (orderId: string) => {
    try {
      const updated = await fetchOrderStatus(orderId);
      if (!updated) return;
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? { ...o, status: updated.status, otp: updated.otp, phone_number: updated.phone_number }
            : o
        )
      );
    } catch (e) {
      console.error('Failed to refresh order status:', e);
    }
  }, []);

  return (
    <OrderContext.Provider value={{ orders, transactions, loading, refreshOrders, refreshTransactions, refreshOrderStatus }}>
      {children}
    </OrderContext.Provider>
  );
}
