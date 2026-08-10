# FIELD-MAP — `inbox.thread`

Measured from the private `messengerConversations` fixture and meaning-checked against the
committed synthetic copy in `../inbox.list/test-fixtures/`. The live thread gate must confirm
the same paths when opening one thread; until then this map describes the network body already
captured on a cold LinkedIn load.

| field | source | exact path |
|---|---|---|
| message rows | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[]` |
| sender urn | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[].sender.hostIdentityUrn` |
| text | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[].body.text` |
| sent_at | voyager body | `$.data.messengerConversationsBySyncToken.elements[].messages.elements[].deliveredAt` |

The sender urn is the host identity, not the messaging-participant wrapper urn. It is checked
against `sessionUrnsOf` output to tag operator-sent versus received messages. No message value
is copied into this map.
