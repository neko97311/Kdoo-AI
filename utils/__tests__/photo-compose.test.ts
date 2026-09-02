import {
  setComposeResultHandler,
  emitComposeResult,
  clearComposeResultHandler,
  parseInitialAttachments,
} from '../photo-compose';
import type { Attachment } from '@/types';

describe('compose-result bridge', () => {
  // The bridge holds a module-level singleton handler. Reset it before every
  // test so case ordering can never leak state.
  beforeEach(() => {
    clearComposeResultHandler();
  });

  it('invokes the registered handler exactly once with (text, attachments)', () => {
    const handler = jest.fn();
    const atts: Attachment[] = [
      { id: 'a1', type: 'image', name: 'a.jpg', uri: 'file://a', mediaType: 'image/jpeg' },
    ];
    setComposeResultHandler(handler);
    emitComposeResult('hello', atts);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('hello', atts);
  });

  it('is one-shot: a second emit does not invoke the handler again', () => {
    const handler = jest.fn();
    setComposeResultHandler(handler);
    emitComposeResult('first', []);
    emitComposeResult('second', []);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('first', []);
  });

  it('emit with no handler registered is a no-op and does not throw', () => {
    expect(() => emitComposeResult('x', [])).not.toThrow();
  });

  it('clearComposeResultHandler prevents a subsequent emit from invoking', () => {
    const handler = jest.fn();
    setComposeResultHandler(handler);
    clearComposeResultHandler();
    emitComposeResult('after-clear', []);
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-setting after an emit registers a new handler invoked by a later emit', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    setComposeResultHandler(h1);
    emitComposeResult('a', []); // consumes h1 (one-shot)
    setComposeResultHandler(h2);
    emitComposeResult('b', []);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h1).toHaveBeenCalledWith('a', []);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledWith('b', []);
  });
});

describe('parseInitialAttachments', () => {
  it('returns valid items with id/uri passed through', () => {
    const json = JSON.stringify([
      { id: 'x', uri: 'file://x', type: 'image', name: 'x.jpg', mediaType: 'image/jpeg' },
      { id: 'y', uri: 'file://y', type: 'image', name: 'y.jpg', mediaType: 'image/png' },
    ]);
    const result = parseInitialAttachments(json);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('x');
    expect(result[0].uri).toBe('file://x');
    expect(result[1].id).toBe('y');
    expect(result[1].uri).toBe('file://y');
  });

  it('returns [] for malformed JSON', () => {
    expect(parseInitialAttachments('not json')).toEqual([]);
  });

  it('returns [] for a JSON object (non-array)', () => {
    expect(parseInitialAttachments('{"a":1}')).toEqual([]);
  });

  it('returns [] for a JSON string scalar (non-array)', () => {
    expect(parseInitialAttachments('"str"')).toEqual([]);
  });

  it('filters out invalid items while preserving order of valid ones', () => {
    const json = JSON.stringify([
      { id: 'x', uri: 'file://x' }, // valid
      { uri: 'no-id' }, // missing id
      { id: 'no-uri' }, // missing uri
      null,
      123,
      'str',
      { id: 5, uri: 'num-id' }, // id is not a string
      { id: 'z', uri: 'file://z' }, // valid
    ]);
    const result = parseInitialAttachments(json);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('x');
    expect(result[1].id).toBe('z');
  });

  it('returns [] for undefined', () => {
    expect(parseInitialAttachments(undefined)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parseInitialAttachments('')).toEqual([]);
  });
});
