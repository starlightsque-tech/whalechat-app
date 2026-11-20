import { whalechatRuntime } from '@whalechat/shared';
import { createMobileStorage } from './storage';
import { createMobileNetwork } from './network';
import { createMobileBackend } from './appwrite';

let configured = false;

export async function configureMobileWhalechat(): Promise<void> {
  if (configured) return;
  configured = true;
  const storage = createMobileStorage();
  const network = createMobileNetwork();
  const backend = await createMobileBackend({ isOnline: () => network.isOnline() });
  whalechatRuntime.configure({ storage, network, backend });
}
