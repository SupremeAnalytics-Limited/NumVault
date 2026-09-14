import React, { createContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { fetchProfile } from '@/services/orderService';
import { getSupabaseClient } from '@/template';

const supabase = getSupabaseClient();

interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  wallet_balance: number;
  paystack_customer_code: string | null;
  card_last4: string | null;
  card_auth_code: string | null;
  card_brand: string | null;
  card_exp_month: string | null;
  card_exp_year: string | null;
}

interface WalletContextType {
  profile: UserProfile | null;
  walletBalance: number;
  hasCard: boolean;
  loading: boolean;
  refreshProfile: () => Promise<void>;
}

export const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshProfile = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchProfile();
      setProfile(data);
    } catch (e) {
      console.error('Failed to fetch profile:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load wallet balance as soon as a session exists, without waiting for
  // the user to navigate to the Wallet or Profile tab.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) refreshProfile();
    });
    return () => { active = false; };
  }, [refreshProfile]);

  const walletBalance = profile?.wallet_balance ?? 0;
  const hasCard = !!(profile?.card_auth_code && profile?.card_last4);

  return (
    <WalletContext.Provider value={{ profile, walletBalance, hasCard, loading, refreshProfile }}>
      {children}
    </WalletContext.Provider>
  );
}
