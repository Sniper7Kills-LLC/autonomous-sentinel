/**
 * Display-shape Message used by the public browse surfaces.
 *
 * Distinct from the raw AppSync row — the list/detail UI only ever
 * needs a curated subset, and the type lets the helper isolate
 * Schema breakage from the rendering layer.
 */
import type { MessageType } from './filters';

export type DisplayMessage = {
  id: string;
  type: MessageType;
  broadcastTs: string;
  sender: string | null;
  receiver: string | null;
  body: string | null;
  confidence: number | null;
  flaggedForReview: boolean;
  publishedAt: string | null;
};

export type ListResult = {
  items: DisplayMessage[];
  nextToken: string | null;
};
