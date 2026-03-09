import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Navbar } from "./components/Navbar";
import { Landing } from "./components/Landing";
import { Chat } from "./components/Chat";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export default function App() {
  const [page,      setPage]      = useState("landing");
  const [interests, setInterests] = useState([]);
  const [ready,     setReady]     = useState(false);
  const socketRef                 = useRef(null);

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;
    socket.on("connect", () => setReady(true));
    socket.on("disconnect", () => setReady(false));
    return () => socket.disconnect();
  }, []);

  function handleStart(selectedInterests) {
    setInterests(selectedInterests);
    setPage("chat");
  }

  function handleStop() {
    setInterests([]);
    setPage("landing");
  }

  return (
    <>
      <Navbar />
      {page === "landing" && <Landing onStart={handleStart} />}
      {page === "chat" && ready && (
        <Chat socket={socketRef.current} interests={interests} onStop={handleStop} />
      )}
      {page === "chat" && !ready && (
        <div className="flex h-screen items-center justify-center pt-nav">
          <p className="text-sm text-muted-foreground">Connecting…</p>
        </div>
      )}
    </>
  );
}