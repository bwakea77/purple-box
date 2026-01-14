// CRITICAL: Import react-native-get-random-values FIRST before any other imports
// This is required for tweetnacl to work on React Native
import 'react-native-get-random-values';

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { AppState, AppStateStatus, View, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NavigationContainerRef } from '@react-navigation/native';
import { useStore } from './stores/useStore';
import { log } from './utils/logger';
import HomeScreen from './screens/HomeScreen';
import ContactListScreen from './screens/ContactListScreen';
import InboxListScreen from './screens/InboxListScreen';
import ChatScreen from './screens/ChatScreen';
import PhoneNumberScreen from './screens/auth/PhoneNumberScreen';
import OtpScreen from './screens/auth/OtpScreen';

export type AuthStackParamList = {
  PhoneNumber: undefined;
  Otp: { phoneNumber: string };
};

export type AppStackParamList = {
  Home: undefined;
  ContactList: undefined;
  InboxList: undefined;
  Chat: { targetUser: string };
};

export type RootStackParamList = AuthStackParamList & AppStackParamList;

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();

export default function App() {
  const appState = useRef(AppState.currentState);
  const navigationRef = useRef<NavigationContainerRef<RootStackParamList>>(null);
  const { wipe, checkLogin, isAuthenticated, checkInbox } = useStore();
  const [isLoading, setIsLoading] = useState(true);
  const [stableAuthState, setStableAuthState] = useState<boolean>(isAuthenticated);
  const authTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialMount = useRef(true);

  // Check login status on app launch
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await checkLogin();
      setIsLoading(false);
    };
    init();
  }, []);

  // Stabilize auth state to prevent rapid toggling during navigation
  useEffect(() => {
    log.debug('[App] auth state effect', { isAuthenticated, stableAuthState });
    // On initial mount, set immediately
    if (isInitialMount.current) {
      isInitialMount.current = false;
      setStableAuthState(isAuthenticated);
      return;
    }

    // Clear any pending timeout
    if (authTimeoutRef.current) {
      clearTimeout(authTimeoutRef.current);
    }

    // If auth state changes, update stable state accordingly
    // For login (false->true), update immediately to prevent navigation issues
    // For logout (true->false), use a delay to prevent flickering
    if (isAuthenticated !== stableAuthState) {
      log.debug('[App] auth state mismatch', { isAuthenticated, stableAuthState });
      if (isAuthenticated) {
        // Login: Update immediately
        log.debug('[App] stableAuthState -> true (login)');
        setStableAuthState(true);
      } else {
        // Logout: Use delay to prevent flickering
        log.debug('[App] scheduling stableAuthState -> false (logout)');
        authTimeoutRef.current = setTimeout(() => {
          log.debug('[App] stableAuthState -> false (logout timeout fired)');
          setStableAuthState(false);
        }, 500);
      }
    }

    return () => {
      if (authTimeoutRef.current) {
        clearTimeout(authTimeoutRef.current);
      }
    };
  }, [isAuthenticated]);

  // Set up notification response listener
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      // Avoid logging full notification payloads; keep metadata only.
      log.info('[App] notification tapped');
      
      // Navigate to InboxList screen if navigation is ready
      // Otherwise navigate to Home (user can tap box to go to InboxList)
      if (navigationRef.current?.isReady()) {
        navigationRef.current.navigate('InboxList');
      } else {
        // Navigation not ready yet, try Home as fallback
        navigationRef.current?.navigate('Home');
      }

      // Refresh inbox to ensure new message is visible
      checkInbox().catch((error) => {
        log.error('[App] error checking inbox after notification', error);
      });
    });

    return () => {
      subscription.remove();
    };
  }, [checkInbox]);

  // Set up AppState listener to wipe data when app goes to background
  // This is critical for security - ensures data is wiped from RAM immediately
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      // If app is transitioning from active to background/inactive
      // CRITICAL: Only wipe when actually going to background, not during navigation transitions
      if (
        appState.current === 'active' &&
        (nextAppState === 'inactive' || nextAppState === 'background')
      ) {
        log.info('[App] app backgrounded - wiping session data');
        // Wipe session data from RAM immediately (but preserve auth state)
        wipe();
      }

      // If app is coming back to foreground, check login and reconnect if authenticated
      // CRITICAL: Only check login if we were actually in background/inactive, not during normal navigation
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        log.info('[App] app foregrounded - checking login');
        // Check login when coming back to foreground
        // Use longer timeout and check if already authenticated to prevent navigation issues
        setTimeout(() => {
          const currentState = useStore.getState();
          // Only check login if not already authenticated - prevents state reset during navigation
          if (!currentState.isAuthenticated) {
            log.info('[App] not authenticated; checking login');
            checkLogin().catch((error) => {
              log.error('[App] error checking login after foreground', error);
            });
          } else {
            log.debug('[App] already authenticated; skipping checkLogin');
          }
        }, 2000); // Increased timeout to prevent interference with navigation transitions
      }

      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [wipe, checkLogin]);

  // Show loading screen while checking login
  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#8A2BE2" />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={DarkTheme}>
      {stableAuthState ? (
        <AppStack.Navigator
          initialRouteName="Home"
          screenOptions={{
            headerStyle: {
              backgroundColor: '#000000',
            },
            headerTintColor: '#FFFFFF',
            headerTitleStyle: {
              fontWeight: '600',
            },
          }}
        >
          <AppStack.Screen
            name="Home"
            component={HomeScreen}
            options={{
              headerShown: false,
            }}
          />
          <AppStack.Screen
            name="ContactList"
            component={ContactListScreen}
            options={{
              headerShown: true,
              title: 'Select Contact',
            }}
          />
          <AppStack.Screen
            name="InboxList"
            component={InboxListScreen}
            options={{
              headerShown: true,
              title: 'Inbox',
            }}
          />
          <AppStack.Screen
            name="Chat"
            component={ChatScreen}
            options={{
              headerShown: true,
              title: 'Chat',
            }}
          />
        </AppStack.Navigator>
      ) : (
        <AuthStack.Navigator
          initialRouteName="PhoneNumber"
          screenOptions={{
            headerStyle: {
              backgroundColor: '#000000',
            },
            headerTintColor: '#FFFFFF',
            headerTitleStyle: {
              fontWeight: '600',
            },
          }}
        >
          <AuthStack.Screen
            name="PhoneNumber"
            component={PhoneNumberScreen}
            options={{
              headerShown: false,
            }}
          />
          <AuthStack.Screen
            name="Otp"
            component={OtpScreen}
            options={{
              headerShown: true,
              title: 'Verification',
            }}
          />
        </AuthStack.Navigator>
      )}
      <StatusBar style="light" />
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
