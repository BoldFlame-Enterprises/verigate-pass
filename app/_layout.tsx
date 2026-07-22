// app/_layout.tsx - Root layout for the entire app
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as ScreenCapture from 'expo-screen-capture';
import { UserProvider } from '@/context/UserContext';
import { DatabaseService } from '@/services/DatabaseService';

export default function RootLayout() {
  useEffect(() => {
    async function setupApp() {
      try {
        // Initialize database
        await DatabaseService.initDatabase();
        
        // Enable screen capture protection
        await ScreenCapture.preventScreenCaptureAsync();
      } catch (error) {
        console.error('App setup error:', error);
      }
    }

    setupApp();

    // Cleanup function
    return () => {
      ScreenCapture.allowScreenCaptureAsync();
    };
  }, []);

  return (
    <UserProvider>
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
          name="index" 
          options={{ 
            title: 'VeriGate Pass',
            headerShown: false 
          }} 
        />
        <Stack.Screen 
          name="(auth)" 
          options={{ 
            headerShown: false 
          }} 
        />
        <Stack.Screen 
          name="(main)" 
          options={{ 
            headerShown: false 
          }} 
        />
      </Stack>
      <StatusBar style="light" />
    </UserProvider>
  );
}