import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ScrollView, StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth, useAlert } from '@/template';
import { waitForSession, setPasswordWithRetry } from '@/services/authHelpers';
import {
  trackSignupStarted, trackSignupOtpSent, trackSignupCompleted, trackSignupFailed,
  trackLoginStarted, trackLoginCompleted, trackLoginFailed,
} from '@/services/sentryService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

type Mode = 'login' | 'register';

export default function LoginScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [showPass, setShowPass] = useState(false);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sendOTP, verifyOTPAndLogin, signInWithPassword, operationLoading } = useAuth();
  const { showAlert } = useAlert();

  const handleSendOTP = async () => {
    if (!email.trim()) {
      showAlert('Please enter your email address');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    trackSignupStarted();
    const { error } = await sendOTP(email.trim().toLowerCase());
    if (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      trackSignupOtpSent(false, error);
      showAlert('Error', error);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      trackSignupOtpSent(true);
      setOtpSent(true);
      showAlert('Code Sent', 'Check your email for the 4-digit verification code.');
    }
  };

  const handleRegister = async () => {
    if (!email || !password || !otp) {
      showAlert('Missing fields', 'Please fill in all required fields.');
      return;
    }
    if (password !== confirmPass) {
      showAlert('Passwords do not match', 'Please make sure both passwords are the same.');
      return;
    }
    if (password.length < 6) {
      showAlert('Password too short', 'Password must be at least 6 characters.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Step 1: Verify OTP — do NOT pass password here; the template's built-in
    // updateUser call runs without waiting for the session and silently ignores
    // failures, leaving the account with no working password.
    const { error: verifyError } = await verifyOTPAndLogin(email.trim().toLowerCase(), otp);
    if (verifyError) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      trackSignupFailed(verifyError);
      showAlert('Registration Failed', verifyError);
      return;
    }

    // Step 2: Wait for the Supabase session that verifyOtp establishes to become
    // fully active before calling updateUser. Without this wait, updateUser hits
    // a timing race and fails with "Auth session missing".
    const sessionReady = await waitForSession();
    if (!sessionReady) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showAlert(
        'Password Not Saved',
        'Your account was verified but the session did not start in time. Please sign in with an email code and then update your password in Profile.'
      );
      return;
    }

    // Step 3: Set the password with one automatic retry.
    const passwordError = await setPasswordWithRetry(password);
    if (passwordError) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showAlert('Password Not Saved', passwordError);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    // Account is created and session is live — navigate to main app.
    const { data: { session } } = await (await import('@/template')).getSupabaseClient().auth.getSession();
    if (session?.user?.id) trackSignupCompleted(session.user.id);
    router.replace('/(tabs)');
  };

  const handleLogin = async () => {
    if (!email || !password) {
      showAlert('Missing fields', 'Please enter your email and password.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    trackLoginStarted();
    const { error, user } = await signInWithPassword(email.trim().toLowerCase(), password);
    if (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      trackLoginFailed(error);
      showAlert('Login Failed', error);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (user?.id) trackLoginCompleted(user.id);
      router.replace('/(tabs)');
    }
  };

  const switchMode = async (m: Mode) => {
    await Haptics.selectionAsync();
    setMode(m);
    setOtpSent(false);
    setOtp('');
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo */}
          <View style={styles.logoArea}>
            <Image
              source={require('@/assets/images/icon.png')}
              style={styles.logoImage}
              contentFit="contain"
              transition={200}
            />
            <Text style={styles.logoText}>NumVault</Text>
            <Text style={styles.logoSub}>SMS Verification Numbers, Instantly</Text>
          </View>

          {/* Mode Toggle */}
          <View style={styles.modeToggle}>
            <TouchableOpacity
              style={[styles.modeBtn, mode === 'login' && styles.modeBtnActive]}
              onPress={() => switchMode('login')}
              activeOpacity={0.8}
            >
              <Text style={[styles.modeBtnText, mode === 'login' && styles.modeBtnTextActive]}>
                Sign In
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, mode === 'register' && styles.modeBtnActive]}
              onPress={() => switchMode('register')}
              activeOpacity={0.8}
            >
              <Text style={[styles.modeBtnText, mode === 'register' && styles.modeBtnTextActive]}>
                Create Account
              </Text>
            </TouchableOpacity>
          </View>

          {/* Form */}
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={styles.inputRow}>
                <MaterialIcons name="email" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            {mode === 'register' && (
              <View style={styles.inputGroup}>
                <View style={styles.inputRow}>
                  <MaterialIcons name="lock-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Create password"
                    placeholderTextColor={Colors.textMuted}
                    secureTextEntry={!showPass}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity onPress={() => setShowPass(!showPass)}>
                    <MaterialIcons name={showPass ? "visibility-off" : "visibility"} size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={[styles.inputRow, { marginTop: Spacing.sm }]}>
                  <MaterialIcons name="lock" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={confirmPass}
                    onChangeText={setConfirmPass}
                    placeholder="Confirm password"
                    placeholderTextColor={Colors.textMuted}
                    secureTextEntry={!showPass}
                    autoCapitalize="none"
                  />
                </View>
              </View>
            )}

            {mode === 'login' && (
              <View style={styles.inputGroup}>
                <View style={styles.inputRow}>
                  <MaterialIcons name="lock-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Password"
                    placeholderTextColor={Colors.textMuted}
                    secureTextEntry={!showPass}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity onPress={() => setShowPass(!showPass)}>
                    <MaterialIcons name={showPass ? "visibility-off" : "visibility"} size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {mode === 'register' && !otpSent && (
              <TouchableOpacity
                style={styles.otpBtn}
                onPress={handleSendOTP}
                disabled={operationLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.otpBtnText}>
                  {operationLoading ? "Sending..." : "Send Verification Code"}
                </Text>
              </TouchableOpacity>
            )}

            {mode === 'register' && otpSent && (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Verification Code</Text>
                <Text style={styles.otpHint}>Enter the 4-digit code sent to {email}</Text>
                <TextInput
                  style={[styles.inputRow, styles.otpInput]}
                  value={otp}
                  onChangeText={setOtp}
                  placeholder="0000"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={4}
                />
              </View>
            )}

            <TouchableOpacity
              style={[styles.cta, operationLoading && styles.ctaDisabled]}
              onPress={mode === 'login' ? handleLogin : handleRegister}
              disabled={operationLoading || (mode === 'register' && !otpSent)}
              activeOpacity={0.85}
            >
              <Text style={styles.ctaText}>
                {operationLoading ? "Please wait..." : mode === 'login' ? "Sign In" : "Create Account"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Trust badges */}
          <View style={styles.badges}>
            <View style={styles.badge}>
              <MaterialIcons name="lock" size={14} color={Colors.primary} />
              <Text style={styles.badgeText}>256-bit Encrypted</Text>
            </View>
            <View style={styles.badge}>
              <MaterialIcons name="verified-user" size={14} color={Colors.primary} />
              <Text style={styles.badgeText}>Secure & Private</Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
  },
  logoArea: {
    alignItems: 'center',
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  logoImage: {
    width: 90,
    height: 90,
    borderRadius: Radius.lg,
    marginBottom: Spacing.md,
  },
  logoText: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: FontWeight.bold,
    letterSpacing: 1,
  },
  logoSub: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    marginTop: 4,
  },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 4,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: Radius.sm,
  },
  modeBtnActive: {
    backgroundColor: Colors.primary,
  },
  modeBtnText: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  modeBtnTextActive: {
    color: Colors.black,
  },
  form: {
    gap: Spacing.md,
  },
  inputGroup: {
    gap: Spacing.xs,
  },
  label: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    height: 50,
  },
  inputIcon: {
    marginRight: Spacing.sm,
  },
  input: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.md,
    includeFontPadding: false,
  },
  otpBtn: {
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.md,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpBtnText: {
    color: Colors.primary,
    fontWeight: FontWeight.semibold,
    fontSize: FontSize.md,
  },
  otpHint: {
    color: Colors.textSecondary,
    fontSize: FontSize.xs,
  },
  otpInput: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    letterSpacing: 8,
    textAlign: 'center',
    color: Colors.text,
    height: 56,
  },
  cta: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  ctaDisabled: {
    opacity: 0.5,
  },
  ctaText: {
    color: Colors.black,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
  },
  badges: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
    marginTop: Spacing.xl,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  badgeText: {
    color: Colors.textSecondary,
    fontSize: FontSize.xs,
  },
});
