/* =========================================================================
   WhaleChat · build-time connection config (wc-build-config)
   -------------------------------------------------------------------------
   Generated with the build. Every endpoint the app needs is hardcoded here so
   a user NEVER enters a server URL, API key or project id. Provider secrets
   stay server-side in the Appwrite Function environment.
   ========================================================================= */
'use strict';
window.WC_BUILD_CONFIG = {
  appwriteEndpoint: 'https://nyc.cloud.appwrite.io/v1',
  appwriteProjectId: '6aff3eda000983f5a975',
  databaseId: '6aff488e0006a3fe39e0',
  bucketId: '6aff48620020a44c714f',
  syncServer: 'https://whalechat-api.appwrite.network',
  stockProxy: 'https://whalechat-api.appwrite.network/api/market/proxy',
  stockProxyFunction: '',
  stockProxyFunctionId: 'stock-proxy',
  realtimeChannel: 'stocks-live',
  emailFunction: 'https://whalechat-api.appwrite.network/api/email/send',
  siteUrl: 'https://whalechat.appwrite.network',
  streaming: false,
  build: '3.77.0'
};
