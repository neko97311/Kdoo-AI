// Message block construction — extracted from ChatInputBar.buildBlocksAndSend
// so the protocol-critical block assembly is unit-testable (this project's
// jest has no component-test setup but tests pure util modules).
//
// BLOCK ORDER IS PROTOCOL-SIGNIFICANT.
// Design §5.5: a single WsChatMessage's `content` is `[text?, ...fileBlocks]` —
// the optional caption text block (if present) ALWAYS comes first, followed by
// zero or more file blocks in attachment order. The backend parses content
// positionally and must NOT change, so do not reorder, dedupe, or filter here.

import type { Attachment, WsContentBlock } from '@/types';
import { attachmentToContentBlockWithUpload } from '@/services/upload-service';

/**
 * Build the `content` block array for an outbound WsChatMessage.
 *
 * Semantics are byte-equivalent to the former inline construction in
 * ChatInputBar.buildBlocksAndSend:
 *   1. If `text` is truthy (the EXACT `if (text)` condition — not trimmed, not
 *      length-checked), a text block is pushed FIRST. An empty caption yields
 *      no text block, which is why send-with-images-and-empty-text is allowed.
 *   2. Each attachment is then uploaded/converted SEQUENTIALLY via
 *      `attachmentToContentBlockWithUpload` (in order) and appended.
 *
 * @param text        Caption text. May be empty string (→ no text block).
 * @param attachments Attachments to upload + convert, in send order.
 * @returns Ordered content blocks: [textBlock?, ...fileBlocks].
 */
export async function createMessageBlocks(
  text: string,
  attachments: Attachment[],
): Promise<WsContentBlock[]> {
  const blocks: WsContentBlock[] = [];
  if (text) {
    blocks.push({ type: 'text', text: text });
  }
  for (const attachment of attachments) {
    blocks.push(await attachmentToContentBlockWithUpload(attachment));
  }
  return blocks;
}
