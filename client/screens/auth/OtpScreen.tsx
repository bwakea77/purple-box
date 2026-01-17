import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { getOrGenerateKeys, publicKeyToBase64, type KeyPair } from '../../services/CryptoService';
import { useStore } from '../../stores/useStore';
import type { AuthStackParamList } from '../../App';
import { log } from '../../utils/logger';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://purple-box.onrender.com';

type OtpScreenNavigationProp = NativeStackNavigationProp<AuthStackParamList, 'Otp'>;
type OtpScreenRouteProp = RouteProp<AuthStackParamList, 'Otp'>;

interface Props {
  navigation: OtpScreenNavigationProp;
  route: OtpScreenRouteProp;
}

/**
 * Register for push notifications and get push token
 */
async function getPushToken(): Promise<string | null> {
  try {
    // Check if running on a physical device
    if (!Device.isDevice) {
      log.debug('[OtpScreen] push notifications not available on simulator/emulator');
      return null;
    }

    // Request permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      log.debug('[OtpScreen] push notification permission not granted');
      return null;
    }

    // Get the push token
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;

    log.info('[OtpScreen] push token registered');
    return token;
  } catch (error) {
    log.error('[OtpScreen] error registering for push notifications', error);
    return null;
  }
}

export default function OtpScreen({ navigation, route }: Props) {
  const { phoneNumber } = route.params;
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [isLoading, setIsLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(120); // 2 minutes in seconds
  const [isResendDisabled, setIsResendDisabled] = useState(true);
  const [isResending, setIsResending] = useState(false);
  const inputRefs = useRef<Array<TextInput | null>>([]);
  const autofillInputRef = useRef<TextInput | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const login = useStore((state) => state.login);
  const requestOtp = useStore((state) => state.requestOtp);

  // Start resend timer on mount
  useEffect(() => {
    setResendTimer(120);
    setIsResendDisabled(true);

    // Start countdown timer
    timerIntervalRef.current = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 1) {
          setIsResendDisabled(false);
          if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Focus first input on mount
    inputRefs.current[0]?.focus();
  }, []);

  const handleCodeChange = (value: string, index: number) => {
    // Only allow digits
    const digit = value.replace(/[^0-9]/g, '');
    
    if (digit) {
      const newCode = [...code];
      newCode[index] = digit;
      setCode(newCode);

      // Auto-focus next input
      if (index < 5 && digit) {
        inputRefs.current[index + 1]?.focus();
      }
    } else {
      // Handle backspace
      const newCode = [...code];
      newCode[index] = '';
      setCode(newCode);

      // Focus previous input on backspace
      if (index > 0 && !digit) {
        inputRefs.current[index - 1]?.focus();
      }
    }
  };

  // Handle SMS autofill
  const handleAutofillChange = (value: string) => {
    // Extract only digits
    const digits = value.replace(/[^0-9]/g, '').slice(0, 6);
    
    if (digits.length === 6) {
      // Split into array and update code
      const newCode = digits.split('');
      setCode(newCode);
      
      // Focus last input
      inputRefs.current[5]?.focus();
    }
  };

  const handleResendCode = async () => {
    if (isResendDisabled || isResending) return;

    setIsResending(true);

    try {
      const result = await requestOtp(phoneNumber);
      
      if (!result.success) {
        Alert.alert('Error', result.error || 'Failed to resend code');
        return;
      }

      // Reset timer
      setResendTimer(120);
      setIsResendDisabled(true);

      // Clear existing interval
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }

      // Start new countdown
      timerIntervalRef.current = setInterval(() => {
        setResendTimer((prev) => {
          if (prev <= 1) {
            setIsResendDisabled(false);
            if (timerIntervalRef.current) {
              clearInterval(timerIntervalRef.current);
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      Alert.alert('Success', 'Verification code resent');
    } catch (error) {
      log.error('[OtpScreen] error resending code', error);
      Alert.alert('Error', 'Failed to resend code. Please try again.');
    } finally {
      setIsResending(false);
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleKeyPress = (key: string, index: number) => {
    // Handle backspace when input is empty
    if (key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const codeString = code.join('');
    
    if (codeString.length !== 6) {
      Alert.alert('Error', 'Please enter the complete 6-digit code');
      return;
    }

    setIsLoading(true);

    try {
      // Generate key pair
      const keyPair: KeyPair = await getOrGenerateKeys();
      const publicKeyBase64 = publicKeyToBase64(keyPair.publicKey);

      // Get push token
      const pushToken = await getPushToken();

      // Verify OTP
      const response = await fetch(`${SERVER_URL}/auth/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phoneNumber,
          code: codeString,
          publicKey: publicKeyBase64,
          pushToken: pushToken,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to verify OTP');
      }

      // Login using the new login action (saves token, sets state, connects socket)
      await login(phoneNumber, data.token, data.userId);

      log.info('[OtpScreen] OTP verified; logged in');

      // Navigation will happen automatically when isAuthenticated becomes true
      // The App component will switch from AuthStack to AppStack
    } catch (error) {
      log.error('[OtpScreen] error verifying OTP', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to verify OTP. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Enter Verification Code</Text>
        <View style={styles.phoneNumberContainer}>
          <Text style={styles.subtitle}>
            Enter the code sent to{'\n'}
            <Text style={styles.phoneNumber}>{phoneNumber}</Text>
          </Text>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.editLink}
            disabled={isLoading}
          >
            <Text style={styles.editLinkText}>Edit / Wrong number?</Text>
          </TouchableOpacity>
        </View>

        {/* Hidden TextInput for SMS autofill */}
        <TextInput
          ref={autofillInputRef}
          style={styles.autofillInput}
          value=""
          onChangeText={handleAutofillChange}
          keyboardType="number-pad"
          autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'off'}
          textContentType={Platform.OS === 'ios' ? 'oneTimeCode' : undefined}
          maxLength={6}
        />

        <View style={styles.codeContainer}>
          {code.map((digit, index) => (
            <TextInput
              key={index}
              ref={(ref) => (inputRefs.current[index] = ref)}
              style={styles.codeInput}
              value={digit}
              onChangeText={(value) => handleCodeChange(value, index)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
              keyboardType="number-pad"
              maxLength={1}
              selectTextOnFocus
              editable={!isLoading}
            />
          ))}
        </View>

        <TouchableOpacity
          style={[styles.button, isLoading && styles.buttonDisabled]}
          onPress={handleVerify}
          disabled={isLoading}
          activeOpacity={0.8}
        >
          {isLoading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Verify</Text>
          )}
        </TouchableOpacity>

        <View style={styles.resendContainer}>
          <Text style={styles.resendText}>Didn't receive the code? </Text>
          <TouchableOpacity
            onPress={handleResendCode}
            disabled={isResendDisabled || isResending}
            style={styles.resendButton}
          >
            {isResendDisabled ? (
              <Text style={styles.resendButtonTextDisabled}>
                Resend code ({formatTime(resendTimer)})
              </Text>
            ) : (
              <Text style={styles.resendButtonText}>
                {isResending ? 'Resending...' : 'Resend code'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    padding: 20,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  phoneNumberContainer: {
    alignItems: 'center',
    marginBottom: 40,
    width: '100%',
  },
  subtitle: {
    fontSize: 16,
    color: '#888888',
    textAlign: 'center',
    marginBottom: 8,
  },
  phoneNumber: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  editLink: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  editLinkText: {
    color: '#9333EA',
    fontSize: 14,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
  autofillInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
  },
  codeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 30,
    paddingHorizontal: 10,
  },
  codeInput: {
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#333333',
    borderRadius: 8,
    width: 50,
    height: 60,
    fontSize: 24,
    color: '#FFFFFF',
    textAlign: 'center',
    fontWeight: '600',
  },
  button: {
    backgroundColor: '#9333EA',
    borderRadius: 8,
    padding: 16,
    width: '100%',
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  resendContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    flexWrap: 'wrap',
  },
  resendText: {
    color: '#888888',
    fontSize: 14,
  },
  resendButton: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  resendButtonText: {
    color: '#9333EA',
    fontSize: 14,
    fontWeight: '500',
  },
  resendButtonTextDisabled: {
    color: '#555555',
    fontSize: 14,
    fontWeight: '500',
  },
});