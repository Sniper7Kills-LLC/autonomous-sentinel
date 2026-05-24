import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Duration, type Stack } from 'aws-cdk-lib';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription, LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function as LambdaFunction, type IFunction, Runtime } from 'aws-cdk-lib/aws-lambda';

/**
 * AWS Budget alarms for Autonomous Sentinel (issue #7).
 *
 * Per CLAUDE.md cost discipline: three monthly cost thresholds, all emailing
 * the project owner. The $50 / $100 / $200 levels match the values documented
 * in the Stack → Budgets row.
 *
 * Configurable via environment variables so a different account or operator
 * can take over without editing source:
 *   - `AS_BUDGET_NOTIFICATION_EMAIL` — defaults to the project owner address
 *   - `AS_BUDGET_SOFT_USD` / `AS_BUDGET_LOUD_USD` / `AS_BUDGET_HARD_USD`
 *     — defaults $50 / $100 / $200 respectively
 *
 * The $200 (hard) tier additionally publishes to an SNS topic
 * (`hardThresholdTopic`). `attachBudgetThrottleAction` subscribes a small
 * throttle Lambda to that topic so the Whisper container Lambda's reserved
 * concurrency drops to 1 when the cap breaches.
 */

const DEFAULT_EMAIL = 'sniper7kills@gmail.com';
const DEFAULT_SOFT_USD = 50;
const DEFAULT_LOUD_USD = 100;
const DEFAULT_HARD_USD = 200;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid value for ${name}: '${raw}'. Expected a positive number.`);
  }
  return n;
}

export interface BudgetConfig {
  email: string;
  softUsd: number;
  loudUsd: number;
  hardUsd: number;
}

export interface BudgetAlarmsResult {
  budget: CfnBudget;
  hardThresholdTopic: Topic;
}

export function readBudgetConfig(): BudgetConfig {
  const config: BudgetConfig = {
    email: process.env.AS_BUDGET_NOTIFICATION_EMAIL ?? DEFAULT_EMAIL,
    softUsd: envNumber('AS_BUDGET_SOFT_USD', DEFAULT_SOFT_USD),
    loudUsd: envNumber('AS_BUDGET_LOUD_USD', DEFAULT_LOUD_USD),
    hardUsd: envNumber('AS_BUDGET_HARD_USD', DEFAULT_HARD_USD),
  };

  // The three tiers are expressed as percentages of `hardUsd`. If they are
  // misconfigured out of order (e.g. soft > loud), the resulting notifications
  // fire at the wrong points and the operator gets paged in the wrong order
  // without any deploy-time signal. Fail loudly at synth instead.
  if (!(config.softUsd < config.loudUsd && config.loudUsd < config.hardUsd)) {
    throw new Error(
      `Budget thresholds must satisfy soft < loud < hard. Got soft=${config.softUsd}, ` +
        `loud=${config.loudUsd}, hard=${config.hardUsd}. Adjust AS_BUDGET_SOFT_USD / ` +
        'AS_BUDGET_LOUD_USD / AS_BUDGET_HARD_USD.',
    );
  }

  return config;
}

export function attachBudgetAlarms(stack: Stack, config: BudgetConfig): BudgetAlarmsResult {
  // Hard-threshold SNS topic — paged via owner email AND fans out to the
  // throttle Lambda once attached. Soft + loud stay email-only because a
  // throttle action at $50 / $100 would clip the Whisper Lambda before
  // the budget is actually at risk.
  const hardThresholdTopic = new Topic(stack, 'BudgetHardThresholdTopic', {
    displayName: 'Autonomous Sentinel — budget hard-threshold breach',
  });
  hardThresholdTopic.addSubscription(new EmailSubscription(config.email));

  // AWS Budgets is the publisher → grant SNS:Publish on the topic. Without
  // this, the budget notification silently drops at runtime.
  hardThresholdTopic.addToResourcePolicy(
    new PolicyStatement({
      sid: 'AllowAwsBudgetsPublish',
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [hardThresholdTopic.topicArn],
    }),
  );

  const emailSubscribers = [{ subscriptionType: 'EMAIL', address: config.email }];
  const hardSubscribers = [
    { subscriptionType: 'EMAIL', address: config.email },
    { subscriptionType: 'SNS', address: hardThresholdTopic.topicArn },
  ];

  const budget = new CfnBudget(stack, 'AutonomousSentinelMonthlyBudget', {
    budget: {
      // No explicit `budgetName` — AWS Budgets names are account-
      // scoped uniques, NOT stack-scoped, so a hardcoded value
      // collides whenever two stacks (e.g. local sandbox + Amplify
      // Hosting branch) deploy this same template into the same
      // account (#326). CFN generates a stable
      // `<stack-name>-<logicalId>-<hash>` name in lieu of one we
      // supply, which stays unique per stack instance while still
      // surfacing recognisably in the Budgets console.
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetLimit: {
        amount: config.hardUsd,
        unit: 'USD',
      },
      costTypes: {
        includeCredit: false,
        includeRefund: false,
        useAmortized: false,
      },
    },
    notificationsWithSubscribers: [
      {
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: (config.softUsd / config.hardUsd) * 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: emailSubscribers,
      },
      {
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: (config.loudUsd / config.hardUsd) * 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: emailSubscribers,
      },
      {
        // `GREATER_THAN` at 100% — the AWS Budgets API only accepts
        // `EQUAL_TO` / `GREATER_THAN` / `LESS_THAN` (#320). `EQUAL_TO`
        // only fires when cost is precisely at the cap, which would
        // miss every subsequent breach in the same billing cycle;
        // `GREATER_THAN 100` fires whenever the cap is exceeded, which
        // is the alert we actually want.
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: hardSubscribers,
      },
    ],
  });

  return { budget, hardThresholdTopic };
}

// Inline handler source — bundled into the throttle Lambda via
// `Code.fromInline`. Kept terse (no logging branches, no retries) because
// AWS Lambda Node.js 20 runtime ships `@aws-sdk/client-lambda` as a built-in
// module, and the cold-start budget of an alarm-triggered cap call is
// non-critical. The CFN-rendered template carries this string literally,
// so any change here ships as a code update on next deploy.
const THROTTLE_HANDLER_SRC = `
const { LambdaClient, PutFunctionConcurrencyCommand } = require('@aws-sdk/client-lambda');
const client = new LambdaClient({});
exports.handler = async () => {
  await client.send(new PutFunctionConcurrencyCommand({
    FunctionName: process.env.TARGET_FUNCTION_NAME,
    ReservedConcurrentExecutions: Number(process.env.TARGET_CONCURRENCY_CAP),
  }));
};
`.trim();

export function attachBudgetThrottleAction(
  stack: Stack,
  topic: Topic,
  target: IFunction,
  cap = 1,
): IFunction {
  const throttleFn = new LambdaFunction(stack, 'BudgetThrottleFn', {
    runtime: Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: Code.fromInline(THROTTLE_HANDLER_SRC),
    timeout: Duration.seconds(10),
    description:
      'Sets a target Lambda reservedConcurrentExecutions to cap on budget hard-threshold breach (#7).',
    environment: {
      TARGET_FUNCTION_NAME: target.functionName,
      TARGET_CONCURRENCY_CAP: String(cap),
    },
  });

  // Scope IAM tight — PutFunctionConcurrency on the single target ARN, not
  // `Resource: '*'`. A bug in the handler can only ever throttle this one
  // Lambda, not anything else in the account.
  throttleFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['lambda:PutFunctionConcurrency'],
      resources: [target.functionArn],
    }),
  );

  topic.addSubscription(new LambdaSubscription(throttleFn));

  return throttleFn;
}
