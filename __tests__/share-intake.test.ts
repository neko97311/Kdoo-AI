import { useShareIntakeStore } from '@/stores/share-intake';
import { useShareIntoUiStore } from '@/stores/share-into-ui';

beforeEach(() => {
  useShareIntakeStore.setState({ pendingToken: null, pendingContent: null });
  useShareIntoUiStore.setState({ modalText: null, pendingImage: null });
});

test('consumeContent is idempotent and returns latest draft', () => {
  const { setPendingContent, consumeContent } = useShareIntakeStore.getState();
  setPendingContent({ text: 'hello', image: null });
  expect(consumeContent()).toEqual({ text: 'hello', image: null });
  expect(consumeContent()).toBeNull();
});

test('existing token flow unaffected', () => {
  const { setPending, consume } = useShareIntakeStore.getState();
  setPending('tok');
  expect(consume()).toBe('tok');
  expect(consume()).toBeNull();
});

test('share-into modal open/close', () => {
  const { openShareModal, closeShareModal } = useShareIntoUiStore.getState();
  openShareModal('https://example.com');
  expect(useShareIntoUiStore.getState().modalText).toBe('https://example.com');
  closeShareModal();
  expect(useShareIntoUiStore.getState().modalText).toBeNull();
});

test('pending image is consumed once', () => {
  const att = { id: 'x', type: 'image' as const, name: 'a.png', uri: 'file:///a.png', mediaType: 'image/png' };
  useShareIntoUiStore.getState().setPendingImage(att);
  expect(useShareIntoUiStore.getState().consumePendingImage()).toEqual(att);
  expect(useShareIntoUiStore.getState().consumePendingImage()).toBeNull();
});
