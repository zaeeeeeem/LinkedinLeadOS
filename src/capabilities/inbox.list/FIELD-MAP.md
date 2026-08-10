# FIELD-MAP — `inbox.list`

Measured from the private fixture promoted from run `01KZH9VVPKB5JEVEBW7G2JJ6F3` and
meaning-checked against `test-fixtures/messenger-conversations.synthetic.json`. The real
fixture and its generated map remain under `.fixtures-private/inbox.list/`.

| field | source | exact path |
|---|---|---|
| conversation rows | voyager body | `$.data.messengerConversationsBySyncToken.elements[]` |
| participant | voyager body | `$.data.messengerConversationsBySyncToken.elements[].conversationParticipants[]` |
| participant urn | voyager body | `$.data.messengerConversationsBySyncToken.elements[].conversationParticipants[].hostIdentityUrn` |
| latest message | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[0]` |
| last-message snippet | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[0].body.text` |
| timestamp | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[0].deliveredAt` |
| unread | voyager body | `$.data.messengerConversationsBySyncToken.elements[].unreadCount` |

All 20 measured conversations carried exactly one message in the list response; index 0 was
therefore the latest in all 20 examined rows. The denominator is the rows examined, not a
rendered-page total. Message text is never copied into this map.
