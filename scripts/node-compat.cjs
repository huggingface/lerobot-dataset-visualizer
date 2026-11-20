/**
 * Removes the non-functional `localStorage` global that Node 25+ exposes.
 *
 * Node 25 enables the Web Storage API by default. `sessionStorage` works (it is
 * in-memory), but `localStorage` is only functional when the process is given a
 * `--localstorage-file` path — without one, `globalThis.localStorage` is a plain
 * empty object whose methods are `undefined`:
 *
 *     $ node -e 'typeof localStorage.getItem'      # Node 25, no flag
 *     undefined
 *     (node:123) Warning: `--localstorage-file` was provided without a valid path
 *
 * That defeats the usual SSR guard, which passes and then throws:
 *
 *     if (typeof localStorage !== "undefined") localStorage.getItem(key)
 *     // TypeError: localStorage.getItem is not a function
 *
 * Next.js 15 ships exactly that guard in its client-side dev overlay
 * (`react-dev-overlay/.../dev-tools-indicator/preferences.js`, reached through
 * `DevOverlay`), which is rendered during the dev server's SSR pass. So on Node
 * 25 every request to `next dev` returns 500.
 *
 * Only `dev` is affected: the overlay is not part of a production build, and
 * `next build` / `next start` were both measured working on Node 25. That is why
 * the preload below is wired into the `dev` script alone.
 *
 * On the server `localStorage` should simply not exist. That is what the code
 * here already assumes: browser-only reads sit in `useEffect`, behind
 * `typeof window === "undefined"` checks, or in try/catch. Removing the stub
 * restores those semantics, and is a no-op on Node <= 24, on Bun, and in the
 * browser, where `localStorage` is either absent or real.
 *
 * `--require` rather than an in-app hook because the dev server renders in a
 * child process too, and NODE_OPTIONS is what reaches it.
 */
if (
  typeof globalThis.localStorage !== "undefined" &&
  typeof globalThis.localStorage?.getItem !== "function"
) {
  delete globalThis.localStorage;
}
