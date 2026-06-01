import { describe, it, expect } from 'vitest';
import {
  createDonationCheckout,
  createSubscriptionCheckout,
  getCustomerPortalUrl,
} from './checkout';

describe('checkout stubs', () => {
  it('createDonationCheckout returns a disabled test-mode result', async () => {
    const r = await createDonationCheckout({
      intendedAmount: 10,
      coverFee: true,
      wantsBadge: true,
      message: 'thanks',
      userId: 'sub-123',
    });
    expect(r.enabled).toBe(false);
    expect(r.status).toBe('test-mode');
    expect(r.message).toMatch(/not yet enabled/i);
  });

  it('createSubscriptionCheckout returns a disabled test-mode result', async () => {
    const r = await createSubscriptionCheckout({
      tierId: 'tier1',
      coverFee: false,
      userId: 'sub-123',
    });
    expect(r.enabled).toBe(false);
    expect(r.status).toBe('test-mode');
  });

  it('getCustomerPortalUrl returns null while disabled', async () => {
    expect(await getCustomerPortalUrl('sub-123')).toBeNull();
  });
});
