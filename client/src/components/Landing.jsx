import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const MAX_INTERESTS = 5;

export function Landing({ onStart }) {
  const [interests, setInterests] = useState([]);
  const [inputVal, setInputVal] = useState("");

  function addInterest() {
    const val = inputVal.trim().toLowerCase();
    if (!val || interests.includes(val) || interests.length >= MAX_INTERESTS)
      return;
    setInterests((prev) => [...prev, val]);
    setInputVal("");
  }

  function removeInterest(tag) {
    setInterests((prev) => prev.filter((i) => i !== tag));
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 pt-nav">
      <div className="w-full max-w-md space-y-8 sm:space-y-10 text-center">
        {/* Hero */}
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Meet someone new.
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            Instantly connect with a random stranger. No accounts, no history —
            just a fresh conversation every time.
          </p>
        </div>

        {/* Interests card */}
        <div className="space-y-4 rounded-xl border border-border bg-card p-5 text-left">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">
              Add your interests
            </p>
            <span className="text-xs text-muted-foreground">
              {interests.length}/{MAX_INTERESTS} · optional
            </span>
          </div>

          {/* Tags */}
          {interests.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {interests.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-3 py-1 text-xs text-secondary-foreground"
                >
                  {tag}
                  <button
                    onClick={() => removeInterest(tag)}
                    aria-label={`Remove ${tag}`}
                    className="ml-0.5 p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Input row */}
          <div className="flex gap-2">
            <Input
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addInterest()}
              placeholder="music, gaming, travel..."
              disabled={interests.length >= MAX_INTERESTS}
            />
            <Button
              variant="secondary"
              onClick={addInterest}
              disabled={!inputVal.trim() || interests.length >= MAX_INTERESTS}
              className="shrink-0"
            >
              Add
            </Button>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            We'll try to match you with someone who shares your interests. If no
            one matches, you'll still be connected to any available user.
          </p>
        </div>

        {/* CTA */}
        <Button
          size="lg"
          className="w-full text-base"
          onClick={() => onStart(interests)}
        >
          Start Chatting →
        </Button>
      </div>
    </main>
  );
}
