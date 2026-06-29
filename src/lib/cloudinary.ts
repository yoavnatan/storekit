/** Transform a Cloudinary URL to serve a resized, auto-format, auto-quality variant. */
export function thumbUrl(src: string, w = 84, h = 84): string {
  const idx = src.indexOf('/upload/');
  if (idx === -1) return src;
  return `${src.slice(0, idx + 8)}w_${w},h_${h},c_fill,f_auto,q_auto/${src.slice(idx + 8)}`;
}
