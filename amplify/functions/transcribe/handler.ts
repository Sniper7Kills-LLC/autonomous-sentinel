import type { Handler } from 'aws-lambda';

interface TranscribeEvent {
  recordingId: string;
  audioKey: string;
  backendOverride?: 'whisper-local' | 'whisper-api' | 'amazon-transcribe' | 'bedrock';
}

export const handler: Handler<TranscribeEvent> = async (event) => {
  console.log('transcribe: received', event);
  // TODO: read backend selection from admin config (DDB) unless overridden
  // TODO: chunk audio > 5 min, transcribe each chunk, stitch
  // TODO: write transcript + word timestamps back to Recording
  // TODO: emit event for linguistic stage
  return { ok: true };
};
