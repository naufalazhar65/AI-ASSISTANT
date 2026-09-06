"use client";

import { useState } from "react";

export default function LoginPage() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      setError("PIN salah — coba lagi.");
    } catch {
      setError("Gagal terhubung ke server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur"
      >
        <h1 className="mb-1 text-xl font-semibold text-cyan-300">Mia</h1>
        <p className="mb-6 text-sm text-white/60">Masukkan PIN untuk membuka asisten.</p>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          autoFocus
          className="mb-3 w-full rounded-xl border border-white/10 bg-black/50 px-4 py-3 text-base text-white placeholder-white/30 outline-none focus:border-cyan-400"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !pin}
          className="w-full rounded-xl bg-cyan-500/90 px-4 py-3 font-medium text-black transition hover:bg-cyan-400 disabled:opacity-40"
        >
          {busy ? "Memeriksa…" : "Masuk"}
        </button>
      </form>
    </main>
  );
}