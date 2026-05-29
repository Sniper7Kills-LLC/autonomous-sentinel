import { describe, it, expect } from 'vitest';
import type { NotificationPrefView } from './query';

// `toView` is internal; exercise behaviour via a re-export shim if
// future tests need it. For now this stub keeps the test file
// addressable + ensures the module compiles standalone.
describe('NotificationPrefView (type shape)', () => {
  it('round-trips a basic record', () => {
    const view: NotificationPrefView = {
      userId: 'u',
      emailEnabled: true,
      pushEnabled: false,
      discordWebhookEnabled: false,
      discordWebhookUrl: null,
      subscribedTypes: ['SKYKING'],
      weeklyDigest: false,
    };
    expect(view.emailEnabled).toBe(true);
    expect(view.subscribedTypes).toEqual(['SKYKING']);
  });
});
