import { Redirect } from 'expo-router';

// Show onboarding on every app session
export default function RootScreen() {
  return <Redirect href="/onboarding" />;
}
