import React, { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/template';
import { getSetting } from '@/services/settingsService';
import { APP_ONBOARDING_SEEN_KEY } from '@/constants/config';

// Whether the app intro (app/onboarding.tsx) shows on every launch or only
// once ever on this device is controlled by the admin toggle
// app_onboarding_force_every_session (defaults to true — every session,
// matching this screen's original always-show behavior).
export default function RootScreen() {
  const { user, loading, initialized } = useAuth();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized || loading) return;
    let cancelled = false;
    (async () => {
      try {
        const forceEverySession = await getSetting<boolean>('app_onboarding_force_every_session', true);
        if (forceEverySession) {
          if (!cancelled) setTarget('/onboarding');
          return;
        }
        const seen = await AsyncStorage.getItem(APP_ONBOARDING_SEEN_KEY);
        if (!cancelled) setTarget(seen ? (user ? '/(tabs)' : '/login') : '/onboarding');
      } catch {
        if (!cancelled) setTarget('/onboarding');
      }
    })();
    return () => { cancelled = true; };
  }, [initialized, loading, user]);

  if (!target) return null;
  return <Redirect href={target as any} />;
}
