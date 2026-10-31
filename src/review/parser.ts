import type { Review, ReviewSource } from "./types";

// Each import owns its worker. Superseded imports terminate immediately.
export function parseInWorker(source: ReviewSource, signal: AbortSignal): Promise<Review> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException("Import cancelled", "AbortError"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ review?: Review; error?: string }>) => {
      stop();
      if (data.review) resolve(data.review);
      else reject(new Error(data.error ?? "Unable to read this patch."));
    };
    worker.onerror = () => {
      stop();
      reject(new Error("The patch reader could not start. Reload and try again."));
    };
    worker.postMessage({ id: 0, source });
  });
}
