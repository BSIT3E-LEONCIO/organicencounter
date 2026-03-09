import logo from "../assets/logo.png";
import { useEffect, useState } from "react";

export function Navbar() {
  const [online, setOnline] = useState(
    () => 2120 + Math.floor(Math.random() * 80),
  );

  useEffect(() => {
    let timeout;
    function wiggle() {
      setOnline((prev) => {
        let next =
          prev +
          (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * 7 + 1);
        if (next < 2000) next = 2000 + Math.floor(Math.random() * 10);
        if (next > 2199) next = 2199 - Math.floor(Math.random() * 10);
        return next;
      });
      timeout = setTimeout(wiggle, 3000 + Math.random() * 4000);
    }
    timeout = setTimeout(wiggle, 3000 + Math.random() * 4000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <nav
      className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/90 backdrop-blur"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      <div className="mx-auto flex h-14 max-w-5xl items-center px-4 sm:px-6">
        {/* Mobile: centered logo + online count */}
        <div className="flex w-full items-center justify-center gap-2 sm:hidden">
          <img src={logo} alt="Random Chat" className="h-24 object-contain" />
          <span className="ml-2 rounded-full bg-emerald-600/90 px-2.5 py-0.5 text-xs font-semibold text-white shadow-sm">
            {online} online
          </span>
        </div>

        {/* Desktop: logo left, online count center, slogan right */}
        <div className="hidden w-full items-center justify-between sm:flex">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Random Chat" className="h-24 object-contain" />
            <span className="rounded-full bg-emerald-600/90 px-3 py-1 text-xs font-semibold text-white shadow-sm">
              {online} online
            </span>
          </div>
          <p className="text-sm italic text-white">
            Strangers today, stories tomorrow
          </p>
        </div>
      </div>
    </nav>
  );
}
