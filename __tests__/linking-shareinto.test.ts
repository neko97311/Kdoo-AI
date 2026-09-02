import {
  _isShareIntoUrlForTest,
  addShareIntoListener,
} from '@/utils/linking-interceptor';

describe('_isShareIntoUrlForTest', () => {
  it('matches expo-sharing hostname', () => {
    // iOS/Android share-into wakeups use `{scheme}://expo-sharing` (host = 'expo-sharing')
    expect(_isShareIntoUrlForTest('kdoomobile://expo-sharing')).toBe(true);
    expect(_isShareIntoUrlForTest('kdoomobile://expo-sharing/')).toBe(true);
  });

  it('rejects regular deep links', () => {
    expect(_isShareIntoUrlForTest('kdoomobile://share/abc')).toBe(false);
    expect(_isShareIntoUrlForTest('https://www.kdoo.ai/share/abc')).toBe(false);
  });

  it('rejects non-parseable or other-host URLs', () => {
    expect(_isShareIntoUrlForTest('not-a-url')).toBe(false);
    expect(_isShareIntoUrlForTest('https://expo-sharing.com/x')).toBe(false);
  });
});

describe('addShareIntoListener', () => {
  it('returns an unsubscribe function', () => {
    const fn = jest.fn();
    const unsubscribe = addShareIntoListener(fn);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
