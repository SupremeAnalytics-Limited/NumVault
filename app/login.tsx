import React, { useState } from 'react';
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

type Mode = 'login' | 'register' | 'forgot';

export default function LoginScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [showPass, setShowPass] = useState(false);
  // Forgot-password state
  const [forgotOtpSent, setForgotOtpSent] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sendOTP, verifyOTPAndLogin, signInWithPassword, operationLoading } = useAuth();
  const { showAlert } = useAlert();

  const switchMode = async (m: Mode) => {
    await Haptics.selectionAsync();
    setMode(m);
    setOtpSent(false);
    setOtp('');
    setForgotOtpSent(false);
    setNewPassword('');
    setConfirmNewPassword('');
  };

  // ── Register handlers ──────────────────────────────────────────────────────

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

    const { error: verifyError } = await verifyOTPAndLogin(email.trim().toLowerCase(), otp);
    if (verifyError) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      trackSignupFailed(verifyError);
      showAlert('Registration Failed', verifyError);
      return;
    }

    const sessionReady = await waitForSession();
    if (!sessionReady) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showAlert(
        'Password Not Saved',
        'Your account was verified but the session did not start in time. Please sign in with an email code and then update your password in Profile.'
      );
      return;
    }

    const passwordError = await setPasswordWithRetry(password);
    if (passwordError) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showAlert('Password Not Saved', passwordError);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    const { data: { session } } = await (await import('@/template')).getSupabaseClient().auth.getSession();
    if (session?.user?.id) trackSignupCompleted(session.user.id);
    router.replace('/(tabs)');
  };

  // ── Login handler ──────────────────────────────────────────────────────────

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

  // ── Forgot-password handlers ───────────────────────────────────────────────

  const handleForgotSendOTP = async () => {
    if (!email.trim()) {
      showAlert('Please enter your email address');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const { error } = await sendOTP(email.trim().toLowerCase());
    if (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showAlert('Error', error);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setForgotOtpSent(true);
      showAlert('Code Sent', 'Check your email for the 4-digit reset code.');
    }
  };

  const handleResetPassword = async () => {
    if (!email || !otp || !newPassword) {
      showAlert('Missing fields', 'Please fill in all required fields.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      showAlert('Passwords do not match', 'Please make sure both passwords are the same.');
      return;
    }
    if (newPassword.length < 6) {
      showAlert('Password too short', 'Password must be at least 6 characters.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Step 1: verify OTP to establish a session
    const { error: verifyError } = await verifyOTPAndLogin(email.trim().toLowerCase(), otp);
    if (verifyError) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showAlert('Verification Failed', verifyError);
      return;
    }
    // Step 2: wait for session then set new password
    const sessionReady = await waitForSession();
    if (!sessionReady) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showAlert('Session Error', 'Could not establish session. Please try again.');
      return;
    }
    const passwordError = await setPasswordWithRetry(newPassword);
    if (passwordError) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showAlert('Password Not Updated', passwordError);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showAlert('Password Updated', 'Your password has been reset. You are now signed in.');
    }
    router.replace('/(tabs)');
  };

  // ── CTA wiring ─────────────────────────────────────────────────────────────

  const handleCTA = () => {
    if (mode === 'login') return handleLogin();
    if (mode === 'register') return handleRegister();
    if (mode === 'forgot') return forgotOtpSent ? handleResetPassword() : handleForgotSendOTP();
  };

  const ctaLabel = operationLoading ? 'Please wait...' :
    mode === 'login' ? 'Sign In' :
    mode === 'forgot' ? (forgotOtpSent ? 'Set New Password' : 'Send Reset Code') :
    'Create Account';

  const ctaDisabled = operationLoading ||
    (mode === 'register' && !otpSent) ||
    (mode === 'forgot' && forgotOtpSent && (!otp || !newPassword || !confirmNewPassword));

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

          {/* Mode Toggle — hidden on forgot password screen */}
          {mode !== 'forgot' ? (
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
          ) : (
            <View style={styles.forgotHeader}>
              <TouchableOpacity onPress={() => switchMode('login')} style={styles.forgotBackBtn}>
                <MaterialIcons name="arrow-back" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
              <View>
                <Text style={styles.forgotTitle}>Reset Password</Text>
                <Text style={styles.forgotSub}>We will send a verification code to your email</Text>
              </View>
            </View>
          )}

          {/* Form */}
          <View style={styles.form}>
            {/* Email — always shown */}
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

            {/* Register: password fields */}
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
                    <MaterialIcons name={showPass ? 'visibility-off' : 'visibility'} size={18} color={Colors.textMuted} />
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

            {/* Login: password field + forgot link */}
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
                    <MaterialIcons name={showPass ? 'visibility-off' : 'visibility'} size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={styles.forgotLink}
                  onPress={() => switchMode('forgot')}
                  activeOpacity={0.7}
                >
                  <Text style={styles.forgotLinkText}>Forgot password?</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Register: send OTP button (before OTP entry) */}
            {mode === 'register' && !otpSent && (
              <TouchableOpacity
                style={styles.otpBtn}
                onPress={handleSendOTP}
                disabled={operationLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.otpBtnText}>
                  {operationLoading ? 'Sending...' : 'Send Verification Code'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Register: OTP input */}
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

            {/* Forgot: send reset code button (before OTP entry) */}
            {mode === 'forgot' && !forgotOtpSent && (
              <TouchableOpacity
                style={styles.otpBtn}
                onPress={handleForgotSendOTP}
                disabled={operationLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.otpBtnText}>
                  {operationLoading ? 'Sending...' : 'Send Reset Code'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Forgot: OTP + new password fields */}
            {mode === 'forgot' && forgotOtpSent && (
              <>
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
                <View style={styles.inputGroup}>
                  <View style={styles.inputRow}>
                    <MaterialIcons name="lock-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                    <TextInput
                      style={styles.input}
                      value={newPassword}
                      onChangeText={setNewPassword}
                      placeholder="New password"
                      placeholderTextColor={Colors.textMuted}
                      secureTextEntry={!showPass}
                      autoCapitalize="none"
                    />
                    <TouchableOpacity onPress={() => setShowPass(!showPass)}>
                      <MaterialIcons name={showPass ? 'visibility-off' : 'visibility'} size={18} color={Colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <View style={[styles.inputRow, { marginTop: Spacing.sm }]}>
                    <MaterialIcons name="lock" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                    <TextInput
                      style={styles.input}
                      value={confirmNewPassword}
                      onChangeText={setConfirmNewPassword}
                      placeholder="Confirm new password"
                      placeholderTextColor={Colors.textMuted}
                      secureTextEntry={!showPass}
                      autoCapitalize="none"
                    />
                  </View>
                </View>
              </>
            )}

            <TouchableOpacity
              style={[styles.cta, ctaDisabled && styles.ctaDisabled]}
              onPress={handleCTA}
              disabled={ctaDisabled}
              activeOpacity={0.85}
            >
              <Text style={styles.ctaText}>{ctaLabel}</Text>
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
  // Forgot password header
  forgotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.lg,
  },
  forgotBackBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forgotTitle: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  forgotSub: {
    color: Colors.textSecondary,
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  forgotLink: {
    alignSelf: 'flex-end',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  forgotLinkText: {
    color: Colors.primary,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
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
