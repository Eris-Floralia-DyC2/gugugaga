/** Reserved extension contracts. No screenshot, chat access or upload runs in v0.1. */
export interface Message {
  id: string;
  source: 'wechat' | 'qq' | 'feishu' | 'wecom' | 'import' | 'ocr';
  text: string;
  timestamp: string;
  sender?: string;
}
export interface MessageSource {
  read(consent: { source: string; scope: string; expiresAt: string }): Promise<Message[]>;
}
export interface MessageParser {
  parse(input: unknown): Message[];
}
export interface TaskProposal {
  title: string;
  planDate: string;
  dueDate: string | null;
  sourceIds: string[];
}
export interface TaskExtractor {
  extract(messages: Message[], consentToTransmit: boolean): Promise<TaskProposal[]>;
}
export interface TaskReviewer {
  approve(proposals: TaskProposal[]): Promise<TaskProposal[]>;
}
export interface TaskRepository {
  addApproved(proposals: TaskProposal[]): Promise<void>;
}
