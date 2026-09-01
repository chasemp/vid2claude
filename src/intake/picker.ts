/**
 * File intake. The picker is the primary path everywhere: no mobile browser
 * can capture the screen from a web page (see docs/spikes.md, constraint C1),
 * so the recording always arrives as a file the OS recorder already wrote.
 */

/** iOS labels some screen recordings as QuickTime even when they are MP4. */
export const ACCEPTED_TYPES = ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm"];
export const ACCEPT_ATTR = ".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/webm";

export function looksLikeVideo(file: File): boolean {
  if (file.type && file.type.startsWith("video/")) return true;
  // Some Android file providers hand over an empty MIME type.
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

export function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT_ATTR;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      },
      { once: true },
    );
    input.click();
  });
}

/** Desktop drag and drop. Returns a teardown function. */
export function enableDropTarget(
  el: HTMLElement,
  onFile: (file: File) => void,
  onStateChange?: (active: boolean) => void,
): () => void {
  const stop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onOver = (event: DragEvent) => {
    stop(event);
    onStateChange?.(true);
  };
  const onLeave = (event: DragEvent) => {
    stop(event);
    onStateChange?.(false);
  };
  const onDrop = (event: DragEvent) => {
    stop(event);
    onStateChange?.(false);
    const file = event.dataTransfer?.files?.[0];
    if (file && looksLikeVideo(file)) onFile(file);
  };
  el.addEventListener("dragover", onOver);
  el.addEventListener("dragleave", onLeave);
  el.addEventListener("drop", onDrop);
  return () => {
    el.removeEventListener("dragover", onOver);
    el.removeEventListener("dragleave", onLeave);
    el.removeEventListener("drop", onDrop);
  };
}
