import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { attachBudgetAlarms, readBudgetConfig } from './budgets';

function synth(env: Record<string, string | undefined> = {}): Template {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    attachBudgetAlarms(stack, readBudgetConfig());
    return Template.fromStack(stack);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('budget alarms', () => {
  beforeEach(() => {
    delete process.env.AS_BUDGET_NOTIFICATION_EMAIL;
    delete process.env.AS_BUDGET_SOFT_USD;
    delete process.env.AS_BUDGET_LOUD_USD;
    delete process.env.AS_BUDGET_HARD_USD;
  });

  afterEach(() => {
    delete process.env.AS_BUDGET_NOTIFICATION_EMAIL;
    delete process.env.AS_BUDGET_SOFT_USD;
    delete process.env.AS_BUDGET_LOUD_USD;
    delete process.env.AS_BUDGET_HARD_USD;
  });

  it('creates a monthly USD budget capped at the hard threshold', () => {
    synth().hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 200, Unit: 'USD' },
      }),
    });
  });

  it('attaches three notifications at the soft, loud, and hard thresholds', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 25, ThresholdType: 'PERCENTAGE' }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 50, ThresholdType: 'PERCENTAGE' }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 100, ThresholdType: 'PERCENTAGE' }),
        }),
      ]),
    });
  });

  it('defaults the subscriber email to the project owner', () => {
    synth().hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'sniper7kills@gmail.com' }],
        }),
      ]),
    });
  });

  it('honours AS_BUDGET_NOTIFICATION_EMAIL when set', () => {
    synth({
      AS_BUDGET_NOTIFICATION_EMAIL: 'ops@example.com',
    }).hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }],
        }),
      ]),
    });
  });

  it('honours AS_BUDGET_SOFT_USD / LOUD_USD / HARD_USD when set', () => {
    synth({
      AS_BUDGET_SOFT_USD: '20',
      AS_BUDGET_LOUD_USD: '40',
      AS_BUDGET_HARD_USD: '80',
    }).hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 80, Unit: 'USD' },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 25, ThresholdType: 'PERCENTAGE' }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 50, ThresholdType: 'PERCENTAGE' }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ Threshold: 100, ThresholdType: 'PERCENTAGE' }),
        }),
      ]),
    });
  });

  it('rejects invalid threshold values', () => {
    expect(() => synth({ AS_BUDGET_HARD_USD: 'not-a-number' })).toThrow(/AS_BUDGET_HARD_USD/);
  });

  it('rejects soft >= loud', () => {
    expect(() =>
      synth({
        AS_BUDGET_SOFT_USD: '100',
        AS_BUDGET_LOUD_USD: '50',
        AS_BUDGET_HARD_USD: '200',
      }),
    ).toThrow(/soft < loud < hard/);
  });

  it('rejects loud >= hard', () => {
    expect(() =>
      synth({
        AS_BUDGET_SOFT_USD: '50',
        AS_BUDGET_LOUD_USD: '200',
        AS_BUDGET_HARD_USD: '100',
      }),
    ).toThrow(/soft < loud < hard/);
  });

  it('rejects equal thresholds at any tier', () => {
    expect(() =>
      synth({
        AS_BUDGET_SOFT_USD: '50',
        AS_BUDGET_LOUD_USD: '50',
        AS_BUDGET_HARD_USD: '200',
      }),
    ).toThrow(/soft < loud < hard/);
  });

  it('does NOT pin an explicit BudgetName so the same template can deploy into multiple stacks in one account (#326)', () => {
    // AWS Budgets names are account-scoped uniques, NOT stack-scoped.
    // A hardcoded `budgetName` collides when both the local sandbox
    // and an Amplify Hosting branch deploy the same CDK template into
    // the same AWS account — Budgets rejects the second create with
    // "A budget or resource with the same name but a different
    // internalId already exists." Omitting the property lets CFN
    // generate a unique name per stack instance.
    const t = synth();
    const budgets = t.findResources('AWS::Budgets::Budget');
    const ids = Object.keys(budgets);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const props = budgets[id]?.Properties as { Budget?: { BudgetName?: string } } | undefined;
      expect(props?.Budget?.BudgetName).toBeUndefined();
    }
  });

  it('uses only AWS-Budgets-valid comparisonOperator enum values on every notification (#320)', () => {
    // The AWS::Budgets::Budget API only accepts `EQUAL_TO`,
    // `GREATER_THAN`, and `LESS_THAN` for `comparisonOperator`. CDK
    // typings on `CfnBudget` are `string`, so synth + typecheck
    // happily pass an invalid enum value like
    // `GREATER_THAN_OR_EQUAL_TO`. The bug surfaces only at deploy
    // time when CFN rejects the resource. Lock the enum here so a
    // future drift becomes a CI-visible diff rather than a sandbox-
    // deploy surprise.
    const VALID_OPERATORS = new Set(['EQUAL_TO', 'GREATER_THAN', 'LESS_THAN']);
    const t = synth();
    const budgets = t.findResources('AWS::Budgets::Budget');
    const budgetIds = Object.keys(budgets);
    expect(budgetIds.length).toBeGreaterThan(0);
    for (const id of budgetIds) {
      const props = budgets[id]?.Properties as
        | {
            NotificationsWithSubscribers?: Array<{
              Notification?: { ComparisonOperator?: string };
            }>;
          }
        | undefined;
      const notifications = props?.NotificationsWithSubscribers ?? [];
      expect(notifications.length).toBeGreaterThan(0);
      for (const n of notifications) {
        const op = n?.Notification?.ComparisonOperator;
        expect(op).toBeDefined();
        expect(VALID_OPERATORS.has(op as string)).toBe(true);
      }
    }
  });
});
