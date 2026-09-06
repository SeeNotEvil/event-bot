import type { ConversationMessage } from '../../types/domain.js';

export type MessageMetadata = {
  messageId?: number | undefined;
  replyToMessageId?: number | undefined;
  authorName?: string | undefined;
};

export type ArchivedMessage = ConversationMessage & {
  id: number;
  author: string | null;
  messageId: number | null;
  replyToMessageId: number | null;
  createdAt: string;
};

export type ThreadSnapshot = {
  id: number;
  summary: string | null;
  summaryCursor: number;
  summaryVersion: number;
};

export type SummaryBatch = ThreadSnapshot & { token: string; messages: ArchivedMessage[] };

export interface ThreadMemory {
  ensure(chatId: number): Promise<ThreadSnapshot>;
  append(threadId: number, userId: number | null, message: ConversationMessage, metadata?: MessageMetadata): Promise<boolean>;
  read(threadId: number, limit: number, beforeId?: number, excludeMessageId?: number): Promise<ArchivedMessage[]>;
  claimSummary(recentLimit: number, leaseMs: number): Promise<SummaryBatch | null>;
  completeSummary(batch: SummaryBatch, summary: string): Promise<boolean>;
  failSummary(batch: SummaryBatch): Promise<void>;
}
