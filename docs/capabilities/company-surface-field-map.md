# FIELD-MAP — company page family

Generated 2026-08-09T15:12:00.007Z from run `01KZKGD683T76H70YA4DMRCRZH`.

Each row was found by searching for a value the operator read off the rendered page, so a hit is the value rather than something the right shape (D128). The values themselves are deliberately absent: this file is committed and `fixtures/` is not — the pinning tests beside the fixture assert the meaning.

## What the probe measured

- Verified against run 01KZKGD683T76H70YA4DMRCRZH (2026-08-09, company/wisprflow, 5 cold sub-page loads).
- NO DOM EXCEPTION IS NEEDED FOR THIS SURFACE. Every §7 column resolves to a labeled field in a captured body: a Voyager response, or the document's own embedded JSON, which D117 already permits.
- LinkedIn's embedded JSON is not in a script tag. It arrives in Big Pipe data islands — <code id="bpr-guid-N">, entity-escaped. The first sweep could not read them and wrongly called nine fields DOM-only (D184).
- The four rows still marked DOM-only are rendered composites, not missing data. size_range = employeeCountRange.{start,end}; hq_full = address.{line1,city,geographicArea,postalCode,country}; post_comments = numComments (the unit is glued on at render); job_posted = listedAt epoch ms (a relative phrase at render). A parser reads the structured field and formats it — it never reads these strings.

## Verdicts

| field | source | paths | note |
|---|---|---|---|
| `name` | voyager-body | 20 (+223 omitted) |  |
| `vanity` | voyager-body | 20 (+389 omitted) |  |
| `website` | embedded-json | 20 (+9 omitted) |  |
| `industry` | voyager-body | 20 (+10 omitted) |  |
| `size_range` | dom-snapshot | 6 | ⚠ DOM-only — blocked on the operator extending the CLAUDE.md exception |
| `hq` | embedded-json | 11 |  |
| `about` | embedded-json | 11 |  |
| `hq_full` | dom-snapshot | 3 | ⚠ DOM-only — blocked on the operator extending the CLAUDE.md exception |
| `founded` | embedded-json | 6 |  |
| `followers` | voyager-body | 20 (+3 omitted) |  |
| `post_text` | voyager-body | 3 |  |
| `post_reactions` | embedded-json | 2 |  |
| `post_comments` | dom-snapshot | 2 | ⚠ DOM-only — blocked on the operator extending the CLAUDE.md exception |
| `person_name` | voyager-body | 11 |  |
| `person_headline` | voyager-body | 4 |  |
| `job_title` | voyager-body | 7 |  |
| `job_location` | voyager-body | 20 (+18 omitted) |  |
| `job_posted` | dom-snapshot | 2 | ⚠ DOM-only — blocked on the operator extending the CLAUDE.md exception |
| `job_title_2` | voyager-body | 12 |  |

### `name`

companies.name — the page's own display name, from the header and About

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.name.accessibilityText` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.name.text` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.name.accessibilityText` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.name.text` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[30].name` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[27].actor.name.accessibilityText` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[27].actor.name.text` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[28].actor.name.accessibilityText` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[28].actor.name.text` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[32].actor.name.accessibilityText` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[32].actor.name.text` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[34].content.imageComponent.images[0].attributes[0].tapTargets[1].text` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[35].actor.name.accessibilityText` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[35].actor.name.text` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[60].name` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.data.data.searchDashClustersByAll.metadata.primaryFilterCluster.primaryFilterGroups[1].filters[0].secondaryFilterValues[14].displayName` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.data.data.searchDashClustersByAll.metadata.primaryFilterCluster.secondaryFilterGroups[1].filters[0].secondaryFilterValues[14].displayName` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].commentary.text.text` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.navigationContext.accessibilityText` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[14].commentary.text.text` | contains | value |

### `vanity`

companies.vanity — the universal name in the URL; the key the operator addresses a company by

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[60].universalName` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.navigationContext.actionTarget` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.subDescriptionButton.navigationContext.actionTarget` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.image.attributes[0].detailData.nonEntityCompanyLogo.vectorImage.artifacts[0].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.image.attributes[0].detailData.nonEntityCompanyLogo.vectorImage.artifacts[1].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.image.attributes[0].detailData.nonEntityCompanyLogo.vectorImage.artifacts[2].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].socialContent.shareUrl` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[15].commentary.text.attributesV2[3].detailData.hyperlink` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[16].content.seeMoreComponent.largeCtaButton.navigationContext.actionTarget` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.navigationContext.actionTarget` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.subDescriptionButton.navigationContext.actionTarget` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.image.attributes[0].detailData.nonEntityCompanyLogo.vectorImage.artifacts[0].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.image.attributes[0].detailData.nonEntityCompanyLogo.vectorImage.artifacts[1].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.image.attributes[0].detailData.nonEntityCompanyLogo.vectorImage.artifacts[2].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].socialContent.shareUrl` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[30].url` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[30].logoResolutionResult.vectorImage.artifacts[0].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[30].logoResolutionResult.vectorImage.artifacts[1].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[30].logoResolutionResult.vectorImage.artifacts[2].fileIdentifyingUrlPathSegment` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.data.data.organizationDashViewWrapperByOrganizationalPageAndContext.elements[0].actions[0].action.navigationAction.urlV2.absoluteUrl` | contains | value |

### `website`

companies.website — About > Details > Website

| source | file | path | match | via |
|---|---|---|---|---|
| embedded-json | `0000-438312a3d613045a.json.gz` | `code#bpr-guid-584185 → $.included[34].websiteUrl` | exact | value |
| embedded-json | `0028-438312a3d613045a.json.gz` | `code#bpr-guid-586527 → $.included[32].websiteUrl` | exact | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587985 → $.included[34].websiteUrl` | exact | value |
| embedded-json | `0081-438312a3d613045a.json.gz` | `code#bpr-guid-590308 → $.included[34].websiteUrl` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48756 → $.included[33].websiteUrl` | exact | value |
| embedded-json | `0000-438312a3d613045a.json.gz` | `code#bpr-guid-584185 → $.included[61].website` | contains | value |
| embedded-json | `0028-438312a3d613045a.json.gz` | `code#bpr-guid-586527 → $.included[59].website` | contains | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587985 → $.included[61].website` | contains | value |
| embedded-json | `0081-438312a3d613045a.json.gz` | `code#bpr-guid-590308 → $.included[61].website` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48756 → $.included[60].website` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[11].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[12].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[13].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[14].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[15].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[16].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[17].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[18].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[19].description.attributesV2[1].detailData.hyperlinkOpenExternally` | contains | value |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `a#ember90[href]` | exact | attribute |

### `industry`

companies.industry — About > Details > Industry, and the page header

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0101-98d98c3b6c8875c5.json.gz` | `$.data.data.organizationDashDiscoverCardGroupsByOrganization.elements[0].cards[0].value.entityCard.entityLockupView.subtitle.text` | exact | value |
| embedded-json | `0000-438312a3d613045a.json.gz` | `code#bpr-guid-584183 → $.data.data.organizationDashDiscoverCardGroupsByOrganization.elements[0].cards[0].value.entityCard.entityLockupView.subtitle.text` | exact | value |
| embedded-json | `0000-438312a3d613045a.json.gz` | `code#bpr-guid-584185 → $.included[30].name` | exact | value |
| embedded-json | `0028-438312a3d613045a.json.gz` | `code#bpr-guid-586527 → $.included[29].name` | exact | value |
| embedded-json | `0028-438312a3d613045a.json.gz` | `code#bpr-guid-586541 → $.data.data.organizationDashDiscoverCardGroupsByOrganization.elements[0].cards[0].value.entityCard.entityLockupView.subtitle.text` | exact | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587985 → $.included[30].name` | exact | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587990 → $.data.data.organizationDashDiscoverCardGroupsByOrganization.elements[0].cards[0].value.entityCard.entityLockupView.subtitle.text` | exact | value |
| embedded-json | `0081-438312a3d613045a.json.gz` | `code#bpr-guid-590308 → $.included[30].name` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48756 → $.included[28].name` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48761 → $.data.data.organizationDashDiscoverCardGroupsByOrganization.elements[0].cards[0].value.entityCard.entityLockupView.subtitle.text` | exact | value |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember32 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember109 > span` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember61 > section > dl > dd:nth-of-type(3)` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember160 > span` | exact | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember143 > span` | exact | text |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `div#ember132 > span` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(1)` | exact | text |

### `size_range`

companies.size_range — DOM-only AS RENDERED, and composed: the parser reads $.included[N].employeeCountRange.{start,end} = 11/50 from the document's embedded json and formats it. No exception needed.

| source | file | path | match | via |
|---|---|---|---|---|
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `a#ember35 > span` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `a#ember36 > span` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember61 > section > dl > dd:nth-of-type(4)` | exact | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `a#ember36 > span` | exact | text |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `a#ember36 > span` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `a#ember36 > span` | exact | text |

### `hq`

companies.hq — About > Details > Headquarters

| source | file | path | match | via |
|---|---|---|---|---|
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[0].fullLocalizedName` | contains | value |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember32 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(2) > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(2) > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember61 > section > dl > dd:nth-of-type(6)` | exact | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(2) > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(2) > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `div#ember33 > div:nth-of-type(2) > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(2) > div > div > div:nth-of-type(2) > div:nth-of-type(1)` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember100 > div:nth-of-type(1) > h3 > div > p` | contains | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `a#ember101 > span:nth-of-type(2)` | contains | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember182 > img[alt]` | contains | attribute |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `code#bpr-guid-48759` | contains | text |

### `about`

companies.about — first sentence of About > Overview; a substring hit is expected and is what tells us the field is one long body

| source | file | path | match | via |
|---|---|---|---|---|
| embedded-json | `0000-438312a3d613045a.json.gz` | `code#bpr-guid-584185 → $.included[34].description` | contains | value |
| embedded-json | `0028-438312a3d613045a.json.gz` | `code#bpr-guid-586527 → $.included[32].description` | contains | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587985 → $.included[34].description` | contains | value |
| embedded-json | `0081-438312a3d613045a.json.gz` | `code#bpr-guid-590308 → $.included[34].description` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48756 → $.included[33].description` | contains | value |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `code#bpr-guid-584185` | contains | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember61 > section > p` | contains | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `code#bpr-guid-586527` | contains | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `code#bpr-guid-587985` | contains | text |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `code#bpr-guid-590308` | contains | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `code#bpr-guid-48756` | contains | text |

### `hq_full`

not a §7 column — DOM-only AS RENDERED, and composed: $.included[N].groupedLocations[0].locations[0].address.{line1,city,geographicArea,postalCode,country} carries every part in the embedded json. No exception needed.

| source | file | path | match | via |
|---|---|---|---|---|
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember100 > div:nth-of-type(1) > h3 > div > p` | exact | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `a#ember101 > span:nth-of-type(2)` | contains | text |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember182 > img[alt]` | contains | attribute |

### `founded`

not a §7 column — measured because About carries it and a later schema may want it

| source | file | path | match | via |
|---|---|---|---|---|
| embedded-json | `0000-438312a3d613045a.json.gz` | `code#bpr-guid-584185 → $.included[34].foundedOn.year` | exact | value |
| embedded-json | `0028-438312a3d613045a.json.gz` | `code#bpr-guid-586527 → $.included[32].foundedOn.year` | exact | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587985 → $.included[34].foundedOn.year` | exact | value |
| embedded-json | `0081-438312a3d613045a.json.gz` | `code#bpr-guid-590308 → $.included[34].foundedOn.year` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48756 → $.included[33].foundedOn.year` | exact | value |
| dom-snapshot | `0053-438312a3d613045a.json.gz` | `div#ember61 > section > dl > dd:nth-of-type(7)` | exact | text |

### `followers`

not a §7 column — measured because it is the one company number that appears in three places, and D128's false positive was a follower count landing in a location slot

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.description.accessibilityText` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[13].actor.description.text` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.description.accessibilityText` | contains | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].actor.description.text` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[27].actor.description.accessibilityText` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[27].actor.description.text` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[28].actor.description.accessibilityText` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[28].actor.description.text` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[32].actor.description.accessibilityText` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[32].actor.description.text` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[35].actor.description.accessibilityText` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[35].actor.description.text` | contains | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587989 → $.included[10].actor.description.accessibilityText` | contains | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587989 → $.included[10].actor.description.text` | contains | value |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember282 > div > div > div > div:nth-of-type(1) > div > div > a:nth-of-type(1)[aria-label]` | contains | attribute |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember282 > div > div > div > div:nth-of-type(1) > div > div > a:nth-of-type(1) > span:nth-of-type(2) > span` | contains | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `body > div:nth-of-type(5) > div:nth-of-type(3) > div > div:nth-of-type(2) > div > div:nth-of-type(2) > main > div:nth-of-type(2) > div > div > div:nth-of-type(1) > section:nth-of-type(1) > p` | contains | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember105 > div > div > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div > div > a:nth-of-type(1)[aria-label]` | contains | attribute |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember105 > div > div > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div > div > a:nth-of-type(1) > span:nth-of-type(2) > span` | contains | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember345 > div > div > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div > div > a:nth-of-type(1)[aria-label]` | contains | attribute |

### `post_text`

company_posts.text — first line of the newest first-party post on the Posts tab

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.included[17].commentary.text.text` | contains | value |
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587989 → $.included[10].commentary.text.text` | contains | value |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `code#bpr-guid-587989` | contains | text |

### `post_reactions`

company_posts.reactions — the reaction count on the reposted Zepto item, the only post whose counts were rendered before the fold

| source | file | path | match | via |
|---|---|---|---|---|
| embedded-json | `0054-438312a3d613045a.json.gz` | `code#bpr-guid-587989 → $.included[7].numLikes` | exact | value |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember175 > div:nth-of-type(1) > div > div > ul > li:nth-of-type(1) > button > span` | exact | text |

### `post_comments`

company_posts.comments — DOM-only AS RENDERED (the unit is glued on): the count is $.included[N].numComments = 29 in the embedded json, beside numLikes = 80. No exception needed.

| source | file | path | match | via |
|---|---|---|---|---|
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember175 > div:nth-of-type(1) > div > div > ul > li:nth-of-type(2) > ul > li:nth-of-type(1) > button > span` | exact | text |
| dom-snapshot | `0080-438312a3d613045a.json.gz` | `div#ember175 > div:nth-of-type(1) > div > div > ul > li:nth-of-type(2) > ul > li:nth-of-type(1) > button[aria-label]` | contains | attribute |

### `person_name`

company_people.person_urn — the name is the handle; the sweep says whether a urn sits beside it in the same source

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[26].actor.name.accessibilityText` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[26].actor.name.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[15].image.accessibilityText` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[15].title.text` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[26].actor.navigationContext.accessibilityText` | contains | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[26].actor.image.accessibilityText` | contains | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[15].title.accessibilityText` | contains | value |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `img#ember185[alt]` | exact | attribute |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `div#ember189` | exact | text |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `div#ember187 > a[aria-label]` | contains | attribute |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `button#ember197[aria-label]` | contains | attribute |

### `person_headline`

not a §7 column — measured to confirm the People tab carries person rows structurally, not just as display strings

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[26].actor.description.accessibilityText` | exact | value |
| voyager-body | `0073-12e39516db5656f4.json.gz` | `$.included[26].actor.description.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[15].primarySubtitle.text` | exact | value |
| dom-snapshot | `0110-438312a3d613045a.json.gz` | `div#ember193` | exact | text |

### `job_title`

jobs.title — first card on the Jobs tab

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.data.data.organizationDashViewWrapperByOrganizationalPageAndContext.elements[0].nestedComponents[3].component.entityCard.entityLockupView.title.text` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[14].title` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[24].title.accessibilityText` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[24].title.text` | exact | value |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember209` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `div#ember112 > div > span > span > strong` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `code#bpr-guid-48759` | contains | text |

### `job_location`

jobs.location — note it differs in form from companies.hq, which is the same city written differently

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.data.data.organizationDashViewWrapperByOrganizationalPageAndContext.elements[0].nestedComponents[2].component.entityCard.entityLockupView.subtitle.text` | exact | value |
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.data.data.organizationDashViewWrapperByOrganizationalPageAndContext.elements[0].nestedComponents[3].component.entityCard.entityLockupView.subtitle.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[12].secondarySubtitle.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[13].secondarySubtitle.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[15].secondarySubtitle.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.included[18].secondarySubtitle.text` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.data.data.searchDashClustersByAll.metadata.primaryFilterCluster.primaryFilterGroups[2].filters[0].secondaryFilterValues[3].displayName` | exact | value |
| voyager-body | `0105-6da50130b093a5d6.json.gz` | `$.data.data.searchDashClustersByAll.metadata.primaryFilterCluster.secondaryFilterGroups[2].filters[0].secondaryFilterValues[3].displayName` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[0].abbreviatedLocalizedName` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[0].fullLocalizedName` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[11].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[12].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[14].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[15].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[18].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[23].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[25].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[26].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[28].secondaryDescription.text` | contains | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48760 → $.included[30].secondaryDescription.text` | contains | value |

### `job_posted`

jobs.posted_at — DOM-only AS RENDERED (a relative phrase): the absolute stamp is $.included[N].listedAt = 1785517295000 (epoch ms) in the embedded json, which is the better field anyway. No exception needed.

| source | file | path | match | via |
|---|---|---|---|---|
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `div#ember93 > section > div > a > ul > li > time` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `div#ember94 > section > div > a > ul > li > time` | exact | text |

### `job_title_2`

jobs.title — second card, so a hit proves the list is addressable rather than one lucky card

| source | file | path | match | via |
|---|---|---|---|---|
| voyager-body | `0021-ffbecb25cb3b8d81.json.gz` | `$.data.data.organizationDashViewWrapperByOrganizationalPageAndContext.elements[0].nestedComponents[2].component.entityCard.entityLockupView.title.text` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[15].title` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[25].title.accessibilityText` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[25].title.text` | exact | value |
| embedded-json | `0111-438312a3d613045a.json.gz` | `code#bpr-guid-48759 → $.included[15].description.text` | contains | value |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember203` | exact | text |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `div#ember199 > div > span > span > strong` | exact | text |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember199 > div:nth-of-type(1) > a[aria-label]` | contains | attribute |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `div#ember200 > div[aria-label]` | contains | attribute |
| dom-snapshot | `0027-438312a3d613045a.json.gz` | `img#ember201[alt]` | contains | attribute |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `button#ember203[aria-label]` | contains | attribute |
| dom-snapshot | `0136-438312a3d613045a.json.gz` | `code#bpr-guid-48759` | contains | text |

## Coverage

- 82 documents swept, 175440 nodes walked
- ⚠ **DOM-only fields:** size_range, hq_full, post_comments, job_posted — CONTEXT rule 7 applies, and the consuming tasks stay blocked until the operator's decision lands in `DECISIONS.md`

