/**
 * F-1: 配信内コメントログ（session-comment-log）の単体テスト。
 *
 * 検証観点:
 * - per-user 記録 / 時刻順取得
 * - per-user 上限（PER_USER_MAX）超過で最古を FIFO eviction
 * - 全体上限（TOTAL_MAX）超過で最古アクティブ author を evict
 * - mark: 同一 text の最新未マークに付与
 * - clear: teardown で全破棄（非永続の担保）
 * - author 空は no-op
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSessionComment,
  markSessionComment,
  getSessionComments,
  clearSessionCommentLog,
  PER_USER_MAX,
  TOTAL_MAX,
  __test__,
} from './session-comment-log.js';

beforeEach(() => {
  clearSessionCommentLog();
});

describe('recordSessionComment / getSessionComments', () => {
  it('per-user に時刻順で記録される', () => {
    recordSessionComment('@a', 'one', { time: 100 });
    recordSessionComment('@a', 'two', { time: 200 });
    recordSessionComment('@b', 'other', { time: 150 });

    const a = getSessionComments('@a');
    expect(a.map((c) => c.text)).toEqual(['one', 'two']);
    expect(a.map((c) => c.time)).toEqual([100, 200]);
    expect(getSessionComments('@b').map((c) => c.text)).toEqual(['other']);
  });

  it('未知の author は空配列', () => {
    expect(getSessionComments('@none')).toEqual([]);
  });

  it('videoTime（再生位置）を保持する。未指定なら undefined', () => {
    recordSessionComment('@a', 'with', { time: 1, videoTime: 3661 });
    recordSessionComment('@a', 'without', { time: 2 });
    const a = getSessionComments('@a');
    expect(a[0].videoTime).toBe(3661);
    expect(a[1].videoTime).toBeUndefined();
  });

  it('シーク再放出の重複排除: 同一 text + ほぼ同一 videoTime は記録しない', () => {
    recordSessionComment('@a', '弾無いなった...', { time: 1000, videoTime: 7023 });
    recordSessionComment('@a', '弾無いなった...', { time: 60_000, videoTime: 7023 }); // 巻き戻し再放出
    recordSessionComment('@a', '弾無いなった...', { time: 61_000, videoTime: 7023.4 }); // 秒未満ズレ
    expect(getSessionComments('@a')).toHaveLength(1);
  });

  it('正当な連投コピペ（別 videoTime の同文）は残る', () => {
    recordSessionComment('@a', '草', { time: 1, videoTime: 100 });
    recordSessionComment('@a', '草', { time: 2, videoTime: 160 });
    recordSessionComment('@a', '草', { time: 3, videoTime: 220 });
    expect(getSessionComments('@a')).toHaveLength(3);
  });

  it('videoTime 無し同士は実時間ウィンドウ（10s）で重複排除', () => {
    recordSessionComment('@a', 'x', { time: 1000 });
    recordSessionComment('@a', 'x', { time: 5000 }); // 10s 以内 → 重複
    recordSessionComment('@a', 'x', { time: 20_000 }); // 10s 超 → 残る
    expect(getSessionComments('@a')).toHaveLength(2);
  });

  it('matchKey（パイプライン text）でも重複排除・マーカー照合できる', () => {
    // 表示 text は絵文字込み、matchKey は textContent ベース
    recordSessionComment('@a', 'すごい:_スバル草草の草:', { time: 1, videoTime: 50, matchKey: 'すごい' });
    recordSessionComment('@a', 'すごい:_スバル草草の草:', { time: 2, videoTime: 50, matchKey: 'すごい' });
    const a = getSessionComments('@a');
    expect(a).toHaveLength(1);
    // 判定パイプラインは絵文字なし text で mark を呼ぶ
    markSessionComment('@a', 'すごい', 'spoiler');
    expect(getSessionComments('@a')[0].primary).toBe('spoiler');
  });

  it('表示は videoTime 昇順（無いものは末尾・記録順）', () => {
    recordSessionComment('@a', 'late-recorded-early-time', { time: 3000, videoTime: 100 });
    recordSessionComment('@a', 'no-vt-1', { time: 1000 });
    recordSessionComment('@a', 'early-recorded-late-time', { time: 2000, videoTime: 500 });
    const a = getSessionComments('@a');
    expect(a.map((c) => c.text)).toEqual([
      'late-recorded-early-time',
      'early-recorded-late-time',
      'no-vt-1',
    ]);
  });

  it('author 空は記録しない（no-op）', () => {
    recordSessionComment('', 'x', { time: 1 });
    expect(__test__.totalCount()).toBe(0);
    expect(__test__.authorCount()).toBe(0);
  });

  it('返り値はコピー（内部バッファを外から破壊できない）', () => {
    recordSessionComment('@a', 'one', { time: 1 });
    const snap = getSessionComments('@a');
    snap[0].text = 'HACKED';
    expect(getSessionComments('@a')[0].text).toBe('one');
  });
});

describe('per-user 上限（PER_USER_MAX）', () => {
  it('超過すると最古を FIFO eviction（直近 N 件を保持）', () => {
    for (let i = 0; i < PER_USER_MAX + 5; i++) {
      recordSessionComment('@a', `c${i}`, { time: i });
    }
    const a = getSessionComments('@a');
    expect(a.length).toBe(PER_USER_MAX);
    // 最古 5 件（c0..c4）は落ち、c5 が先頭・最新が末尾。
    expect(a[0].text).toBe('c5');
    expect(a[a.length - 1].text).toBe(`c${PER_USER_MAX + 4}`);
    expect(__test__.totalCount()).toBe(PER_USER_MAX);
  });
});

describe('全体上限（TOTAL_MAX）', () => {
  it('超過すると最古アクティブ author を丸ごと evict する', () => {
    // 各 author を PER_USER_MAX 件で満たし、TOTAL_MAX を超えるまで author を増やす。
    const authorsNeeded = Math.ceil(TOTAL_MAX / PER_USER_MAX) + 1;
    for (let u = 0; u < authorsNeeded; u++) {
      for (let i = 0; i < PER_USER_MAX; i++) {
        recordSessionComment(`@u${u}`, `c${i}`, { time: u * 1000 + i });
      }
    }
    // 全体件数は TOTAL_MAX を超えない。
    expect(__test__.totalCount()).toBeLessThanOrEqual(TOTAL_MAX);
    // 最古 author（@u0）は evict されている。
    expect(getSessionComments('@u0')).toEqual([]);
    // 最新 author は保持。
    expect(getSessionComments(`@u${authorsNeeded - 1}`).length).toBe(PER_USER_MAX);
  });
});

describe('markSessionComment', () => {
  it('同一 text の最新未マークに primary を付与', () => {
    // 正当な連投（重複排除に落ちないよう videoTime を離す）
    recordSessionComment('@a', 'dup', { time: 1, videoTime: 100 });
    recordSessionComment('@a', 'dup', { time: 2, videoTime: 200 });
    markSessionComment('@a', 'dup', 'harassment');
    const a = getSessionComments('@a');
    // 最新（videoTime=200）が付与され、古い方は未マークのまま。
    expect(a[0].primary).toBeUndefined();
    expect(a[1].primary).toBe('harassment');
  });

  it('2 回目の mark はもう一方（古い未マーク）に付与される', () => {
    recordSessionComment('@a', 'dup', { time: 1, videoTime: 100 });
    recordSessionComment('@a', 'dup', { time: 2, videoTime: 200 });
    markSessionComment('@a', 'dup', 'spoiler');
    markSessionComment('@a', 'dup', 'backseat');
    const a = getSessionComments('@a');
    expect(a[0].primary).toBe('backseat'); // 古い方（残っていた未マーク）
    expect(a[1].primary).toBe('spoiler');
  });

  it('未知 author / 不一致 text は no-op', () => {
    recordSessionComment('@a', 'hello', { time: 1 });
    markSessionComment('@none', 'hello', 'spam');
    markSessionComment('@a', 'nomatch', 'spam');
    expect(getSessionComments('@a')[0].primary).toBeUndefined();
  });
});

describe('clearSessionCommentLog（teardown・非永続）', () => {
  it('全 author を破棄し件数もリセット', () => {
    recordSessionComment('@a', 'x', { time: 1 });
    recordSessionComment('@b', 'y', { time: 2 });
    clearSessionCommentLog();
    expect(getSessionComments('@a')).toEqual([]);
    expect(getSessionComments('@b')).toEqual([]);
    expect(__test__.totalCount()).toBe(0);
    expect(__test__.authorCount()).toBe(0);
  });
});
