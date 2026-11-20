/// <reference types="vite/client" />

declare const __WHALECHAT_OFFLINE__: boolean;

interface ImportMetaEnv {
  readonly VITE_APPWRITE_ENDPOINT?: string;
  readonly VITE_APPWRITE_PROJECT_ID?: string;
  readonly VITE_APPWRITE_DATABASE_ID?: string;
  readonly VITE_APPWRITE_FUNCTION_ID?: string;
  readonly VITE_APPWRITE_COLLECTION_PREFIX?: string;
  readonly VITE_API_PROBE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
