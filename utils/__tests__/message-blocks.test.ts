import { createMessageBlocks } from '../message-blocks';
import { attachmentToContentBlockWithUpload } from '@/services/upload-service';
import type { Attachment, WsContentBlock } from '@/types';

/**
 * Mock the upload chain so the real upload-service (and its transitive
 * imports) never load — we only care that createMessageBlocks calls it once
 * per attachment, in order, and assembles blocks in protocol order.
 *
 * The moduleNameMapper in jest.config.js makes '@/services/upload-service'
 * resolvable; the factory here replaces it wholesale.
 */
jest.mock('@/services/upload-service', () => ({
  attachmentToContentBlockWithUpload: jest.fn(),
}));

const att1: Attachment = {
  id: 'a1',
  type: 'image',
  name: '1.jpg',
  uri: 'file://1',
  mediaType: 'image/jpeg',
};
const att2: Attachment = {
  id: 'a2',
  type: 'image',
  name: '2.jpg',
  uri: 'file://2',
  mediaType: 'image/jpeg',
};
const att3: Attachment = {
  id: 'a3',
  type: 'image',
  name: '3.jpg',
  uri: 'file://3',
  mediaType: 'image/jpeg',
};

const file1: WsContentBlock = {
  type: 'file',
  data: 'd1',
  mimeType: 'image/jpeg',
  filename: '1.jpg',
};
const file2: WsContentBlock = {
  type: 'file',
  data: 'd2',
  mimeType: 'image/jpeg',
  filename: '2.jpg',
};
const file3: WsContentBlock = {
  type: 'file',
  data: 'd3',
  mimeType: 'image/jpeg',
  filename: '3.jpg',
};

const mockUpload = attachmentToContentBlockWithUpload as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

it('text + attachments → text block first, then file blocks in order', async () => {
  mockUpload.mockResolvedValueOnce(file1).mockResolvedValueOnce(file2);

  const result = await createMessageBlocks('cap', [att1, att2]);

  expect(result).toEqual([{ type: 'text', text: 'cap' }, file1, file2]);
});

it('empty text + attachment → no text block, only the file block (locks `if (text)` semantics)', async () => {
  mockUpload.mockResolvedValueOnce(file1);

  const result = await createMessageBlocks('', [att1]);

  expect(result).toEqual([file1]);
  expect(result.find((b) => b.type === 'text')).toBeUndefined();
});

it('text only + no attachments → single text block, upload not called', async () => {
  const result = await createMessageBlocks('just text', []);

  expect(result).toEqual([{ type: 'text', text: 'just text' }]);
  expect(mockUpload).not.toHaveBeenCalled();
});

it('empty text + no attachments → empty array', async () => {
  const result = await createMessageBlocks('', []);

  expect(result).toEqual([]);
});

it('three attachments → file blocks appear in input order with sequential upload calls', async () => {
  mockUpload
    .mockResolvedValueOnce(file1)
    .mockResolvedValueOnce(file2)
    .mockResolvedValueOnce(file3);

  const result = await createMessageBlocks('', [att1, att2, att3]);

  expect(result).toEqual([file1, file2, file3]);
  // upload observed the attachments sequentially, in input order
  expect(mockUpload.mock.calls).toEqual([[att1], [att2], [att3]]);
});
