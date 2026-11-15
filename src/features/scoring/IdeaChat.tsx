import { LoaderCircle, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { applyMention, CHAT_MESSAGE_MAX, filterMentionCandidates, mentionQueryAt } from "@/domain/chat";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { dataErrorMessages, evaluationErrorMessages } from "@/lib/messages";
import {
  evaluateAndWait,
  listChatMessages,
  listMentionCandidates,
  sendChatMessage,
  type ChatMessageRow,
} from "@/lib/scoringData";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "Pourquoi cette note sur le caractère innovant ?",
  "Quelles informations feraient monter la note globale ?",
  "Compare cette idée avec @",
];

/**
 * Discussion avec l'associé senior (IA) sur la décision : explication de la note, apport
 * d'informations, comparaison avec d'autres idées citées par @IDENTIFIANT. Les informations
 * données peuvent être transmises aux agents par une réévaluation.
 */
export function IdeaChat({
  challengeId,
  ideaId,
  ideaRef,
  onReevaluated,
}: {
  challengeId: string;
  ideaId: string;
  ideaRef: string;
  onReevaluated: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-6 right-6 z-30 h-12 rounded-full px-5 shadow-lg"
        aria-expanded={open}
        aria-controls="idea-chat"
      >
        <Sparkles className="size-5" aria-hidden />
        Discuter de la décision
      </Button>
      {open && (
        <ChatDrawer
          challengeId={challengeId}
          ideaId={ideaId}
          ideaRef={ideaRef}
          onClose={() => setOpen(false)}
          onReevaluated={onReevaluated}
        />
      )}
    </>
  );
}

function ChatDrawer({
  challengeId,
  ideaId,
  ideaRef,
  onClose,
  onReevaluated,
}: {
  challengeId: string;
  ideaId: string;
  ideaRef: string;
  onClose: () => void;
  onReevaluated: () => void;
}) {
  const id = useId();
  const { client, state } = useAuth();
  const history = useLoader(() => listChatMessages(client, ideaId), [client, ideaId]);
  const candidates = useLoader(() => listMentionCandidates(client, challengeId), [client, challengeId]);
  const [extra, setExtra] = useState<ChatMessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reevaluating, setReevaluating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => [...(history.state.status === "ready" ? history.state.data : []), ...extra],
    [history.state, extra],
  );
  const idByRef = useMemo(() => {
    const m = new Map<string, string>();
    if (candidates.state.status === "ready") for (const c of candidates.state.data) m.set(c.external_ref.toUpperCase(), c.id);
    return m;
  }, [candidates.state]);
  const pendingNotes = messages.filter(m => m.role === "user" && m.used_for_evaluation_id === null).length;

  // Saisie d'une mention : liste des idées proposées.
  const mention = mentionQueryAt(draft, caret);
  const options =
    mention && candidates.state.status === "ready"
      ? filterMentionCandidates(candidates.state.data, mention.query, ideaId, 6)
      : [];
  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && !mention && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mention, onClose]);

  const choose = (ref: string) => {
    if (!mention) return;
    const next = applyMention(draft, mention.start, caret, ref);
    setDraft(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = async (text = draft) => {
    const message = text.trim();
    if (!message || pending || state.status !== "authenticated") return;
    setPending(true);
    setError(null);
    setNotice(null);
    const r = await sendChatMessage(state.session.access_token, ideaId, message);
    setPending(false);
    if (!r.ok) {
      setError(evaluationErrorMessages[r.error]);
      return;
    }
    setDraft("");
    setCaret(0);
    setExtra(prev => [...prev, ...r.value.messages]);
    if (r.value.unknownRefs.length > 0) {
      setNotice(`Identifiant${r.value.unknownRefs.length > 1 ? "s" : ""} introuvable${r.value.unknownRefs.length > 1 ? "s" : ""} dans ce challenge : ${r.value.unknownRefs.map(x => `@${x}`).join(", ")}.`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (e.key === "ArrowDown") return e.preventDefault(), setActiveIndex(i => (i + 1) % options.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setActiveIndex(i => (i - 1 + options.length) % options.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(options[activeIndex]!.external_ref);
      if (e.key === "Escape") return e.preventDefault(), setCaret(-1);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const reevaluate = async () => {
    if (reevaluating || state.status !== "authenticated") return;
    setReevaluating(true);
    setError(null);
    const r = await evaluateAndWait(client, state.session.access_token, ideaId, true, () => false, true);
    setReevaluating(false);
    if (!r.ok) return setError(evaluationErrorMessages[r.error]);
    setExtra([]);
    history.reload();
    onReevaluated();
    setNotice("Réévaluation terminée : les agents ont pris en compte vos informations. La section « Évaluation » est à jour.");
  };

  return (
    <aside
      id="idea-chat"
      aria-labelledby={`${id}-title`}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-background shadow-2xl"
    >
      <header className="flex items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold">
            <Sparkles className="size-4 text-indigo-600" aria-hidden />
            Discussion sur {ideaRef}
          </h2>
          <p className="text-xs text-muted-foreground">
            L'associé senior explique la décision. Apportez des informations, citez une autre idée avec @.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fermer la discussion">
          <X className="size-4" aria-hidden />
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm" role="log" aria-live="polite">
        {history.state.status === "loading" && <p className="text-muted-foreground">Chargement de la discussion…</p>}
        {history.state.status === "error" && <Alert tone="error">{dataErrorMessages[history.state.error]}</Alert>}
        {history.state.status === "ready" && messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-muted-foreground">Exemples de questions :</p>
            <ul className="space-y-2">
              {SUGGESTIONS.map(s => (
                <li key={s}>
                  <button
                    type="button"
                    className="w-full rounded-md border px-3 py-2 text-left hover:bg-muted"
                    onClick={() => {
                      setDraft(s);
                      setCaret(s.length);
                      inputRef.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {messages.map(m => (
          <Bubble key={m.id} message={m} challengeId={challengeId} idByRef={idByRef} />
        ))}
        {pending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            L'associé senior prépare sa réponse…
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="space-y-2 border-t p-4">
        {notice && <Alert tone="info">{notice}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        {pendingNotes > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-950">
            <span>
              {pendingNotes} message{pendingNotes > 1 ? "s" : ""} non encore transmis aux agents.
            </span>
            <Button size="sm" variant="outline" onClick={() => void reevaluate()} disabled={reevaluating || pending}>
              {reevaluating ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
              {reevaluating ? "Réévaluation en cours…" : "Réévaluer avec ces informations"}
            </Button>
          </div>
        )}

        <div className="relative">
          {options.length > 0 && (
            <ul
              role="listbox"
              aria-label="Idées à mentionner"
              className="absolute bottom-full left-0 mb-2 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
            >
              {options.map((o, i) => (
                <li
                  key={o.id}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={e => {
                    e.preventDefault();
                    choose(o.external_ref);
                  }}
                  className={cn("cursor-pointer rounded px-2 py-1.5", i === activeIndex && "bg-muted")}
                >
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{o.external_ref}</span>
                  {o.title}
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={e => {
              setDraft(e.target.value.slice(0, CHAT_MESSAGE_MAX));
              setCaret(e.target.selectionStart);
            }}
            onSelect={e => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Votre question ou une information (tapez @ pour citer une idée)"
            aria-label="Message à l'associé senior"
            disabled={pending || reevaluating}
            className="w-full resize-none rounded-md border bg-background px-3 py-2 pr-12 text-sm"
          />
          <Button
            size="sm"
            className="absolute bottom-3 right-2 h-8 w-8 p-0"
            onClick={() => void send()}
            disabled={!draft.trim() || pending || reevaluating}
            aria-label="Envoyer"
          >
            <Send className="size-4" aria-hidden />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Ne saisissez aucune donnée personnelle.
        </p>
      </div>
    </aside>
  );
}

const MENTION_SPLIT = /(@[A-Za-z0-9][A-Za-z0-9_-]{0,63})/g;

function Bubble({
  message,
  challengeId,
  idByRef,
}: {
  message: ChatMessageRow;
  challengeId: string;
  idByRef: Map<string, string>;
}) {
  const mine = message.role === "user";
  // Les mentions connues deviennent des liens vers la fiche de l'idée ; le reste est du texte brut.
  const parts: ReactNode[] = message.content.split(MENTION_SPLIT).map((part, i) => {
    if (i % 2 === 0) return part;
    const ideaId = idByRef.get(part.slice(1).replace(/[-_]+$/, "").toUpperCase());
    return ideaId ? (
      <Link key={i} to={`/challenges/${challengeId}/idees/${ideaId}`} className="font-medium underline underline-offset-2">
        {part}
      </Link>
    ) : (
      <span key={i} className="font-medium">
        {part}
      </span>
    );
  });
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-line rounded-lg px-3 py-2 leading-relaxed",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {!mine && (
          <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3" aria-hidden />
            Associé senior
          </p>
        )}
        {parts}
        {mine && message.used_for_evaluation_id && (
          <p className="mt-1 text-[11px] opacity-75">Transmis aux agents lors d'une réévaluation</p>
        )}
      </div>
    </div>
  );
}
