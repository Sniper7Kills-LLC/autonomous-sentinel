import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerHandler } from 'aws-lambda';

const DEFAULT_GROUP = 'member';

const client = new CognitoIdentityProviderClient({});

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const { userPoolId, userName, triggerSource } = event;

  // Only react to genuine confirmations. PostConfirmation_ConfirmForgotPassword
  // fires on password recovery — the user already exists and is already in the
  // group, so re-adding is a no-op but skipping it avoids needless API calls.
  if (
    triggerSource !== 'PostConfirmation_ConfirmSignUp' &&
    triggerSource !== 'PostConfirmation_ConfirmForgotPassword'
  ) {
    return event;
  }

  await client.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: userName,
      GroupName: DEFAULT_GROUP,
    }),
  );

  console.info('postConfirmation: added to group', {
    userPoolId,
    userName,
    group: DEFAULT_GROUP,
  });

  return event;
};
