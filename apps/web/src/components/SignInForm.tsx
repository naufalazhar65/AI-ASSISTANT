"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { LogIn } from "lucide-react";
import FloatingParticles from "@/components/FloatingParticles";
import { resolveBrowserUserKey, OWNER_KEY, OWNER_LABEL } from "@/lib/identity";

const STORAGE_KEY = "voice-ai.user";

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    // OVERRIDE, never fold. This used to be `canonicalUserKey(stored) ?? OWNER_KEY`,
    // which looked safe and was not: a fold returns the key unchanged when the key
    // is valid but simply absent from the alias table — which is exactly the stale
    // `s` this migration exists to repair. The `?? OWNER_KEY` therefore could
    // never fire, and the owner kept talking to a stranger. There is one user of
    // this app, so the browser's identity is a constant, not a lookup.
    const resolved = resolveBrowserUserKey(stored);
    if (resolved !== stored) window.localStorage.setItem(STORAGE_KEY, resolved);
    setUser(resolved);
  }, []);

  const signIn = () => {
    // Sign-in is a door, not an identity claim: there is nothing to choose.
    window.localStorage.setItem(STORAGE_KEY, OWNER_KEY);
    setUser(OWNER_KEY);
  };

  const signOut = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  return { user, signIn, signOut };
}

/**
 * Sign-in is a DOOR, not an identity claim.
 *
 * It used to be a free-text name box, and that is precisely how the browser
 * ended up talking to a different person: the owner typed one letter, `s`, and
 * a whole session went to a Mia with 4 facts instead of 22 (including a wrong
 * `city: Jakarta` and a hallucinated `plan: free`). There is exactly one user
 * of this app, so the honest UI states who you are instead of asking.
 */
export default function SignInForm({ onSignIn }: { onSignIn: () => void }) {
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSignIn();
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
              <h1 className="text-xl font-bold tracking-tight text-white">Mia</h1>
            </div>
            <p className="text-sm text-white/40">
              Masuk untuk mulai. Satu akun, satu memori — sama dengan Discord
              dan Telegram.
            </p>
          </div>

          <button
            type="submit"
            autoFocus
            className="rounded-xl bg-primary/90 py-3 text-sm font-semibold text-white hover:bg-primary transition-all duration-300 hover:shadow-[0_0_20px_rgba(59,130,246,0.3)]"
          >
            Masuk sebagai {OWNER_LABEL}
          </button>
        </form>
      </motion.div>
    </main>
  );
}
