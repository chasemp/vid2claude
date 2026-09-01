/**
 * Web Share with a file payload (assumption A2). Availability is checked with
 * navigator.canShare({ files }) rather than assumed, because Safari and
 * Chrome disagree about which file types they will accept.
 */

export function canShareFile(file: File): boolean {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof navigator.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareFile(file: File, title: string): Promise<"shared" | "cancelled"> {
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    throw err;
  }
}

export function zipAsFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: "application/zip" });
}
