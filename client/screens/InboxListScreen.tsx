import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useStore } from '../stores/useStore';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { log } from '../utils/logger';

type RootStackParamList = {
  Home: undefined;
  ContactList: undefined;
  InboxList: undefined;
  Chat: { targetUser: string };
};

type InboxListScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'InboxList'>;

interface Props {
  navigation: InboxListScreenNavigationProp;
}

export default function InboxListScreen({ navigation }: Props) {
  usePreventScreenCapture();

  const { inbox } = useStore();

  const handleSenderPress = (sender: string) => {
    navigation.navigate('Chat', { targetUser: sender });
  };

  const senders = Object.keys(inbox);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Inbox</Text>
      </View>
      <FlatList
          data={senders}
          keyExtractor={(item) => item}
          renderItem={({ item }) => {
            const messages = inbox[item];
            const messageCount = messages.length;
            return (
              <TouchableOpacity
                style={styles.inboxItem}
                onPress={() => handleSenderPress(item)}
              >
                <View style={styles.inboxAvatar}>
                  <Text style={styles.inboxAvatarText}>
                    {item.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.inboxContent}>
                  <Text style={styles.inboxSender}>Message from {item}</Text>
                  <Text style={styles.inboxCount}>
                    {messageCount} {messageCount === 1 ? 'message' : 'messages'}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No messages</Text>
            </View>
          }
        />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: '#9CA3AF',
  },
  inboxItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  inboxAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#8B5CF6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  inboxAvatarText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  inboxContent: {
    flex: 1,
  },
  inboxSender: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 4,
  },
  inboxCount: {
    fontSize: 14,
    color: '#6B7280',
  },
  chevron: {
    fontSize: 24,
    color: '#9CA3AF',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    fontSize: 16,
    color: '#9CA3AF',
  },
});
