"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { LogIn } from "lucide-react";
import FloatingParticles from "@/components/FloatingParticles";

const STORAGE_KEY = "voice-ai.user";

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setUser(stored);
  }, []);

  const signIn = (name: string) => {
    window.localStorage.setItem(STORAGE_KEY, name);
    setUser(name);
  };

  const signOut = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  return { user, signIn, signOut };
}

export default function SignInForm({ onSignIn }: { onSignIn: (name: string) => void }) {
  const [name, setName] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSignIn(name.trim());
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 relative overflow-hidden">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-gray-900 animate-gradient-shift" />

      {/* Floating particles */}
      <FloatingParticles />

      {/* Glow orb */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 h-64 w-64 rounded-full bg-primary/10 blur-[100px]" />

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative w-full max-w-sm"
      >
        {/* Rotating border */}
        <div className="absolute -inset-[1px] rounded-2xl overflow-hidden">
          <div className="absolute inset-0 animate-border-rotate bg-[conic-gradient(from_0deg,transparent_0%,rgba(59,130,246,0.3)_25%,transparent_50%,rgba(59,130,246,0.3)_75%,transparent_100%)]" />
        </div>

        <form
          onSubmit={submit}
          className="relative flex flex-col gap-5 rounded-2xl bg-black/90 backdrop-blur-xl p-8 border border-white/10"
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/20 border border-primary/30">
                <LogIn className="h-4 w-4 text-primary" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-white">Voice AI</h1>
            </div>
            <p className="text-sm text-white/40">
              Enter a name to start. This is a local stand-in for full authentication.
            </p>
          </div>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoFocus
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-colors"
          />

          <button
            type="submit"
            className="rounded-xl bg-primary/90 py-3 text-sm font-semibold text-white hover:bg-primary transition-all duration-300 hover:shadow-[0_0_20px_rgba(59,130,246,0.3)]"
          >
            Continue
          </button>
        </form>
      </motion.div>
    </main>
  );
}
