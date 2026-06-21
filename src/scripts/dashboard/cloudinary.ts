export async function cloudinaryUpload(blob: Blob, cloud: string, preset: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob);
  fd.append('upload_preset', preset);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const json = await res.json() as { secure_url: string };
  return json.secure_url;
}
