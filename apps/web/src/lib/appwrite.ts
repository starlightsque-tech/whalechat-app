import {
  createAppwriteBackend,
  createDemoBackend,
  type AppwriteClientBundle,
  type AppwriteConfig,
  type AppwriteRealtimeEvent,
  type WhalechatBackend,
} from '@whalechat/shared';

interface BackendOptions {
  isOnline: () => boolean;
}

/**
 * Web Appwrite boot: the SDK is injected into the shared layer, so no
 * business logic knows whether it is running on web, Expo or the demo.
 */
export async function createWebBackend(options: BackendOptions): Promise<WhalechatBackend> {
  const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT as string | undefined;
  const projectId = import.meta.env.VITE_APPWRITE_PROJECT_ID as string | undefined;

  if (!endpoint || !projectId) {
    return createDemoBackend({ isOnline: options.isOnline });
  }

  const { Client, Account, Databases, Functions } = await import('appwrite');
  const client = new Client().setEndpoint(endpoint).setProject(projectId);
  const bundle: AppwriteClientBundle = {
    account: new Account(client),
    databases: new Databases(client),
    functions: new Functions(client),
    // Appwrite 18 exposes realtime on the client (`client.subscribe`).
    realtime: {
      subscribe: (channels: string | string[], callback: (event: AppwriteRealtimeEvent) => void) =>
        client.subscribe(channels, (event) =>
          callback({
            events: event.events,
            payload: (event.payload ?? {}) as Record<string, unknown>,
            timestamp: event.timestamp ? String(event.timestamp) : undefined,
          }),
        ),
    },
  } as unknown as AppwriteClientBundle;

  const config: Partial<AppwriteConfig> = {
    endpoint,
    projectId,
    databaseId: (import.meta.env.VITE_APPWRITE_DATABASE_ID as string | undefined) ?? 'whalechat',
    functionId: (import.meta.env.VITE_APPWRITE_FUNCTION_ID as string | undefined) ?? 'whalechat-sync',
    collectionPrefix: (import.meta.env.VITE_APPWRITE_COLLECTION_PREFIX as string | undefined) ?? '',
  };

  // Appwrite Auth session user id; the sync function validates the JWT too.
  let userId = 'demo-user';
  try {
    const account = await bundle.account.get();
    userId = String(account.$id ?? userId);
  } catch {
    // Not signed in yet — the app still boots and shows cached data.
  }

  return createAppwriteBackend({ client: bundle, userId, config });
}
