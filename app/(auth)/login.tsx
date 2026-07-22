// app/(auth)/login.tsx - Login screen
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
} from 'react-native';
import { router } from 'expo-router';
import { DatabaseService } from '@/services/DatabaseService';
import { useUser } from '@/context/UserContext';
import { ApiClient } from '@/services/ApiClient';
import { SyncService } from '@/services/SyncService';
import { NotificationService } from '@/services/NotificationService';
import { BiometricService } from '@/services/BiometricService';
import { OfflineSessionService } from '@/services/OfflineSessionService';
import { DEMO_MODE } from '@/config';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const { setUser } = useUser();

  const completeLogin = useCallback(async (user: Awaited<ReturnType<typeof DatabaseService.getUserByEmail>>) => {
    if (!user) return;
    setUser(user);
    await NotificationService.init().catch((err) => console.warn('Notification init failed:', err));
    router.replace('/(main)/qr-display');
  }, [setUser]);

  const handleAutoLogin = useCallback(async (storedEmail: string) => {
    try {
      const normalizedEmail = storedEmail.toLowerCase().trim();
      const metadata = await OfflineSessionService.getMetadata(normalizedEmail);
      const user = await DatabaseService.getUserByEmail(normalizedEmail);
      if (!metadata || !user || (metadata.mode === 'demo' && !DEMO_MODE)) return;
      const eventId = metadata.mode === 'production'
        ? await SyncService.getCurrentEventId()
        : metadata.eventId;
      if (eventId == null) return;
      const deviceId = await SyncService.getDeviceId();
      const credential = metadata.mode === 'production'
        ? await DatabaseService.getQrCredential(eventId, user.id)
        : null;
      const session = await OfflineSessionService.getValid({
        userId: user.id,
        email: normalizedEmail,
        eventId,
        deviceId,
        tokenBinding: ApiClient.getTokenBinding(),
        credentialVersion: credential?.payload.credential_version ?? null,
      });
      if (!session) return;
      if (await BiometricService.isEnabled()) {
        const ok = await BiometricService.authenticate('Unlock VeriGate Pass');
        if (!ok) return;
      }
      await completeLogin(user);
    } catch (error) {
      console.error('Auto-login failed:', error);
    }
  }, [completeLogin]);

  const loadStoredCredentials = useCallback(async () => {
    try {
      setBiometricAvailable(await BiometricService.isAvailable());
      setBiometricEnabled(await BiometricService.isEnabled());

      const storedEmail = await DatabaseService.getStoredEmail();
      await ApiClient.loadTokens();

      if (storedEmail) {
        setEmail(storedEmail);
        setRememberMe(true);
        await handleAutoLogin(storedEmail);
      }
    } catch (error) {
      console.error('Error loading stored credentials:', error);
    }
  }, [handleAutoLogin]);

  // Load stored email on component mount
  useEffect(() => {
    loadStoredCredentials();
  }, [loadStoredCredentials]);

  const handleLogin = async () => {
    if (!email.trim()) {
      Alert.alert('Error', 'Please enter your email address');
      return;
    }

    setIsLoading(true);

    try {
      const normalizedEmail = email.toLowerCase().trim();

      if (!password && !DEMO_MODE) {
        Alert.alert('Password Required', 'Production mode requires backend authentication.');
        return;
      }

      let eventId = 0;
      let mode: 'production' | 'demo' = 'demo';
      if (password) {
        await ApiClient.login(normalizedEmail, password);
        const sync = await SyncService.syncNow();
        if (!sync.success || !sync.eventId) {
          await ApiClient.clearTokens();
          throw new Error(sync.error || 'Credential sync failed');
        }
        eventId = sync.eventId;
        mode = 'production';
      }
      const user = await DatabaseService.getUserByEmail(normalizedEmail);

      if (user) {
        const deviceId = await SyncService.getDeviceId();
        const credential = mode === 'production'
          ? await DatabaseService.getQrCredential(eventId, user.id)
          : null;
        await OfflineSessionService.create(user.id, normalizedEmail, eventId, mode, {
          deviceId,
          tokenBinding: ApiClient.getTokenBinding(),
          credentialVersion: credential?.payload.credential_version ?? null,
        });
        // Store credentials if remember me is enabled
        if (rememberMe) {
          await DatabaseService.storeUserCredentials(normalizedEmail, true);
        } else {
          await DatabaseService.clearStoredCredentials();
        }

        await completeLogin(user);
      } else {
        Alert.alert(
          'Login Failed',
          DEMO_MODE
            ? 'User not found. Check the email or reset the demo data.'
            : 'No synchronized credential was found for this authenticated account.'
        );
      }
    } catch (error) {
      Alert.alert('Login Failed', error instanceof Error ? error.message : 'Login failed. Please try again.');
      console.error('Login error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const showDemoUsers = async () => {
    try {
      const demoUsers = await DatabaseService.getDemoUsers();
      
      if (demoUsers.length === 0) {
        Alert.alert('Demo Users', 'No demo users found in database.');
        return;
      }

      const userList = demoUsers
        .map(user => `• ${user.email} (${user.access_level})`)
        .join('\n');

      Alert.alert(
        'Demo Users',
        'Available demo accounts:\n\n' + userList + '\n\nAll users are stored in encrypted SQLite database.',
        [
          { text: 'Reset Demo Data', style: 'destructive', onPress: resetDemoData },
          { text: 'OK', style: 'default' }
        ]
      );
    } catch (error) {
      console.error('Error loading demo users:', error);
      Alert.alert('Error', 'Failed to load demo users from database.');
    }
  };

  const resetDemoData = async () => {
    Alert.alert(
      'Reset Demo Data',
      'This will reset all demo users in the database. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await DatabaseService.resetDemoData();
              Alert.alert('Success', 'Demo data has been reset.');
            } catch {
              Alert.alert('Error', 'Failed to reset demo data.');
            }
          }
        }
      ]
    );
  };

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.content}>
          <Text style={styles.title}>VeriGate Pass</Text>
          <Text style={styles.subtitle}>Secure Digital Access</Text>

          <View style={styles.formContainer}>
            <Text style={styles.label}>Email Address</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="Enter your email"
              placeholderTextColor="#6b7280"
              selectionColor="#2563eb"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />

            <Text style={styles.label}>{DEMO_MODE ? 'Password (blank only for demo accounts)' : 'Password'}</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder={DEMO_MODE ? 'Blank selects explicit demo mode' : 'Enter your backend password'}
              placeholderTextColor="#6b7280"
              selectionColor="#2563eb"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />

            <View style={styles.rememberMeContainer}>
              <Switch
                value={rememberMe}
                onValueChange={setRememberMe}
                trackColor={{ false: '#d1d5db', true: '#93c5fd' }}
                thumbColor={rememberMe ? '#2563eb' : '#f4f3f4'}
              />
              <Text style={styles.rememberMeText}>Remember me</Text>
            </View>

            {biometricAvailable && rememberMe && (
              <View style={styles.rememberMeContainer}>
                <Switch
                  value={biometricEnabled}
                  onValueChange={(enabled) => {
                    setBiometricEnabled(enabled);
                    BiometricService.setEnabled(enabled);
                  }}
                  trackColor={{ false: '#d1d5db', true: '#93c5fd' }}
                  thumbColor="#2563eb"
                />
                <Text style={styles.rememberMeText}>Require biometric unlock</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.loginButton, isLoading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={isLoading}
            >
              <Text style={styles.loginButtonText}>
                {isLoading ? 'Logging in...' : 'Login'}
              </Text>
            </TouchableOpacity>

            {DEMO_MODE && <TouchableOpacity
              style={styles.demoButton}
              onPress={showDemoUsers}
            >
              <Text style={styles.demoButtonText}>View Demo Users</Text>
            </TouchableOpacity>}
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              Secure QR Code Generation
            </Text>
            <Text style={styles.footerSubtext}>
              Anti-screenshot protection enabled
            </Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#1e293b',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 18,
    textAlign: 'center',
    color: '#64748b',
    marginBottom: 40,
  },
  formContainer: {
    backgroundColor: '#ffffff',
    padding: 24,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#111827',
    backgroundColor: '#f9fafb',
    marginBottom: 20,
  },
  rememberMeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  rememberMeText: {
    marginLeft: 8,
    fontSize: 14,
    color: '#374151',
  },
  loginButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: {
    backgroundColor: '#9ca3af',
  },
  loginButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  demoButton: {
    borderWidth: 1,
    borderColor: '#2563eb',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  demoButtonText: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '500',
  },
  footer: {
    marginTop: 40,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '500',
  },
  footerSubtext: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 4,
  },
});
