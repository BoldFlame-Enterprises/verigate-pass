// app/(main)/qr-display.tsx - QR Display screen
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Dimensions,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { router } from 'expo-router';
import { useUser } from '@/context/UserContext';
import { DatabaseService } from '@/services/DatabaseService';
import { SyncService } from '@/services/SyncService';
import { SyncScheduler } from '@/services/SyncScheduler';
import { NotificationService } from '@/services/NotificationService';
import { ApiClient } from '@/services/ApiClient';
import { DEMO_MODE, QR_EXPIRY_WARNING_MS } from '@/config';
import { QrCredentialService } from '@/services/QrCredentialService';
import { OfflineSessionService } from '@/services/OfflineSessionService';

const { width } = Dimensions.get('window');
const QR_SIZE = width * 0.7;

export default function QRDisplayScreen() {
  const { user, setUser } = useUser();
  const [qrData, setQrData] = useState('');
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [systemInfo, setSystemInfo] = useState<{areas: string[], levels: string[]}>({areas: [], levels: []});
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const syncedStateRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const authenticatedUserId = user?.id;

  const generateQRData = useCallback(async () => {
    if (!user) return '';

    try {
      const session = await OfflineSessionService.getMetadata(user.email);
      const eventId = (await SyncService.getCurrentEventId()) ?? session?.eventId ?? null;
      if (eventId == null) throw new Error('No bounded event session is selected');
      const credential = await DatabaseService.getQrCredential(eventId, user.id);
      if (!credential) {
        if (DEMO_MODE) return QrCredentialService.createDemoPresentation(user, eventId);
        throw new Error('No current signed credential; connect and sync');
      }
      const presentation = await QrCredentialService.createPresentation(credential);
      NotificationService.scheduleQrExpiryReminder(credential.payload.expires_at, QR_EXPIRY_WARNING_MS).catch(() => undefined);
      return presentation;
    } catch (error) {
      console.error('Error generating secure QR:', error);
      return '';
    }
  }, [user]);

  const refreshQR = useCallback(async () => {
    const newQrData = await generateQRData();
    if (!mountedRef.current) return;
    setQrData(newQrData);
    setLastUpdated(new Date());
  }, [generateQRData]);

  const loadSystemInfo = useCallback(async () => {
    if (user?.event_id == null) return;
    try {
      const areas = await DatabaseService.getAvailableAreas(user.event_id);
      const levels = await DatabaseService.getAvailableAccessLevels(user.event_id);
      if (mountedRef.current) setSystemInfo({ areas, levels });
    } catch (error) {
      console.error('Error loading system info:', error);
    }
  }, [user?.event_id]);

  const refreshSyncedState = useCallback(async () => {
    if (!user || user.event_id == null) return;
    const refreshed = await DatabaseService.getUserById(user.id, user.event_id);
    if (!mountedRef.current) return;
    if (refreshed) setUser(refreshed);
    await Promise.all([refreshQR(), loadSystemInfo()]);
  }, [user, setUser, refreshQR, loadSystemInfo]);

  syncedStateRefreshRef.current = refreshSyncedState;

  const handleSyncNow = useCallback(async () => {
    if (!user) return;
    setIsSyncing(true);
    try {
      const result = await SyncScheduler.syncNow();
      if (!mountedRef.current) return;
      if (result.success) {
        setSyncStatus(`Synced your credential with ${result.eventName}`);
      } else {
        setSyncStatus(result.error ?? 'Sync unavailable offline');
      }
    } finally {
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [user]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!authenticatedUserId || !ApiClient.isAuthenticated()) return;
    SyncScheduler.start({
      onSuccess: () => syncedStateRefreshRef.current(),
    });
    return () => SyncScheduler.stop();
  }, [authenticatedUserId]);

  useEffect(() => {
    refreshQR();
    loadSystemInfo();
    
    // Short-lived device-signed presentations rotate every 30 seconds.
    const interval = setInterval(() => {
      refreshQR();
    }, 30 * 1000);

    return () => clearInterval(interval);
  }, [refreshQR, loadSystemInfo]);

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            SyncScheduler.stop();
            // Clear stored credentials and tokens
            await DatabaseService.clearStoredCredentials();
            await DatabaseService.clearUserToken();
            await ApiClient.clearTokens();
            await OfflineSessionService.clear();
            await NotificationService.cancelQrExpiryReminder();

            setUser(null);
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  };

  const showAccessDetails = () => {
    if (!user) return;

    const allAreas = systemInfo.areas.length > 0 ? systemInfo.areas : user.allowed_areas;
    const userAreas = user.allowed_areas;
    const deniedAreas = allAreas.filter(area => !userAreas.includes(area));

    Alert.alert(
      'Access Details',
      `Name: ${user.name}\n\n` +
      `Access Level: ${user.access_level}\n\n` +
      `Phone: ${user.phone}\n\n` +
      `✅ PERMITTED AREAS:\n• ${userAreas.join('\n• ')}\n\n` +
      (deniedAreas.length > 0 ? `❌ RESTRICTED AREAS:\n• ${deniedAreas.join('\n• ')}\n\n` : '') +
      `📊 SYSTEM INFO:\n` +
      `• Total Areas: ${allAreas.length}\n` +
      `• Access Levels: ${systemInfo.levels.join(', ')}\n` +
      `• Data Source: Encrypted SQLite`,
      [{ text: 'OK' }]
    );
  };

  if (!user) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>User data not available</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace('/(auth)/login')}>
          <Text style={styles.buttonText}>Back to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const getAccessLevelColor = (level: string) => {
    switch (level.toLowerCase()) {
      case 'management': return '#7c3aed';
      case 'vip': return '#dc2626';
      case 'security': return '#ea580c';
      case 'staff': return '#059669';
      case 'general': default: return '#2563eb';
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.welcomeText}>Welcome</Text>
        <Text style={styles.nameText}>{user.name}</Text>
        <View style={[styles.accessBadge, { backgroundColor: getAccessLevelColor(user.access_level) }]}>
          <Text style={styles.accessText}>{user.access_level.toUpperCase()}</Text>
        </View>
      </View>

      <View style={styles.qrContainer}>
        <Text style={styles.qrTitle}>Your Access QR Code</Text>
        <View style={styles.qrWrapper}>
          {qrData ? (
            <QRCode
              value={qrData}
              size={QR_SIZE}
              color="#000000"
              backgroundColor="#ffffff"
            />
          ) : (
            <View style={[styles.qrPlaceholder, { width: QR_SIZE, height: QR_SIZE }]}>
              <Text>Loading QR Code...</Text>
            </View>
          )}
        </View>
        <Text style={styles.lastUpdated}>
          Last updated: {lastUpdated.toLocaleTimeString()}
        </Text>
      </View>

      <View style={styles.infoContainer}>
        <Text style={styles.infoTitle}>Access Information</Text>
        <Text style={styles.infoText}>
          You have {user.access_level} level access to {user.allowed_areas.length} areas
        </Text>
        
        <TouchableOpacity style={styles.detailsButton} onPress={showAccessDetails}>
          <Text style={styles.detailsButtonText}>View Access Details</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.refreshButton} onPress={refreshQR}>
          <Text style={styles.refreshButtonText}>Refresh QR Code</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.refreshButton, styles.syncButton]} onPress={handleSyncNow} disabled={isSyncing}>
          <Text style={styles.refreshButtonText}>{isSyncing ? 'Syncing...' : 'Sync with event'}</Text>
        </TouchableOpacity>
        {syncStatus && <Text style={styles.syncStatusText}>{syncStatus}</Text>}
      </View>

      <View style={styles.warningContainer}>
        <Text style={styles.warningTitle}>⚠️ Security Notice</Text>
        <Text style={styles.warningText}>
          • QR presentations are device-key signed and expire quickly
        </Text>
        <Text style={styles.warningText}>
          • Code refreshes automatically for security
        </Text>
        <Text style={styles.warningText}>
          • Screenshots may work briefly; never share them
        </Text>
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutButtonText}>Logout</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  content: {
    padding: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 30,
  },
  welcomeText: {
    fontSize: 18,
    color: '#6b7280',
    marginBottom: 4,
  },
  nameText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 12,
    textAlign: 'center',
  },
  accessBadge: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  accessText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  qrContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  qrTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 20,
  },
  qrWrapper: {
    padding: 20,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  qrPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
  },
  lastUpdated: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 12,
  },
  infoContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 16,
  },
  detailsButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  detailsButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
  refreshButton: {
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  refreshButtonText: {
    color: '#3b82f6',
    fontSize: 14,
    fontWeight: '500',
  },
  syncButton: {
    marginTop: 12,
  },
  syncStatusText: {
    marginTop: 8,
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
  },
  warningContainer: {
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  warningTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#92400e',
    marginBottom: 8,
  },
  warningText: {
    fontSize: 12,
    color: '#92400e',
    marginBottom: 4,
  },
  logoutButton: {
    backgroundColor: '#ef4444',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  logoutButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 18,
    color: '#ef4444',
    marginBottom: 20,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
