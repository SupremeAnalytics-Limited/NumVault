import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getSupabaseClient } from '@/template';

// Configure how notifications are displayed when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** Returns true if the string looks like a valid Expo push token. */
function isValidExpoPushToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith('ExponentPushToken[') && token.endsWith(']');
}

export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Set up the Android notification channel BEFORE attempting push registration.
 * This must be called early (app/_layout.tsx NotificationSetup already does it)
 * but we guard here too so registerPushToken is self-contained.
 */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('otp', {
    name: 'OTP Alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 100, 250],
    sound: 'default',
    lightColor: '#00C853',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
  });
}

/**
 * Register the device's Expo push token in user_profiles so server-side
 * functions (e.g. auto-expire-orders) can send push notifications.
 *
 * Errors are no longer silently swallowed — any failure is logged with
 * enough context to diagnose the problem without exposing credentials.
 */
export async function registerPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await ensureAndroidChannel();

    const granted = await requestNotificationPermissions();
    if (!granted) {
      console.log('registerPushToken: notification permission not granted, skipping registration');
      return;
    }

    // No EAS projectId is configured for this project, so we call
    // getExpoPushTokenAsync() without options and rely on the bare Expo
    // token issued for the development/production build.
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const pushToken = tokenData.data;

    if (!pushToken) {
      console.warn('registerPushToken: Expo returned empty push token');
      return;
    }

    if (!isValidExpoPushToken(pushToken)) {
      console.warn('registerPushToken: token does not match expected Expo format:', pushToken.slice(0, 30));
      return;
    }

    const supabase = getSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.warn('registerPushToken: no authenticated user, skipping DB write');
      return;
    }

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ push_token: pushToken })
      .eq('id', user.id);

    if (updateError) {
      // Explicit error — not silently swallowed
      console.error('registerPushToken: failed to save push token to user_profiles:', {
        code: updateError.code,
        message: updateError.message,
        details: updateError.details,
        userId: user.id,
      });
      throw new Error(`Push token DB update failed: ${updateError.message}`);
    }

    console.log('registerPushToken: token saved for user', user.id, '— token prefix:', pushToken.slice(0, 30));
  } catch (e) {
    // Surface with enough context for debugging; never expose tokens in logs
    console.error('registerPushToken: unhandled error during registration:', e instanceof Error ? e.message : String(e));
  }
}

export async function sendOTPReceivedNotification(platform: string, otp: string) {
  // Vibrate the device with a success pattern
  if (Platform.OS !== 'web') {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Double-pulse vibration for emphasis
    setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), 300);
  }

  const hasPermission = await requestNotificationPermissions();
  if (!hasPermission) return;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: '🔐 OTP Received!',
      body: `Your ${platform} code is: ${otp} — Tap to copy`,
      data: { type: 'otp_received', otp, platform },
      sound: true,
      // Android priority
      priority: Notifications.AndroidNotificationPriority.MAX,
      vibrationPattern: [0, 250, 100, 250],
    },
    trigger: null, // Send immediately
  });
}

export async function sendLowBalanceNotification(balance: number) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '💳 Low Wallet Balance',
      body: `Your NumVault balance is ₦${balance.toLocaleString()}. Top up now to continue buying numbers.`,
      data: { type: 'low_balance', balance },
      sound: true,
    },
    trigger: null, // Send immediately
  });
}
