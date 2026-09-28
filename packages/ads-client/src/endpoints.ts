// @adrails/ads-client/endpoints — REST path builders verified against the
// fetched googleads v25 discovery document (packages/ads-client/discovery/).
// No developer token in any request (sunset 2026-09-09).
export const ADS_REST_BASE = "https://googleads.googleapis.com";
export const ADS_API_VERSION = "v25";

export function customersPath(customerId: string): string {
  return `${ADS_REST_BASE}/${ADS_API_VERSION}/customers/${customerId}`;
}
export function customersActionPath(customerId: string, action: string): string {
  return `${ADS_REST_BASE}/${ADS_API_VERSION}/customers/${customerId}:${action}`;
}
export const ENDPOINTS = {
  /** EXCEPTION endpoint: raw OAuth only, no login-customer-id header. */
  listAccessibleCustomers: () => `${ADS_REST_BASE}/${ADS_API_VERSION}/customers:listAccessibleCustomers`,
  gaussian: {
    search: (customerId: string) => customersActionPath(customerId, "googleAds:search"),
    searchStream: (customerId: string) => customersActionPath(customerId, "googleAds:searchStream"),
    mutate: (customerId: string) => customersActionPath(customerId, "googleAds:mutate"),
  },
  plans: {
    ideas: (customerId: string) => customersActionPath(customerId, "generateKeywordIdeas"),
    historical: (customerId: string) => customersActionPath(customerId, "generateKeywordHistoricalMetrics"),
    forecast: (customerId: string) => customersActionPath(customerId, "generateKeywordForecastMetrics"),
  },
  conversions: {
    uploadClicks: (customerId: string) => customersActionPath(customerId, "uploadClickConversions"),
    uploadCalls: (customerId: string) => customersActionPath(customerId, "uploadCallConversions"),
  },
  customers: {
    createClient: (customerId: string) => customersActionPath(customerId, "createCustomerClient"),
  },
} as const;
