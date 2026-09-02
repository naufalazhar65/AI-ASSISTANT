"use client";

import { motion } from "framer-motion";

const PARTICLE_COUNT = 20;

// Deterministic PRNG so SSR HTML and client hydration produce identical
// values (Math.random() here would cause hydration mismatches).
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARTICLE_CONFIGS = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
  const rnd = mulberry32(1337 + i);
  const left = rnd() * 100;
  const xFrom = rnd() * 200 - 100;
  const xTo = rnd() * 200 - 100;
  const duration = 5 + rnd() * 3;
  return { left, xFrom, xTo, duration };
});

export default function FloatingParticles() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {PARTICLE_CONFIGS.map((p, i) => (
        <motion.div
          key={i}
          className="absolute h-1 w-1 rounded-full bg-white/10"
          style={{ left: `${p.left}%`, bottom: "-10%" }}
          animate={{
            y: ["0%", "-140%"],
            x: [p.xFrom, p.xTo],
            opacity: [0, 1, 0],
          }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            delay: i * 0.5,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}