import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { useSharedValue, withRepeat, withTiming, withSequence, useAnimatedStyle, cancelAnimation } from 'react-native-reanimated';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useStore } from '../stores/useStore';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

type RootStackParamList = {
  Home: undefined;
  ContactList: undefined;
  InboxList: undefined;
  Chat: { targetUser: string };
};

type BoxScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Home'>;

interface Props {
  navigation: BoxScreenNavigationProp;
}

// Pulsing Box component with react-native-reanimated
const BoxIcon: React.FC<{ isFull: boolean }> = ({ isFull }) => {
  const boxSize = 120;
  const scale = useSharedValue(1.0);
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    if (isFull) {
      // FULL state: Purple with breathing animation
      // Scale: 1.0 to 1.1, Opacity: 0.8 to 1.0
      // Cancel any existing animations and set initial values
      cancelAnimation(scale);
      cancelAnimation(opacity);
      scale.value = 1.0;
      opacity.value = 0.8;
      // Then start the repeating animation
      scale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 1000 }),
          withTiming(1.0, { duration: 1000 })
        ),
        -1,
        false
      );
      opacity.value = withRepeat(
        withSequence(
          withTiming(1.0, { duration: 1000 }),
          withTiming(0.8, { duration: 1000 })
        ),
        -1,
        false
      );
    } else {
      // EMPTY state: Gray, no animation
      cancelAnimation(scale);
      cancelAnimation(opacity);
      scale.value = withTiming(1.0, { duration: 200 });
      opacity.value = withTiming(0.5, { duration: 200 });
    }
  }, [isFull]);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
    };
  });

  const boxColor = isFull ? '#8A2BE2' : '#4A4A4A';

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

export default function BoxScreen({ navigation }: Props) {
  // Block screenshots immediately on mount
  usePreventScreenCapture();

  const { hasUnread, initialize } = useStore();

  // Initialize store on mount
  useEffect(() => {
    initialize();
  }, []);

  // Handle box tap - navigate to InboxList when full
  const handleBoxTap = () => {
    if (hasUnread) {
      navigation.navigate('InboxList');
    }
  };

  // Handle FAB tap - navigate to ContactList
  const handleCompose = () => {
    navigation.navigate('ContactList');
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      
      {/* Center: Box icon */}
      <View style={styles.centerContent}>
        <TouchableOpacity
          onPress={handleBoxTap}
          disabled={!hasUnread}
          activeOpacity={0.7}
          style={styles.boxContainer}
        >
          <BoxIcon isFull={hasUnread} />
        </TouchableOpacity>
      </View>

      {/* Bottom Right: Floating Action Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleCompose}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212', // Almost Black
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
  fab: {
    position: 'absolute',
    bottom: 40,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2C2C2C', // Dark Gray
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
    color: '#FFFFFF', // White
    fontWeight: '300',
    textAlign: 'center',
    lineHeight: 32,
  },
});
