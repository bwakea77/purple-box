import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../App';
import { log } from '../../utils/logger';
import { parsePhoneNumber } from 'libphonenumber-js';
import { countries, getCountryByCode, getDefaultCountry, type Country } from '../../utils/countries';
import { getDeviceRegionCodeSync } from '../../utils/localization';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://purple-box.onrender.com';

type PhoneNumberScreenNavigationProp = NativeStackNavigationProp<AuthStackParamList, 'PhoneNumber'>;

interface Props {
  navigation: PhoneNumberScreenNavigationProp;
}

export default function PhoneNumberScreen({ navigation }: Props) {
  const [selectedCountry, setSelectedCountry] = useState<Country>(getDefaultCountry());
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearchQuery, setCountrySearchQuery] = useState('');

  // Auto-detect country on mount
  useEffect(() => {
    try {
      const regionCode = getDeviceRegionCodeSync();
      
      if (regionCode) {
        const detectedCountry = getCountryByCode(regionCode);
        if (detectedCountry) {
          setSelectedCountry(detectedCountry);
          log.debug('[PhoneNumberScreen] Auto-detected country', { country: detectedCountry.code });
        }
      }
    } catch (error) {
      log.warn('[PhoneNumberScreen] Failed to detect country', error);
    }
  }, []);

  // Filter countries based on search query
  const filteredCountries = useMemo(() => {
    if (!countrySearchQuery.trim()) {
      return countries;
    }
    const query = countrySearchQuery.toLowerCase();
    return countries.filter(
      country =>
        country.name.toLowerCase().includes(query) ||
        country.dialCode.includes(query) ||
        country.code.toLowerCase().includes(query)
    );
  }, [countrySearchQuery]);

  // Format phone number with spacing as user types
  const handlePhoneNumberChange = (text: string) => {
    // Remove all non-digits
    const digitsOnly = text.replace(/\D/g, '');
    
    // Limit to reasonable length (15 digits max for international numbers)
    const limitedDigits = digitsOnly.slice(0, 15);
    
    // Format with spacing for readability (groups of 3-4 digits)
    let formatted = '';
    if (limitedDigits.length <= 3) {
      formatted = limitedDigits;
    } else if (limitedDigits.length <= 6) {
      formatted = `${limitedDigits.slice(0, 3)} ${limitedDigits.slice(3)}`;
    } else if (limitedDigits.length <= 9) {
      formatted = `${limitedDigits.slice(0, 3)} ${limitedDigits.slice(3, 6)} ${limitedDigits.slice(6)}`;
    } else {
      formatted = `${limitedDigits.slice(0, 3)} ${limitedDigits.slice(3, 6)} ${limitedDigits.slice(6, 9)} ${limitedDigits.slice(9)}`;
    }
    
    setPhoneNumber(formatted);
  };

  const handleCountrySelect = (country: Country) => {
    setSelectedCountry(country);
    setShowCountryPicker(false);
    setCountrySearchQuery('');
  };

  const handleNext = async () => {
    // Validate phone number
    const trimmedPhone = phoneNumber.trim();
    if (!trimmedPhone) {
      Alert.alert('Error', 'Please enter your phone number');
      return;
    }

    // Combine country code and phone number
    const digitsOnly = trimmedPhone.replace(/\D/g, '');
    const fullPhoneNumber = `${selectedCountry.dialCode}${digitsOnly}`;

    // Validate using libphonenumber-js
    try {
      const parsedNumber = parsePhoneNumber(fullPhoneNumber, selectedCountry.code as any);
      if (!parsedNumber.isValid()) {
        Alert.alert('Error', 'Please enter a valid phone number');
        return;
      }
    } catch (error) {
      // If parsing fails, do basic validation
      if (digitsOnly.length < 7) {
        Alert.alert('Error', 'Please enter a valid phone number');
        return;
      }
    }

    setIsLoading(true);

    try {
      log.info('[PhoneNumberScreen] requesting OTP');
      const response = await fetch(`${SERVER_URL}/auth/request-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phoneNumber: fullPhoneNumber }),
      });

      log.debug('[PhoneNumberScreen] request-otp status', { status: response.status });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to request OTP');
      }

      // Navigate to OTP screen with phone number
      log.debug('[PhoneNumberScreen] navigating to Otp');
      navigation.navigate('Otp', { phoneNumber: fullPhoneNumber });
    } catch (error) {
      log.error('[PhoneNumberScreen] error requesting OTP', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to request OTP. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>
          <Text style={styles.title}>Enter Your Phone Number</Text>
          <Text style={styles.subtitle}>We'll send you a verification code</Text>

          {/* Country Selector */}
          <TouchableOpacity
            style={styles.countrySelector}
            onPress={() => setShowCountryPicker(true)}
            disabled={isLoading}
          >
            <Text style={styles.countryCode}>{selectedCountry.dialCode}</Text>
            <Text style={styles.countryName}>{selectedCountry.name}</Text>
            <Text style={styles.dropdownArrow}>▼</Text>
          </TouchableOpacity>

          {/* Phone Number Input */}
          <View style={styles.phoneInputContainer}>
            <Text style={styles.countryCodeLabel}>{selectedCountry.dialCode}</Text>
            <TextInput
              style={styles.phoneInput}
              placeholder="123 456 7890"
              placeholderTextColor="#888"
              value={phoneNumber}
              onChangeText={handlePhoneNumberChange}
              keyboardType="phone-pad"
              autoFocus
              editable={!isLoading}
            />
          </View>

          {/* Disclaimer */}
          <Text style={styles.disclaimer}>
            Purple Box will need to verify your number through SMS or call
          </Text>

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleNext}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Next</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Country Picker Modal */}
      <Modal
        visible={showCountryPicker}
        animationType="slide"
        transparent={false}
        onRequestClose={() => {
          setShowCountryPicker(false);
          setCountrySearchQuery('');
        }}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Country</Text>
            <TouchableOpacity
              onPress={() => {
                setShowCountryPicker(false);
                setCountrySearchQuery('');
              }}
            >
              <Text style={styles.modalCloseButton}>✕</Text>
            </TouchableOpacity>
          </View>
          
          <TextInput
            style={styles.countrySearchInput}
            placeholder="Search country..."
            placeholderTextColor="#888"
            value={countrySearchQuery}
            onChangeText={setCountrySearchQuery}
            autoFocus
          />

          <FlatList
            data={filteredCountries}
            keyExtractor={(item) => item.code}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.countryItem}
                onPress={() => handleCountrySelect(item)}
              >
                <Text style={styles.countryItemDialCode}>{item.dialCode}</Text>
                <Text style={styles.countryItemName}>{item.name}</Text>
                <Text style={styles.countryItemCode}>{item.code}</Text>
              </TouchableOpacity>
            )}
            style={styles.countryList}
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#888888',
    marginBottom: 30,
    textAlign: 'center',
  },
  countrySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#333333',
    borderRadius: 8,
    padding: 16,
    width: '100%',
    marginBottom: 12,
  },
  countryCode: {
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '500',
    marginRight: 8,
  },
  countryName: {
    fontSize: 16,
    color: '#FFFFFF',
    flex: 1,
  },
  dropdownArrow: {
    fontSize: 12,
    color: '#888888',
  },
  phoneInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#333333',
    borderRadius: 8,
    width: '100%',
    marginBottom: 16,
    paddingLeft: 16,
  },
  countryCodeLabel: {
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '500',
    marginRight: 8,
  },
  phoneInput: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    color: '#FFFFFF',
    paddingLeft: 0,
  },
  disclaimer: {
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
    marginBottom: 20,
    paddingHorizontal: 20,
    lineHeight: 18,
  },
  button: {
    backgroundColor: '#9333EA',
    borderRadius: 8,
    padding: 16,
    width: '100%',
    alignItems: 'center',
    marginTop: 10,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 60,
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  modalCloseButton: {
    fontSize: 24,
    color: '#FFFFFF',
    fontWeight: '300',
  },
  countrySearchInput: {
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#333333',
    borderRadius: 8,
    padding: 16,
    fontSize: 16,
    color: '#FFFFFF',
    margin: 20,
    marginBottom: 10,
  },
  countryList: {
    flex: 1,
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  countryItemDialCode: {
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '500',
    width: 70,
  },
  countryItemName: {
    fontSize: 16,
    color: '#FFFFFF',
    flex: 1,
  },
  countryItemCode: {
    fontSize: 14,
    color: '#888888',
    marginLeft: 8,
  },
});