// Shared handling for user-attached documents (see ContentBlock "document").
// Text documents are inlined into the prompt so every provider — including
// local runtimes — can use them.

import type { ContentBlock } from "../types.ts"

export type DocumentBlock = Extract<ContentBlock, { type: "document" }>

/** Wrap an extracted document as a text block, delimited so the model can
 *  tell the user's message from the attachment. */
export function docTextBlock(doc: DocumentBlock): { type: "text"; text: string } {
  const head = `--- Attached document: ${doc.name} ---`
  const tail = `--- End of document: ${doc.name} ---`
  return { type: "text", text: `${head}\n${doc.text ?? ""}\n${tail}` }
}
