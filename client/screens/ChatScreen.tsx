import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useFocusEffect } from '@react-navigation/native';
import { useStore, type SignedPayload } from '../stores/useStore';
import { log } from '../utils/logger';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

type RootStackParamList = {
  Home: undefined;
  ContactList: undefined;
  InboxList: undefined;
  Chat: { targetUser: string };
};

type ChatScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Chat'>;
type ChatScreenRouteProp = RouteProp<RootStackParamList, 'Chat'>;

interface Props {
  navigation: ChatScreenNavigationProp;
  route: ChatScreenRouteProp;
}

export default function ChatScreen({ navigation, route }: Props) {
  usePreventScreenCapture();

  const { targetUser } = route.params;
  // Subscribe to inbox changes - selector ensures reactivity
  const inbox = useStore((state) => state.inbox);
  const sendMessage = useStore((state) => state.sendMessage);
  const exitSession = useStore((state) => state.exitSession);
  const enterChat = useStore((state) => state.enterChat);
  const leaveChat = useStore((state) => state.leaveChat);
  const userId = useStore((state) => state.userId);
  
  // Get messages for this user - will update when inbox changes
  const messages = inbox[targetUser] || [];
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const conversationIdRef = useRef<string | null>(null);

  // Generate conversation ID (simple hash - no native module required)
  useEffect(() => {
    if (!userId || !targetUser) return;
    // Simple hash function for conversation ID
    const simpleHash = (str: string): string => {
      let hash = 5381;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
      }
      return Math.abs(hash).toString(16).padStart(8, '0');
    };
    const [s1, s2] = userId < targetUser ? [userId, targetUser] : [targetUser, userId];
    const combined = `${s1}|${s2}`;
    conversationIdRef.current = simpleHash(combined);
  }, [userId, targetUser]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  // Enter chat when screen focuses and leave chat on blur
  useFocusEffect(
    React.useCallback(() => {
      // On focus: enter chat to flush buffer and get buffered messages
      if (conversationIdRef.current) {
        enterChat(conversationIdRef.current).catch((error) => {
          log.error('[ChatScreen] error entering chat', error);
        });
      }
      
      return () => {
        // On blur: leave chat and exit session to wipe data
        if (conversationIdRef.current) {
          leaveChat(conversationIdRef.current).catch((error) => {
            log.error('[ChatScreen] error leaving chat', error);
          });
        }
        exitSession(targetUser);
      };
    }, [targetUser, exitSession, enterChat, leaveChat])
  );

  // Also handle unmount
  useEffect(() => {
    return () => {
      if (conversationIdRef.current) {
        leaveChat(conversationIdRef.current).catch(() => {});
      }
      exitSession(targetUser);
    };
  }, [targetUser, exitSession, leaveChat]);

  const handleSend = async () => {
    if (!messageText.trim() || sending) {
      return;
    }

    try {
      setSending(true);
      await sendMessage(targetUser, messageText.trim());
      setMessageText('');
    } catch (error) {
      log.error('[ChatScreen] error sending message', error);
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item }: { item: SignedPayload }) => {
    const isMe = item.sender === userId;
    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const renderStatusIndicator = () => {
      if (!isMe || !item.status) return null;

      switch (item.status) {
        case 'pending':
          return (
            <ActivityIndicator 
              size="small" 
              color="#8B5CF6"
            />
          );
        case 'sent':
          return (
            <Text style={styles.statusCheckmark}>✓</Text>
          );
        case 'delivered':
          return (
            <Text style={styles.statusCheckmark}>✓✓</Text>
          );
        default:
          return null;
      }
    };

    return (
      <View
        style={[
          styles.messageContainer,
          isMe ? styles.messageRight : styles.messageLeft,
        ]}
      >
        <View
          style={[
            styles.messageBubble,
            isMe ? styles.messageBubbleRight : styles.messageBubbleLeft,
          ]}
        >
          <Text style={[styles.messageText, isMe && styles.messageTextRight]}>
            {item.message}
          </Text>
          <View style={styles.messageTimeContainer}>
            <Text style={[styles.messageTime, isMe && styles.messageTimeRight]}>
              {time}
            </Text>
            {renderStatusIndicator()}
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{targetUser}</Text>
        <View style={styles.backButton} />
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        extraData={messages.length}
        keyExtractor={(item, index) => `${item.timestamp}-${index}`}
        renderItem={renderMessage}
        contentContainerStyle={styles.messagesList}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No messages yet</Text>
          </View>
        }
      />

      {/* Input */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={messageText}
          onChangeText={setMessageText}
          placeholder="Type a message..."
          multiline
          maxLength={500}
        />
        <TouchableOpacity
          style={[styles.sendButton, sending && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={sending || !messageText.trim()}
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 32,
    color: '#8B5CF6',
    fontWeight: '300',
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
    textAlign: 'center',
  },
  messagesList: {
    padding: 16,
    flexGrow: 1,
  },
  messageContainer: {
    marginBottom: 12,
  },
  messageLeft: {
    alignItems: 'flex-start',
  },
  messageRight: {
    alignItems: 'flex-end',
  },
  messageBubble: {
    maxWidth: '75%',
    padding: 12,
    borderRadius: 16,
  },
  messageBubbleLeft: {
    backgroundColor: '#2C2C2C',
    borderBottomLeftRadius: 4,
  },
  messageBubbleRight: {
    backgroundColor: '#4A148C',
    borderBottomRightRadius: 4,
  },
  messageText: {
    fontSize: 16,
    color: '#E0E0E0',
    marginBottom: 4,
  },
  messageTextRight: {
    color: '#FFFFFF',
  },
  messageTimeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 4,
  },
  messageTime: {
    fontSize: 12,
    color: '#B0B0B0',
  },
  messageTimeRight: {
    color: '#E5E7EB',
  },
  statusCheckmark: {
    fontSize: 12,
    color: '#8B5CF6',
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
  inputContainer: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#1E1E1E',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 100,
    marginRight: 8,
    backgroundColor: '#FFFFFF',
    color: '#1F2937',
  },
  sendButton: {
    backgroundColor: '#8A2BE2',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
