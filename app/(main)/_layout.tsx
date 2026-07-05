// app/(main)/_layout.tsx - Main app layout
import { Stack, router } from 'expo-router';
import { useCallback } from 'react';
import { useUser } from '@/context/UserContext';
import { DatabaseService } from '@/services/DatabaseService';
import { ApiClient } from '@/services/ApiClient';
import { NotificationService } from '@/services/NotificationService';
import SecurityGate from '@/components/SecurityGate';

export default function MainLayout() {
  const { user, setUser } = useUser();

  const handleAutoLogout = useCallback(async () => {
    await DatabaseService.clearStoredCredentials();
    await DatabaseService.clearUserToken();
    await ApiClient.clearTokens();
    await NotificationService.cancelQrExpiryReminder();
    setUser(null);
    router.replace('/(auth)/login');
  }, [setUser]);

  return (
    <SecurityGate enabled={!!user} onAutoLogout={handleAutoLogout}>
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: '#2563eb',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        }}
      >
        <Stack.Screen
          name="qr-display"
          options={{
            title: 'Your QR Code',
            headerLeft: () => null, // Prevent going back
          }}
        />
      </Stack>
    </SecurityGate>
  );
}
