/**
 * YouTube チャット DOM からの投稿者・配信者識別子抽出ヘルパー。
 *
 * archive.ts（Phase 2.5 ingest 用）と user-blocking/blocking.ts
 * （Phase 3 ユーザーブロック用）の双方が使う。両者の循環 import を避けるため
 * 独立モジュールに切り出した（B3 / P3-UI-02 のリファクタ）。
 *
 * DOM 依存だが副作用を持たない純粋な抽出関数のみ。
 */

/**
 * 親フレームの DOM から配信者の channel ID を抽出する。
 *
 * YouTube の DOM は SPA レンダリング + Lit/Polymer Components で頻繁に
 * 構造が変わる。2026-05 時点では `meta[itemprop="channelId"]` も
 * `ytd-channel-name a` も親 document からは取れず、唯一安定して取れるのは
 * 親ページ全体に散らばる `<a href*="/channel/UC...">` の集合のみ。
 *
 * 配信者の channel ID は「join / videos / about など複数のサブパスへの
 * リンクが同じ UC ID を指す」性質を利用し、**親ページ内で最頻出の UC ID** を
 * 配信者と判定する。これは関連動画やコメンター等の単発リンクに紛れない
 * 堅牢な戦略。
 *
 * 失敗時は空文字を返す（呼び出し側で emit を諦める）。
 */
export function getChannelIdFromDom(): string {
  try {
    const doc = window.parent?.document;
    if (!doc) return '';

    // 1. meta itemprop（旧 schema.org、現状は出ない）
    const meta = doc.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]');
    if (meta?.content) return meta.content;

    // 2. ytd-channel-name の anchor（旧レイアウト互換）
    const channelLink = doc.querySelector<HTMLAnchorElement>(
      'ytd-channel-name a[href*="/channel/"]',
    );
    const fromChannelName = extractChannelIdFromHref(channelLink?.href);
    if (fromChannelName) return fromChannelName;

    // 3. #owner-text の anchor（モバイル/旧レイアウト）
    const ownerLink = doc.querySelector<HTMLAnchorElement>(
      '#owner-text a[href*="/channel/"], #owner a[href*="/channel/"]',
    );
    const fromOwner = extractChannelIdFromHref(ownerLink?.href);
    if (fromOwner) return fromOwner;

    // 4. 最頻出戦略: 親ページ全体の /channel/UC... リンクから最頻出 ID を返す。
    //    配信者は join / videos / about など複数のサブパスを持つため、自然と
    //    最頻出になる。関連動画リンク等は通常 1 件なので紛れない。
    return findMostFrequentChannelId(doc);
  } catch {
    return '';
  }
}

/**
 * チャットメッセージ要素から投稿者の識別子を抽出する。
 *
 * **2026-05 時点の仕様変更（重要）**:
 * YouTube は live chat replay の DOM から `authorExternalChannelId`（UC...）を
 * **完全に削除した**（プライバシー強化と推察）。HTML 属性・Polymer 内部状態
 * （`__data` / `_data` / `properties`）・shadowRoot・iframe globals
 * （`ytInitialData` 等）すべてに UC ID は存在しない。
 *
 * 唯一安定して取れるのは `#author-name` 内の **ハンドル名**
 * （`@rm-yw4ep` のような表示名）。これを識別子として採用する。
 *
 * **データ収集への影響**: フィールド名 `targetAuthorChannelId` は維持
 * （スキーマ互換性のため）、value がハンドル文字列になる。SHA-1 ハッシュ
 * 化ロジックも変更不要（input 文字列が変わるだけ）。同一動画内のユーザー
 * 一貫性は保たれるため、Phase 2.5 のデータ品質は十分保たれる。
 *
 * **ユーザーブロックへの影響（Phase 3）**: ブロックキーもこのハンドル名に
 * なる。同一動画内では一貫するので遡及非表示・以降の自動ブロックは機能する。
 * 別配信をまたいだ永続ブロックは Innertube API 解析（Phase 3+）まで限定的。
 *
 * フォールバック chain（保険として旧経路も残す）:
 *
 *   1. `data-author-external-channel-id` — 旧属性（過去 YouTube 互換）
 *   2. `author-external-channel-id` — data- prefix なし（過去 YouTube 互換）
 *   3. `renderer.data.authorExternalChannelId` — Polymer JS プロパティ（過去）
 *   4. renderer 内の `a[href*="/channel/"]` から抽出（過去）
 *   5. **`#author-name` の textContent**（現行 2026-05、ハンドル名）
 *
 * すべて失敗時は空文字を返す。
 */
export function getAuthorChannelIdFromElement(el: Element): string {
  const renderer =
    el.closest('yt-live-chat-text-message-renderer') ??
    el.closest('yt-live-chat-paid-message-renderer');
  if (!renderer) return '';

  // 1. data- prefix 付き
  const dataAttr = renderer.getAttribute('data-author-external-channel-id');
  if (dataAttr) return dataAttr;

  // 2. data- prefix なし
  const plainAttr = renderer.getAttribute('author-external-channel-id');
  if (plainAttr) return plainAttr;

  // 3. Polymer data property
  const polymerData = (renderer as unknown as {
    data?: { authorExternalChannelId?: unknown };
  }).data;
  const fromPolymer = polymerData?.authorExternalChannelId;
  if (typeof fromPolymer === 'string' && fromPolymer.length > 0) return fromPolymer;

  // 4. renderer 内の anchor の href から抽出
  const authorLink = renderer.querySelector<HTMLAnchorElement>('a[href*="/channel/"]');
  const fromHref = extractChannelIdFromHref(authorLink?.href);
  if (fromHref) return fromHref;

  // 5. **現行 YouTube（2026-05）**: ハンドル名を使用。
  //    `#author-name` の textContent から、付随する子要素のテキストを除外して
  //    ハンドル本体だけを取り出す（badge 等のネスト要素のテキストが混入する
  //    のを避けるため、子要素を一旦無視して直接の textNode のみを連結）。
  const authorNameEl = renderer.querySelector('#author-name');
  if (authorNameEl) {
    const handle = extractDirectText(authorNameEl).trim();
    // ハンドルは @ で始まる場合が多いが、任意の表示名（チャンネル名）の場合もある。
    // 空でなければ採用する。同一動画内では同じ値を返すため、ユーザー一貫性 OK。
    if (handle) return handle;
  }

  return '';
}

/**
 * 要素の直下の textNode のテキストだけを連結する（子要素のテキストは除外）。
 *
 * `<span id="author-name"><span id="prepend-chat-badges"></span>@rm-yw4ep<span id="chip-badges"></span></span>`
 * から `@rm-yw4ep` だけを取り出す用途。
 */
export function extractDirectText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    }
  }
  return text;
}

/**
 * `/channel/UCxxxxx...` を含む href から channelId 部分（UCxxxxx）を取り出す。
 * マッチしなければ空文字。UC で始まり [A-Za-z0-9_-] が続く YouTube channelId 形式。
 */
export function extractChannelIdFromHref(href: string | undefined | null): string {
  if (!href) return '';
  const match = href.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
  return match?.[1] ?? '';
}

/**
 * チャットメッセージ要素から投稿者の**表示名**を抽出する。
 *
 * `getAuthorChannelIdFromElement` と同じく `#author-name` の直下 textNode のみ
 * （`#prepend-chat-badges` / `#chip-badges` 等の子要素を除外）から取り出す。
 * 2026-05 仕様では channelId == display 文字列（@handle）になることが多いが、
 * 「表示名」と「識別子」は別概念として将来分岐する可能性があるため別関数とする。
 *
 * Phase 3.5 B5 で B4 の集計時 displayName 取得に使用。
 */
export function getAuthorDisplayNameFromElement(messageEl: Element): string {
  const renderer =
    messageEl.closest('yt-live-chat-text-message-renderer') ??
    messageEl.closest('yt-live-chat-paid-message-renderer') ??
    messageEl;
  const authorNameEl = renderer.querySelector('#author-name');
  if (!authorNameEl) return '';
  return extractDirectText(authorNameEl).trim();
}

/**
 * 配信者の**表示名**を親ページから抽出する。content script が chat iframe で
 * 動いているため `window.parent?.document` 経由で漁る（getChannelIdFromDom と同パターン）。
 *
 * 抽出順:
 * 1. `ytd-channel-name` 内の表示名要素（`#text` ないし `a` のテキスト）
 * 2. `#owner` 配下のチャンネル名 anchor のテキスト
 * 3. `document.title` から ` - YouTube` を除去（video title fallback）
 * 4. すべて失敗で空文字
 *
 * Phase 3.5 B5 で stream-detector が表示名を持てるよう新設。
 */
export function getStreamerDisplayName(): string {
  try {
    const doc = window.parent?.document ?? (typeof document !== 'undefined' ? document : null);
    if (!doc) return '';

    // 1. ytd-channel-name の表示名（yt-formatted-string / #text a / #text / a の順）。
    //    B5-hotfix: 現代 YouTube DOM は `<ytd-channel-name><yt-formatted-string>...</yt-formatted-string></ytd-channel-name>`
    //    が頻出パターンになっており、先頭で拾わないと title fallback まで降りてしまう。
    const channelNameEl = doc.querySelector('ytd-channel-name');
    if (channelNameEl) {
      const inner =
        channelNameEl.querySelector('yt-formatted-string') ??
        channelNameEl.querySelector('#text a') ??
        channelNameEl.querySelector('#text') ??
        channelNameEl.querySelector('a');
      const text = inner?.textContent?.trim();
      if (text) return text;
    }

    // 2. #owner / #owner-text 配下の anchor テキスト（旧/モバイルレイアウト）
    const ownerAnchor = doc.querySelector<HTMLAnchorElement>(
      '#owner a, #owner-text a',
    );
    const ownerText = ownerAnchor?.textContent?.trim();
    if (ownerText) return ownerText;

    // 3. fallback: document.title から末尾 " - YouTube" 除去（タイトル先頭は video title だが、
    //    streamer 名が title に入る運用も多く、null よりはマシな fallback）
    const title = doc.title || '';
    const stripped = title.replace(/\s*-\s*YouTube\s*$/, '').trim();
    if (stripped) return stripped;

    return '';
  } catch {
    return '';
  }
}

/**
 * 親ページ内の `/channel/UC...` リンクから最頻出 channelId を返す。
 *
 * 配信者は join / videos / about / membership 等の複数サブパスを持つため、
 * 自然と最頻出になる。関連動画やコメンターのリンクは通常 1 件で紛れない。
 *
 * 同数 1 位が複数ある場合は最初に見つかったものを返す。リンクが 1 つもなければ
 * 空文字。
 */
export function findMostFrequentChannelId(doc: Document): string {
  const links = doc.querySelectorAll<HTMLAnchorElement>('a[href*="/channel/"]');
  const counts = new Map<string, number>();
  for (const link of Array.from(links)) {
    const id = extractChannelIdFromHref(link.href);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of counts) {
    if (best === null || count > best.count) best = { id, count };
  }
  return best?.id ?? '';
}
