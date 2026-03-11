import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

// ── Topic data ──────────────────────────────────────────────────────────────
const SUBJECTS = [
  "Social Media",
  "AI",
  "Fast Food",
  "Remote Work",
  "Video Games",
  "Climate Change",
  "School Uniforms",
  "Basic Income",
  "Space Travel",
  "Veganism",
  "Homework",
  "TikTok",
  "Electric Cars",
  "Zoos",
  "Crypto",
  "Online School",
  "Cancel Culture",
];

const VERBS = ["is", "should be", "isn't", "will be", "could be", "won't be"];

const OPINIONS = [
  "overrated",
  "necessary",
  "harmful",
  "the future",
  "misunderstood",
  "a waste",
  "worth it",
  "destroying us",
  "underrated",
  "making us smarter",
  "here to stay",
  "dividing us",
  "good for all",
  "overdue",
  "dangerous",
];

// ── Spin schedule: cumulative ms from effect start ───────────────────────────
// 8 fast ticks → 5 medium → 4 slow-down → 3 slow → 1 final  (21 ticks total)
const SPIN_SCHEDULE = [
  55,
  110,
  165,
  220,
  275,
  330,
  385,
  440, // 8 × 55 ms
  530,
  620,
  710,
  800,
  890, // 5 × 90 ms
  1030,
  1170,
  1310,
  1450, // 4 × 140 ms
  1660,
  1870,
  2080, // 3 × 210 ms
  2400, // 1 × 320 ms  ← lands here
];
const SPIN_SETTLE_MS = 2600; // parent waits this long before flipping isSpinning=false

const ITEM_H = 40; // px per row

// ── Single reel column ───────────────────────────────────────────────────────
function WheelReel({ label, items, isSpinning, finalIndex, landed }) {
  const [centerIdx, setCenterIdx] = useState(0);

  useEffect(() => {
    if (!isSpinning) return;

    const timers = SPIN_SCHEDULE.map((delay, i) =>
      setTimeout(() => {
        if (i === SPIN_SCHEDULE.length - 1) {
          setCenterIdx(finalIndex);
        } else {
          setCenterIdx((prev) => (prev + 1) % items.length);
        }
      }, delay),
    );

    return () => timers.forEach(clearTimeout);
  }, [isSpinning, finalIndex, items.length]);

  const OFFSETS = [-2, -1, 0, 1, 2];
  const OPACITY = [0.1, 0.32, 1, 0.32, 0.1];
  const SCALE = [0.72, 0.85, 1, 0.85, 0.72];
  const FONT_SIZE = ["0.63rem", "0.72rem", "0.82rem", "0.72rem", "0.63rem"];

  function itemAt(offset) {
    const idx =
      (((centerIdx + offset) % items.length) + items.length) % items.length;
    return items[idx];
  }

  return (
    <div
      className="flex flex-col items-center"
      style={{ flex: label === "" ? "0 0 72px" : 1 }}
    >
      <span className="mb-1.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground font-medium truncate px-1 w-full text-center">
        {label || "‒"}
      </span>

      {/* Reel window */}
      <div
        className="relative w-full rounded-xl border border-border bg-muted/20 overflow-hidden"
        style={{ height: ITEM_H * OFFSETS.length }}
      >
        {/* Top + bottom gradient overlays */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-linear-to-b from-background to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-linear-to-t from-background to-transparent" />

        {/* Center selection highlight */}
        <div
          className="pointer-events-none absolute inset-x-0 z-10 border-y border-primary/25 bg-primary/5"
          style={{ top: 2 * ITEM_H, height: ITEM_H }}
        />

        {/* Items */}
        {OFFSETS.map((offset, i) => {
          const isCenter = offset === 0;
          const text = itemAt(offset);

          return (
            <div
              key={offset}
              className="absolute inset-x-0 flex items-center justify-center px-1 text-center"
              style={{ top: i * ITEM_H, height: ITEM_H }}
            >
              {isCenter ? (
                <span
                  key={`${centerIdx}-${isSpinning ? "spin" : landed ? "land" : "idle"}`}
                  className={
                    landed
                      ? "reel-center-land font-semibold text-foreground"
                      : isSpinning
                        ? "reel-center-tick font-medium text-foreground"
                        : "font-medium text-foreground"
                  }
                  style={{ fontSize: FONT_SIZE[i] }}
                >
                  {text}
                </span>
              ) : (
                <span
                  className="truncate text-foreground select-none"
                  style={{
                    opacity: OPACITY[i],
                    transform: `scale(${SCALE[i]})`,
                    fontSize: FONT_SIZE[i],
                  }}
                >
                  {text}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TopicSpinner modal ───────────────────────────────────────────────────────
export function TopicSpinner({ socket, matched, onClose }) {
  const [isSpinning, setIsSpinning] = useState(false);
  const [finalIndices, setFinalIndices] = useState([0, 0, 0]);
  const [landed, setLanded] = useState(false);
  const [result, setResult] = useState(null);
  const [shared, setShared] = useState(false);
  const spinTimeoutRef = useRef(null);

  // Cleanup on unmount
  useEffect(() => () => clearTimeout(spinTimeoutRef.current), []);

  function handleSpin() {
    if (isSpinning) return;

    const indices = [
      Math.floor(Math.random() * SUBJECTS.length),
      Math.floor(Math.random() * VERBS.length),
      Math.floor(Math.random() * OPINIONS.length),
    ];

    setFinalIndices(indices);
    setIsSpinning(true);
    setLanded(false);
    setResult(null);
    setShared(false);

    spinTimeoutRef.current = setTimeout(() => {
      setIsSpinning(false);
      setLanded(true);
      setResult({
        subject: SUBJECTS[indices[0]],
        verb: VERBS[indices[1]],
        opinion: OPINIONS[indices[2]],
      });
      // Remove landing glow after animation completes
      setTimeout(() => setLanded(false), 600);
    }, SPIN_SETTLE_MS);
  }

  function handleShare() {
    if (!result || shared || !matched) return;
    const topic = `${result.subject} ${result.verb} ${result.opinion}`;
    socket.emit("topicSpin", { topic });
    setShared(true);
  }

  const topicText = result
    ? `${result.subject} ${result.verb} ${result.opinion}`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={!isSpinning ? onClose : undefined}
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              🎡 Topic Spinner
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isSpinning
                ? "Spinning…"
                : result
                  ? "Share it to start the debate!"
                  : "Spin for a random debate topic"}
            </p>
          </div>
          {!isSpinning && (
            <button
              onClick={onClose}
              className="ml-3 mt-0.5 shrink-0 text-lg leading-none text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {/* Reels */}
        <div className="flex gap-2 px-4 py-5">
          <WheelReel
            label="Topic"
            items={SUBJECTS}
            isSpinning={isSpinning}
            finalIndex={finalIndices[0]}
            landed={landed}
          />
          <WheelReel
            label=""
            items={VERBS}
            isSpinning={isSpinning}
            finalIndex={finalIndices[1]}
            landed={landed}
          />
          <WheelReel
            label="Take"
            items={OPINIONS}
            isSpinning={isSpinning}
            finalIndex={finalIndices[2]}
            landed={landed}
          />
        </div>

        {/* Result banner */}
        <div
          className={`mx-4 mb-4 rounded-xl border transition-all duration-300 ${
            result && !isSpinning
              ? "border-primary/25 bg-primary/8 px-4 py-3 opacity-100"
              : "border-transparent px-4 py-0 opacity-0 pointer-events-none"
          }`}
          style={{ minHeight: result ? undefined : 0 }}
        >
          {result && !isSpinning && (
            <p className="text-center text-sm font-medium text-foreground">
              "{topicText}"
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 border-t border-border px-4 py-4">
          <Button className="flex-1" onClick={handleSpin} disabled={isSpinning}>
            {isSpinning ? "Spinning…" : result ? "Spin Again" : "🎰 Spin!"}
          </Button>

          {result && !isSpinning && (
            <Button
              onClick={handleShare}
              disabled={shared || !matched}
              className={
                shared
                  ? "bg-emerald-400 hover:bg-emerald-400 text-emerald-950 border border-emerald-400 font-semibold shadow-[0_0_12px_rgba(52,211,153,0.5)]"
                  : "bg-white hover:bg-gray-100 text-gray-900 border border-gray-300 font-medium"
              }
            >
              {shared ? "✓ Shared!" : "Share"}
            </Button>
          )}
        </div>

        {!matched && (
          <p className="pb-4 text-center text-xs text-muted-foreground">
            Connect to a stranger first to share topics.
          </p>
        )}
      </div>
    </div>
  );
}
