import {
  parseNotificationPayload,
  resolveNavigationAction,
  isSafeUrl,
  type ResolveContext,
} from '@/services/notification-navigation';

describe('isSafeUrl', () => {
  it('returns true for https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
  });

  it('returns true for http URLs', () => {
    expect(isSafeUrl('http://example.com')).toBe(true);
  });

  it('returns false for javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('returns false for intent: URLs', () => {
    expect(isSafeUrl('intent://x')).toBe(false);
  });

  it('returns false for tel: URLs', () => {
    expect(isSafeUrl('tel:1234567890')).toBe(false);
  });
});

describe('parseNotificationPayload', () => {
  it('parses a valid chat payload', () => {
    const result = parseNotificationPayload({
      v: 1,
      type: 'chat',
      sessionId: 'abc',
    });
    expect(result).toEqual({ v: 1, type: 'chat', sessionId: 'abc' });
  });

  it('parses a valid new_chat payload', () => {
    const result = parseNotificationPayload({
      v: 1,
      type: 'new_chat',
      messageText: '今天天气怎么样？',
    });
    expect(result).toEqual({
      v: 1,
      type: 'new_chat',
      messageText: '今天天气怎么样？',
    });
  });

  it('parses a new_chat payload with optional newsId', () => {
    const result = parseNotificationPayload({
      v: 1,
      type: 'new_chat',
      messageText: 'hello',
      newsId: 'n_123',
    });
    expect(result).toEqual({
      v: 1,
      type: 'new_chat',
      messageText: 'hello',
      newsId: 'n_123',
    });
  });

  it('normalizes FCM stringified v=1 for new_chat', () => {
    const result = parseNotificationPayload({
      v: '1',
      type: 'new_chat',
      messageText: 'hi',
    });
    expect(result).toEqual({ v: 1, type: 'new_chat', messageText: 'hi' });
  });

  it('returns null when new_chat messageText is missing', () => {
    expect(parseNotificationPayload({ v: 1, type: 'new_chat' })).toBeNull();
  });

  it('returns null when new_chat messageText is empty string', () => {
    expect(
      parseNotificationPayload({ v: 1, type: 'new_chat', messageText: '' }),
    ).toBeNull();
  });

  it('omits newsId when it is not a non-empty string', () => {
    const result = parseNotificationPayload({
      v: 1,
      type: 'new_chat',
      messageText: 'hi',
      newsId: 123,
    });
    expect(result).toEqual({ v: 1, type: 'new_chat', messageText: 'hi' });
  });

  it('parses a valid page payload', () => {
    const result = parseNotificationPayload({
      v: 1,
      type: 'page',
      screen: 'home',
    });
    expect(result).toEqual({ v: 1, type: 'page', screen: 'home' });
  });

  it('parses a valid url payload', () => {
    const result = parseNotificationPayload({
      v: 1,
      type: 'url',
      url: 'https://example.com',
    });
    expect(result).toEqual({ v: 1, type: 'url', url: 'https://example.com' });
  });

  it('returns null when chat payload is missing sessionId', () => {
    expect(parseNotificationPayload({ v: 1, type: 'chat' })).toBeNull();
  });

  it('returns null when payload version is wrong', () => {
    expect(
      parseNotificationPayload({ v: 2, type: 'chat', sessionId: 'x' }),
    ).toBeNull();
  });

  it('returns null for unknown payload type', () => {
    expect(parseNotificationPayload({ v: 1, type: 'video' })).toBeNull();
  });

  it('returns null for unknown page screen', () => {
    expect(
      parseNotificationPayload({ v: 1, type: 'page', screen: 'unknown' }),
    ).toBeNull();
  });

  it('returns null for unsafe url', () => {
    expect(
      parseNotificationPayload({
        v: 1,
        type: 'url',
        url: 'javascript:alert(1)',
      }),
    ).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseNotificationPayload(null)).toBeNull();
  });

  it('returns null for string input', () => {
    expect(parseNotificationPayload('string')).toBeNull();
  });

  it('returns null for number input', () => {
    expect(parseNotificationPayload(42)).toBeNull();
  });

  it('returns null when chat sessionId is empty string', () => {
    expect(
      parseNotificationPayload({ v: 1, type: 'chat', sessionId: '' }),
    ).toBeNull();
  });
});

describe('resolveNavigationAction', () => {
  const authedReadyCtx: ResolveContext = {
    isAuthenticated: true,
    isReady: true,
    sessions: [{ id: 's1' }],
  };

  it('resolves chat to session when authenticated, ready, and session exists', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'chat', sessionId: 's1' },
        authedReadyCtx,
      ),
    ).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('resolves new_chat to newChat when authenticated and ready', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'new_chat', messageText: 'hello' },
        authedReadyCtx,
      ),
    ).toEqual({ kind: 'newChat', messageText: 'hello' });
  });

  it('resolves new_chat and preserves newsId when present', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'new_chat', messageText: 'hi', newsId: 'n_1' },
        authedReadyCtx,
      ),
    ).toEqual({ kind: 'newChat', messageText: 'hi', newsId: 'n_1' });
  });

  it('ignores new_chat when not authenticated', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'new_chat', messageText: 'hello' },
        { isAuthenticated: false, isReady: true, sessions: [] },
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores new_chat when not ready', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'new_chat', messageText: 'hello' },
        { isAuthenticated: true, isReady: false, sessions: [] },
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores chat when session does not exist (stale session)', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'chat', sessionId: 'stale' },
        authedReadyCtx,
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores chat when sessions are not yet loaded (not ready)', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'chat', sessionId: 's1' },
        { isAuthenticated: true, isReady: false, sessions: [{ id: 's1' }] },
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores chat when not authenticated (queue handled by caller)', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'chat', sessionId: 's1' },
        { isAuthenticated: false, isReady: true, sessions: [{ id: 's1' }] },
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('resolves page home to navigate "/" when authenticated', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'page', screen: 'home' },
        authedReadyCtx,
      ),
    ).toEqual({ kind: 'navigate', path: '/' });
  });

  it('resolves page search-chats to navigate "/search-chats" when authenticated', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'page', screen: 'search-chats' },
        authedReadyCtx,
      ),
    ).toEqual({ kind: 'navigate', path: '/search-chats' });
  });

  it('ignores page when not authenticated', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'page', screen: 'home' },
        { isAuthenticated: false, isReady: true, sessions: [] },
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('resolves url without requiring authentication', () => {
    expect(
      resolveNavigationAction(
        { v: 1, type: 'url', url: 'https://example.com' },
        { isAuthenticated: false, isReady: false, sessions: [] },
      ),
    ).toEqual({ kind: 'url', url: 'https://example.com' });
  });
});
