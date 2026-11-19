/* =========================================================================
   WhaleChat · build-time connection config (wc-build-config)
   -------------------------------------------------------------------------
   Generated with the build. Every endpoint the app needs is hardcoded here so
   a user NEVER enters a server URL, API key or project id. Provider secrets
   stay server-side in the Appwrite Function environment.
   ========================================================================= */
'use strict';
window.WC_BUILD_CONFIG = {
  appwriteEndpoint: 'https://cloud.appwrite.io/v1',
  appwriteProjectId: '6afec9ae002d0af5e0c6',
  databaseId: 'whalechat_db',
  bucketId: 'whalechat',
  syncServer: 'https://whalechat-api.appwrite.network',
  stockProxy: 'https://whalechat-api.appwrite.network/api/market/proxy',
  realtimeChannel: 'stocks-live',
  emailFunction: 'https://whalechat-api.appwrite.network/api/email/send',
  siteUrl: 'https://whalechat.appwrite.network',
  build: '3.60.0'
};
