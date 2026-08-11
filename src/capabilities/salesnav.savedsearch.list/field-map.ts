export const SAVED_SEARCH_FIELD_PATHS = {
  rows: "$.elements[]",
  saved_search_id: "$.elements[].id",
  label: "$.elements[].name",
  created_at: "$.elements[].createdAt",
  last_viewed_at: "$.elements[].lastViewedAt",
  filters: "$.elements[].filters[]",
  keywords: "$.elements[].keywords",
} as const;
