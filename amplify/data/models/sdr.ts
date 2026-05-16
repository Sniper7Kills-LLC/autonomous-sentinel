import { a } from '@aws-amplify/backend';

/**
 * SDR — a software-defined radio registered by a user.
 *
 * Owner FK to User (#248); survives the owner's self-deletion. Lat/lon are
 * user-chosen via the map selector with user-selectable granularity (EXACT
 * / CITY / REGION). The owner's `publicVisible` toggle controls whether the
 * SDR appears on the propagation map.
 */
export const Sdr = a
  .model({
    name: a.string().required(),
    latitude: a.float(),
    longitude: a.float(),
    locationGranularity: a.enum(['EXACT', 'CITY', 'REGION']),
    publicVisible: a.boolean().default(false),
    ownerId: a.id(),
    owner: a.belongsTo('User', 'ownerId'),
  })
  .authorization((allow) => [
    allow.authenticated().to(['read']),
    allow.owner().to(['read', 'create', 'update', 'delete']),
    allow.groups(['admin']).to(['read', 'update', 'delete']),
  ]);
