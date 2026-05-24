import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Function as LambdaFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { attachBudgetAlarms, attachBudgetThrottleAction, readBudgetConfig } from './budgets';

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

function synthWithThrottle(env: Record<string, string | undefined> = {}, cap?: number): Template {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const { hardThresholdTopic } = attachBudgetAlarms(stack, readBudgetConfig());
    const target = new LambdaFunction(stack, 'FakeWhisperFn', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => {};'),
    });
    attachBudgetThrottleAction(stack, hardThresholdTopic, target, cap);
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

  it('creates an SNS topic for the hard-threshold (#7) and subscribes the owner email', () => {
    const t = synth();
    t.resourceCountIs('AWS::SNS::Topic', 1);
    // Owner email subscribed for paging (in addition to the budget's own
    // email subscriber on every threshold).
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'sniper7kills@gmail.com',
    });
  });

  it('attaches the SNS topic as a subscriber on the hard-threshold notification only (#7)', () => {
    const t = synth();
    const budgets = t.findResources('AWS::Budgets::Budget');
    const ids = Object.keys(budgets);
    expect(ids.length).toBe(1);
    type Sub = { SubscriptionType?: string; Address?: string | object };
    type Notification = {
      Notification?: { Threshold?: number };
      Subscribers?: Sub[];
    };
    const id = ids[0]!;
    const notifications = (
      budgets[id]!.Properties as { NotificationsWithSubscribers: Notification[] }
    ).NotificationsWithSubscribers;
    const hard = notifications.find((n) => n.Notification?.Threshold === 100);
    const soft = notifications.find((n) => n.Notification?.Threshold === 25);
    const loud = notifications.find((n) => n.Notification?.Threshold === 50);
    expect(hard?.Subscribers?.some((s) => s.SubscriptionType === 'SNS')).toBe(true);
    expect(hard?.Subscribers?.some((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
    // Soft + loud stay email-only — SNS publish would re-trigger the throttle
    // Lambda at $50 and $100 even though we only want it at $200.
    expect(soft?.Subscribers?.every((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
    expect(loud?.Subscribers?.every((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
  });

  it('grants AWS Budgets permission to publish to the hard-threshold SNS topic (#7)', () => {
    const t = synth();
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'sns:Publish',
          }),
        ]),
      }),
    });
  });

  it('throttle action creates a Lambda subscribed to the hard-threshold SNS topic (#7)', () => {
    const t = synthWithThrottle();
    // Two Lambdas in the template — the fake Whisper target plus the throttle.
    t.resourceCountIs('AWS::Lambda::Function', 2);
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
    });
  });

  it('grants SNS permission to invoke the throttle Lambda (#7)', () => {
    // CDK's `LambdaSubscription` auto-emits an AWS::Lambda::Permission for
    // SNS → InvokeFunction. Without that permission the budget breach would
    // fan out to a topic that can't invoke its subscriber. Lock the contract
    // here so a future swap of the subscription mechanism doesn't silently
    // drop the auto-grant.
    const t = synthWithThrottle();
    t.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'sns.amazonaws.com',
    });
  });

  it('throttle Lambda env wires the target function name + concurrency cap (#7)', () => {
    const t = synthWithThrottle();
    const fns = t.findResources('AWS::Lambda::Function');
    const throttle = Object.values(fns).find(
      (f) =>
        typeof (f.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables?.TARGET_FUNCTION_NAME !== 'undefined',
    );
    expect(throttle).toBeDefined();
    const vars = (
      throttle!.Properties as {
        Environment: {
          Variables: { TARGET_FUNCTION_NAME: unknown; TARGET_CONCURRENCY_CAP: string };
        };
      }
    ).Environment.Variables;
    expect(vars.TARGET_FUNCTION_NAME).toBeDefined();
    expect(vars.TARGET_CONCURRENCY_CAP).toBe('1');
  });

  it('throttle Lambda accepts a custom cap (#7)', () => {
    const t = synthWithThrottle({}, 3);
    const fns = t.findResources('AWS::Lambda::Function');
    const throttle = Object.values(fns).find(
      (f) =>
        typeof (f.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables?.TARGET_CONCURRENCY_CAP !== 'undefined',
    );
    expect(throttle).toBeDefined();
    const cap = (
      throttle!.Properties as {
        Environment: { Variables: { TARGET_CONCURRENCY_CAP: string } };
      }
    ).Environment.Variables.TARGET_CONCURRENCY_CAP;
    expect(cap).toBe('3');
  });

  it('throttle Lambda IAM policy is scoped to PutFunctionConcurrency on the target only (#7)', () => {
    const t = synthWithThrottle();
    // The throttle role policy must allow lambda:PutFunctionConcurrency
    // and must NOT use Resource: '*' — scope to the target ARN only so a
    // bug in the handler can't throttle anything else in the account.
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'lambda:PutFunctionConcurrency',
            Resource: Match.not('*'),
          }),
        ]),
      }),
    });
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
