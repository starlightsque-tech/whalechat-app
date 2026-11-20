import {
  createAppwriteBackend,
  createDemoBackend,
  type AppwriteClientBundle,
  type WhalechatBackend,
} from '@whalechat/shared';

/** React Native Appwrite client injected into the shared service layer. */
export async function createMobileBackend(options: { isOnline: () => boolean }): Promise<WhalechatBackend> {
  const endpoint = process.env.EXPO_PUBLIC_APPWRITE_ENDPOINT;
  const projectId = process.env.EXPO_PUBLIC_APPWRITE_PROJECT_ID;

  if (!endpoint || !projectId) {
    return createDemoBackend({ isOnline: options.isOnline, latencyMs: 120 });
  }

  const sdk = await import('react-native-appwrite');
  const client = new sdk.Client().setEndpoint(endpoint).setProject(projectId);
  const bundle = {
    account: new sdk.Account(client),
    databases: new sdk.Databases(client),
    functions: new sdk.Functions(client),
    realtime: {
      subscribe: (channels: string | string[], callback: (event: { events: string[]; payload: Record<string, unknown>; timestamp?: string }) => void) =>
        (client as unknown as { subscribe: (c: string | string[], cb: (e: never) => void) => () => void }).subscribe(channels, callback as never),
    },
  } as unknown as AppwriteClientBundle;

  let userId = 'demo-user';
  try {
    const account = await bundle.account.get();
    userId = String(account.$id ?? userId);
  } catch {
    // cached/offline boot
  }

  return createAppwriteBackend({
    client: bundle,
    userId,
    config: {
      endpoint,
      projectId,
      databaseId: process.env.EXPO_PUBLIC_APPWRITE_DATABASE_ID ?? 'whalechat',
      functionId: process.env.EXPO_PUBLIC_APPWRITE_FUNCTION_ID ?? 'whalechat-sync',
      collectionPrefix: process.env.EXPO_PUBLIC_APPWRITE_COLLECTION_PREFIX ?? '',
    },
  });
}
