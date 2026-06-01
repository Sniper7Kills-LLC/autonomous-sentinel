import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';

/**
 * Client-side profanity pre-check (#93).
 *
 * This is a fast, free first-pass filter using the open-source
 * `obscenity` English dataset — it mirrors the wordlist stage of the
 * CLAUDE.md "Content moderation" hybrid pipeline. A hit here blocks the
 * submission client-side before the mutation is ever called.
 *
 * The authoritative confirmation (AWS Comprehend) runs server-side in the
 * createTranscriptRevision resolver and is OUT OF SCOPE for this web work
 * — tracked under #99 / #287. We never treat the client check as the final
 * word: it only spares the backend an obvious-spam round trip.
 */
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/** Returns true when the text trips the open-source wordlist filter. */
export function containsProfanity(text: string): boolean {
  return matcher.hasMatch(text);
}
