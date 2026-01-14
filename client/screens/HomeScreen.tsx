import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useStore } from '../stores/useStore';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

type RootStackParamList = {
  Home: undefined;
  ContactList: undefined;
  InboxList: undefined;
  Chat: { targetUser: string };
};

type HomeScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Home'>;

interface Props {
  navigation: HomeScreenNavigationProp;
}

// Pulsing Box icon component
const BoxIcon: React.FC<{ isFull: boolean; pulseAnim: Animated.Value }> = ({ isFull, pulseAnim }) => {
  const boxColor = isFull ? '#8A2BE2' : '#9CA3AF'; // Electric Purple when full, Gray when empty
  const boxSize = 120;

  const animatedStyle = {
    transform: [
      {
        scale: pulseAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 1.1],
        }),
      },
    ],
    opacity: pulseAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0.7],
    }),
  };

  return (
    <Animated.View
      style={[
        styles.boxIcon,
        {
          width: boxSize,
          height: boxSize,
          backgroundColor: boxColor,
          borderRadius: 16,
        },
        animatedStyle,
      ]}
    >
      <Text style={styles.boxIconText}>📦</Text>
    </Animated.View>
  );
};

export default function HomeScreen({ navigation }: Props) {
  // Block screenshots immediately on mount
  usePreventScreenCapture();

  const { userId, hasUnread, initialize } = useStore();
  const pulseAnim = useRef(new Animated.Value(0)).current;

  // Initialize store on mount
  useEffect(() => {
    initialize();
  }, []);

  // Pulsing animation for the box
  useEffect(() => {
    if (hasUnread) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(0);
    }
  }, [hasUnread, pulseAnim]);

  const handleBoxTap = () => {
    if (hasUnread) {
      navigation.navigate('InboxList');
    }
  };

  const handleCompose = () => {
    navigation.navigate('ContactList');
  };

  return (
    <View style={styles.container}>
      {/* Header: Purple Box title */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Purple Box</Text>
      </View>

      {/* Center: Pulsing Box icon */}
      <View style={styles.centerContent}>
        <TouchableOpacity
          onPress={handleBoxTap}
          disabled={!hasUnread}
          activeOpacity={0.7}
          style={styles.boxContainer}
        >
          <BoxIcon isFull={hasUnread} pulseAnim={pulseAnim} />
          {hasUnread && (
            <Text style={styles.tapHint}>Tap to open</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Bottom Center: Floating Action Button */}
      <View style={styles.bottomContainer}>
        <TouchableOpacity
          style={styles.fab}
          onPress={handleCompose}
        >
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212', // WhatsApp Dark Mode
  },
  header: {
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1F1F1F',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#9CA3AF', // Gray color similar to WhatsApp
  },
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  boxIconText: {
    fontSize: 64,
  },
  tapHint: {
    marginTop: 16,
    fontSize: 14,
    color: '#8A2BE2',
    fontWeight: '500',
  },
  bottomContainer: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#8A2BE2', // Electric Purple
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  fabText: {
    fontSize: 32,
    color: '#FFFFFF',
    fontWeight: '300',
    textAlign: 'center',
    lineHeight: 32,
  },
});
