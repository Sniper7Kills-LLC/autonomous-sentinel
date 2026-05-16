import { a } from '@aws-amplify/backend';

/**
 * Transmitter — known EAM broadcast sites.
 *
 * Admin-managed, publicly visible on the propagation map. Pre-populated at
 * launch from public sources (HFGCS Wikipedia, reference sites); admins
 * curate from there.
 */
export const Transmitter = a
  .model({
    name: a.string().required(),
    latitude: a.float().required(),
    longitude: a.float().required(),
    callsign: a.string(),
    notes: a.string(),
  })
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
