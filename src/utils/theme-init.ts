/** Shared with utils/theme.ts, which writes the viewer's choice. Kept free of React so the root
 * layout (a server component) can import the script below. */
export const THEME_STORAGE_KEY = "lerobot-viz-theme";

/**
 * Inlined in <head> so the right theme is applied before first paint. Order: the `__theme` query
 * param (HF Spaces passes the Hub's theme to the embedded app that way), then the viewer's own
 * choice, then the OS preference.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("__theme");var s=null;try{s=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}var t=q==="light"||q==="dark"?q:s==="light"||s==="dark"?s:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.classList.toggle("dark",t==="dark")}catch(e){}})()`;
