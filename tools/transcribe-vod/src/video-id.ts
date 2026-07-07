/**
 * YouTube URL / ID → videoId 抽出（AR-2・純ロジック）。
 *
 * AR-1 endpoint の videoId 制約 `[A-Za-z0-9_-]{1,64}` に合わせて検証する。
 */

/** AR-1 endpoint と同じ videoId 形式。 */
export const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * YouTube の各種 URL 形式（watch?v= / youtu.be / live / embed / shorts）または
 * 素の ID から videoId を取り出す。取れなければ null。
 */
export function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (s.length === 0) return null;

  // 素の ID（11 文字前後の YouTube ID）。
  if (VIDEO_ID_REGEX.test(s) && !s.includes('/') && !s.includes('.')) return s;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return VIDEO_ID_REGEX.test(id) ? id : null;
  }
  // youtube.com/watch?v=<id>
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID_REGEX.test(v)) return v;
  // youtube.com/{live,embed,shorts}/<id>
  const m = /^\/(?:live|embed|shorts)\/([A-Za-z0-9_-]{1,64})/.exec(url.pathname);
  if (m) return m[1];

  return null;
}
