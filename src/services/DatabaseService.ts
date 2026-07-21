// src/services/DatabaseService.ts - Updated for Expo
import * as SQLite from './EncryptedSQLite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { DEMO_MODE } from '../config';
import type { AuthorityCredential, CredentialAssignment } from './QrCredentialService';

export interface User {
  id: number;
  event_id?: number;
  email: string;
  name: string;
  phone: string;
  access_level: string;
  allowed_areas: string[];
  assignments?: CredentialAssignment[];
  is_active: boolean;
}

class DatabaseServiceClass {
  private database: SQLite.SQLiteDatabase | null = null;

  async initDatabase(): Promise<void> {
    try {
      this.database = await this.openWithIntegrityCheck();

      await this.createTables();
      await this.verifyIntegrityAndRecoverIfTampered();
      if (DEMO_MODE) await this.seedSampleData();
      await this.recordIntegrityChecksum();
    } catch (error) {
      console.error('Database initialization error:', error);
      throw error;
    }
  }

  /** Opens the encrypted database. If the file fails to open or fails a
   * cheap sanity query (corrupted/tampered so badly SQLCipher can't even
   * read it), it is genuinely deleted and recreated from scratch with a
   * fresh device key - not just reopened against the same broken file. */
  private async openWithIntegrityCheck(): Promise<SQLite.SQLiteDatabase> {
    try {
      const db = await SQLite.openDatabaseAsync('verigate_pass.db');
      await db.execAsync('SELECT 1'); // cheap sanity read to surface corruption early
      return db;
    } catch (error) {
      console.warn('Encrypted database failed to open (corrupted?) - deleting and recreating:', error);
      await SQLite.resetDatabase('verigate_pass.db');
      await SecureStore.deleteItemAsync('db_integrity_checksum');
      return SQLite.openDatabaseAsync('verigate_pass.db');
    }
  }

  /** Compares the current data against the last-recorded SHA-256 checksum
   * *before* this launch does any seeding/sync writes of its own. A mismatch
   * on a database that already had data and a prior checksum means the file
   * was modified outside the app between launches - the safe response is to
   * reset rather than silently trust (and build further sync state on top
   * of) altered data. */
  private async verifyIntegrityAndRecoverIfTampered(): Promise<void> {
    try {
      const previous = await SecureStore.getItemAsync('db_integrity_checksum');
      if (!previous) return; // first run, nothing to compare against yet

      const current = await this.computeIntegrityChecksum();
      if (current === previous) return;

      const existingUsers = await this.getAllUsers();
      if (existingUsers.length === 0) return; // nothing there to have been tampered with

      console.warn('Local database integrity check failed (unexpected external change) - resetting to a clean state');
      await this.database?.execAsync('DELETE FROM users');
      await SecureStore.deleteItemAsync('demo_users_seed');
      await SecureStore.deleteItemAsync('db_integrity_checksum');
    } catch (error) {
      console.warn('Integrity verification failed to run:', error);
    }
  }

  private async recordIntegrityChecksum(): Promise<void> {
    try {
      const checksum = await this.computeIntegrityChecksum();
      await SecureStore.setItemAsync('db_integrity_checksum', checksum);
    } catch (error) {
      console.warn('Could not record integrity checksum:', error);
    }
  }

  private async computeIntegrityChecksum(): Promise<string> {
    const users = await this.getAllUsers();
    const canonical = JSON.stringify(users.map((u) => ({ ...u })).sort((a, b) => a.id - b.id));
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
  }

  /** Wipes synced event data once the event has ended (plus a grace period),
   * so a lost/stolen device doesn't retain access data indefinitely. */
  async purgeIfEventExpired(eventEndsAtMs: number | null, gracePeriodMs = 24 * 60 * 60 * 1000): Promise<boolean> {
    if (!eventEndsAtMs || Date.now() < eventEndsAtMs + gracePeriodMs) return false;
    if (!this.database) return false;

    await this.database.execAsync('DELETE FROM users; DELETE FROM qr_credentials;');
    await SecureStore.deleteItemAsync('demo_users_seed');
    await this.recordIntegrityChecksum();
    return true;
  }

  private async createTables(): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const createUsersTable = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        event_id INTEGER DEFAULT 0,
        access_level TEXT NOT NULL,
        allowed_areas TEXT NOT NULL,
        assignments TEXT DEFAULT '[]',
        is_active INTEGER DEFAULT 1
      );
    `;

    await this.database.execAsync(createUsersTable);
    const columns = await this.database.getAllAsync('PRAGMA table_info(users)') as any[];
    if (!columns.some((column) => column.name === 'event_id')) {
      await this.database.execAsync('ALTER TABLE users ADD COLUMN event_id INTEGER DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'assignments')) {
      await this.database.execAsync(`ALTER TABLE users ADD COLUMN assignments TEXT DEFAULT '[]'`);
    }
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS qr_credentials (
        event_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        credential TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, user_id)
      )
    `);
  }

  private async seedSampleData(): Promise<void> {
    const existingUsers = await this.getAllUsers();
    if (existingUsers.length > 0) {
      return; // Data already seeded
    }

    // Check if we have encrypted seed data in SecureStore
    const seedData = await this.getEncryptedSeedData();
    if (seedData && seedData.length > 0) {
      for (const user of seedData) {
        await this.insertUser(user);
      }
    } else {
      // If no seed data exists, create default demo users and encrypt them
      await this.createAndStoreEncryptedSeedData();
    }
  }

  private async getEncryptedSeedData(): Promise<Omit<User, 'id'>[] | null> {
    try {
      const encryptedData = await SecureStore.getItemAsync('demo_users_seed');
      if (!encryptedData) return null;

      // Decrypt the seed data
      const decryptedData = await this.decryptData(encryptedData);
      return JSON.parse(decryptedData);
    } catch (error) {
      console.error('Error retrieving encrypted seed data:', error);
      return null;
    }
  }

  private async createAndStoreEncryptedSeedData(): Promise<void> {
    try {
      const sampleUsers: Omit<User, 'id'>[] = [
        {
          email: 'john.athlete@sports.com',
          name: 'John Athlete',
          phone: '+1234567890',
          access_level: 'General',
          allowed_areas: ['Main Arena', 'General Entrance', 'Food Court'],
          is_active: true
        },
        {
          email: 'sarah.vip@company.com',
          name: 'Sarah VIP Guest',
          phone: '+1234567891',
          access_level: 'VIP',
          allowed_areas: ['Main Arena', 'VIP Lounge', 'General Entrance', 'Food Court'],
          is_active: true
        },
        {
          email: 'mike.staff@event.com',
          name: 'Mike Staff Member',
          phone: '+1234567892',
          access_level: 'Staff',
          allowed_areas: ['Main Arena', 'Staff Area', 'General Entrance', 'Food Court'],
          is_active: true
        },
        {
          email: 'emma.security@event.com',
          name: 'Emma Security',
          phone: '+1234567893',
          access_level: 'Security',
          allowed_areas: ['Main Arena', 'Security Zone', 'Staff Area', 'General Entrance'],
          is_active: true
        },
        {
          email: 'david.manager@event.com',
          name: 'David Manager',
          phone: '+1234567894',
          access_level: 'Management',
          allowed_areas: ['Main Arena', 'VIP Lounge', 'Security Zone', 'Staff Area', 'General Entrance'],
          is_active: true
        },
        {
          email: 'lisa.coach@sports.com',
          name: 'Lisa Coach',
          phone: '+1234567895',
          access_level: 'Staff',
          allowed_areas: ['Main Arena', 'Staff Area', 'General Entrance'],
          is_active: true
        },
        {
          email: 'alex.media@news.com',
          name: 'Alex Media',
          phone: '+1234567896',
          access_level: 'General',
          allowed_areas: ['Main Arena', 'General Entrance'],
          is_active: true
        },
        {
          email: 'sophie.sponsor@corp.com',
          name: 'Sophie Sponsor',
          phone: '+1234567897',
          access_level: 'VIP',
          allowed_areas: ['Main Arena', 'VIP Lounge', 'General Entrance', 'Food Court'],
          is_active: true
        },
        {
          email: 'james.volunteer@event.com',
          name: 'James Volunteer',
          phone: '+1234567898',
          access_level: 'Staff',
          allowed_areas: ['General Entrance', 'Food Court'],
          is_active: true
        },
        {
          email: 'maria.official@sports.org',
          name: 'Maria Official',
          phone: '+1234567899',
          access_level: 'Management',
          allowed_areas: ['Main Arena', 'VIP Lounge', 'Security Zone', 'Staff Area', 'General Entrance'],
          is_active: true
        }
      ];

      // Encrypt and store the seed data
      const encryptedData = await this.encryptData(JSON.stringify(sampleUsers));
      await SecureStore.setItemAsync('demo_users_seed', encryptedData);

      // Add users to database
      for (const user of sampleUsers) {
        await this.insertUser(user);
      }
    } catch (error) {
      console.error('Error creating encrypted seed data:', error);
    }
  }

  private async encryptData(data: string): Promise<string> {
    try {
      // Generate a random salt
      const salt = await Crypto.getRandomBytesAsync(16);
      const saltBase64 = btoa(String.fromCharCode(...salt));
      
      // Create a hash with salt for encryption key
      const key = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        'demo_encryption_key_2024' + saltBase64
      );
      
      // Simple encryption using base64 encoding with key mixing
      const dataWithKey = data + '::' + key.substring(0, 32);
      const encryptedData = btoa(unescape(encodeURIComponent(dataWithKey)));
      
      return saltBase64 + '::' + encryptedData;
    } catch (error) {
      console.error('Error encrypting data:', error);
      throw error;
    }
  }

  private async decryptData(encryptedData: string): Promise<string> {
    try {
      const [saltBase64, encrypted] = encryptedData.split('::');
      
      // Recreate the key using the salt
      const key = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        'demo_encryption_key_2024' + saltBase64
      );
      
      // Decrypt the data
      const decryptedWithKey = decodeURIComponent(escape(atob(encrypted)));
      const [originalData] = decryptedWithKey.split('::' + key.substring(0, 32));
      
      return originalData;
    } catch (error) {
      console.error('Error decrypting data:', error);
      throw error;
    }
  }

  private async insertUser(user: Omit<User, 'id'>): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const insertQuery = `
      INSERT OR IGNORE INTO users (email, name, phone, access_level, allowed_areas, is_active) 
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    await this.database.runAsync(insertQuery, [
      user.email,
      user.name,
      user.phone,
      user.access_level,
      JSON.stringify(user.allowed_areas),
      user.is_active ? 1 : 0
    ]);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const query = 'SELECT * FROM users WHERE email = ? AND is_active = 1';
    const result = await this.database.getFirstAsync(query, [email]) as any;

    if (result) {
      return {
        id: result.id,
        event_id: result.event_id || 0,
        email: result.email,
        name: result.name,
        phone: result.phone,
        access_level: result.access_level,
        allowed_areas: JSON.parse(result.allowed_areas),
        assignments: JSON.parse(result.assignments || '[]'),
        is_active: result.is_active === 1
      };
    }

    return null;
  }

  async getAllUsers(): Promise<User[]> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const query = 'SELECT * FROM users WHERE is_active = 1';
    const results = await this.database.getAllAsync(query) as any[];

    return results.map(row => ({
      id: row.id,
      event_id: row.event_id || 0,
      email: row.email,
      name: row.name,
      phone: row.phone,
      access_level: row.access_level,
      allowed_areas: JSON.parse(row.allowed_areas),
      assignments: JSON.parse(row.assignments || '[]'),
      is_active: row.is_active === 1
    }));
  }

  // Secure credential storage methods
  async storeUserCredentials(email: string, rememberMe: boolean = false): Promise<void> {
    try {
      if (rememberMe) {
        await SecureStore.setItemAsync('rememberedEmail', email);
        await SecureStore.setItemAsync('lastLoginTime', Date.now().toString());
      }
    } catch (error) {
      console.error('Error storing credentials:', error);
    }
  }

  async getStoredEmail(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync('rememberedEmail');
    } catch (error) {
      console.error('Error retrieving stored email:', error);
      return null;
    }
  }

  async clearStoredCredentials(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('rememberedEmail');
      await SecureStore.deleteItemAsync('lastLoginTime');
    } catch (error) {
      console.error('Error clearing credentials:', error);
    }
  }

  async isLoginRecent(): Promise<boolean> {
    try {
      const lastLoginTime = await SecureStore.getItemAsync('lastLoginTime');
      if (!lastLoginTime) return false;
      
      const timeElapsed = Date.now() - parseInt(lastLoginTime);
      const oneDay = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      
      return timeElapsed < oneDay;
    } catch (error) {
      console.error('Error checking login time:', error);
      return false;
    }
  }

  // Store user session token (for future API integration)
  async storeUserToken(token: string): Promise<void> {
    try {
      await SecureStore.setItemAsync('userToken', token);
    } catch (error) {
      console.error('Error storing user token:', error);
    }
  }

  async getUserToken(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync('userToken');
    } catch (error) {
      console.error('Error retrieving user token:', error);
      return null;
    }
  }

  async clearUserToken(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('userToken');
    } catch (error) {
      console.error('Error clearing user token:', error);
    }
  }

  // Get demo users for display (without sensitive data)
  async getDemoUsers(): Promise<{email: string, name: string, access_level: string}[]> {
    try {
      const users = await this.getAllUsers();
      return users.map(user => ({
        email: user.email,
        name: user.name,
        access_level: user.access_level
      })).sort((a, b) => a.access_level.localeCompare(b.access_level));
    } catch (error) {
      console.error('Error getting demo users:', error);
      return [];
    }
  }

  // Get access levels available in the system
  async getAvailableAccessLevels(): Promise<string[]> {
    try {
      const users = await this.getAllUsers();
      const levels = [...new Set(users.map(user => user.access_level))];
      return levels.sort();
    } catch (error) {
      console.error('Error getting access levels:', error);
      return ['General', 'Staff', 'VIP', 'Security', 'Management'];
    }
  }

  // Get areas available in the system
  async getAvailableAreas(): Promise<string[]> {
    try {
      const users = await this.getAllUsers();
      const allAreas = users.flatMap(user => user.allowed_areas);
      const uniqueAreas = [...new Set(allAreas)];
      return uniqueAreas.sort();
    } catch (error) {
      console.error('Error getting available areas:', error);
      return ['Main Arena', 'VIP Lounge', 'Staff Area', 'Security Zone', 'General Entrance', 'Food Court'];
    }
  }

  // --- Real backend sync (Phase 7) ---
  // Upserts users pulled from GET /api/sync/users-database, preserving the
  // backend's real numeric user id so a generated QR's user_id matches what
  // the server (and the scanner app) will look up.
  async upsertSyncedUsers(users: User[]): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    for (const user of users) {
      const assignments = user.assignments ?? [];
      const primaryAssignment = [...assignments].sort((a, b) => b.access_priority - a.access_priority)[0];
      const accessLevel = primaryAssignment?.access_level_name ?? user.access_level ?? 'general';
      const allowedAreas = assignments.length > 0
        ? [...new Set(assignments.map((assignment) => assignment.area_name))]
        : user.allowed_areas ?? [];
      // A local demo-seeded row can hold this same email under a different
      // (locally-generated) id. Since email is UNIQUE, upserting by id alone
      // would violate that constraint in that case - clear the stale row first.
      await this.database.runAsync(`DELETE FROM users WHERE email = ? AND id != ?`, [user.email, user.id]);

      await this.database.runAsync(
        `INSERT INTO users (id, event_id, email, name, phone, access_level, allowed_areas, assignments, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           event_id = excluded.event_id,
           email = excluded.email,
           name = excluded.name,
           phone = excluded.phone,
           access_level = excluded.access_level,
           allowed_areas = excluded.allowed_areas,
           assignments = excluded.assignments,
           is_active = excluded.is_active`,
        [
          user.id,
          user.event_id ?? 0,
          user.email,
          user.name,
          user.phone,
          accessLevel,
          JSON.stringify(allowedAreas),
          JSON.stringify(assignments),
          user.is_active ? 1 : 0,
        ]
      );
    }

    // Sync is a legitimate data change - re-baseline the integrity checksum
    // so the next launch doesn't mistake this update for external tampering.
    await this.recordIntegrityChecksum();
  }

  async getUserById(id: number): Promise<User | null> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }
    const result = (await this.database.getFirstAsync('SELECT * FROM users WHERE id = ?', [id])) as any;
    if (!result) return null;
    return {
      id: result.id,
      event_id: result.event_id || 0,
      email: result.email,
      name: result.name,
      phone: result.phone,
      access_level: result.access_level,
      allowed_areas: JSON.parse(result.allowed_areas),
      assignments: JSON.parse(result.assignments || '[]'),
      is_active: result.is_active === 1,
    };
  }

  async storeQrCredential(credential: AuthorityCredential): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    await this.database.runAsync(
      `INSERT INTO qr_credentials (event_id, user_id, credential, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, user_id) DO UPDATE SET
         credential = excluded.credential,
         expires_at = excluded.expires_at`,
      [
        credential.payload.event_id,
        credential.payload.user_id,
        JSON.stringify(credential),
        credential.payload.expires_at,
      ]
    );
  }

  async getQrCredential(eventId: number, userId: number): Promise<AuthorityCredential | null> {
    if (!this.database) throw new Error('Database not initialized');
    const row = await this.database.getFirstAsync(
      'SELECT credential, expires_at FROM qr_credentials WHERE event_id = ? AND user_id = ?',
      [eventId, userId]
    ) as any;
    if (!row || Number(row.expires_at) <= Date.now()) return null;
    return JSON.parse(row.credential) as AuthorityCredential;
  }

  // Reset demo data (for development/testing)
  async resetDemoData(): Promise<void> {
    try {
      if (!DEMO_MODE) throw new Error('Demo data is disabled in this build');
      // Clear existing users
      await this.database?.execAsync('DELETE FROM users');
      
      // Clear encrypted seed data
      await SecureStore.deleteItemAsync('demo_users_seed');
      
      // Recreate seed data
      await this.createAndStoreEncryptedSeedData();
    } catch (error) {
      console.error('Error resetting demo data:', error);
    }
  }
}

export const DatabaseService = new DatabaseServiceClass();
