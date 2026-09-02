import {
  setCameraResultHandler,
  emitCameraResult,
  clearCameraResultHandler,
} from '../camera-bridge';
import type { Attachment } from '@/types';

const photo: Attachment = {
  id: 'img_1',
  type: 'image',
  name: 'p.jpg',
  uri: 'file:///p.jpg',
  mediaType: 'image/jpeg',
};

describe('camera-result bridge', () => {
  // The bridge holds a module-level singleton handler. Reset it before every
  // test so case ordering can never leak state.
  beforeEach(() => {
    clearCameraResultHandler();
  });

  it('invokes the registered handler exactly once with the attachment', () => {
    const handler = jest.fn();
    setCameraResultHandler(handler);
    emitCameraResult(photo);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(photo);
  });

  it('is one-shot: a second emit does not invoke the handler again', () => {
    const handler = jest.fn();
    setCameraResultHandler(handler);
    emitCameraResult(photo);
    emitCameraResult(photo);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(photo);
  });

  it('emit with no handler registered is a no-op and does not throw', () => {
    expect(() => emitCameraResult(photo)).not.toThrow();
  });

  it('clearCameraResultHandler prevents a subsequent emit from invoking', () => {
    const handler = jest.fn();
    setCameraResultHandler(handler);
    clearCameraResultHandler();
    emitCameraResult(photo);
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-setting after an emit registers a new handler invoked by a later emit', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    setCameraResultHandler(h1);
    emitCameraResult(photo); // consumes h1 (one-shot)
    setCameraResultHandler(h2);
    emitCameraResult(photo);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h1).toHaveBeenCalledWith(photo);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledWith(photo);
  });
});
