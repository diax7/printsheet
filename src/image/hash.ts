/** A short hex id for a file's bytes (the first 96 bits of SHA-256): the same bytes, the same id. */
export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest).subarray(0, 12), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
