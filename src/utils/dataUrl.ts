/**
 * Resolve a dataset asset URL for the current runtime (opt-in local mode).
 *
 * In local mode `NEXT_PUBLIC_DATASET_URL` is a same-origin path (e.g. "/local-data",
 * the in-app route handler), so the browser fetches assets same-origin — no CORS,
 * no port matching (any tunnelled port works). Node's fetch (server components) needs
 * an absolute URL, so on the server we prepend the app's OWN local origin — the loopback
 * address it actually listens on, NOT the public/tunnelled host it can't reach.
 *
 * That origin follows the app's port automatically: `next dev`/`next start` honour the
 * `PORT` env var, and we read the same var, so `PORT=3005 bun dev` needs no extra config.
 * `LOCAL_SELF_ORIGIN` overrides it (e.g. if you launch with the `--port` flag instead of
 * the `PORT` env var, or bind a non-loopback host).
 *
 * Inert on the hosted deployment: with `NEXT_PUBLIC_DATASET_URL` unset the base is
 * an absolute `https://huggingface.co/...` URL and takes the early return.
 */
const SELF_ORIGIN =
  process.env.LOCAL_SELF_ORIGIN ||
  `http://127.0.0.1:${process.env.PORT || "3000"}`;

export function toFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url; // absolute (HF Hub or explicit) — unchanged
  if (typeof window !== "undefined") return url; // browser: same-origin relative is fine
  return SELF_ORIGIN + url; // server: absolutise to the app's own route handler
}
