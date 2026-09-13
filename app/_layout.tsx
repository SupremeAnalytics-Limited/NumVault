// build-v3
import { AlertProvider, AuthProvider } from '@/template';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OrderProvider } from '@/contexts/OrderContext';
import { WalletProvider } from '@/contexts/WalletContext';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

function NotificationSetup() {
  useEffect(() => {
    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('otp', {
        name: 'OTP Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 100, 250],
        sound: 'default',
        lightColor: '#00C853',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
      });
    }
  }, []);
  return null;
}

export default function RootLayout() {
  return (
    <AlertProvider>
      <SafeAreaProvider>
        <AuthProvider>
          <WalletProvider>
            <OrderProvider>
              <NotificationSetup />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="onboarding" />
                <Stack.Screen name="login" />
                <Stack.Screen name="(tabs)" />
                <Stack.Screen
                  name="checkout"
                  options={{ headerShown: false, presentation: 'modal' }}
                />
                <Stack.Screen
                  name="number-display"
                  options={{ headerShown: false }}
                />
              </Stack>
            </OrderProvider>
          </WalletProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </AlertProvider>
  );
}
