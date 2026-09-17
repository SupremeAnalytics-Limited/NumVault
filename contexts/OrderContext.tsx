import React, { createContext, useState, useCallback, useEffect, useRef, useContext, ReactNode } from 'react';
import { getSupabaseClient } from '@/template';
import { fetchOrders, fetchTransactions, fetchOrderStatus, Order, Transaction } from '@/services/orderService';
import { OTP_TIMEOUT } from '@/constants/config';
import { WalletContext } from '@/contexts/WalletContext';
import { sendRefundNotification } from '@/services/notificationService';

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

  // Access wallet refresh without prop-drilling. WalletProvider is above
  // OrderProvider in app/_layout.tsx so this context is always available.
  const walletCtx = useContext(WalletContext);

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

        // Guard: treat non-2xx as a retriable failure, not a silent success
        if (!res.ok) {
          const errText = await res.text().catch(() => '(unreadable body)');
          console.warn(`OrderContext: expire-order HTTP ${res.status} for ${order.id}:`, errText);
          expiryInFlight.delete(order.id); // allow retry next cycle
          continue;
        }

        const result = await res.json();

        // Treat both a fresh refund and an already-handled response as terminal —
        // flip the local order status so the UI reflects reality immediately.
        if (result.refunded || result.already_handled) {
          const finalStatus = result.status ?? 'expired';
          setOrders((prev) =>
            prev.map((o) =>
              o.id === order.id ? { ...o, status: finalStatus } : o
            )
          );

          // After a confirmed refund, re-fetch the authoritative wallet_balance
          // and transaction list from the DB so the Wallet UI updates immediately
          // without the user pressing Refresh.
          // NOTE: always refresh on result.refunded; also refresh on already_handled
          // because the previous caller may have credited the wallet and we need
          // the client to catch up if it missed the earlier update.
          walletCtx?.refreshProfile().catch((e) =>
            console.warn('OrderContext: wallet refresh after refund failed', e)
          );
          refreshTransactions().catch((e) =>
            console.warn('OrderContext: tx refresh after refund failed', e)
          );

          // Fire a local device notification only on a fresh refund (not
          // already_handled) so the user is notified even while the app is
          // backgrounded or on a different screen. Deduplication is enforced
          // inside sendRefundNotification via a module-level Set.
          if (result.refunded && result.refund_amount) {
            sendRefundNotification(order.id, result.refund_amount).catch((e) =>
              console.warn('OrderContext: refund notification failed', e)
            );
          }
        }
      } catch (e) {
        console.warn(`OrderContext: expire-order failed for ${order.id}`, e);
        // Remove from in-flight so it can be retried next cycle
        expiryInFlight.delete(order.id);
      }
    }
  }, [walletCtx, refreshTransactions]);

  // Keep a stable ref to the latest orders so the interval closure always
  // has access to current state without being recreated on every render.
  const ordersRef = useRef<Order[]>([]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  // On mount: ensure we have a populated order list before the first expiry
  // check runs. Without this, ordersRef.current starts as [] and any pending
  // orders created before this session are invisible to the watcher.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) refreshOrders();
    });
  }, []);

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
