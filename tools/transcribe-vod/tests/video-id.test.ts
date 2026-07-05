import { describe, it, expect } from 'vitest';
import { extractVideoId } from '../src/video-id.js';

describe('extractVideoId', () => {
  it('watch?v=', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=PHPWFt6d5TM')).toBe('PHPWFt6d5TM');
  });
  it('youtu.be', () => {
    expect(extractVideoId('https://youtu.be/PHPWFt6d5TM')).toBe('PHPWFt6d5TM');
  });
  it('live/', () => {
    expect(extractVideoId('https://www.youtube.com/live/PHPWFt6d5TM?feature=share')).toBe(
      'PHPWFt6d5TM',
    );
  });
  it('shorts/', () => {
    expect(extractVideoId('https://youtube.com/shorts/abc123DEF_-')).toBe('abc123DEF_-');
  });
  it('素の ID', () => {
    expect(extractVideoId('PHPWFt6d5TM')).toBe('PHPWFt6d5TM');
  });
  it('追加クエリがあっても v= を拾う', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=PHPWFt6d5TM&t=120s')).toBe('PHPWFt6d5TM');
  });
  it('抽出できない入力は null', () => {
    expect(extractVideoId('')).toBeNull();
    expect(extractVideoId('https://example.com/foo')).toBeNull();
    expect(extractVideoId('not a url')).toBeNull();
  });
});
