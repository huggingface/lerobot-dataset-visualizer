/**
 * The query string with `tab` set to the open tab, so the address bar always names the view on
 * screen and a copied link opens it. The default tab is left out to keep episode links short. Other
 * parameters (`t`, `__theme`) are kept as they are.
 */
export function searchWithTab(
  search: string,
  tab: string,
  defaultTab: string,
): string {
  const params = new URLSearchParams(search);
  if (tab === defaultTab) params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  return query ? `?${query}` : "";
}
