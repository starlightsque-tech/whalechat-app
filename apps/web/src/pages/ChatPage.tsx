import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useChat, whalechatRuntime, whalechatStore, type Message } from '@whalechat/shared';

function StatusTick({ message }: { message: Message }) {
  if (message.senderId !== 'demo-user' && message.senderId !== whalechatStore.getState().profile?.id) return null;
  const map: Record<Message['status'], { icon: string; className: string; label: string }> = {
    sending: { icon: '◌', className: 'text-slate-500', label: 'Sending' },
    sent: { icon: '✓', className: 'text-slate-400', label: 'Sent' },
    delivered: { icon: '✓✓', className: 'text-slate-400', label: 'Delivered' },
    read: { icon: '✓✓', className: 'text-mint', label: 'Read' },
    failed: { icon: '!', className: 'text-coral', label: 'Failed — will retry' },
  };
  const tick = map[message.status];
  return <span title={tick.label} className={`text-[10px] ${tick.className}`}>{tick.icon}</span>;
}

export function ChatPage() {
  const conversations = useStore(whalechatStore, (s) => s.conversations);
  const activeId = useStore(whalechatStore, (s) => s.activeConversationId);
  const profile = useStore(whalechatStore, (s) => s.profile);
  const { messages, send, markRead } = useChat(activeId);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId && conversations[0]) {
      whalechatStore.getState().setActiveConversation(conversations[0].id);
    }
  }, [activeId, conversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    const last = messages[messages.length - 1];
    if (activeId && last && last.senderId !== profile?.id && last.status !== 'read') {
      void markRead(last.id);
    }
  }, [messages, activeId, markRead, profile?.id]);

  const active = conversations.find((c) => c.id === activeId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    const body = draft;
    setDraft('');
    setError(null);
    try {
      await send(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send');
      setDraft(body);
    }
  }

  return (
    <div className="grid h-[calc(100vh-190px)] min-h-[520px] gap-4 lg:grid-cols-[320px_1fr]">
      <aside className="card flex flex-col overflow-hidden">
        <div className="border-b border-white/10 p-3">
          <h2 className="font-semibold">Messages</h2>
          <p className="text-xs text-slate-500">{conversations.reduce((n, c) => n + c.unreadCount, 0)} unread · cached locally</p>
        </div>
        <ul className="flex-1 overflow-auto scroll-thin">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                onClick={() => {
                  whalechatStore.getState().setActiveConversation(conversation.id);
                  void whalechatRuntime.loadMessages(conversation.id);
                }}
                className={`w-full border-b border-white/5 px-3 py-3 text-left transition hover:bg-white/5 ${
                  activeId === conversation.id ? 'bg-white/5' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{conversation.title ?? 'Direct chat'}</span>
                  {conversation.unreadCount > 0 && (
                    <span className="rounded-full bg-mint px-1.5 text-[10px] font-bold text-abyss">{conversation.unreadCount}</span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">{conversation.lastMessagePreview || 'No messages yet'}</p>
              </button>
            </li>
          ))}
          {conversations.length === 0 && <li className="p-4 text-xs text-slate-500">No conversations cached yet.</li>}
        </ul>
      </aside>

      <section className="card flex min-h-0 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <h3 className="font-semibold">{active?.title ?? 'Select a conversation'}</h3>
            <p className="text-xs text-slate-500">{active ? `${active.kind} · ${active.participantIds.length} participants` : ''}</p>
          </div>
          <span className="pill bg-white/5 text-slate-400">E2E-ready · idempotent send</span>
        </header>

        <div className="flex-1 space-y-2 overflow-auto scroll-thin px-3 py-4">
          {messages.map((message) => {
            const mine = message.senderId === profile?.id || message.senderId === 'demo-user';
            return (
              <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-mint/20 text-slate-100' : 'bg-white/8 text-slate-200'}`}>
                  {!mine && <p className="mb-0.5 text-[10px] font-semibold text-foam">{message.senderId}</p>}
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-500">
                    {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    <StatusTick message={message} />
                  </div>
                </div>
              </div>
            );
          })}
          {messages.length === 0 && <p className="py-10 text-center text-xs text-slate-500">Say hello — messages queue offline and send on reconnect.</p>}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={(e) => void submit(e)} className="border-t border-white/10 p-3">
          {error && <p className="mb-2 text-xs text-coral">{error}</p>}
          <div className="flex gap-2">
            <input
              className="input"
              placeholder={active ? 'Write a message…' : 'Pick a conversation first'}
              value={draft}
              disabled={!active}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn-primary" type="submit" disabled={!active || !draft.trim()}>Send</button>
          </div>
        </form>
      </section>
    </div>
  );
}
