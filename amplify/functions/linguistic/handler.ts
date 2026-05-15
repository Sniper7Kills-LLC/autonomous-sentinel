import type { Handler } from 'aws-lambda';

interface LinguisticEvent {
  recordingId: string;
  transcript: string;
  wordTimestamps?: Array<{ word: string; start: number; end: number }>;
}

export const handler: Handler<LinguisticEvent> = async (event) => {
  console.log('linguistic: received', { recordingId: event.recordingId });
  // TODO: load rules + thresholds from DynamoDB
  // TODO: try rules + regex; if fully matched, return parsed Message
  // TODO: if rules incomplete, fall back to Bedrock with admin-selected model
  // TODO: write Message + confidence + linguistic_attempts entry
  return { ok: true };
};
