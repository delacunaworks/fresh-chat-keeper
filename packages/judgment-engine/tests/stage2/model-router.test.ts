import { describe, it, expect } from 'vitest';
import {
  selectModel,
  getEffectiveModel,
  getSummaryModel,
  type ModelTier,
} from '../../src/stage2/model-router.js';

describe('model-router', () => {
  describe('selectModel', () => {
    it('returns Haiku config for free tier', () => {
      const config = selectModel('free');
      expect(config.model).toBe('claude-haiku-4-5-20251001');
      expect(config.maxTokens).toBe(200);
      expect(config.temperature).toBe(0);
      expect(config.supportsCaching).toBe(true);
    });

    it('returns Sonnet config for premium tier (logical mapping)', () => {
      const config = selectModel('premium');
      expect(config.model).toBe('claude-sonnet-4-6');
      expect(config.maxTokens).toBe(300);
    });

    it('returns Sonnet config for streamer tier (logical mapping)', () => {
      const config = selectModel('streamer');
      expect(config.model).toBe('claude-sonnet-4-6');
      expect(config.maxTokens).toBe(300);
    });
  });

  describe('getEffectiveModel (Phase 2: all tiers → Haiku)', () => {
    it.each<ModelTier>(['free', 'premium', 'streamer'])(
      'returns Haiku regardless of tier (%s)',
      (tier) => {
        const config = getEffectiveModel(tier);
        expect(config.model).toBe('claude-haiku-4-5-20251001');
      },
    );

    it('temperature is 0 for deterministic judgment', () => {
      expect(getEffectiveModel('free').temperature).toBe(0);
      expect(getEffectiveModel('premium').temperature).toBe(0);
      expect(getEffectiveModel('streamer').temperature).toBe(0);
    });

    it('supportsCaching is true for all tiers (effective)', () => {
      expect(getEffectiveModel('free').supportsCaching).toBe(true);
      expect(getEffectiveModel('premium').supportsCaching).toBe(true);
      expect(getEffectiveModel('streamer').supportsCaching).toBe(true);
    });
  });

  describe('getSummaryModel (Phase 7: 要約は Sonnet・判定と分離)', () => {
    it('判定（Haiku）とは別モデル（Sonnet 4.6）を返す', () => {
      const summary = getSummaryModel();
      expect(summary.model).toBe('claude-sonnet-4-6');
      expect(summary.model).not.toBe(getEffectiveModel('free').model);
    });

    it('要約は temperature 0.2 / supportsCaching=false（判定キャッシュに影響させない）', () => {
      const summary = getSummaryModel();
      expect(summary.temperature).toBe(0.2);
      expect(summary.supportsCaching).toBe(false);
      expect(summary.maxTokens).toBeGreaterThanOrEqual(300);
    });
  });
});
