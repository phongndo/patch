import { parseReview } from "./parse";
import type { ReviewSource } from "./types";

self.onmessage = async ({ data }: MessageEvent<{ id: number; source: ReviewSource }>) => {
  try {
    self.postMessage({ id: data.id, review: await parseReview(data.source) });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : "Unable to read this patch.",
    });
  }
};
