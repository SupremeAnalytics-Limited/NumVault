import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/template';
import { Colors } from '@/constants/theme';

const ONBOARDING_KEY = 'nv_onboarding_done';

export default function RootScreen() {
  const { user, loading } = useAuth();
  const [checking, setChecking] = useState(true);
  const [onboardingDone, setOnboardingDone] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY).then((val) => {
      setOnboardingDone(val === 'true');
      setChecking(false);
    });
  }, []);

  if (loading || checking) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  // First-time user: show onboarding regardless of auth state
  if (!onboardingDone) return <Redirect href="/onboarding" />;

  // Returning user: route by auth state
  if (user) return <Redirect href="/(tabs)" />;
  return <Redirect href="/login" />;
}
