/**
 * camelCase ↔ snake_case mapper の単体テスト。
 *
 * 設計書 §4.1 の SpoilerJudgmentLog と §5.3 の judgment_logs テーブル定義の
 * 対応が崩れていないことを保護する。
 */

import { describe, it, expect } from 'vitest';
import { toJudgmentLogRow, fromJudgmentLogRow } from '../src/db/schema.js';
import type { SpoilerJudgmentLog } from '@fresh-chat-keeper/shared';

function buildSampleLog(overrides: Partial<SpoilerJudgmentLog> = {}): SpoilerJudgmentLog {
  return {
    logId: '00000000-0000-4000-8000-000000000001',
    recordedAt: '2026-05-01T10:00:00.000Z',
    consentVersion: '2026-05-01',
    videoId: 'dQw4w9WgXcQ',
    channelId: 'UCstreamer',
    gameTitle: 'persona5',
    streamProgressHint: null,
    timeIntoStream: 1234,
    judgmentMode: 'archive_replay',
    targetMessage: {
      body: '主人公が死ぬ',
      authorChannelId: 'UCviewer-plain',
      timestamp: '2026-05-01T09:59:50.000Z',
      isMember: null,
      isModerator: null,
      isVerified: null,
    },
    precedingMessages: [
      { body: 'こんにちは', timestamp: '2026-05-01T09:59:40.000Z' },
    ],
    followingMessages: [],
    stageACategory: 'unknown',
    stageAConfidence: null,
    labels: ['spoiler'],
    primaryLabel: 'spoiler',
    confidence: 0.92,
    stage: 'stage2',
    reasonJa: '物語の結末への直接言及',
    labelSource: 'haiku',
    reviewedByHuman: false,
    userFeedback: null,
    extensionVersion: '0.3.5',
    userTokenHashed: 'placeholder-will-be-overwritten',
    ...overrides,
  };
}

describe('toJudgmentLogRow', () => {
  it('camelCase の SpoilerJudgmentLog を snake_case の D1 行に変換する', () => {
    const log = buildSampleLog();
    const row = toJudgmentLogRow(log, 'hashed-author', 'hashed-token', 1700000000000);

    expect(row.log_id).toBe(log.logId);
    expect(row.recorded_at).toBe(Date.parse(log.recordedAt));
    expect(row.consent_version).toBe('2026-05-01');
    expect(row.video_id).toBe('dQw4w9WgXcQ');
    expect(row.channel_id).toBe('UCstreamer');
    expect(row.judgment_mode).toBe('archive_replay');
    // ハッシュ化された値が引数経由で入っていること
    expect(row.target_author_channel_id).toBe('hashed-author');
    expect(row.user_token_hashed).toBe('hashed-token');
    expect(row.target_timestamp).toBe(Date.parse(log.targetMessage.timestamp));
    // boolean → 0/1/null
    expect(row.target_is_member).toBeNull();
    expect(row.reviewed_by_human).toBe(0);
    // JSON 化
    expect(JSON.parse(row.labels_json)).toEqual(['spoiler']);
    expect(JSON.parse(row.preceding_messages_json)).toHaveLength(1);
    expect(row.following_messages_json).toBe('[]');
    // userFeedback null → null（空オブジェクトではなく）
    expect(row.user_feedback_json).toBeNull();
    expect(row.received_at).toBe(1700000000000);
  });

  it('userFeedback がある場合は JSON 化される', () => {
    const log = buildSampleLog({
      labelSource: 'user_report',
      userFeedback: {
        reportedAt: '2026-05-01T10:05:00.000Z',
        correctLabel: 'safe',
        failureCategory: 'metaphor',
        freeTextReason: '比喩表現でした',
      },
    });
    const row = toJudgmentLogRow(log, 'h-author', 'h-token', 0);

    expect(row.user_feedback_json).not.toBeNull();
    const parsed = JSON.parse(row.user_feedback_json!);
    expect(parsed.correctLabel).toBe('safe');
    expect(parsed.failureCategory).toBe('metaphor');
  });

  it('reviewedByHuman: true → 1', () => {
    const log = buildSampleLog({ reviewedByHuman: true });
    const row = toJudgmentLogRow(log, 'a', 'b', 0);
    expect(row.reviewed_by_human).toBe(1);
  });

  it('isMember/Moderator/Verified が boolean のとき 0/1 に変換される', () => {
    const log = buildSampleLog({
      targetMessage: {
        ...buildSampleLog().targetMessage,
        isMember: true,
        isModerator: false,
        isVerified: true,
      },
    });
    const row = toJudgmentLogRow(log, 'a', 'b', 0);
    expect(row.target_is_member).toBe(1);
    expect(row.target_is_moderator).toBe(0);
    expect(row.target_is_verified).toBe(1);
  });

  it('不正な ISO 8601 タイムスタンプは例外を投げる', () => {
    const log = buildSampleLog({ recordedAt: 'not-a-date' });
    expect(() => toJudgmentLogRow(log, 'a', 'b', 0)).toThrow(/Invalid ISO 8601/);
  });
});

describe('fromJudgmentLogRow', () => {
  it('toJudgmentLogRow → fromJudgmentLogRow で値が復元される（authorChannelId 以外）', () => {
    const original = buildSampleLog();
    const row = toJudgmentLogRow(original, 'hashed-author', 'hashed-token', 1700000000000);
    const restored = fromJudgmentLogRow(row);

    // authorChannelId / userTokenHashed は DB 側でハッシュ化された値になる
    expect(restored.targetMessage.authorChannelId).toBe('hashed-author');
    expect(restored.userTokenHashed).toBe('hashed-token');

    // それ以外は元の値と一致
    expect(restored.logId).toBe(original.logId);
    expect(restored.recordedAt).toBe(original.recordedAt);
    expect(restored.videoId).toBe(original.videoId);
    expect(restored.judgmentMode).toBe(original.judgmentMode);
    expect(restored.targetMessage.body).toBe(original.targetMessage.body);
    expect(restored.targetMessage.timestamp).toBe(original.targetMessage.timestamp);
    expect(restored.precedingMessages).toEqual(original.precedingMessages);
    expect(restored.labels).toEqual(original.labels);
    expect(restored.confidence).toBe(original.confidence);
    expect(restored.userFeedback).toBeNull();
  });
});
