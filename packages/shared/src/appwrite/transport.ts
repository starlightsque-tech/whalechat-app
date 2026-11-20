/**
 * Appwrite SDK surface used by the shared layer.
 *
 * The concrete SDKs (`appwrite` on web, `react-native-appwrite` on Expo) are
 * injected by the app at boot. Shared code never imports either package, so
 * the same bundle logic runs on every platform and in tests.
 */
export interface AppwriteDocument {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
  [key: string]: unknown;
}

export interface AppwriteList<T> {
  total: number;
  documents: T[];
}

export interface AppwriteDatabases {
  listDocuments<T extends AppwriteDocument = AppwriteDocument>(
    databaseId: string,
    collectionId: string,
    queries?: string[],
  ): Promise<AppwriteList<T>>;
  getDocument<T extends AppwriteDocument = AppwriteDocument>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    queries?: string[],
  ): Promise<T>;
  createDocument<T extends AppwriteDocument = AppwriteDocument>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    permissions?: string[],
  ): Promise<T>;
  updateDocument<T extends AppwriteDocument = AppwriteDocument>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    permissions?: string[],
  ): Promise<T>;
  deleteDocument(databaseId: string, collectionId: string, documentId: string): Promise<unknown>;
}

export interface AppwriteExecution {
  $id?: string;
  status: string;
  responseStatusCode?: number;
  responseBody: string;
  errors?: string;
}

export interface AppwriteFunctions {
  createExecution(
    functionId: string,
    body?: string,
    async?: boolean,
    path?: string,
    method?: string,
    headers?: Record<string, string>,
  ): Promise<AppwriteExecution>;
}

export interface AppwriteAccount {
  get(): Promise<Record<string, unknown>>;
}

export interface AppwriteRealtimeEvent {
  events: string[];
  payload: Record<string, unknown>;
  timestamp?: string;
}

export interface AppwriteRealtime {
  subscribe(channels: string | string[], callback: (event: AppwriteRealtimeEvent) => void): () => void;
}

export interface AppwriteClientBundle {
  account: AppwriteAccount;
  databases: AppwriteDatabases;
  functions: AppwriteFunctions;
  realtime?: AppwriteRealtime;
}

export type AppwriteSdkFactory = (config: {
  endpoint: string;
  projectId: string;
}) => AppwriteClientBundle;

export interface AppwriteConfig {
  endpoint: string;
  projectId: string;
  databaseId: string;
  functionId: string;
  /** optional prefix for deployments sharing a database with other apps */
  collectionPrefix?: string;
  /** collection ids, overridable per environment */
  collections: {
    users: string;
    wallets: string;
    conversations: string;
    messages: string;
    products: string;
    orders: string;
    trades: string;
    ledger: string;
    assets?: string;
  };
}

export const defaultAppwriteConfig: AppwriteConfig = {
  endpoint: 'https://nyc.cloud.appwrite.io/v1',
  projectId: '6aff3eda000983f5a975',
  databaseId: 'whalechat',
  functionId: 'whalechat-sync',
  collections: {
    users: 'users',
    wallets: 'wallets',
    conversations: 'conversations',
    messages: 'messages',
    products: 'products',
    orders: 'orders',
    trades: 'trades',
    ledger: 'ledger_transactions',
    assets: 'assets',
  },
};
