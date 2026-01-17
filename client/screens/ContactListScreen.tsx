import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native';
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

type ContactListScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'ContactList'>;

interface Props {
  navigation: ContactListScreenNavigationProp;
}

export default function ContactListScreen({ navigation }: Props) {
  usePreventScreenCapture();

  const { contacts, syncContacts, userId, isAuthenticated } = useStore();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    log.debug('[ContactList] effect', { isAuthenticated, userId });
    
    // Don't sync contacts if user is not authenticated
    if (!isAuthenticated) {
      log.debug('[ContactList] not authenticated; skipping syncContacts');
      setLoading(false);
      return;
    }
    
    const loadContacts = async () => {
      try {
        setLoading(true);
        await syncContacts();
      } catch (error) {
        log.error('[ContactList] error syncing contacts', error);
        // Don't throw or cause navigation - just show empty contacts
      } finally {
        setLoading(false);
      }
    };

    loadContacts();
  }, [isAuthenticated]);

  const handleContactPress = (contactUserId: string) => {
    navigation.navigate('Chat', { targetUser: contactUserId });
  };

  // Filter out current user from contacts and apply search filter
  const filteredContacts = contacts
    .filter((contact) => contact.userId !== userId)
    .filter((contact) => 
      contact.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#8B5CF6" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts..."
          placeholderTextColor="#9CA3AF"
          value={searchQuery}
          onChangeText={setSearchQuery}
          selectionColor="#8A2BE2"
        />
      </View>
      <FlatList
        data={filteredContacts}
        keyExtractor={(item) => item.userId}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.contactItem}
            onPress={() => handleContactPress(item.userId)}
          >
            <View style={styles.contactAvatar}>
              <Text style={styles.contactAvatarText}>
                {item.name.charAt(0).toUpperCase()}
              </Text>
            </View>
            <Text style={styles.contactName}>{item.name}</Text>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No contacts found on Purple Box. Invite your friends!</Text>
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
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1E1E1E',
  },
  searchInput: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#3A3A3A',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  contactAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#2C2C2C',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  contactAvatarText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#BB86FC',
  },
  contactName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
    color: '#1F2937',
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
