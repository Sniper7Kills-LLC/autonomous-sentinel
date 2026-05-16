import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { Stack } from 'aws-cdk-lib';

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
 * Out of scope here (left to the owner / a follow-up):
 *   - $200 Budget Action that throttles the Whisper Lambda concurrency to 1.
 *     The Whisper Lambda is still a placeholder in phase 0; once it lands as
 *     its own resource with a stable name, a CfnBudgetsAction + SNS topic
 *     wires the auto-throttle.
 *   - Subscribing the address: AWS sends a confirmation email when the budget
 *     is created; the owner has to click through once per address.
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
    throw new Error(
      `Invalid value for ${name}: '${raw}'. Expected a positive number.`,
    );
  }
  return n;
}

export interface BudgetConfig {
  email: string;
  softUsd: number;
  loudUsd: number;
  hardUsd: number;
}

export function readBudgetConfig(): BudgetConfig {
  return {
    email: process.env.AS_BUDGET_NOTIFICATION_EMAIL ?? DEFAULT_EMAIL,
    softUsd: envNumber('AS_BUDGET_SOFT_USD', DEFAULT_SOFT_USD),
    loudUsd: envNumber('AS_BUDGET_LOUD_USD', DEFAULT_LOUD_USD),
    hardUsd: envNumber('AS_BUDGET_HARD_USD', DEFAULT_HARD_USD),
  };
}

export function attachBudgetAlarms(stack: Stack, config: BudgetConfig): CfnBudget {
  const subscribers = [{ subscriptionType: 'EMAIL', address: config.email }];

  return new CfnBudget(stack, 'AutonomousSentinelMonthlyBudget', {
    budget: {
      budgetName: 'autonomous-sentinel-monthly',
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
        subscribers,
      },
      {
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: (config.loudUsd / config.hardUsd) * 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      },
      {
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN_OR_EQUAL_TO',
          threshold: 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      },
    ],
  });
}
