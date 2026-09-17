import React, { createContext, useState, useCallback, ReactNode } from 'react';
import { fetchOrders, fetchTransactions, fetchOrderStatus, Order, Transaction } from '@/services/orderService';

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
