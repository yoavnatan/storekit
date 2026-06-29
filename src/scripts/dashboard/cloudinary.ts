export function thumbUrl(src: string, w = 84, h = 84): string {
  const idx = src.indexOf('/upload/');
  if (idx === -1) return src;
  return `${src.slice(0, idx + 8)}w_${w},h_${h},c_fill,f_auto,q_auto/${src.slice(idx + 8)}`;
}

export async function cloudinaryUpload(blob: Blob, cloud: string, preset: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob);
  fd.append('upload_preset', preset);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const json = await res.json() as { secure_url: string };
  return json.secure_url;
}
