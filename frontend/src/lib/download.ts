// Save a gallery file to the user's Downloads (web). In the browser gallery
// mode the images live in the origin-private file system, which the user can't
// reach: this is the way out. Goes through a Blob URL rather than the data URL
// itself, which some browsers refuse past a few MB (videos).
export async function downloadFile(src: string, name: string): Promise<void> {
  const blob = await (await fetch(src)).blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser time to start the download before the URL goes away.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
