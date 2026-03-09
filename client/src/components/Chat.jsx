import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const SLOW_MATCH_MS = 20_000;
const uid = () => `${Date.now()}-${Math.random()}`;

const STATUS_DOT = {
  searching: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-400",
  ended: "bg-red-400",
};

export function Chat({ socket, interests, onStop }) {
  const [messages, setMessages] = useState([
    { id: uid(), type: "system", text: "Looking for a stranger..." },
  ]);
  const [input, setInput] = useState("");
  const [matched, setMatched] = useState(false);
  const [status, setStatus] = useState("searching");
  const [common, setCommon] = useState([]);
  const [slowMatch, setSlowMatch] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [escStep, setEscStep] = useState(0);
  const [strangerTyping, setStrangerTyping] = useState(false);
  const bottomRef = useRef(null);
  const timerRef = useRef(null);
  const typingTimerRef = useRef(null);
  const iAmTypingRef = useRef(false);

  function resetEscFlow() {
    setEscStep(0);
    setConfirmEnd(false);
  }

  function beginFindMatch() {
    clearTimeout(timerRef.current);
    clearTimeout(typingTimerRef.current);
    iAmTypingRef.current = false;
    setStrangerTyping(false);
    setSlowMatch(false);
    setStatus("searching");
    setMatched(false);
    setCommon([]);
    resetEscFlow();
    setMessages([
      { id: uid(), type: "system", text: "Looking for a stranger..." },
    ]);
    socket.emit("start", { interests });
    startSlowTimer();
  }

  function finishConversation() {
    clearTimeout(timerRef.current);
    setSlowMatch(false);
    setMatched(false);
    setStatus("ended");
    setCommon([]);
    setConfirmEnd(false);
    setEscStep(2);
    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        type: "system",
        text: "Conversation ended. Press Find Match when ready.",
      },
    ]);
    socket.emit("stop");
  }

  function startSlowTimer() {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSlowMatch(true), SLOW_MATCH_MS);
  }

  // Socket event listeners
  useEffect(() => {
    function onMatched({ commonInterests: ci = [] }) {
      clearTimeout(timerRef.current);
      setSlowMatch(false);
      setStatus("connected");
      setMatched(true);
      setCommon(ci);
      resetEscFlow();
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          type: "system",
          text:
            ci.length > 0
              ? `Connected! You both like: ${ci.join(", ")}`
              : "You are now connected.",
        },
      ]);
    }

    function onMessage(text) {
      setMessages((prev) => [...prev, { id: uid(), type: "stranger", text }]);
    }

    function onPartnerLeft() {
      clearTimeout(timerRef.current);
      setStrangerTyping(false);
      setSlowMatch(false);
      setStatus("ended");
      setMatched(false);
      setConfirmEnd(false);
      setEscStep(2);
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          type: "system",
          text: "Stranger disconnected. Press Find Match when ready.",
        },
      ]);
    }

    function onTyping() { setStrangerTyping(true); }
    function onStopTyping() { setStrangerTyping(false); }

    socket.on("matched", onMatched);
    socket.on("message", onMessage);
    socket.on("partnerLeft", onPartnerLeft);
    socket.on("typing", onTyping);
    socket.on("stopTyping", onStopTyping);

    beginFindMatch();

    return () => {
      clearTimeout(timerRef.current);
      clearTimeout(typingTimerRef.current);
      socket.off("matched", onMatched);
      socket.off("message", onMessage);
      socket.off("partnerLeft", onPartnerLeft);
      socket.off("typing", onTyping);
      socket.off("stopTyping", onStopTyping);
    };
  }, [socket]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ESC shortcut flow:
  // 1st ESC: request end
  // 2nd ESC: confirm end
  // 3rd ESC: find next match
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;

      if (status === "connected") {
        if (escStep === 0) {
          setConfirmEnd(true);
          setEscStep(1);
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              type: "system",
              text: "Press ESC again to confirm ending this chat.",
            },
          ]);
          return;
        }

        if (escStep === 1) {
          finishConversation();
          return;
        }
      }

      if (escStep === 2) {
        beginFindMatch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escStep, status]);

  function sendMessage() {
    const text = input.trim();
    if (!text || !matched) return;
    // Clear outgoing typing state immediately on send
    clearTimeout(typingTimerRef.current);
    if (iAmTypingRef.current) {
      socket.emit("stopTyping");
      iAmTypingRef.current = false;
    }
    socket.emit("message", text);
    setMessages((prev) => [...prev, { id: uid(), type: "you", text }]);
    setInput("");
  }

  function handleInputChange(e) {
    setInput(e.target.value);
    if (!matched) return;
    if (!iAmTypingRef.current) {
      socket.emit("typing");
      iAmTypingRef.current = true;
    }
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit("stopTyping");
      iAmTypingRef.current = false;
    }, 2000);
  }

  function handleStop() {
    clearTimeout(timerRef.current);
    setMatched(false);
    setStatus("searching");
    setCommon([]);
    resetEscFlow();
    socket.emit("stop");
    onStop();
  }

  function handleEndChatClick() {
    if (!matched) return;
    setConfirmEnd(true);
    setEscStep(1);
  }

  function handleCancelEnd() {
    resetEscFlow();
  }

  function handleConfirmEnd() {
    finishConversation();
  }

  return (
    <div className="flex h-[100dvh] flex-col pt-nav">
      {/* ── Toolbar ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2">
          <span
            className={`block h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
          />
          <span className="text-sm capitalize text-muted-foreground">
            {status}
          </span>
          {common.length > 0 && (
            <div className="ml-2 hidden gap-1.5 sm:flex">
              {common.map((i) => (
                <span
                  key={i}
                  className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
                >
                  {i}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleStop}>
            <span className="hidden sm:inline">← </span>Back
          </Button>
        </div>
      </div>

      {/* Mobile: common interests strip */}
      {common.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2 sm:hidden">
          {common.map((i) => (
            <span
              key={i}
              className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {i}
            </span>
          ))}
        </div>
      )}

      {confirmEnd && (
        <div className="mx-4 mt-4 rounded-lg border border-border bg-card px-4 py-3 sm:mx-6">
          <p className="text-sm text-foreground">End this conversation?</p>
          <p className="mt-1 text-xs text-muted-foreground hidden sm:block">
            Shortcut: ESC once to request end, ESC again to confirm, ESC again
            to find match.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleCancelEnd}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={handleConfirmEnd}>
              Confirm End
            </Button>
          </div>
        </div>
      )}

      {/* ── Slow match warning ── */}
      {slowMatch && status === "searching" && (
        <div className="m-4 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 sm:mx-6">
          <p className="text-sm font-medium text-amber-400">
            Taking longer than usual…
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {interests.length > 0
              ? "No one with matching interests is online right now. You'll be connected to the next available user."
              : "The queue might be empty right now. Hang tight or try again in a moment."}
          </p>
          {interests.length > 0 && (
            <button
              onClick={handleStop}
              className="mt-2 text-xs text-amber-400/80 underline underline-offset-2 hover:text-amber-400"
            >
              Go back and change interests
            </button>
          )}
        </div>
      )}

      {/* ── Messages ── */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-8">
        {messages.map((msg) =>
          msg.type === "system" ? (
            <div
              key={msg.id}
              className="flex select-none items-center gap-3 py-0.5"
            >
              <div className="h-px flex-1 bg-border" />
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {msg.text}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          ) : (
            <div
              key={msg.id}
              className={`flex ${msg.type === "you" ? "justify-end" : "justify-start"}`}
            >
              <p
                className={`max-w-[88%] sm:max-w-[75%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  msg.type === "you"
                    ? "rounded-br-md bg-primary text-primary-foreground"
                    : "rounded-bl-md border border-border bg-muted text-foreground"
                }`}
              >
                {msg.text}
              </p>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Typing indicator ── */}
      {strangerTyping && matched && (
        <div className="flex shrink-0 items-center gap-1.5 px-4 pb-1 sm:px-6">
          <span className="text-xs text-muted-foreground">Stranger is typing</span>
          <span className="flex gap-0.5">
            <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
            <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
            <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
          </span>
        </div>
      )}

      {/* ── Input ── */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 sm:px-6 pb-safe">
        <Input
          value={input}
          onChange={handleInputChange}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder={matched ? "Message..." : "Waiting for a stranger..."}
          disabled={!matched}
          className="flex-1"
          autoFocus
        />
        <Button
          onClick={sendMessage}
          disabled={!matched || !input.trim()}
          className="shrink-0"
        >
          Send
        </Button>
        {status === "connected" && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleEndChatClick}
            className="shrink-0"
          >
            End Chat
          </Button>
        )}
        {status !== "connected" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={beginFindMatch}
            disabled={status === "searching"}
            className="shrink-0"
          >
            {status === "searching" ? "Searching…" : "Find Match"}
          </Button>
        )}
      </div>
    </div>
  );
}
