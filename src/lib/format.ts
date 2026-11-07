export function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}
