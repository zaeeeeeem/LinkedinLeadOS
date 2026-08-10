export const INBOX_THREAD_FIELD_PATHS = {
  messages: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[]",
  senderUrn: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[].sender.hostIdentityUrn",
  text: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[].body.text",
  sentAt: "$.data.messengerConversationsBySyncToken.elements[].messages.elements[].deliveredAt",
} as const;
