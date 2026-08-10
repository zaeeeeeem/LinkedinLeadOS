export const INBOX_LIST_FIELD_PATHS = {
  rows: "$.data.messengerConversationsBySyncToken.elements[]",
  participant: "$.data.messengerConversationsBySyncToken.elements[].conversationParticipants[]",
  participantUrn: "$.data.messengerConversationsBySyncToken.elements[].conversationParticipants[].hostIdentityUrn",
  latestMessage: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[0]",
  lastMessageSnippet: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[0].body.text",
  timestamp: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[0].deliveredAt",
  unread: "$.data.messengerConversationsBySyncToken.elements[].unreadCount",
} as const;
