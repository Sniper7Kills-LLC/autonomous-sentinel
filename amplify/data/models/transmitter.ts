import { a } from '@aws-amplify/backend';

/**
 * Transmitter — known EAM broadcast sites (issue #31).
 *
 * Admin-managed, publicly visible on the propagation map. Pre-populated at
 * launch from public sources (HFGCS Wikipedia, reference sites); admins
 * curate from there. Sdrs may attribute themselves to a transmitter so the
 * propagation overlay can correlate captures with known sites.
 */
export const Transmitter = a
  .model({
    name: a.string().required(),
    latitude: a.float().required(),
    longitude: a.float().required(),
    callsign: a.string(),
    // Common frequencies for this site (kHz). Multi-valued because most EAM
    // transmitters cycle through several primary frequencies (per CLAUDE.md
    // Frequency enum + curated dictionary work in phase 2 #43).
    frequencyKhzList: a.integer().array(),
    notes: a.string(),
    sdrs: a.hasMany('Sdr', 'transmitterId'),
  })
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
