/**
 * collection-log-builder.ts の単体テスト。
 *
 * SpoilerJudgmentLog のフィールドが仕様どおりに埋まることを確認する。
 * Phase 3+ で値が入るフィールド（isMember 等）が null / 空配列で
 * 埋まっていることが重要（apps/api 側の validateLog が 422 にならない）。
 */

import { describe, it, expect } from 'vitest';
import { buildJudgmentLog, type JudgmentRawData } from '../src/content/collection-log-builder.js';

function buildRaw(overrides: Partial<JudgmentRawData> = {}): JudgmentRawData {
  return {
    logId: '00000000-0000-4000-8000-000000000001',
    consentVersion: '2026-05-01',
    videoId: 'dQw4w9WgXcQ',
    channelId: 'UCstreamer',
    gameTitle: 'persona5',
    timeIntoStream: 100,
    judgmentMode: 'archive_replay',
    targetBody: '主人公が死ぬ',
    targetAuthorChannelId: 'UCviewer-plain',
    targetTimestamp: '2026-05-01T10:00:00.000Z',
    precedingMessages: [],
    stageACategory: 'unknown',
    labels: ['spoiler'],
    primaryLabel: 'spoiler',
    confidence: 0.92,
    stage: 'stage2',
    reasonJa: '結末への直接言及',
    labelSource: 'haiku',
    extensionVersion: '0.3.5',
    ...overrides,
  };
}

describe('buildJudgmentLog', () => {
  it('必須フィールドがすべて期待どおりに埋まる', () => {
    const log = buildJudgmentLog(buildRaw());
    expect(log.logId).toBe('00000000-0000-4000-8000-000000000001');
    expect(log.consentVersion).toBe('2026-05-01');
    expect(log.videoId).toBe('dQw4w9WgXcQ');
    expect(log.channelId).toBe('UCstreamer');
    expect(log.judgmentMode).toBe('archive_replay');
    expect(log.targetMessage.body).toBe('主人公が死ぬ');
    expect(log.targetMessage.authorChannelId).toBe('UCviewer-plain');
    expect(log.labels).toEqual(['spoiler']);
    expect(log.primaryLabel).toBe('spoiler');
    expect(log.confidence).toBe(0.92);
  });

  it('userTokenHashed は常に空文字（apps/api 側で必ず上書き）', () => {
    const log = buildJudgmentLog(buildRaw());
    expect(log.userTokenHashed).toBe('');
  });

  it('Phase 3+ で埋まるフィールドは null / false / 空配列', () => {
    const log = buildJudgmentLog(buildRaw());
    expect(log.streamProgressHint).toBeNull();
    expect(log.targetMessage.isMember).toBeNull();
    expect(log.targetMessage.isModerator).toBeNull();
    expect(log.targetMessage.isVerified).toBeNull();
    expect(log.followingMessages).toEqual([]);
    expect(log.stageAConfidence).toBeNull();
    expect(log.reviewedByHuman).toBe(false);
    expect(log.userFeedback).toBeNull();
  });

  it('recordedAt は ISO 8601 形式（UTC）', () => {
    const log = buildJudgmentLog(buildRaw());
    // YYYY-MM-DDTHH:MM:SS.sssZ
    expect(log.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('isObviouslySafe 経路: stageACategory=reaction / labels=[safe] が通る', () => {
    const log = buildJudgmentLog(
      buildRaw({
        stageACategory: 'reaction',
        labels: ['safe'],
        primaryLabel: 'safe',
        confidence: 1.0,
        stage: 'stage1',
      }),
    );
    expect(log.stageACategory).toBe('reaction');
    expect(log.primaryLabel).toBe('safe');
    expect(log.stage).toBe('stage1');
  });

  it('precedingMessages は入力配列をそのまま保持', () => {
    const messages = [
      { body: 'hello', timestamp: '2026-05-01T09:59:00.000Z' },
      { body: 'world', timestamp: '2026-05-01T09:59:30.000Z' },
    ];
    const log = buildJudgmentLog(buildRaw({ precedingMessages: messages }));
    expect(log.precedingMessages).toEqual(messages);
  });

  it('gameTitle が null の場合（none/other ゲーム）も保持', () => {
    const log = buildJudgmentLog(buildRaw({ gameTitle: null }));
    expect(log.gameTitle).toBeNull();
  });

  it('live モード: judgmentMode=live + timeIntoStream', () => {
    const log = buildJudgmentLog(
      buildRaw({ judgmentMode: 'live', timeIntoStream: 500, precedingMessages: [] }),
    );
    expect(log.judgmentMode).toBe('live');
    expect(log.timeIntoStream).toBe(500);
    expect(log.precedingMessages).toEqual([]);
  });
});
