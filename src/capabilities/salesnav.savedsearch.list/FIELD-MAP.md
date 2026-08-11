# `salesnav.savedsearch.list` FIELD-MAP

Measured on run `01KZQCS8XZDDYSDGMT5SB81YBS`, 2026-08-11. The D408 panel click
loaded one 1,054-byte Lead body; the D409 Account-tab click loaded one
1,390-byte Account body. Both came from `salesApiSavedSearchesV2`, with one row
in `$.elements[]`. No field below comes from the DOM.

| Field | Source | Measured path | Meaning check |
|---|---|---|---|
| row | `salesApiSavedSearchesV2` | `$.elements[]` | exactly 1 row in each positive body |
| saved-search id | body | `$.elements[].id` | positive integer; matches the `savedSearchId` in the UI-produced row href without printing it |
| operator label | body | `$.elements[].name` | non-empty operator-authored label |
| created time | body | `$.elements[].createdAt` | epoch milliseconds |
| last viewed time | body | `$.elements[].lastViewedAt` | epoch milliseconds |
| filters | body | `$.elements[].filters[]` | 4 Lead filters / 5 Account filters in the measured rows |
| keywords | body | `$.elements[].keywords` | absent on measured Lead row, present on measured Account row |
| vertical | request context | n/a | first response followed D408's default Lead tab; second followed D409's Account tab |
| filter URL | derived from body id + measured vertical | n/a | UI-produced row href is `/sales/search/{people|company}?savedSearchId=<id>` |

The committed synthetic fixtures pin the same paths without carrying the
operator's labels, ids, filter values or seat identifier.
