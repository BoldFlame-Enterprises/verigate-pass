import { useEffect, useRef, useState, ReactNode } from 'react';
import { AppState, AppStateStatus, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { BiometricService } from '../services/BiometricService';
import { AUTO_LOGOUT_INACTIVITY_MS } from '../config';

interface SecurityGateProps {
  children: ReactNode;
  enabled: boolean;
  onAutoLogout: () => void;
}

/**
 * Wraps authenticated screens with two behaviors required by the spec:
 * 1. Secure content on backgrounding — an opaque blur covers the screen the
 *    instant the app leaves the foreground (App Switcher / lock screen),
 *    hiding QR codes and access details from screenshots of recent apps.
 * 2. Auto-logout after inactivity — if the app is backgrounded, or sits idle
 *    in the foreground, for longer than AUTO_LOGOUT_INACTIVITY_MS, the
 *    session is force-logged-out. Biometric re-auth (if enabled) can dismiss
 *    the blur without a full logout for a shorter backgrounding.
 */
export default function SecurityGate({ children, enabled, onAutoLogout }: SecurityGateProps) {
  const [isCovered, setIsCovered] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const lastActiveAtRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;

    const idleCheck = setInterval(() => {
      if (Date.now() - lastActiveAtRef.current > AUTO_LOGOUT_INACTIVITY_MS) {
        onAutoLogout();
      }
    }, 15_000);

    const subscription = AppState.addEventListener('change', async (state: AppStateStatus) => {
      if (state === 'active') {
        const backgroundedAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        lastActiveAtRef.current = Date.now();

        if (backgroundedAt && Date.now() - backgroundedAt > AUTO_LOGOUT_INACTIVITY_MS) {
          onAutoLogout();
          return;
        }

        if (backgroundedAt) {
          const biometricEnabled = await BiometricService.isEnabled();
          if (biometricEnabled) {
            const ok = await BiometricService.authenticate('Unlock VeriGate Pass');
            if (!ok) {
              onAutoLogout();
              return;
            }
          }
        }
        setIsCovered(false);
      } else {
        backgroundedAtRef.current = Date.now();
        setIsCovered(true);
      }
    });

    return () => {
      subscription.remove();
      clearInterval(idleCheck);
    };
  }, [enabled, onAutoLogout]);

  const touch = () => {
    lastActiveAtRef.current = Date.now();
  };

  return (
    <View style={styles.flex} onTouchStart={touch}>
      {children}
      {enabled && isCovered && (
        <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill}>
          <View style={styles.center}>
            <Text style={styles.label}>VeriGate Pass secured</Text>
          </View>
        </BlurView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { color: '#fff', fontWeight: '600' },
});
