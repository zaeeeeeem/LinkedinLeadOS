export const INBOX_THREAD_FIELD_PATHS = {
  messages: "$.data.messengerMessagesBySyncToken.elements[]",
  conversationUrn: "$.data.messengerMessagesBySyncToken.elements[].conversation.entityUrn",
  backendConversationUrn: "$.data.messengerMessagesBySyncToken.elements[].backendConversationUrn",
  senderUrn: "$.data.messengerMessagesBySyncToken.elements[].sender.hostIdentityUrn",
  text: "$.data.messengerMessagesBySyncToken.elements[].body.text",
  sentAt: "$.data.messengerMessagesBySyncToken.elements[].deliveredAt",
} as const;
