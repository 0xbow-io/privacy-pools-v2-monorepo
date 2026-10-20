/**
 * Returns a promise that resolves after the given number of milliseconds.
 * @param ms - Duration to sleep in milliseconds.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
