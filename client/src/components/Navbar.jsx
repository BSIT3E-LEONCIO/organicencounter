import logo from "../assets/logo.png";

export function Navbar() {
  return (
    <nav
      className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/90 backdrop-blur"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      <div className="mx-auto flex h-14 max-w-5xl items-center px-4 sm:px-6">
        {/* Mobile: centered logo */}
        <div className="flex w-full justify-center sm:hidden">
          <img src={logo} alt="Random Chat" className="h-24 object-contain" />
        </div>

        {/* Desktop: logo left, slogan right */}
        <div className="hidden w-full items-center justify-between sm:flex">
          <img src={logo} alt="Random Chat" className="h-24 object-contain" />
          <p className="text-sm italic text-white">
            Strangers today, stories tomorrow
          </p>
        </div>
      </div>
    </nav>
  );
}
