import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { preprocess } from './functions/preprocess/resource';
import { transcribe } from './functions/transcribe/resource';
import { linguistic } from './functions/linguistic/resource';

defineBackend({
  auth,
  data,
  storage,
  preprocess,
  transcribe,
  linguistic,
});
