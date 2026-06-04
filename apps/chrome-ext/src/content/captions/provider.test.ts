/**
 * Phase 5 P5-B3: YouTubeCaptionProvider の単体テスト。
 *
 * jsdom 非導入のため、parent frame DOM（window.parent.document）と video 要素を
 * 最小スタブで globalThis に注入する。MutationObserver の実駆動はテストせず、
 * 収集ロジックは provider.__test__.ingest で直接駆動する（observer 経由でない）。
 * getRecentContext / 5 秒メモ化 / window 抽出 / ring buffer / null 返却を検証。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YouTubeCaptionProvider } from './provider.js';

/** video.currentTime をテストから可変にするためのコンテナ。 */
interface VideoStub {
  currentTime: number;
}

interface DocStub {
  video: VideoStub;
  hasContainer: boolean;
  querySelector(sel: string): unknown;
}

function installParentDom(opts?: { hasContainer?: boolean }): DocStub {
  const video: VideoStub = { currentTime: 0 };
  const doc: DocStub = {
    video,
    hasContainer: opts?.hasContainer ?? true,
    querySelector(sel: string) {
      if (sel === 'video') return video;
      if (sel.includes('caption')) {
        return doc.hasContainer ? { textContent: '' } : null;
      }
      return null;
    },
  };
  // window.parent.document を stub（content script は chat iframe で動く想定）
  (globalThis as unknown as { window: unknown }).window = {
    parent: { document: doc },
  };
  return doc;
}

describe('YouTubeCaptionProvider', () => {
  let doc: DocStub;

  beforeEach(() => {
    doc = installParentDom();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function provider(mode: 'live' | 'archive' = 'archive'): YouTubeCaptionProvider {
    return new YouTubeCaptionProvider(mode);
  }

  it('getName は youtube-caption', () => {
    expect(provider().getName()).toBe('youtube-caption');
  });

  it('しきい値: live=0.5 / archive=0.4', () => {
    expect(provider('live').__test__.getThreshold()).toBe(0.5);
    expect(provider('archive').__test__.getThreshold()).toBe(0.4);
  });

  it('字幕収集 → getRecentContext で text/quality/source/segmentCount を返す', async () => {
    const p = provider('archive');
    doc.video.currentTime = 120;
    p.__test__.ingest('これから次のエリアに進むよ', 100, Date.now());
    p.__test__.ingest('ここのボス強いけど頑張る', 110, Date.now());

    const ctx = await p.getRecentContext(60);
    expect(ctx).not.toBeNull();
    expect(ctx!.source).toBe('caption');
    expect(ctx!.segmentCount).toBe(2);
    expect(ctx!.text).toContain('次のエリア');
    expect(ctx!.text).toContain('ボス');
    expect(ctx!.qualityScore).toBeGreaterThan(0.7);
  });

  it('getRecentContext は currentTimeSeconds に video.currentTime を含む（P5-B4c）', async () => {
    const p = provider('archive');
    doc.video.currentTime = 137;
    p.__test__.ingest('十分に長い字幕テキストその1です', 120, Date.now());
    p.__test__.ingest('十分に長い字幕テキストその2です', 130, Date.now());
    const ctx = await p.getRecentContext(60);
    expect(ctx).not.toBeNull();
    // text/quality と同一スナップショットの再生位置（captionSig 組み立て用）
    expect(ctx!.currentTimeSeconds).toBe(137);
  });

  it('thresholdOverride: 高いしきい値を渡すと品質が満たず null（ユーザー設定が mode 既定に勝つ）', async () => {
    const p = provider('archive'); // mode 既定 0.4
    doc.video.currentTime = 120;
    p.__test__.ingest('これから次のエリアに進むよ', 100, Date.now());
    p.__test__.ingest('ここのボス強いけど頑張る', 110, Date.now());
    // 既定 0.4 では useable（同一バッファ）
    expect(await p.getRecentContext(60)).not.toBeNull();
    // override 1.1（スコア上限 1.0 を超える）では必ず弾かれる。memo は threshold
    // 違いで再走査され、override が evaluateCaptionQuality に確実に届く（既定 0.4 が
    // 通る一方で override は弾く＝ユーザー設定が mode 既定に勝つことの証左）。
    expect(await p.getRecentContext(60, 1.1)).toBeNull();
  });

  it('UI 文字列（自動生成/クリックして設定）は ingest しない（P5-B5 hotfix）', () => {
    const p = provider('archive');
    p.__test__.ingest('日本語 (自動生成) をクリックして設定', 100, Date.now());
    p.__test__.ingest('字幕を選択', 101, Date.now());
    expect(p.__test__.segmentCount()).toBe(0);
  });

  it('効果音注釈 [叫び声] 等は sanitize で除去してから積む（P5-B5 hotfix）', async () => {
    const p = provider('archive');
    doc.video.currentTime = 120;
    p.__test__.ingest('[叫び声] よし来た、次の部屋に進もう [笑い]', 100, Date.now());
    p.__test__.ingest('ここのボスは強かったけど倒せた [荒い息]', 110, Date.now());
    const ctx = await p.getRecentContext(60);
    expect(ctx).not.toBeNull();
    expect(ctx!.text).not.toContain('[');
    expect(ctx!.text).not.toContain('叫び声');
    expect(ctx!.text).not.toContain('荒い息');
    expect(ctx!.text).toContain('次の部屋');
    expect(ctx!.text).toContain('倒せた');
  });

  it('getRecentContext: ローリング字幕の周期重複を畳む（A B A B → A B）（P5-B5 hotfix）', async () => {
    const p = provider('archive');
    doc.video.currentTime = 120;
    // 各 segment は distinct（ingest の lastText 重複スキップを回避）だが、
    // 連結すると A。B。A。B。 の周期になる → dedupeRepeatedPhrases で 1 周期へ。
    p.__test__.ingest('これから次のエリアに進むよ。', 100, Date.now());
    p.__test__.ingest('ここのボス強いけど頑張る。これから次のエリアに進むよ。', 105, Date.now());
    p.__test__.ingest('ここのボス強いけど頑張る。', 110, Date.now());
    const ctx = await p.getRecentContext(60);
    expect(ctx).not.toBeNull();
    expect(ctx!.text).toBe('これから次のエリアに進むよ。ここのボス強いけど頑張る。');
  });

  it('useable=false（短すぎ）→ null を返す', async () => {
    const p = provider('archive');
    doc.video.currentTime = 105;
    p.__test__.ingest('え', 100, Date.now());
    const ctx = await p.getRecentContext(60);
    expect(ctx).toBeNull();
  });

  it('window 抽出: currentTime-window 範囲外のセグメントは除外', async () => {
    const p = provider('archive');
    p.__test__.ingest('古い発話なので範囲外になるはず', 10, Date.now()); // currentTime=120, window 60 → minTime 60。10 は範囲外
    p.__test__.ingest('最近の発話で範囲内に入る長めの字幕', 100, Date.now());
    p.__test__.ingest('もう一つ最近の発話を足しておく', 115, Date.now());
    doc.video.currentTime = 120;

    const ctx = await p.getRecentContext(60);
    expect(ctx).not.toBeNull();
    // 範囲内 2 件のみ（10 秒の古い発話は除外）
    expect(ctx!.segmentCount).toBe(2);
    expect(ctx!.text).not.toContain('古い発話');
  });

  it('5 秒メモ化: TTL 内の 2 回目は再走査せず同じ結果（video.currentTime 変化を無視）', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const p = provider('archive');
    doc.video.currentTime = 120;
    p.__test__.ingest('これは十分長い字幕テキストの一つ目です', 100, Date.now());
    p.__test__.ingest('これは十分長い字幕テキストの二つ目です', 110, Date.now());

    const first = await p.getRecentContext(60);
    expect(first).not.toBeNull();
    const firstCount = first!.segmentCount;

    // currentTime を大きく動かす（メモが効いていれば結果は変わらない）
    doc.video.currentTime = 9999;
    vi.advanceTimersByTime(2000); // TTL 5s 以内
    const second = await p.getRecentContext(60);
    expect(second!.segmentCount).toBe(firstCount); // 再走査されていない
    expect(second!.text).toBe(first!.text);
  });

  it('5 秒メモ化: TTL 超過で再走査される', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const p = provider('archive');
    doc.video.currentTime = 120;
    p.__test__.ingest('これは十分長い字幕テキストの一つ目です', 100, Date.now());
    p.__test__.ingest('これは十分長い字幕テキストの二つ目です', 110, Date.now());
    const first = await p.getRecentContext(60);
    expect(first!.segmentCount).toBe(2);

    // currentTime を範囲外へ動かし、TTL 超過させる → 再走査で 0 件 → null
    doc.video.currentTime = 9999;
    vi.advanceTimersByTime(5001);
    const second = await p.getRecentContext(60);
    expect(second).toBeNull(); // 9999 付近にセグメントなし → useable false
  });

  it('新規 ingest でメモが無効化され、次の getRecentContext で反映される', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const p = provider('archive');
    doc.video.currentTime = 120;
    p.__test__.ingest('これは十分長い字幕テキストの一つ目です', 100, Date.now());
    p.__test__.ingest('これは十分長い字幕テキストの二つ目です', 110, Date.now());
    const first = await p.getRecentContext(60);
    expect(first!.segmentCount).toBe(2);

    // TTL 内だが新規 ingest → memo 無効化
    p.__test__.ingest('三つ目の発話を追加で取り込んでおく', 115, Date.now());
    const second = await p.getRecentContext(60);
    expect(second!.segmentCount).toBe(3); // 再走査されメモ更新
  });

  it('重複字幕・空字幕は収集しない', async () => {
    const p = provider('archive');
    p.__test__.ingest('おなじ', 100, Date.now());
    p.__test__.ingest('おなじ', 101, Date.now()); // 直前と同一 → スキップ
    p.__test__.ingest('   ', 102, Date.now()); // 空白のみ → スキップ
    expect(p.__test__.segmentCount()).toBe(1);
  });

  it('ring buffer: 5 分超のセグメントは prune される', () => {
    const p = provider('archive');
    const t0 = 1_700_000_000_000;
    p.__test__.ingest('古い発話', 10, t0);
    // 6 分後に新発話 → 古いものは MAX_AGE_MS(5分) 超で除外
    p.__test__.ingest('新しい発話', 20, t0 + 6 * 60 * 1000);
    expect(p.__test__.segmentCount()).toBe(1);
  });

  it('stop() でバッファ・observer・memo がクリアされる', async () => {
    const p = provider('archive');
    p.__test__.ingest('発話テキストを十分長く入れておく一つ目', 100, Date.now());
    expect(p.__test__.segmentCount()).toBe(1);
    p.stop();
    expect(p.__test__.segmentCount()).toBe(0);
  });

  it('reset() でバッファがクリアされる（observer は維持される設計）', () => {
    const p = provider('archive');
    p.__test__.ingest('発話一つ目を長めに入れる', 100, Date.now());
    p.__test__.ingest('発話二つ目を長めに入れる', 110, Date.now());
    expect(p.__test__.segmentCount()).toBe(2);
    p.reset();
    expect(p.__test__.segmentCount()).toBe(0);
  });

  it('isAvailable: コンテナ有→true / 無→false', async () => {
    const p = provider('archive');
    expect(await p.isAvailable()).toBe(true);
    doc.hasContainer = false;
    expect(await p.isAvailable()).toBe(false);
  });
});
