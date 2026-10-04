// @adrails/audit-worker/queries — the scan GAQL builders, exported pure.
// Same strings the scans have always sent; now inspectable so CI-time
// validation (ads-client gaql validator) can prove them before the cron fires.
export const gaqlDateTime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

export const buildDriftQuery = (since: Date): string =>
  `SELECT change_event.change_date_time, change_event.change_resource_name, ` +
  `change_event.client_type, change_event.user_email, change_event.resource_change_operation ` +
  `FROM change_event WHERE change_event.change_date_time > '${gaqlDateTime(since)}' ` +
  `ORDER BY change_event.change_date_time DESC LIMIT 50`;

export const buildPolicyQuery = (): string =>
  `SELECT ad_group_ad.ad.id, ad_group_ad.policy_summary.review_status, ` +
  `ad_group_ad.policy_summary.approval_status FROM ad_group_ad ` +
  `WHERE ad_group_ad.policy_summary.approval_status != 'APPROVED' LIMIT 50`;

export const buildRecommendationQuery = (limit = 10): string =>
  `SELECT recommendation.resource_name, recommendation.type, recommendation.campaign ` +
  `FROM recommendation LIMIT ${Math.min(Math.max(limit, 1), 25)}`;

export const buildConversionLossQuery = (since: Date): string => {
  const from = gaqlDateTime(since).slice(0, 10);
  return (
    `SELECT campaign.name, metrics.conversions, metrics.conversions_value, ` +
    `metrics.cost_micros, segments.date FROM campaign ` +
    `WHERE segments.date >= '${from}' ORDER BY segments.date DESC LIMIT 100`
  );
};

export const buildImpressionShareQuery = (): string =>
  `SELECT campaign.name, metrics.search_impression_share, ` +
  `metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share ` +
  `FROM campaign LIMIT 100`;

export const buildUploadHealthQuery = (): string =>
  `SELECT offline_conversion_upload_conversion_action_summary.conversion_action_name, ` +
  `offline_conversion_upload_conversion_action_summary.successful_event_count, ` +
  `offline_conversion_upload_conversion_action_summary.total_event_count, ` +
  `offline_conversion_upload_conversion_action_summary.status ` +
  `FROM offline_conversion_upload_conversion_action_summary LIMIT 50`;

export const ALL_BUILDERS: Array<{ name: string; build: () => string }> = [
  { name: "drift", build: () => buildDriftQuery(new Date("2026-09-28T00:00:00Z")) },
  { name: "policy", build: () => buildPolicyQuery() },
  { name: "recommendation", build: () => buildRecommendationQuery() },
  { name: "conversion-loss", build: () => buildConversionLossQuery(new Date("2026-09-20T00:00:00Z")) },
  { name: "impression-share", build: () => buildImpressionShareQuery() },
  { name: "upload-health", build: () => buildUploadHealthQuery() },
];
