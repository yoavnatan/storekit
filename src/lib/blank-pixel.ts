// 1x1 transparent GIF as an inline data URI — costs no request.
// Used as the src of an image whose real URL is deferred (held in data-src until
// something decides it's worth fetching). A src-less <img> renders its alt TEXT
// instead of a picture, so a deferred slide needs *some* src to stay blank.
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
