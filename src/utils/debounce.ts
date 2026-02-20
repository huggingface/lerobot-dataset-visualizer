// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<F extends (...args: any[]) => void>(
  func: F,
  waitFor: number,
): (...args: Parameters<F>) => void {
  let timeoutId: number;
  return (...args: Parameters<F>) => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => func(...args), waitFor);
  };
}
