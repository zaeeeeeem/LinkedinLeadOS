# FIELD-MAP — `inbox.thread`

Measured from the private `messengerMessages` fixture captured by default `inbox.list` run
`01KZNABFNDM59AQEAEHV5SRTTG` and meaning-checked against the committed synthetic copy under
`test-fixtures/`. Reusing that run saved a page load before the thread gate.

| field | source | exact path |
|---|---|---|
| message rows | voyager body | `$.data.messengerMessagesBySyncToken.elements[]` |
| conversation urn | voyager body | `$.data.messengerMessagesBySyncToken.elements[].conversation.entityUrn` |
| backend conversation urn | voyager body | `$.data.messengerMessagesBySyncToken.elements[].backendConversationUrn` |
| sender urn | voyager body | `$.data.messengerMessagesBySyncToken.elements[].sender.hostIdentityUrn` |
| text | voyager body | `$.data.messengerMessagesBySyncToken.elements[].body.text` |
| sent_at | voyager body | `$.data.messengerMessagesBySyncToken.elements[].deliveredAt` |

The sender urn is the host identity, not the messaging-participant wrapper urn. It is checked
against `sessionUrnsOf` output to tag operator-sent versus received messages. No message value
is copied into this map.
