import { Capacitor } from "@capacitor/core";
import { AccessControl, NativeBiometric } from "@capgo/capacitor-native-biometric";
import { supabase } from "@/integrations/supabase/client";

const SERVER = "com.sparkleinsure.app";
export const biometricSupported = () => Capacitor.isNativePlatform();

export async function biometricIsReady() {
  if (!biometricSupported()) return false;
  const availability = await NativeBiometric.isAvailable({ useFallback: false });
  if (!availability.isAvailable || !availability.strongBiometryIsAvailable) return false;
  return (await NativeBiometric.isCredentialsSaved({ server: SERVER })).isSaved;
}

export async function enableBiometric(email: string, password: string) {
  if (!biometricSupported()) throw new Error("Biometric sign-in is available in the Sparkle mobile app only.");
  const availability = await NativeBiometric.isAvailable({ useFallback: false });
  if (!availability.isAvailable || !availability.strongBiometryIsAvailable) throw new Error("Set up fingerprint or face unlock on this phone first.");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await NativeBiometric.setCredentials({ username: email, password, server: SERVER, accessControl: AccessControl.BIOMETRY_CURRENT_SET, title: "Enable biometric sign-in" });
}

export async function biometricSignIn() {
  const credentials = await NativeBiometric.getSecureCredentials({ server: SERVER, reason: "Use biometrics to sign in to Sparkle", title: "Sparkle sign-in" });
  const { error } = await supabase.auth.signInWithPassword({ email: credentials.username, password: credentials.password });
  if (error) throw error;
}

export async function disableBiometric() {
  if (biometricSupported()) await NativeBiometric.deleteCredentials({ server: SERVER });
}
