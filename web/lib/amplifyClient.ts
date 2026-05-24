/**
 * Amplify Gen 2 client bootstrap.
 *
 * `Amplify.configure(...)` only needs to run once per browser session.
 * Importing this module from any client component triggers the call. We
 * also export `getDataClient()` so callers can grab a typed
 * `generateClient<Schema>()` without re-instantiating it on every render.
 */
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import amplifyOutputs from '../../amplify_outputs.json';
import type { Schema } from '../../amplify/data/resource';

let configured = false;

export function configureAmplifyOnce(): void {
  if (configured) return;
  configured = true;
  Amplify.configure(amplifyOutputs);
}

let cachedClient: ReturnType<typeof generateClient<Schema>> | null = null;

export function getDataClient(): ReturnType<typeof generateClient<Schema>> {
  configureAmplifyOnce();
  if (!cachedClient) {
    cachedClient = generateClient<Schema>();
  }
  return cachedClient;
}
