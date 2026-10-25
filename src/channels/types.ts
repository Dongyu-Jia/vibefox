/**
 * A Channel is how the parent and the agent talk. It is deliberately separate
 * from the agent's identities (email, phone): a channel is a conversation
 * surface, an identity is how the agent appears to the rest of the world.
 *
 * The router only ever talks to this interface. Version 1 ships Telegram;
 * iMessage, SMS or email-as-chat are additional implementations.
 */

export interface ChannelCapabilities {
  replyTo: boolean;
  buttons: boolean;
  edit: boolean;
  files: boolean;
  voice: boolean;
  maxTextLength: number;
}

export interface Sender {
  id: string;
  displayName: string;
  username?: string;
}

export interface MessageRef {
  channel: string;
  chatId: string;
  messageId: string;
}

export function refKey(ref: MessageRef): string {
  return `${ref.chatId}:${ref.messageId}`;
}

export interface Attachment {
  kind: 'document' | 'photo' | 'voice' | 'audio' | 'video';
  fileId?: string;
  path?: string;
  name?: string;
  mime?: string;
}

export interface InboundMessage {
  channel: string;
  id: string;
  chatId: string;
  isPrivateChat: boolean;
  sender: Sender;
  text: string;
  /** The message this one quotes/replies to — the most reliable task link there is. */
  replyTo?: MessageRef;
  /** Set when the parent tapped a button; `buttonMessage` is the message that carried it. */
  buttonPayload?: string;
  buttonMessage?: MessageRef;
  callbackId?: string;
  attachments: Attachment[];
  at: Date;
}

export interface Button {
  label: string;
  payload: string;
}

export interface OutboundMessage {
  /** Text in the channel-neutral mini-markup produced by `format.ts` (HTML subset). */
  text: string;
  buttons?: Button[][];
  replyTo?: MessageRef;
  files?: Attachment[];
}

export interface Address {
  channel: string;
  chatId: string;
}

export interface Channel {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  start(handler: (msg: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(to: Address, msg: OutboundMessage): Promise<MessageRef>;
  edit(ref: MessageRef, msg: OutboundMessage): Promise<void>;
  /** Acknowledge a button tap (so the client stops spinning), optionally with a toast. */
  acknowledge(msg: InboundMessage, toast?: string): Promise<void>;
  typing(to: Address): Promise<void>;
  describe(): Promise<{ handle: string; displayName: string; id: string }>;
  downloadAttachment?(a: Attachment, dir: string): Promise<string>;
}
