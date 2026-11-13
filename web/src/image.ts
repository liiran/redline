export type Prepared = { data: string; mediaType: "image/jpeg" | "image/png"; width: number; height: number; preview: string }

/**
 * Shrinks a photo to at most 1568 px on its long side, the size Claude reads without scaling
 * it again, so the box positions it reports match the picture Redline keeps.
 */
export async function prepareImage(blob: Blob, max = 1568): Promise<Prepared> {
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new Error("That file isn't an image Redline can open.")
  })
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(16, Math.round(bitmap.width * scale))
  const height = Math.max(16, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return fromCanvas(canvas, "image/jpeg")
}

export function fromCanvas(canvas: HTMLCanvasElement, mediaType: "image/jpeg" | "image/png" = "image/png"): Prepared {
  const preview = canvas.toDataURL(mediaType, 0.9)
  return { data: preview.slice(preview.indexOf(",") + 1), mediaType, width: canvas.width, height: canvas.height, preview }
}

export function imageFrom(items: DataTransferItemList | FileList | null | undefined): File | null {
  if (!items) return null
  for (const item of Array.from(items as ArrayLike<DataTransferItem | File>)) {
    const file = item instanceof File ? item : item.kind === "file" ? item.getAsFile() : null
    if (file && file.type.startsWith("image/")) return file
  }
  return null
}
