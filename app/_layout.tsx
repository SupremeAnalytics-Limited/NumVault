// build-v4
import * as Sentry from '@sentry/react-native';
import { AlertProvider, AuthProvider } from '@/template';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OrderProvider } from '@/contexts/OrderContext';
import { WalletProvider } from '@/contexts/WalletContext';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

// ─── Sentry initialisation ────────────────────────────────────────────────────
// DSN is read from the public environment variable set in .env:
//   EXPO_PUBLIC_SENTRY_DSN=https://...@sentry.io/...
// Release is set manually because the @sentry/react-native/expo Expo config
// plugin is NOT used (its postinstall script requires expo to be resolvable
// at install time, which is incompatible with the OnSpace build environment).
// Keep release in sync with app.json version + android.versionCode.
Sentry.init({
  release: 'ng.numvault.app@1.0.4+15',
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: __DEV__ ? 'development' : 'production',
  enableTracing: true,
  tracesSampleRate: __DEV__ ? 1.0 : 0.2,
  // Session Replay — production only; maximum privacy masking.
  _experiments: {
    replaysSessionSampleRate: __DEV__ ? 0 : 0.1,
    replaysOnErrorSampleRate: __DEV__ ? 0 : 1.0,
  },
  integrations: [
    Sentry.mobileReplayIntegration({
      // Mask ALL text — prevents OTPs, passwords, amounts, phone numbers from appearing in replays.
      maskAllText: true,
      // Block ALL images — no visual content leakage.
      maskAllImages: true,
    }),
    Sentry.reactNativeTracingIntegration(),
  ],
  // Strip sensitive console breadcrumbs before they reach Sentry.
  beforeBreadcrumb(breadcrumb) {
    if (breadcrumb.category === 'console') {
      const msg = (breadcrumb.message || '').toLowerCase();
      if (
        msg.includes('password') ||
        msg.includes('otp') ||
        msg.includes('token') ||
        msg.includes('auth_code') ||
        msg.includes('card') ||
        msg.includes('cvv')
      ) {
        return null;
      }
    }
    return breadcrumb;
  },
  // Strip sensitive extra/context keys from all events before sending.
  beforeSend(event) {
    const sensitiveKeys = ['password', 'otp', 'token', 'auth_code', 'card', 'cvv', 'secret'];
    if (event.extra) {
      for (const key of Object.keys(event.extra)) {
        if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
          delete event.extra![key];
        }
      }
    }
    return event;
  },
  debug: __DEV__,
});
// ─────────────────────────────────────────────────────────────────────────────

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

function RootLayout() {
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

export default Sentry.wrap(RootLayout);
