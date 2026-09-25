
// build-v7
import * as Sentry from '@sentry/react-native';
import { AlertProvider, AuthProvider } from '@/template';
import { Stack, useNavigationContainerRef } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OrderProvider } from '@/contexts/OrderContext';
import { WalletProvider } from '@/contexts/WalletContext';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { Colors } from '@/constants/theme';

// Keep the native splash up until app/index.tsx knows where to send the user,
// so there's no blank white frame between the splash and the first screen.
SplashScreen.preventAutoHideAsync().catch(() => {});

// ─── Sentry initialisation ───────────────────────────────────────────────────
// DSN is injected at build time via EXPO_PUBLIC_SENTRY_DSN (Cloud Secret).
// The @sentry/react-native/expo Expo config plugin is intentionally NOT used
// in app.json — its postinstall script breaks the OnSpace install environment.
// All Sentry features (tracing, replay, breadcrumbs) are configured manually.
//
// Release format: {android.package}@{version}+{versionCode}
// Update this string whenever version/versionCode changes in app.json.
const SENTRY_RELEASE = 'ng.numvault.app@1.0.4+20';

// navigationIntegration is the correct integration that exposes
// registerNavigationContainer — reactNativeTracingIntegration() is for
// general performance spans and does NOT have that method.
const navigationIntegration = Sentry.reactNavigationIntegration();

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  release: SENTRY_RELEASE,
  environment: __DEV__ ? 'development' : 'production',

  // Performance tracing: 100% in dev, 20% in production
  tracesSampleRate: __DEV__ ? 1.0 : 0.2,

  // Session Replay: 10% of sessions, 100% on error — production only
  replaysSessionSampleRate: __DEV__ ? 0 : 0.1,
  replaysOnErrorSampleRate: __DEV__ ? 0 : 1.0,

  integrations: [
    Sentry.mobileReplayIntegration({
      maskAllText: true,   // Masks OTPs, phone numbers, amounts, passwords
      maskAllImages: true, // Blocks all images in replays
    }),
    navigationIntegration,
    Sentry.reactNativeTracingIntegration(), // general span / performance tracing
  ],

  // Strip sensitive keys from event payloads before they leave the device
  beforeSend(event) {
    const sensitiveKeys = ['password', 'otp', 'token', 'auth_code', 'card', 'cvv', 'secret'];
    if (event.extra) {
      for (const key of Object.keys(event.extra)) {
        if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
          delete event.extra![key];
        }
      }
    }
    return event;
  },

  // Drop breadcrumbs that contain sensitive content
  beforeBreadcrumb(breadcrumb) {
    const sensitiveKeys = ['password', 'otp', 'token', 'auth_code', 'card', 'cvv', 'secret'];
    if (
      breadcrumb.category === 'console' &&
      breadcrumb.message &&
      sensitiveKeys.some((s) => breadcrumb.message!.toLowerCase().includes(s))
    ) {
      return null;
    }
    return breadcrumb;
  },
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
  const navigationRef = useNavigationContainerRef();

  // Wire Sentry navigation instrumentation to the Expo Router nav container.
  // Guard against web/browser environments where the method may not exist.
  useEffect(() => {
    if (navigationRef && typeof navigationIntegration.registerNavigationContainer === 'function') {
      navigationIntegration.registerNavigationContainer(navigationRef);
    }
  }, [navigationRef]);

  // Safety net: never leave the splash up if the first route can't resolve.
  useEffect(() => {
    const t = setTimeout(() => { SplashScreen.hideAsync().catch(() => {}); }, 8000);
    return () => clearTimeout(t);
  }, []);

  return (
    <AlertProvider>
      <SafeAreaProvider>
        <AuthProvider>
          <WalletProvider>
            <OrderProvider>
              <NotificationSetup />
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
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
                <Stack.Screen
                  name="acquisition-program"
                  options={{ headerShown: false }}
                />
                <Stack.Screen name="admin" options={{ headerShown: false }} />
              </Stack>
            </OrderProvider>
          </WalletProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </AlertProvider>
  );
}

export default Sentry.wrap(RootLayout);
