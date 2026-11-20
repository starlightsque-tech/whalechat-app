import { whalechatRuntime } from '@whalechat/shared';
import { createWebStorage } from './storage';
import { createWebNetwork } from './network';
import { createWebBackend } from './appwrite';

let configured = false;

/** Configure the shared runtime with web ports (IndexedDB + Appwrite/demo). */
export async function configureWebWhalechat(): Promise<void> {
  if (configured) return;
  configured = true;
  const storage = await createWebStorage();
  const network = createWebNetwork();
  const backend = await createWebBackend({ isOnline: () => network.isOnline() });
  whalechatRuntime.configure({ storage, network, backend });
}
